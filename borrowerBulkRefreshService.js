/**
 * Parallel borrower refresh.
 *
 * 1. Load previous history from SQLite (borrowerId, emiAmount, lastSyncedDate).
 * 2. Split into batches of BORROWER_BATCH_SIZE (max 100).
 * 3. Process batches with a worker pool of BORROWER_SYNC_CONCURRENCY.
 *    When a worker finishes a batch it automatically takes the next one.
 * 4. For every active loan belonging to each borrower, also pull the full
 *    repayment ledger from LoanDisk and store it in loan_repayments (SQLite).
 *    This is the only way to get repayment data newer than the last CRIF sync.
 */
import { randomUUID } from 'crypto'
import db from './db.js'
import { config } from './engine/src/config.js'
import { mapWithConcurrency, chunk } from './engine/src/concurrency.js'
import { fetchBorrowerById } from './loandisk.js'
import { upsertLoansForBorrower } from './loanDiskLoans.js'
import { fetchLoanReceiptHistory } from './engine/src/loandiskClient.js'
import { readBorrowerRefresh, writeBorrowerRefresh, resetBorrowerRefresh } from './borrowerRefreshState.js'

let _abortController = null
let _running = false

function batchSize() {
  return Math.min(100, Math.max(1, config.borrowerRefresh?.batchSize || 100))
}

function concurrency() {
  return Math.max(1, config.borrowerRefresh?.concurrency || 5)
}

function isCancelled() {
  return Boolean(_abortController?.signal?.aborted)
}

function throwIfCancelled() {
  if (isCancelled()) {
    const reason = _abortController.signal.reason
    const err = new Error(typeof reason === 'string' ? reason : 'Borrower bulk refresh cancelled')
    err.code = 'CANCELLED'
    throw err
  }
}

function upsertBorrowerRecord(b) {
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

  const byPk = db.prepare('select id from borrowers where id = ?').get(String(b.loandisk_id))
  if (byPk) {
    db.prepare(
      `update borrowers set full_name = ?, first_name = ?, last_name = ?, employer = ?, aliases = ?, branch_id = ?, branch_name = ?, loandisk_id = ? where id = ?`
    ).run(
      b.full_name,
      b.first_name,
      b.last_name,
      b.employer,
      aliasesJson,
      b.branch_id,
      b.branch_name,
      b.loandisk_id,
      byPk.id
    )
    return { id: byPk.id, created: false }
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

function persistFetchedBorrower(localId, result) {
  let resolvedLocalId = localId
  if (result.borrower) {
    const upserted = upsertBorrowerRecord(result.borrower)
    resolvedLocalId = upserted.id
  }
  if (resolvedLocalId && result.loans?.length) {
    upsertLoansForBorrower(db, resolvedLocalId, result.loans)
  } else if (resolvedLocalId) {
    db.prepare(`update loans set synced_at = ? where borrower_id = ?`).run(new Date().toISOString(), resolvedLocalId)
  }
  return resolvedLocalId
}

function receiptDate(value) {
  const text = String(value || '')
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

function loandiskApiAvailable() {
  return !!(config.loandisk?.publicKey && config.loandisk?.authToken)
}

/**
 * Resolve the LoanDisk branch id for a borrower.
 * Falls back to the first configured branch when branch_id isn't stored.
 */
function resolveBranchId(localBorrowerId) {
  const row = localBorrowerId
    ? db.prepare('select branch_id from borrowers where id = ?').get(localBorrowerId)
    : null
  const configured = config.loandisk.branches
  if (!configured?.length) return null
  const match = row?.branch_id
    ? configured.find((b) => String(b.id) === String(row.branch_id))
    : null
  return match ? match.id : configured[0].id
}

let _upsertRepaymentStmt = null
function getUpsertRepaymentStmt() {
  if (_upsertRepaymentStmt) return _upsertRepaymentStmt
  // Ensure table exists even if this module loaded before initDb() finished.
  db.exec(`
    CREATE TABLE IF NOT EXISTS loan_repayments (
      id TEXT PRIMARY KEY,
      loan_number TEXT NOT NULL,
      borrower_id TEXT REFERENCES borrowers(id),
      repayment_id_ext TEXT,
      date TEXT,
      amount REAL,
      reference TEXT,
      source TEXT DEFAULT 'loandisk',
      raw TEXT,
      synced_at TEXT DEFAULT (datetime('now')),
      UNIQUE(loan_number, repayment_id_ext)
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan ON loan_repayments(loan_number)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_loan_repayments_date ON loan_repayments(date)')
  _upsertRepaymentStmt = db.prepare(`
    INSERT INTO loan_repayments (id, loan_number, borrower_id, repayment_id_ext, date, amount, reference, source, raw, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'loandisk', ?, datetime('now'))
    ON CONFLICT(loan_number, repayment_id_ext) DO UPDATE SET
      date = excluded.date,
      amount = excluded.amount,
      reference = excluded.reference,
      raw = excluded.raw,
      synced_at = excluded.synced_at
  `)
  return _upsertRepaymentStmt
}

/**
 * Pull the full repayment ledger for one loan from LoanDisk and store locally.
 * Safe to call multiple times — upserts by (loan_number, repayment_id_ext).
 */
async function syncLoanRepayments(loanNumber, localBorrowerId) {
  if (!loandiskApiAvailable()) return 0
  const branchId = resolveBranchId(localBorrowerId)
  if (!branchId) return 0
  try {
    const rows = await fetchLoanReceiptHistory(branchId, loanNumber)
    const now = new Date().toISOString()
    let count = 0
    const localLoan = db.prepare('select id from loans where loan_number = ?').get(String(loanNumber))
    const loanDbId = localLoan?.id || null

    const insertMany = db.transaction((items) => {
      for (const r of items) {
        const extId = r.repayment_id ? String(r.repayment_id) : null
        if (!extId) continue
        const date = receiptDate(r.repayment_collected_date)
        const amount = r.repayment_amount != null ? Number(r.repayment_amount) : null
        const existing = db.prepare('select id from loan_repayments where loan_number = ? and repayment_id_ext = ?').get(String(loanNumber), extId)
        const rowId = existing?.id || randomUUID()
        getUpsertRepaymentStmt().run(
          rowId,
          String(loanNumber),
          localBorrowerId || null,
          extId,
          date,
          amount,
          r.repayment_reference || null,
          JSON.stringify(r)
        )
        count++
      }
    })
    insertMany(rows)
    // Mark loan as repayments-synced
    if (loanDbId) {
      db.prepare(`update loans set synced_at = ? where id = ?`).run(now, loanDbId)
    }
    return count
  } catch (err) {
    console.warn(`[BorrowerBulkRefresh] Repayments for loan ${loanNumber}:`, err?.message || err)
    return 0
  }
}

/**
 * Load previous borrower history. Count is never assumed — whatever the DB
 * returns is batched dynamically.
 */
export function loadBorrowerQueue({ staleDaysThreshold } = {}) {
  const rows = db
    .prepare(
      `SELECT
         b.id AS localId,
         b.loandisk_id AS borrowerId,
         MAX(l.emi) AS emiAmount,
         MAX(l.synced_at) AS lastSyncedDate
       FROM borrowers b
       LEFT JOIN loans l ON l.borrower_id = b.id
       WHERE b.loandisk_id IS NOT NULL AND TRIM(b.loandisk_id) != ''
       GROUP BY b.id, b.loandisk_id
       ORDER BY
         CASE WHEN MAX(l.synced_at) IS NULL THEN 0 ELSE 1 END,
         MAX(l.synced_at) ASC`
    )
    .all()

  const seen = new Set()
  const queue = []
  for (const row of rows) {
    const borrowerId = String(row.borrowerId).trim()
    if (!borrowerId || seen.has(borrowerId)) continue
    seen.add(borrowerId)
    queue.push({
      borrowerId,
      localId: row.localId || null,
      emiAmount: row.emiAmount != null ? Number(row.emiAmount) : null,
      lastSyncedDate: row.lastSyncedDate || null,
    })
  }

  if (staleDaysThreshold != null && Number.isFinite(Number(staleDaysThreshold))) {
    const cutoff = Date.now() - Number(staleDaysThreshold) * 86400000
    return queue.filter((b) => {
      if (!b.lastSyncedDate) return true
      const t = Date.parse(b.lastSyncedDate)
      return !Number.isFinite(t) || t < cutoff
    })
  }

  return queue
}

async function processBatch(batch, counters) {
  const errors = []
  for (const item of batch) {
    throwIfCancelled()
    try {
      const result = await fetchBorrowerById(item.borrowerId)
      const resolvedLocalId = persistFetchedBorrower(item.localId, result)

      // Pull repayment history for every active loan in this borrower.
      const activeLoanNumbers = (result.loans || [])
        .filter((l) => !l.status || /active|current/i.test(String(l.status)))
        .map((l) => l.loan_number)
        .filter(Boolean)
      for (const loanNumber of activeLoanNumbers) {
        throwIfCancelled()
        await syncLoanRepayments(loanNumber, resolvedLocalId)
      }

      counters.processed += 1
    } catch (err) {
      if (err?.code === 'CANCELLED') throw err
      counters.failed += 1
      errors.push({ borrowerId: item.borrowerId, error: err?.message || String(err) })
      console.warn(`[BorrowerBulkRefresh] ${item.borrowerId}:`, err?.message || err)
    }
  }
  writeBorrowerRefresh({
    status: 'running',
    processed: counters.processed,
    failed: counters.failed,
    progress: {
      phase: 'fetching',
      processed: counters.processed,
      failed: counters.failed,
      total: counters.total,
    },
  })
  return errors
}

export function cancelBorrowerBulkRefresh(reason = 'Borrower bulk refresh cancelled by user') {
  if (_abortController) {
    try {
      _abortController.abort(reason)
    } catch {}
  }
  writeBorrowerRefresh({
    status: 'failed',
    error: reason,
    finishedAt: new Date().toISOString(),
    progress: { phase: 'cancelled' },
  })
  return true
}

export function getBorrowerBulkRefreshStatus() {
  return readBorrowerRefresh()
}

export function getBorrowerRefreshSettings() {
  return { batchSize: batchSize(), concurrency: concurrency() }
}

/**
 * Sync repayments for a single loan number — called from the loan statement
 * route so on-demand refresh doesn't require a full borrower bulk refresh.
 */
export async function syncLoanRepaymentsForRoute(loanNumber) {
  const row = db.prepare('select borrower_id from loans where loan_number = ?').get(String(loanNumber))
  return syncLoanRepayments(loanNumber, row?.borrower_id || null)
}

export async function runBorrowerBulkRefresh({ staleDaysThreshold } = {}) {
  if (_running) {
    return { status: 'running', ...(readBorrowerRefresh() || {}) }
  }

  _running = true
  _abortController = new AbortController()
  const size = batchSize()
  const workers = concurrency()

  try {
    const queue = loadBorrowerQueue({ staleDaysThreshold })
    const batches = chunk(queue, size)
    const startedAt = new Date().toISOString()

    resetBorrowerRefresh({
      status: 'running',
      startedAt,
      finishedAt: null,
      error: null,
      total: queue.length,
      processed: 0,
      failed: 0,
      batches: batches.length,
      batchesComplete: 0,
      batchSize: size,
      concurrency: workers,
      progress: {
        phase: 'queued',
        total: queue.length,
        batches: batches.length,
        batchSize: size,
        concurrency: workers,
      },
    })

    if (!queue.length) {
      const finishedAt = new Date().toISOString()
      return writeBorrowerRefresh({
        status: 'idle',
        finishedAt,
        lastSuccessfulAt: finishedAt,
        error: null,
        progress: { phase: 'empty', total: 0 },
      })
    }

    const counters = { processed: 0, failed: 0, total: queue.length }

    await mapWithConcurrency(
      batches,
      workers,
      async (batch) => {
        throwIfCancelled()
        return processBatch(batch, counters)
      },
      (completed, totalBatches) => {
        writeBorrowerRefresh({
          status: 'running',
          batchesComplete: completed,
          processed: counters.processed,
          failed: counters.failed,
          progress: {
            phase: 'fetching',
            processed: counters.processed,
            failed: counters.failed,
            total: counters.total,
            batchesComplete: completed,
            batches: totalBatches,
          },
        })
      }
    )

    throwIfCancelled()

    const finishedAt = new Date().toISOString()
    return writeBorrowerRefresh({
      status: 'idle',
      finishedAt,
      lastSuccessfulAt: finishedAt,
      error: null,
      processed: counters.processed,
      failed: counters.failed,
      batchesComplete: batches.length,
      progress: {
        phase: 'done',
        processed: counters.processed,
        failed: counters.failed,
        total: counters.total,
        batches: batches.length,
        batchesComplete: batches.length,
      },
    })
  } catch (err) {
    const cancelled = err?.code === 'CANCELLED' || isCancelled()
    const finishedAt = new Date().toISOString()
    return writeBorrowerRefresh({
      status: 'failed',
      finishedAt,
      error: cancelled
        ? err.message || 'Borrower bulk refresh cancelled'
        : err.message || String(err),
      progress: { phase: cancelled ? 'cancelled' : 'failed' },
    })
  } finally {
    _running = false
    _abortController = null
  }
}
