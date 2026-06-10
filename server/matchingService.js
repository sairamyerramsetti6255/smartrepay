import { randomUUID } from 'crypto'
import { rowBorrower } from './db.js'
import { createCandidateMatcher, detectExceptionType, parsePayerName } from './matcher.js'
import { yieldEventLoop } from './asyncUtil.js'
import { fetchBorrowersForTransactions, fetchAllBorrowers, fetchBorrowerLoansFromApi } from './loandisk.js'
import { upsertLoansForBorrower } from './loanDiskLoans.js'
import {
  groupBorrowersByBranch,
  buildLoansByBorrowerId,
  buildBranchSummaries,
  enrichTxForMatching,
} from './matchingBranches.js'

const LARGE_BATCH = 200
const MAX_BORROWER_SEARCH_TERMS = 300
const TX_BATCH_SIZE = 300
const LOAN_ENRICH_CONCURRENCY = 8

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
  return { id, created: true }
}

async function loadAllBorrowersFallback() {
  const { borrowers } = await fetchAllBorrowers()
  return borrowers
}

/** Enrich EMI data from OperationsNewForId for payers likely to match. */
async function enrichLoanEmisForMatching(db, localBorrowers, toMatch, loansByBorrowerId, onProgress) {
  if (!loanDiskConfigured()) return 0

  const payerKeys = new Set(
    toMatch.map((t) => {
      const p = parsePayerName(t.payer)
      return `${normalizeKey(p.first)}|${normalizeKey(p.last)}`
    })
  )

  const needsEnrich = localBorrowers.filter((b) => {
    if (!b.loandisk_id) return false
    const loans = loansByBorrowerId.get(b.id) || []
    if (loans.some((l) => l.emi != null && Number(l.emi) > 0)) return false
    const p = parsePayerName(b.full_name)
    const key = `${normalizeKey(p.first)}|${normalizeKey(p.last)}`
    const keyFirst = `${normalizeKey(p.first)}|`
    return [...payerKeys].some((pk) => pk === key || pk.startsWith(keyFirst))
  })

  let done = 0
  const total = needsEnrich.length
  onProgress?.({ phase: 'loading_loans', loansLoaded: 0, loansTotal: total })

  for (let i = 0; i < needsEnrich.length; i += LOAN_ENRICH_CONCURRENCY) {
    const chunk = needsEnrich.slice(i, i + LOAN_ENRICH_CONCURRENCY)
    await Promise.all(
      chunk.map(async (b) => {
        try {
          const parsed = await fetchBorrowerLoansFromApi(b.loandisk_id)
          const { id } = upsertBorrowerRecord(db, parsed.borrower || b)
          if (parsed.loans?.length) {
            const saved = upsertLoansForBorrower(db, id, parsed.loans)
            loansByBorrowerId.set(id, saved)
          }
        } catch (e) {
          console.warn(`Loan enrich ${b.loandisk_id}:`, e.message)
        }
      })
    )
    done += chunk.length
    onProgress?.({ phase: 'loading_loans', loansLoaded: done, loansTotal: total })
    await yieldEventLoop()
  }
  return done
}

function normalizeKey(s) {
  return String(s || '').toLowerCase().trim()
}

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

function updateBranchStatsFromMatches(db, branchStats, branchGroups) {
  const allMatched = db
    .prepare(
      `select t.amount, t.matched_borrower_id, b.branch_id, b.branch_name
       from transactions t
       left join borrowers b on b.id = t.matched_borrower_id
       where t.status in ('matched','posted') and t.matched_borrower_id is not null`
    )
    .all()

  for (const stat of branchStats) {
    const rows = allMatched.filter(
      (t) => String(t.branch_id || t.branch_name || 'unknown') === String(stat.branchKey)
    )
    stat.matched = rows.length
    stat.totalEmiReceived = Math.round(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0) * 100) / 100
    stat.unmatched = 0
    stat.percent = 100
    stat.status = 'done'
  }
}

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
  const txBatchesTotal = Math.max(1, Math.ceil(toMatch.length / TX_BATCH_SIZE))

  report({
    phase: 'preparing',
    processed: 0,
    total: toMatch.length,
    matched: 0,
    excepted: 0,
    branches: branchStats,
    batchIndex: 0,
    batchTotal: txBatchesTotal,
  })
  await yieldEventLoop()

  let searchSource = 'local'
  let searchError = null
  let termsSearched = 0

  if (loanDiskConfigured()) {
    report({ phase: 'loading_borrowers', processed: 0, total: toMatch.length, matched: 0, excepted: 0, branches: branchStats })
    try {
      const all = await loadAllBorrowersFallback()
      if (all.length) {
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
  if (loanDiskConfigured() && toMatch.length <= LARGE_BATCH && uniquePayerCount <= MAX_BORROWER_SEARCH_TERMS) {
    try {
      const searchResult = await fetchBorrowersForTransactions(toMatch, report)
      for (const b of searchResult.apiPool) upsertBorrowerRecord(db, b)
      termsSearched = searchResult.termsSearched
      searchSource = searchSource === 'GetAllBorrowers' ? 'GetAllBorrowers+BorrowerSerch' : 'BorrowerSerch'
      localBorrowers = db.prepare('select * from borrowers').all().map(rowBorrower)
      loans = db.prepare('select * from loans').all()
      branchGroups = groupBorrowersByBranch(localBorrowers)
      branchStats = buildBranchSummaries(branchGroups, loans, toMatch)
    } catch (e) {
      if (!searchError) searchError = e.message
    }
  }

  const loansByBorrowerId = buildLoansByBorrowerId(loans)
  await enrichLoanEmisForMatching(db, localBorrowers, toMatch, loansByBorrowerId, report)
  loans = db.prepare('select * from loans').all()
  for (const loan of loans) {
    if (!loansByBorrowerId.has(loan.borrower_id)) loansByBorrowerId.set(loan.borrower_id, [])
    const list = loansByBorrowerId.get(loan.borrower_id)
    if (!list.some((l) => l.id === loan.id)) list.push(loan)
  }

  const matchAll = createCandidateMatcher(localBorrowers, loansByBorrowerId)
  const pendingIds = new Set(toMatch.map((t) => t.id))
  let matched = 0
  let excepted = 0

  report({
    phase: 'matching',
    processed: 0,
    total: toMatch.length,
    matched: 0,
    excepted: 0,
    branches: branchStats,
    batchIndex: 0,
    batchTotal: txBatchesTotal,
  })

  for (let batchIdx = 0; batchIdx < txBatchesTotal; batchIdx++) {
    const batchStart = batchIdx * TX_BATCH_SIZE
    const batch = toMatch.slice(batchStart, batchStart + TX_BATCH_SIZE)

    for (const rawTx of batch) {
      if (!pendingIds.has(rawTx.id)) continue
      const tx = enrichTxForMatching(rawTx, docFilenames)
      const { borrower, score, loan } = matchAll(tx)

      if (score >= threshold && borrower) {
        let resolvedBorrower = borrower
        if (borrower.loandisk_id) {
          const { id } = upsertBorrowerRecord(db, borrower)
          resolvedBorrower = rowBorrower(db.prepare('select * from borrowers where id = ?').get(id))
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
      }
    }

    const processed = Math.min(toMatch.length, batchStart + batch.length)
    report({
      phase: 'matching',
      processed,
      total: toMatch.length,
      matched,
      excepted,
      branches: branchStats,
      batchIndex: batchIdx + 1,
      batchTotal: txBatchesTotal,
      percent: Math.round((processed / Math.max(1, toMatch.length)) * 100),
    })
    await yieldEventLoop()
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
    pendingIds.delete(rawTx.id)
  }

  updateBranchStatsFromMatches(db, branchStats, branchGroups)

  report({
    phase: 'done',
    processed: toMatch.length,
    total: toMatch.length,
    matched,
    excepted,
    branches: branchStats,
    percent: 100,
  })

  audit(db, 'matching', null, 'run', actor, null, {
    matched,
    excepted,
    searchSource,
    termsSearched,
    searchError,
  })

  return {
    matched,
    excepted,
    pending: toMatch.length,
    borrowers: localBorrowers.length,
    searchSource,
    termsSearched,
    candidatesFound: localBorrowers.length,
    searchError,
    branches: branchStats,
  }
}
