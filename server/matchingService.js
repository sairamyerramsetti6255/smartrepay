import { randomUUID } from 'crypto'
import { rowBorrower } from './db.js'
import { bestMatchFromCandidates, createCandidateMatcher, detectExceptionType } from './matcher.js'
import { yieldEventLoop } from './asyncUtil.js'
import { fetchBorrowersForTransactions, fetchAllBorrowers } from './loandisk.js'
import {
  groupBorrowersByBranch,
  buildLoansByBorrowerId,
  buildBranchSummaries,
  enrichTxForMatching,
} from './matchingBranches.js'

const LARGE_BATCH = 200
const MAX_BORROWER_SEARCH_TERMS = 300

function loanDiskConfigured() {
  return !!(process.env.LOANDISK_USERNAME || process.env.LOANDISK_PASSWORD || process.env.LOANDISK_ACCESS_TOKEN)
}

function getSettings(db) {
  const row = db.prepare('select value from app_settings where key = ?').get('global')
  return row ? JSON.parse(row.value) : {}
}

function audit(db, entity, entityId, action, actor, priorValue, newValue) {
  db.prepare(
    `insert into audit_log (id, entity, entity_id, action, actor, prior_value, new_value) values (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    entity,
    entityId || null,
    action,
    actor,
    priorValue ? JSON.stringify(priorValue) : null,
    newValue ? JSON.stringify(newValue) : null
  )
}

function upsertBorrowerRecord(db, b) {
  const existing = db.prepare('select id from borrowers where loandisk_id = ?').get(b.loandisk_id)
  const aliasesJson = JSON.stringify(b.aliases || [])

  const loanNum = b.unique_number || `LD-${b.loandisk_id}`
  const emi = b.emi != null && !isNaN(Number(b.emi)) ? Number(b.emi) : null
  const balance = b.loan_amount != null && !isNaN(Number(b.loan_amount)) ? Number(b.loan_amount) : null

  if (existing) {
    db.prepare(
      `update borrowers set full_name = ?, first_name = ?, last_name = ?, employer = ?, aliases = ?, branch_id = ?, branch_name = ? where id = ?`
    ).run(
      b.full_name,
      b.first_name,
      b.last_name,
      b.employer,
      aliasesJson,
      b.branch_id,
      b.branch_name,
      existing.id
    )
    const loanRow = db.prepare('select id from loans where borrower_id = ?').get(existing.id)
    if (loanRow && (emi != null || balance != null)) {
      db.prepare(
        'update loans set outstanding_balance = coalesce(?, outstanding_balance), emi = coalesce(?, emi) where borrower_id = ?'
      ).run(balance, emi, existing.id)
    }
    return { id: existing.id, created: false }
  }

  const id = randomUUID()
  db.prepare(
    `insert into borrowers (id, full_name, first_name, last_name, employer, aliases, loandisk_id, branch_id, branch_name)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    b.full_name,
    b.first_name,
    b.last_name,
    b.employer,
    aliasesJson,
    b.loandisk_id,
    b.branch_id,
    b.branch_name
  )

  const loanExists = db.prepare('select id from loans where loan_number = ?').get(loanNum)
  if (!loanExists) {
    db.prepare(
      'insert into loans (id, borrower_id, loan_number, outstanding_balance, emi, status) values (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), id, loanNum, balance, emi, 'active')
  } else if (emi != null || balance != null) {
    db.prepare(
      'update loans set outstanding_balance = coalesce(?, outstanding_balance), emi = coalesce(?, emi) where loan_number = ?'
    ).run(balance, emi, loanNum)
  }
  return { id, created: true }
}

async function loadAllBorrowersFallback() {
  const { borrowers } = await fetchAllBorrowers()
  return borrowers
}

/** Branch preview for matching UI (no job required). */
export function getMatchingPreview(db) {
  const pending = db
    .prepare("select * from transactions where status in ('pending', 'exception') order by date asc")
    .all()
  const borrowers = db.prepare('select * from borrowers').all().map(rowBorrower)
  const loans = db.prepare('select * from loans').all()
  const branchGroups = groupBorrowersByBranch(borrowers)
  const branches = buildBranchSummaries(branchGroups, loans, pending)
  const totalPendingEmi = pending.reduce((s, t) => s + (Number(t.amount) || 0), 0)
  return {
    pendingCount: pending.length,
    totalPendingEmi: Math.round(totalPendingEmi * 100) / 100,
    borrowerCount: borrowers.length,
    branchCount: branches.length,
    branches,
  }
}

/** List transactions for a branch drill-down in matching UI. */
export function getBranchTransactions(db, branchKey, status = 'all') {
  const borrowers = db
    .prepare('select * from borrowers')
    .all()
    .map(rowBorrower)
    .filter((b) => String(b.branch_id || b.branch_name || 'unknown') === String(branchKey))

  const borrowerIds = new Set(borrowers.map((b) => b.id))
  const borrowerById = Object.fromEntries(borrowers.map((b) => [b.id, b]))

  let rows = db
    .prepare(
      `select t.*, b.full_name as matched_borrower_name, b.loandisk_id as borrower_loandisk_id, b.branch_name
       from transactions t
       left join borrowers b on b.id = t.matched_borrower_id
       order by t.date asc`
    )
    .all()
    .filter((t) => t.matched_borrower_id && borrowerIds.has(t.matched_borrower_id))

  if (status === 'matched') rows = rows.filter((t) => t.status === 'matched' || t.status === 'posted')
  else if (status === 'unmatched') rows = rows.filter((t) => t.status === 'exception' || t.status === 'pending')

  return rows.map((t) => ({
    ...t,
    borrower: t.matched_borrower_id ? borrowerById[t.matched_borrower_id] : null,
  }))
}

/** Runs in a worker thread — branch-wise matching with progress. */
export async function runMatchingBatch(db, actor, onProgress) {
  const report = (patch) => onProgress?.(patch)

  const settings = getSettings(db)
  const threshold = settings.autoApproveThreshold ?? 80
  let localBorrowers = db.prepare('select * from borrowers').all().map(rowBorrower)
  const toMatch = db
    .prepare("select * from transactions where status in ('pending', 'exception') order by date asc")
    .all()
  const allTx = db.prepare('select * from transactions').all()
  const docFilenames = new Map(
    db.prepare('select id, filename from documents').all().map((d) => [d.id, d.filename])
  )

  let loans = db.prepare('select * from loans').all()
  let branchGroups = groupBorrowersByBranch(localBorrowers)
  let branchStats = buildBranchSummaries(branchGroups, loans, toMatch)

  report({
    phase: 'preparing',
    processed: 0,
    total: toMatch.length,
    matched: 0,
    excepted: 0,
    branches: branchStats,
    currentBranch: null,
  })
  await yieldEventLoop()

  let apiPool = []
  let searchSource = 'local'
  let searchError = null
  let termsSearched = 0

  if (loanDiskConfigured()) {
    report({ phase: 'loading_borrowers', processed: 0, total: toMatch.length, matched: 0, excepted: 0, branches: branchStats })
    try {
      const all = await loadAllBorrowersFallback()
      if (all.length) {
        apiPool = all
        searchSource = 'GetAllBorrowers'
        for (const b of all) upsertBorrowerRecord(db, b)
        localBorrowers = db.prepare('select * from borrowers').all().map(rowBorrower)
        loans = db.prepare('select * from loans').all()
        branchGroups = groupBorrowersByBranch(localBorrowers)
        branchStats = buildBranchSummaries(branchGroups, loans, toMatch)
      }
    } catch (e) {
      searchError = e.message
      console.warn('GetAllBorrowers failed:', e.message)
    }
  }

  const uniquePayerCount = new Set(toMatch.map((t) => String(t.payer || '').trim().toLowerCase()).filter(Boolean)).size
  if (
    loanDiskConfigured() &&
    toMatch.length <= LARGE_BATCH &&
    uniquePayerCount <= MAX_BORROWER_SEARCH_TERMS
  ) {
    try {
      const searchResult = await fetchBorrowersForTransactions(toMatch, report)
      for (const b of searchResult.apiPool) {
        if (!apiPool.some((x) => x.loandisk_id === b.loandisk_id)) apiPool.push(b)
      }
      termsSearched = searchResult.termsSearched
      searchSource = searchSource === 'GetAllBorrowers' ? 'GetAllBorrowers+BorrowerSerch' : 'BorrowerSerch'
      for (const b of searchResult.apiPool) upsertBorrowerRecord(db, b)
      localBorrowers = db.prepare('select * from borrowers').all().map(rowBorrower)
      loans = db.prepare('select * from loans').all()
      branchGroups = groupBorrowersByBranch(localBorrowers)
      branchStats = buildBranchSummaries(branchGroups, loans, toMatch)
    } catch (e) {
      if (!searchError) searchError = e.message
    }
  }

  const loansByBorrowerId = buildLoansByBorrowerId(loans)
  const pendingIds = new Set(toMatch.map((t) => t.id))
  let matched = 0
  let excepted = 0
  let globalProcessed = 0

  if (!branchGroups.length) {
    branchGroups = [{ branchKey: 'unknown', branchId: null, branchName: 'All borrowers', borrowers: localBorrowers }]
    branchStats = buildBranchSummaries(branchGroups, loans, toMatch)
  }

  report({
    phase: 'matching',
    processed: 0,
    total: toMatch.length,
    matched: 0,
    excepted: 0,
    branches: branchStats,
    currentBranch: null,
  })

  for (let bi = 0; bi < branchGroups.length; bi++) {
    const branch = branchGroups[bi]
    const stat = branchStats[bi]
    stat.status = 'running'
    const branchMatcher = createCandidateMatcher(branch.borrowers, loansByBorrowerId)

    report({
      phase: 'matching',
      processed: globalProcessed,
      total: toMatch.length,
      matched,
      excepted,
      branches: branchStats,
      currentBranch: branch.branchName,
      branchIndex: bi,
      branchTotal: branchGroups.length,
    })

    let branchAttempts = 0
    for (const rawTx of toMatch) {
      if (!pendingIds.has(rawTx.id)) continue
      branchAttempts++

      const tx = enrichTxForMatching(rawTx, docFilenames)
      const { borrower, score, loan } = branchMatcher(tx)

      if (score >= threshold && borrower) {
        let resolvedBorrower = borrower
        if (borrower.loandisk_id) {
          const { id } = upsertBorrowerRecord(db, borrower)
          resolvedBorrower = rowBorrower(db.prepare('select * from borrowers where id = ?').get(id))
          const loanRow = loan?.id
            ? db.prepare('select * from loans where id = ?').get(loan.id)
            : db.prepare('select * from loans where borrower_id = ?').get(id)
          if (loanRow && !loansByBorrowerId.has(id)) loansByBorrowerId.set(id, [])
          if (loanRow) {
            const list = loansByBorrowerId.get(id) || []
            if (!list.some((l) => l.id === loanRow.id)) list.push(loanRow)
            loansByBorrowerId.set(id, list)
          }
        }

        const loanId = loan?.id || db.prepare('select id from loans where borrower_id = ?').get(resolvedBorrower.id)?.id

        db.prepare(
          `update transactions set status = 'matched', confidence_score = ?, matched_borrower_id = ?, loan_id = ? where id = ?`
        ).run(score, resolvedBorrower.id, loanId || null, tx.id)
        db.prepare(
          `update exceptions set status = 'resolved', resolved_at = datetime('now')
           where transaction_id = ? and status = 'open'`
        ).run(tx.id)

        pendingIds.delete(tx.id)
        matched++
        stat.matched++
        stat.totalEmiReceived = Math.round((stat.totalEmiReceived + Number(tx.amount || 0)) * 100) / 100
      }

      if (branchAttempts % 15 === 0) await yieldEventLoop()
    }

    stat.processed = branchAttempts
    stat.unmatched = branchAttempts - stat.matched
    stat.percent = 100
    stat.status = 'done'
    globalProcessed = toMatch.length - pendingIds.size

    report({
      phase: 'matching',
      processed: globalProcessed,
      total: toMatch.length,
      matched,
      excepted,
      branches: branchStats,
      currentBranch: branch.branchName,
      branchIndex: bi,
      branchTotal: branchGroups.length,
    })
  }

  for (const rawTx of toMatch) {
    if (!pendingIds.has(rawTx.id)) continue
    const tx = enrichTxForMatching(rawTx, docFilenames)
    const exType = detectExceptionType(tx, allTx, 0)
    db.prepare(
      `update transactions set status = 'exception', confidence_score = ?, matched_borrower_id = ? where id = ?`
    ).run(0, null, tx.id)
    const existing = db.prepare("select id from exceptions where transaction_id = ? and status = 'open'").get(tx.id)
    if (!existing) {
      const sla = settings.slaHours?.[exType] ?? 24
      db.prepare(
        `insert into exceptions (id, transaction_id, type, status, assigned_to, sla_hours) values (?, ?, ?, 'open', ?, ?)`
      ).run(randomUUID(), tx.id, exType, actor, sla)
    }
    excepted++
    pendingIds.delete(tx.id)
  }

  for (const stat of branchStats) {
    if (stat.status !== 'done') stat.status = 'done'
    stat.percent = 100
  }

  report({
    phase: 'done',
    processed: toMatch.length,
    total: toMatch.length,
    matched,
    excepted,
    branches: branchStats,
    currentBranch: null,
  })

  audit(db, 'matching', null, 'run', actor, null, {
    matched,
    excepted,
    searchSource,
    termsSearched,
    branches: branchStats,
    searchError,
  })

  return {
    matched,
    excepted,
    pending: toMatch.length,
    borrowers: db.prepare('select count(*) as c from borrowers').get().c,
    searchSource,
    termsSearched,
    candidatesFound: localBorrowers.length,
    searchError,
    branches: branchStats,
  }
}
