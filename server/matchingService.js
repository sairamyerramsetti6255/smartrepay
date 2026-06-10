import { randomUUID } from 'crypto'
import { rowBorrower } from './db.js'
import { createCandidateMatcher, detectExceptionType } from './matcher.js'
import { yieldEventLoop } from './asyncUtil.js'
import {
  groupBorrowersByBranch,
  buildLoansByBorrowerId,
  buildBranchSummaries,
  enrichTxForMatching,
} from './matchingBranches.js'

const REPORT_EVERY = 25

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
  return { id, created: false }
}

function branchKeyForBorrower(b) {
  return String(b?.branch_id || b?.branch_name || 'unknown')
}

function findBranchStat(branchStats, borrower) {
  const key = branchKeyForBorrower(borrower)
  return branchStats.find((s) => String(s.branchKey) === key)
}

function liveRow(tx, borrower, status) {
  return {
    id: tx.id,
    payer: tx.payer,
    amount: tx.amount,
    date: tx.date,
    status,
    borrowerName: borrower?.full_name || null,
    loandiskId: borrower?.loandisk_id || null,
    branchName: borrower?.branch_name || null,
  }
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

/** Fast name-only matching with live matched/unmatched progress. */
export async function runMatchingBatch(db, actor, onProgress) {
  const report = (patch) => onProgress?.(patch)

  const settings = getSettings(db)
  const threshold = settings.autoApproveThreshold ?? 80
  const localBorrowers = db.prepare('select * from borrowers').all().map(rowBorrower)
  const toMatch = db
    .prepare("select * from transactions where status in ('pending', 'exception') order by date asc")
    .all()
  const allTx = db.prepare('select * from transactions').all()
  const docFilenames = new Map(
    db.prepare('select id, filename from documents').all().map((d) => [d.id, d.filename])
  )

  const loans = db.prepare('select * from loans').all()
  let branchGroups = groupBorrowersByBranch(localBorrowers)
  let branchStats = buildBranchSummaries(branchGroups, loans, toMatch)

  if (!branchGroups.length) {
    branchGroups = [{ branchKey: 'unknown', branchId: null, branchName: 'All borrowers', borrowers: localBorrowers }]
    branchStats = buildBranchSummaries(branchGroups, loans, toMatch)
  }

  const recentMatched = []
  const recentUnmatched = []
  let matched = 0
  let excepted = 0

  report({
    phase: 'matching',
    processed: 0,
    total: toMatch.length,
    matched: 0,
    excepted: 0,
    percent: 0,
    branches: branchStats,
    recentMatched: [],
    recentUnmatched: [],
  })

  if (!localBorrowers.length) {
    report({ phase: 'done', processed: 0, total: 0, matched: 0, excepted: 0, percent: 100, branches: branchStats })
    return {
      matched: 0,
      excepted: 0,
      pending: 0,
      borrowers: 0,
      searchSource: 'local',
      message: 'No borrowers — sync LoanDisk first',
      branches: branchStats,
    }
  }

  const loansByBorrowerId = buildLoansByBorrowerId(loans)
  const matchAll = createCandidateMatcher(localBorrowers, loansByBorrowerId)

  for (let i = 0; i < toMatch.length; i++) {
    const rawTx = toMatch[i]
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

      matched++
      const stat = findBranchStat(branchStats, resolvedBorrower)
      if (stat) {
        stat.matched++
        stat.totalEmiReceived = Math.round((stat.totalEmiReceived + Number(tx.amount || 0)) * 100) / 100
        stat.processed++
        stat.percent = stat.processed > 0 ? Math.min(100, Math.round((stat.matched / stat.processed) * 100)) : 0
        stat.status = 'running'
      }

      recentMatched.unshift(liveRow(tx, resolvedBorrower, 'matched'))
      if (recentMatched.length > 30) recentMatched.pop()
    } else {
      const exType = detectExceptionType(tx, allTx, score)
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
      recentUnmatched.unshift(liveRow(tx, null, 'exception'))
      if (recentUnmatched.length > 30) recentUnmatched.pop()
    }

    const processed = i + 1
    if (processed % REPORT_EVERY === 0 || processed === toMatch.length) {
      const percent = Math.round((processed / Math.max(1, toMatch.length)) * 100)
      for (const stat of branchStats) {
        if (stat.status === 'running') stat.percent = percent
        if (processed === toMatch.length) {
          stat.status = 'done'
          stat.percent = 100
          stat.unmatched = Math.max(0, (stat.processed || 0) - (stat.matched || 0))
        }
      }
      report({
        phase: processed === toMatch.length ? 'done' : 'matching',
        processed,
        total: toMatch.length,
        matched,
        excepted,
        percent,
        branches: branchStats,
        recentMatched: [...recentMatched],
        recentUnmatched: [...recentUnmatched],
      })
      await yieldEventLoop()
    }
  }

  audit(db, 'matching', null, 'run', actor, null, { matched, excepted, searchSource: 'local-name' })

  return {
    matched,
    excepted,
    pending: toMatch.length,
    borrowers: localBorrowers.length,
    searchSource: 'local-name',
    termsSearched: 0,
    candidatesFound: localBorrowers.length,
    branches: branchStats,
    recentMatched,
    recentUnmatched,
  }
}
