/**
 * Incremental LoanDisk → SQL batch-wise sync.
 *
 * Modes:
 *  - delta (default when lastSuccessfulAt exists): pull Active+Current, upsert only
 *    new/changed rows (fingerprint compare against local DB). Resume supported.
 *  - full (forceFull, stale >7d, or first sync): same pull, write all rows, clear resume.
 *
 * LoanDisk does not support reliable "updated since" filters on advanced_search_loans,
 * so delta still pages the active book — speed comes from larger pages, branch/page
 * concurrency, resume, and skipping unchanged DB writes.
 */
import { readLoanRefresh, writeLoanRefresh, loansAreStale } from './loanRefreshState.js'
import { config } from './engine/src/config.js'
import { fetchAllLoansByStatus, loanFingerprint } from './engine/src/currentLoansClient.js'
import { bulkInsertStagingRecords, bulkUpsertSilLoanRepayments, markStaleLoansInBranch } from './engine/src/dataAccess.js'
import { fetchBranchRepaymentsBulk } from './engine/src/loandiskClient.js'
import db from './db.js'
import { invalidateCrifCache } from './crifClient.js'

let _syncAbortController = null
let _cancelled = false

export function getSyncSignal() {
  return _syncAbortController?.signal ?? null
}

export function cancelSqlBorrowerLoanSync(reason = 'Loan synchronization cancelled by user') {
  _cancelled = true
  if (_syncAbortController) {
    try {
      _syncAbortController.abort(reason)
    } catch {}
    _syncAbortController = null
  }
  globalThis.__loanSyncSignal = null
  writeLoanRefresh({
    status: 'failed',
    error: reason,
    progress: { phase: 'cancelled' },
    finishedAt: new Date().toISOString(),
  })
  return true
}

export function buildBorrowerRowsFromLoans(loanRecords) {
  const seen = new Map()
  for (const rec of loanRecords) {
    if (!rec?.borrowerId) continue
    const key = `${rec.branchId}:${rec.borrowerId}`
    if (seen.has(key)) continue
    const full = String(rec.borrowerFullName || '').trim()
    const parts = full.split(/\s+/).filter(Boolean)
    const first = parts[0] || ''
    const last = parts.length > 1 ? parts.slice(1).join(' ') : ''
    seen.set(key, {
      borrower_id: rec.borrowerId,
      borrower_firstname: first,
      borrower_lastname: last,
      borrower_email: rec.borrowerEmail || null,
      borrower_mobile: rec.borrowerPhone || null,
      branchId: rec.branchId,
      branchName: rec.branchName,
    })
  }
  return [...seen.values()]
}

/** Load local loan fingerprints keyed by loan id and loan number. */
export function loadExistingLoanFingerprints() {
  const byId = new Map()
  const byNumber = new Map()
  try {
    const rows = db
      .prepare(
        `SELECT id, loan_number, outstanding_balance, emi, status, fingerprint
         FROM loans`
      )
      .all()
    for (const row of rows) {
      const fp =
        row.fingerprint ||
        `${row.outstanding_balance ?? ''}|${row.emi ?? ''}|${row.status ?? ''}|`
      if (row.id) byId.set(String(row.id), fp)
      if (row.loan_number) byNumber.set(String(row.loan_number), fp)
    }
  } catch (err) {
    console.warn('[LoanSync] Could not load local fingerprints:', err.message)
  }
  return { byId, byNumber, count: byId.size }
}

function filterChangedRecords(records, fingerprints, mode) {
  if (mode === 'full' || !fingerprints?.byId) {
    return { toSave: records, skipped: 0, inserted: records.length, updated: 0 }
  }

  const toSave = []
  let skipped = 0
  let inserted = 0
  let updated = 0

  for (const rec of records) {
    const fp = loanFingerprint(rec)
    const prev =
      (rec.loanId && fingerprints.byId.get(String(rec.loanId))) ||
      (rec.loanNumber && fingerprints.byNumber.get(String(rec.loanNumber))) ||
      null

    if (prev == null) {
      inserted++
      toSave.push({ ...rec, _fingerprint: fp })
      continue
    }
    if (prev === fp) {
      skipped++
      continue
    }
    updated++
    toSave.push({ ...rec, _fingerprint: fp })
  }

  return { toSave, skipped, inserted, updated }
}

async function saveLoansBatch(records) {
  if (!records?.length) return

  const now = new Date().toISOString()

  // ─── STEP 1: Write to SQL Server FIRST ────────────────────────────────────
  // CRITICAL ordering: SQL Server must succeed before we update the local SQLite
  // fingerprint cache. If we write SQLite first and the SQL MERGE later throws,
  // the fingerprint lands in SQLite but not in SQL Server. Every subsequent delta
  // run then sees "fingerprint match → skip" and the loan is permanently excluded
  // from SQL Server. By writing SQL Server first, a failure leaves SQLite clean so
  // the loan is retried as "new" on the very next sync run.
  try {
    await bulkInsertStagingRecords(records)
  } catch (err) {
    console.error('[LoanSync] Staging_LoandiskDueRecords MERGE FAILED:', err.message)
    throw err  // do NOT update SQLite — loan will be retried next run
  }

  // ─── STEP 2: SQL Server succeeded — now persist fingerprints to SQLite ───
  try {
    const insertBorrower = db.prepare(`
      INSERT INTO borrowers (id, full_name, employer, loandisk_id, first_name, last_name, branch_id, branch_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        full_name = excluded.full_name,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        branch_id = excluded.branch_id,
        branch_name = excluded.branch_name
    `)
    const insertLoan = db.prepare(`
      INSERT INTO loans (id, borrower_id, loan_number, outstanding_balance, emi, status, synced_at, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        borrower_id = excluded.borrower_id,
        loan_number = excluded.loan_number,
        outstanding_balance = excluded.outstanding_balance,
        emi = excluded.emi,
        status = excluded.status,
        synced_at = excluded.synced_at,
        fingerprint = excluded.fingerprint
    `)
    // Also update by loan_number when id differs (legacy UUID rows).
    const updateByNumber = db.prepare(`
      UPDATE loans
      SET outstanding_balance = ?, emi = ?, status = ?, synced_at = ?, fingerprint = ?,
          borrower_id = COALESCE(borrower_id, ?)
      WHERE loan_number = ? AND id != ?
    `)

    const tx = db.transaction((rows) => {
      for (const r of rows) {
        if (!r.loanId) continue
        const borrowerId = r.borrowerId ? String(r.borrowerId) : `b_${r.loanId}`
        const fullName = r.borrowerFullName || 'Unknown Borrower'
        const parts = fullName.split(/\s+/).filter(Boolean)
        const first = parts[0] || ''
        const last = parts.length > 1 ? parts.slice(1).join(' ') : ''
        const balance = r.loanBalanceAmount || r.totalDue || 0
        const emi = r.expectedEmiAmount || 0
        const status = r.loanStatus || 'active'
        const fp = r._fingerprint || loanFingerprint(r)

        insertBorrower.run(
          borrowerId,
          fullName,
          r.branchName || null,
          r.borrowerId || null,
          first,
          last,
          r.branchId || null,
          r.branchName || null
        )
        insertLoan.run(String(r.loanId), borrowerId, String(r.loanNumber || r.loanId), balance, emi, status, now, fp)
        if (r.loanNumber) {
          updateByNumber.run(balance, emi, status, now, fp, borrowerId, String(r.loanNumber), String(r.loanId))
        }

        // Keep in-memory fingerprints fresh for later batches in this run.
        fingerprintsTouch(String(r.loanId), String(r.loanNumber || ''), fp)
      }
    })
    tx(records)
  } catch (err) {
    // SQLite failure is non-fatal: SQL Server already has the data.
    // The next delta run will treat these loans as "new" and re-MERGE them
    // (idempotent), then re-write to SQLite.
    console.warn('[LoanSync] SQLite batch upsert error (non-fatal, SQL Server already updated):', err.message)
  }

  try {
    invalidateCrifCache('Get_LoandiskDueRecords')
    invalidateCrifCache('Get_Loan')
    invalidateCrifCache('Get_LoanRepayments')
  } catch {}
}

function pickRepaymentField(row, ...keys) {
  for (const key of keys) {
    const v = row?.[key]
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return null
}

function normalizeRepaymentRow(raw, loan) {
  const repaymentId = pickRepaymentField(raw, 'repayment_id', 'RepaymentId', 'id')
  if (repaymentId == null) return null
  const loanId =
    pickRepaymentField(raw, 'loan_id', 'LoanId') ||
    loan.loanId ||
    loan.loanNumber
  if (loanId == null) return null

  const collected =
    pickRepaymentField(raw, 'repayment_collected_date', 'RepaymentCollectedDate', 'collected_date') || null
  const amount = pickRepaymentField(
    raw,
    'repayment_amount',
    'RepaymentAmount',
    'amount',
    'principal_repayment_amount'
  )

  return {
    repaymentId: String(repaymentId),
    loanId: String(loanId),
    branchId: loan.branchId != null ? String(loan.branchId) : null,
    branchName: loan.branchName || null,
    amount: amount != null ? Number(amount) : null,
    principalAmount: (() => {
      const v = pickRepaymentField(raw, 'principal_repayment_amount', 'PrincipalRepaymentAmount')
      return v != null ? Number(v) : null
    })(),
    interestAmount: (() => {
      const v = pickRepaymentField(raw, 'interest_repayment_amount', 'InterestRepaymentAmount')
      return v != null ? Number(v) : null
    })(),
    feesAmount: (() => {
      const v = pickRepaymentField(raw, 'fees_repayment_amount', 'FeesRepaymentAmount')
      return v != null ? Number(v) : null
    })(),
    penaltyAmount: (() => {
      const v = pickRepaymentField(raw, 'penalty_repayment_amount', 'PenaltyRepaymentAmount')
      return v != null ? Number(v) : null
    })(),
    method: pickRepaymentField(
      raw,
      'loan_repayment_method_id',
      'repayment_method_id',
      'RepaymentMethodId',
      'method'
    ),
    collectorId: pickRepaymentField(raw, 'collector_id', 'CollectorId'),
    collectedDate: collected != null ? String(collected).slice(0, 50) : null,
    systemDate: pickRepaymentField(raw, 'loandisk_system_date', 'LoandiskSystemDate'),
    description: pickRepaymentField(raw, 'repayment_description', 'RepaymentDescription', 'repayment_reference'),
  }
}

/**
 * Bulk-pull repayments for a branch via advanced_search_repayments (docs §26)
 * and MERGE into dbo.SILLoanRepayments. Replaces per-loan repayment/loan/{id}
 * (thousands of calls → ~ceil(N/500) pages).
 */
async function syncRepaymentsToSqlServer(loanRecords, onProgress) {
  if (!loanRecords?.length) return { loans: 0, repayments: 0 }
  if (!config.loandisk?.publicKey || !config.loandisk?.authToken) {
    console.warn('[LoanSync] Skipping SILLoanRepayments push — LoanDisk direct API keys missing')
    return { loans: 0, repayments: 0 }
  }
  if (process.env.RESYNC_SKIP_REPAYMENTS === 'true') {
    console.warn('[LoanSync] Skipping SILLoanRepayments — RESYNC_SKIP_REPAYMENTS=true')
    return { loans: 0, repayments: 0 }
  }

  const byBranch = new Map()
  for (const loan of loanRecords) {
    const branchId = loan.branchId != null ? String(loan.branchId) : null
    if (!branchId) continue
    if (!byBranch.has(branchId)) {
      byBranch.set(branchId, {
        branchId,
        branchName: loan.branchName || null,
        loanById: new Map(),
      })
    }
    const entry = byBranch.get(branchId)
    if (!entry.branchName && loan.branchName) entry.branchName = loan.branchName
    const lid = loan.loanId != null ? String(loan.loanId) : null
    if (lid) entry.loanById.set(lid, loan)
  }

  const statusIds = config.loandisk?.sync?.statusIds || [18, 1]
  let upserted = 0
  let loanFailures = 0

  for (const { branchId, branchName, loanById } of byBranch.values()) {
    if (_cancelled) throw new Error('Synchronization cancelled by user')
    onProgress?.({
      phase: 'repayments',
      branch: branchName,
      branchId,
      loansTotal: loanById.size,
    })

    let rawRows = []
    try {
      rawRows = await fetchBranchRepaymentsBulk(branchId, {
        statusIds,
        pageSize: 500,
        pageConcurrency: Math.max(1, config.loandisk?.sync?.pageConcurrency || 3),
        onProgress: (p) =>
          onProgress?.({
            ...p,
            phase: 'repayments',
            branch: branchName,
            branchId,
            repaymentBuffer: p.count,
          }),
      })
    } catch (err) {
      loanFailures++
      console.warn(`[LoanSync] Bulk repayments for branch ${branchName || branchId}:`, err.message)
      continue
    }

    const repaymentRows = []
    for (const row of rawRows) {
      const loanId = row?.loan_id != null ? String(row.loan_id) : null
      const loan = (loanId && loanById.get(loanId)) || {
        loanId,
        branchId,
        branchName: branchName || row?.branch_name || null,
      }
      const mapped = normalizeRepaymentRow(row, loan)
      if (mapped) repaymentRows.push(mapped)
    }

    const CHUNK = 500
    for (let i = 0; i < repaymentRows.length; i += CHUNK) {
      if (_cancelled) throw new Error('Synchronization cancelled by user')
      const part = repaymentRows.slice(i, i + CHUNK)
      const result = await bulkUpsertSilLoanRepayments(part)
      upserted += result.upserted
    }

    onProgress?.({
      phase: 'repayments-saved',
      branch: branchName,
      branchId,
      repaymentsSaved: repaymentRows.length,
      totalRepayments: upserted,
    })
  }

  return { loans: loanRecords.length, repayments: upserted, loanFailures }
}

/** Mutable fingerprint maps shared for the current sync run. */
let _fpMaps = null
function fingerprintsTouch(id, loanNumber, fp) {
  if (!_fpMaps) return
  if (id) _fpMaps.byId.set(id, fp)
  if (loanNumber) _fpMaps.byNumber.set(loanNumber, fp)
}

function resolveMode({ forceFull, lastSuccessfulAt, localCount }) {
  if (forceFull) return 'full'
  if (!lastSuccessfulAt) return 'full'
  if (loansAreStale(lastSuccessfulAt)) return 'full'
  if (!localCount || localCount < 50) return 'full'
  return 'delta'
}

async function performLoanSync(onProgress, { mode, resume }) {
  const startedAt = Date.now()
  const statusIds = config.loandisk?.sync?.statusIds || [18, 1]

  const assertNotCancelled = () => {
    if (_cancelled) throw new Error('Synchronization cancelled by user')
  }

  _fpMaps = loadExistingLoanFingerprints()
  const fingerprints = _fpMaps

  onProgress({
    phase: 'fetching-loans',
    statusIds,
    mode,
    percent: 5,
    localLoans: fingerprints.count,
    resumedBranches: resume?.completedBranchIds?.length || 0,
  })
  assertNotCancelled()

  let totalSaved = 0
  let totalSkipped = 0
  let totalInserted = 0
  let totalUpdated = 0
  let totalRepayments = 0
  let latestCompletedBranchIds = [...(resume?.completedBranchIds || [])]

  // Serialize DB writes when branches run in parallel.
  let saveQueue = Promise.resolve()
  const enqueueSave = (fn) => {
    const run = saveQueue.then(fn, fn)
    saveQueue = run.catch(() => {})
    return run
  }

  const {
    records,
    errors: fetchErrors,
    completedBranchIds,
    activeCount = 0,
    currentCount = 0,
    totalCount = 0,
    counts = {},
  } = await fetchAllLoansByStatus(
    statusIds,
    (p) => {
      if (_cancelled) return
      if (p.completedBranchIds) latestCompletedBranchIds = p.completedBranchIds
      if (p.phase === 'batch-done' && p.completedBranchIds) {
        writeLoanRefresh({
          resume: { mode, completedBranchIds: p.completedBranchIds },
        })
      }
      onProgress(p)
    },
    async ({ branch, batchIndex, totalBatches, records: batchRecords, hadErrors }) => {
      assertNotCancelled()
      await enqueueSave(async () => {
        assertNotCancelled()
        const { toSave, skipped, inserted, updated } = filterChangedRecords(
          batchRecords,
          fingerprints,
          mode
        )
        totalSkipped += skipped
        totalInserted += inserted
        totalUpdated += updated

        if (toSave.length > 0) {
          await saveLoansBatch(toSave)
          totalSaved += toSave.length
        }

        // ── Stale-loan cleanup ────────────────────────────────────────────────
        // Mark loans in this branch that are no longer returned by LoanDisk's
        // Active/Current queries as 'inactive'. This prevents paid-off or
        // status-changed loans from lingering forever with stale labels.
        // batchRecords = ALL loans fetched from LoanDisk for this branch (both
        // Active + Current combined) — it's the authoritative current state.
        //
        // IMPORTANT: Skip cleanup if any page fetch failed for this branch.
        // Running on partial data would incorrectly mark missing loans inactive.
        if (batchRecords.length > 0 && branch.id && !hadErrors) {
          const currentNums = batchRecords.map((r) => r.loanNumber).filter(Boolean)
          try {
            const { deactivated } = await markStaleLoansInBranch(branch.id, currentNums)
            if (deactivated > 0) {
              console.log(
                `[LoanSync] Marked ${deactivated} stale loans inactive for branch ${branch.name} (${branch.id})`
              )
              onProgress({
                phase: 'stale-cleaned',
                branch: branch.name,
                deactivated,
                batch: batchIndex,
                totalBatches,
              })
            }
          } catch (cleanupErr) {
            // Non-fatal: just log. Data integrity is not at risk — the match
            // engine still works; stale loans simply won't match any credits.
            console.warn(
              `[LoanSync] Stale-loan cleanup failed for branch ${branch.name}:`,
              cleanupErr.message
            )
          }
        } else if (hadErrors) {
          console.warn(
            `[LoanSync] Skipping stale-loan cleanup for branch ${branch.name} — fetch was incomplete (page errors). Re-run sync to retry.`
          )
        }
        onProgress({
          phase: 'batch-saved',
          branch: branch.name,
          batch: batchIndex,
          totalBatches,
          savedThisBatch: toSave.length,
          skippedUnchanged: skipped,
          totalSaved,
          totalSkipped,
          totalInserted,
          totalUpdated,
          mode,
          percent: Math.min(90, Math.round((batchIndex / totalBatches) * 80) + 5),
        })

        // Push repayment history into SILLoanRepayments (SQL Server).
        // Staging_LoandiskDueRecords only holds loan master data — repayments live here.
        if (batchRecords.length > 0) {
          onProgress({
            phase: 'repayments',
            branch: branch.name,
            batch: batchIndex,
            totalBatches,
            percent: Math.min(95, Math.round((batchIndex / totalBatches) * 80) + 10),
          })
          const repay = await syncRepaymentsToSqlServer(batchRecords, onProgress)
          totalRepayments += repay.repayments || 0
          onProgress({
            phase: 'repayments-saved',
            branch: branch.name,
            batch: batchIndex,
            totalBatches,
            repaymentsSaved: repay.repayments,
            totalRepayments,
            percent: Math.min(96, Math.round((batchIndex / totalBatches) * 90) + 5),
          })
        }
      })
    },
    { resume, mode }
  )

  assertNotCancelled()

  // If we fetched nothing but already had local data and this was a resumed/partial failure set:
  if (!records.length && fetchErrors?.length && fingerprints.count === 0) {
    throw new Error(`Loan download failed: ${fetchErrors.map((e) => `${e.branch}: ${e.error}`).join('; ')}`)
  }
  if (!records.length && fingerprints.count === 0) {
    throw new Error('LoanDisk returned no active loans for the configured branches. Previous loan data retained.')
  }

  // Successful completion clears resume only when every branch finished.
  const incomplete = (fetchErrors?.length || 0) > 0
  if (!incomplete) writeLoanRefresh({ resume: null })
  else {
    writeLoanRefresh({
      resume: { mode, completedBranchIds: completedBranchIds || latestCompletedBranchIds },
    })
  }

  onProgress({
    phase: incomplete ? 'partial' : 'done',
    count: records.length || fingerprints.count,
    totalSaved,
    totalSkipped,
    totalInserted,
    totalUpdated,
    totalRepayments,
    mode,
    percent: incomplete ? 90 : 100,
    branchErrors: fetchErrors,
  })

  return {
    success: !incomplete,
    partial: incomplete,
    strategy: mode === 'delta' ? 'delta_upsert' : 'full_upsert',
    mode,
    statusIds,
    loansFetched: records.length,
    loansSaved: totalSaved,
    loansSkippedUnchanged: totalSkipped,
    loansInserted: totalInserted,
    loansUpdated: totalUpdated,
    repaymentsSaved: totalRepayments,
    activeCount: activeCount || counts.active || 0,
    currentCount: currentCount || counts.current || 0,
    totalCount: totalCount || records.length,
    localLoansBefore: fingerprints.count,
    branchErrors: fetchErrors,
    completedBranchIds: completedBranchIds || latestCompletedBranchIds,
    durationMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
    message: incomplete
      ? `PARTIAL sync: saved ${totalSaved} loans, ${totalRepayments} repayments. Failed branches: ${fetchErrors.map((e) => e.branch).join(', ')}. Retry to resume.`
      : mode === 'delta'
        ? `Delta sync: fetched ${records.length} loans, saved ${totalSaved}, repayments ${totalRepayments}, skipped ${totalSkipped} unchanged.`
        : `Full sync: fetched ${records.length} loans (Active ${activeCount || counts.active || 0} + Current ${currentCount || counts.current || 0}), saved ${totalSaved}, repayments ${totalRepayments}.`,
  }
}

/**
 * @param {function} [onProgress]
 * @param {{ forceFull?: boolean, allowResume?: boolean }} [opts]
 */
export async function runSqlBorrowerLoanSync(onProgress = () => {}, opts = {}) {
  const forceFull = opts.forceFull === true
  const allowResume = opts.allowResume !== false

  const current = readLoanRefresh()
  if (current.status === 'running') {
    const started = Date.parse(current.startedAt || '')
    // Align with hard timeout (15 min) so a long sync isn't double-started.
    if (started && Date.now() - started < 15 * 60_000) {
      throw new Error('Active loan refresh already in progress')
    }
  }

  const fingerprints = loadExistingLoanFingerprints()
  const mode = resolveMode({
    forceFull,
    lastSuccessfulAt: current.lastSuccessfulAt,
    localCount: fingerprints.count,
  })

  let resume = null
  // Resume completed branches even on forceFull — full sync can take hours and
  // the 45–180 min timeout otherwise restarts the same branch forever.
  if (allowResume && current.resume?.completedBranchIds?.length) {
    if (!current.resume.mode || current.resume.mode === mode || forceFull) {
      resume = { completedBranchIds: current.resume.completedBranchIds.map(String) }
    }
  }

  _cancelled = false
  _syncAbortController = new AbortController()
  globalThis.__loanSyncSignal = _syncAbortController.signal

  writeLoanRefresh({
    status: 'running',
    startedAt: new Date().toISOString(),
    error: null,
    progress: {
      phase: 'starting',
      percent: 2,
      mode,
      localLoans: fingerprints.count,
      resumedBranches: resume?.completedBranchIds?.length || 0,
    },
    finishedAt: null,
  })

  // Full Active+Current + per-loan repayments routinely exceeds 45 min on LoanDisk.
  const TIMEOUT_MS = Math.max(
    45 * 60 * 1000,
    Number(process.env.LOANDISK_SYNC_TIMEOUT_MS) || 3 * 60 * 60 * 1000
  )
  const timeoutId = setTimeout(() => {
    if (!_cancelled) {
      // Keep resume checkpoint so the next run continues.
      cancelSqlBorrowerLoanSync(
        'Loan synchronization timed out. Progress was saved — retry to resume remaining branches. Previous loan data remains safe.'
      )
    }
  }, TIMEOUT_MS)

  try {
    const result = await performLoanSync(
      (p) => {
        if (!_cancelled) {
          writeLoanRefresh({ progress: p })
          onProgress(p)
        }
      },
      { mode, resume }
    )

    clearTimeout(timeoutId)
    _syncAbortController = null
    _cancelled = false
    globalThis.__loanSyncSignal = null
    _fpMaps = null

    writeLoanRefresh({
      status: result.partial ? 'completed' : 'completed',
      lastSuccessfulAt: result.partial ? readLoanRefresh().lastSuccessfulAt : new Date().toISOString(),
      lastMode: mode,
      resume: result.partial
        ? { mode, completedBranchIds: (result.completedBranchIds || []).map(String) }
        : null,
      progress: {
        phase: result.partial ? 'partial' : 'done',
        percent: result.partial ? 90 : 100,
        mode,
        totalSaved: result.loansSaved,
        totalSkipped: result.loansSkippedUnchanged,
        totalInserted: result.loansInserted,
        totalUpdated: result.loansUpdated,
        repaymentsSaved: result.repaymentsSaved,
        activeCount: result.activeCount,
        currentCount: result.currentCount,
        totalCount: result.totalCount,
        branchErrors: result.branchErrors,
      },
      error: result.partial ? result.message : null,
      finishedAt: new Date().toISOString(),
      activeCount: result.activeCount,
      currentCount: result.currentCount,
      totalLoans: result.totalCount,
      lastResult: {
        loansFetched: result.loansFetched,
        loansSaved: result.loansSaved,
        loansSkippedUnchanged: result.loansSkippedUnchanged,
        loansInserted: result.loansInserted,
        loansUpdated: result.loansUpdated,
        repaymentsSaved: result.repaymentsSaved,
        activeCount: result.activeCount,
        currentCount: result.currentCount,
        totalCount: result.totalCount,
        durationMs: result.durationMs,
        mode,
        partial: result.partial,
        branchErrors: result.branchErrors,
      },
    })

    return result
  } catch (e) {
    clearTimeout(timeoutId)
    _syncAbortController = null
    globalThis.__loanSyncSignal = null
    _fpMaps = null

    const msg = String(e?.message || e || '')
    const isCancelled = _cancelled || msg.includes('cancelled') || msg.includes('canceled')
    _cancelled = false

    const isTimeout = msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('timed out')

    let userMsg
    if (isCancelled) {
      userMsg = msg.includes('timed out')
        ? msg
        : 'Synchronization was cancelled. Previous loan data is retained. Retry to resume.'
    } else if (isTimeout) {
      userMsg =
        'LoanDisk response timeout interrupted the sync. Progress was saved where possible. Previous loan data remains safe — please retry.'
    } else {
      userMsg = msg || 'Loan synchronization failed'
    }

    const latest = readLoanRefresh()
    if (latest.status !== 'failed') {
      writeLoanRefresh({ status: 'failed', error: userMsg, finishedAt: new Date().toISOString() })
    }

    throw new Error(userMsg)
  }
}

export default runSqlBorrowerLoanSync
