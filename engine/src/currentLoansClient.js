import { config } from './config.js'
import { branchUrl, loandiskRequest } from './httpClient.js'
import { mapWithConcurrency } from './concurrency.js'

function getSyncSignal() {
  try {
    return globalThis.__loanSyncSignal ?? null
  } catch {
    return null
  }
}

/**
 * Fast loan export — LoanDisk API Advanced Search Loans (status filter).
 *
 *   loan_status_id: 18  -> "Current" loans
 *   loan_status_id: 1   -> "Active"  (open) loans
 *   Combined as "18||1" per LoanDisk docs §16 (one call series per branch).
 *
 * Speed notes:
 *  - Large pages (default 500) cut round-trips against a slow API.
 *  - Pages within a branch run with bounded concurrency.
 *  - Branches can run with bounded concurrency.
 *  - Progress fires as each page completes (not only after the whole branch).
 *  - Resume skips already-completed branch ids.
 */

// 2 attempts (1 automatic retry) per page before treating it as a hard failure.
// Previously this was 1 (= 0 retries), which caused a single transient timeout to
// abort the entire branch+status fetch.
const PAGE_RETRIES = 2
const MAX_PAGES = 200

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pageSize() {
  return config.loandisk?.sync?.searchPageSize || 500
}

function pageConcurrency() {
  return config.loandisk?.sync?.pageConcurrency || 2
}

function branchConcurrency() {
  return config.loandisk?.sync?.branchConcurrency || 2
}

function isRateLimit(err) {
  return err?.loandiskCode === 19 || /limit per hour/i.test(err?.message || '')
}

function isUserCancel(err) {
  return Boolean(getSyncSignal()?.aborted) || /cancelled by user/i.test(err?.message || '')
}

const STATUS_LABELS = {
  1: 'active',
  18: 'current',
}

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

function getResponseNode(payload) {
  return payload?.response ?? payload?.Response ?? null
}

function flattenResults(responseNode) {
  const results = responseNode?.Results ?? responseNode?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((inner) => asArray(inner)).filter((row) => row && typeof row === 'object')
}

function getTotalResults(responseNode) {
  const total = responseNode?.TotalResults ?? responseNode?.totalResults
  return Number(total) || 0
}

function toNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const n = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function pick(row, ...keys) {
  for (const key of keys) {
    const v = row?.[key]
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return null
}

function borrowerFullName(row) {
  const first = pick(row, 'borrower_firstname', 'BorrowerFirstName')
  const last = pick(row, 'borrower_lastname', 'BorrowerLastName')
  const business = pick(row, 'borrower_business_name', 'BorrowerBusinessName')
  const combined = [first, last].filter(Boolean).join(' ').trim()
  if (combined) return combined
  if (business) return String(business).trim()
  const borrowerId = pick(row, 'borrower_id', 'BorrowerId')
  return borrowerId != null ? `Borrower ${borrowerId}` : null
}

function expectedEmi(row) {
  const direct = toNumber(pick(row, 'amortization', 'override_each_repayment_amount', 'first_repayment_amount'))
  if (direct != null && direct > 0) return direct
  const totalDue = toNumber(pick(row, 'total_amount_due'))
  const count = toNumber(pick(row, 'loan_num_of_repayments'))
  if (totalDue != null && count != null && count > 0) {
    return Math.round((totalDue / count) * 100) / 100
  }
  return null
}

/** Map an advanced_search_loans row into the staging record shape. */
export function mapLoanRecord(row, branch, defaultStatus = 'active') {
  const loanId = pick(row, 'loan_id', 'LoanId')
  if (!loanId) return null

  const loanNumber = String(loanId)
  const loanApplicationId = pick(row, 'loan_application_id', 'loan_number', 'loan_unique_number')

  const rawStatusId = Number(pick(row, 'loan_status_id', 'LoanStatusId'))
  const statusLabel = STATUS_LABELS[rawStatusId] || (rawStatusId === 18 ? 'current' : defaultStatus)

  return {
    loanId: String(loanId),
    // LoanNumber must be LoanDisk loan_id — SILLoanRepayments.LoanId and the
    // repayment/loan/{id} API both use loan_id, not loan_application_id.
    loanNumber,
    loanApplicationId: loanApplicationId != null ? String(loanApplicationId) : null,
    borrowerId: pick(row, 'borrower_id', 'BorrowerId') != null ? String(row.borrower_id) : null,
    borrowerFullName: borrowerFullName(row),
    borrowerEmail: pick(row, 'borrower_email', 'BorrowerEmail'),
    borrowerPhone: pick(row, 'borrower_mobile', 'BorrowerMobile'),
    expectedEmiAmount: expectedEmi(row),
    principalAmount: toNumber(pick(row, 'loan_principal_amount')),
    totalLoanAmount: toNumber(pick(row, 'loan_principal_amount')),
    interestAmount: toNumber(pick(row, 'loan_interest_amount')),
    interestRate: toNumber(pick(row, 'loan_interest')),
    totalDue: toNumber(pick(row, 'total_amount_due')),
    totalPaid: toNumber(pick(row, 'total_paid')),
    loanBalanceAmount: toNumber(pick(row, 'balance_amount', 'loan_balance')),
    emiLastPaidDate: null,
    loanStatus: statusLabel,
    branchId: branch.id,
    branchName: branch.name,
  }
}

/** Stable fingerprint used to skip unchanged DB upserts in delta mode. */
export function loanFingerprint(rec) {
  const bal = rec?.loanBalanceAmount ?? rec?.totalDue ?? ''
  const emi = rec?.expectedEmiAmount ?? ''
  const status = rec?.loanStatus ?? ''
  const name = rec?.borrowerFullName ?? ''
  return `${bal}|${emi}|${status}|${name}`
}

async function fetchPage(branch, statusParam, page) {
  const signal = getSyncSignal()
  if (signal?.aborted) throw new DOMException('Sync cancelled by user', 'AbortError')

  const size = pageSize()
  const url = branchUrl(branch.id, 'advanced_search_loans')
  const payload = { from: page, count: size, loan_status_id: statusParam }
  const timeoutMs = config.loandisk?.sync?.searchTimeoutMs || 60_000

  const data = await loandiskRequest(url, {
    method: 'POST',
    body: payload,
    timeoutMs,
    maxRetries: 0,  // No HTTP-level retries; fetchPageWithRetry handles page-level retries
    signal,
  })
  const responseNode = getResponseNode(data)
  const rows = flattenResults(responseNode)
    .map((row) => mapLoanRecord(row, branch))
    .filter(Boolean)
  return { rows, total: getTotalResults(responseNode), returnResults: rows.length }
}

async function fetchPageWithRetry(branch, statusParam, page) {
  let lastError
  for (let attempt = 0; attempt < PAGE_RETRIES; attempt++) {
    try {
      return await fetchPage(branch, statusParam, page)
    } catch (err) {
      // User cancel only — request timeouts also surface as AbortError.
      if (isUserCancel(err)) throw err
      if (err.name === 'AbortError' && getSyncSignal()?.aborted) throw err

      lastError = err
      if (isRateLimit(err)) {
        await sleep(10_000)
        continue
      }
      if (attempt < PAGE_RETRIES - 1) await sleep(1000 * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Fetch all loans for a branch matching statusParam (e.g. "18||1").
 * Pages until a short/empty page (TotalResults is only used for progress estimate).
 */
async function fetchBranchLoans(branch, statusParam, onProgress) {
  const signal = getSyncSignal()
  if (signal?.aborted) throw new DOMException('Sync cancelled by user', 'AbortError')

  const size = pageSize()
  const concurrency = pageConcurrency()

  let hadPageErrors = false   // ← set true if any page fails; stale cleanup must be skipped

  const page1 = await fetchPageWithRetry(branch, statusParam, 1)
  const all = [...page1.rows]
  const seen = new Set(page1.rows.map((r) => r.loanId))

  const claimedTotal = page1.total
  let estimatedPages = Math.max(1, Math.ceil((claimedTotal || page1.rows.length) / size))
  estimatedPages = Math.min(MAX_PAGES, estimatedPages)

  let pagesDone = 1
  onProgress?.({
    phase: 'branch-page',
    branch: branch.name,
    page: 1,
    totalPages: estimatedPages,
    pagesDone,
    count: all.length,
    claimedTotal,
  })

  if (page1.rows.length < size) {
    onProgress?.({ phase: 'branch-done', branch: branch.name, count: all.length, pagesDone })
    return { rows: all, hadPageErrors: false }
  }

  let nextPage = 2
  let hitShortPage = false

  while (nextPage <= MAX_PAGES && !hitShortPage) {
    if (getSyncSignal()?.aborted) throw new DOMException('Sync cancelled by user', 'AbortError')

    const wave = []
    for (let i = 0; i < concurrency && nextPage + i <= MAX_PAGES; i++) {
      wave.push(nextPage + i)
    }
    // Stretch estimate if API keeps returning full pages past claimed total.
    if (nextPage + wave.length - 1 > estimatedPages) {
      estimatedPages = Math.min(MAX_PAGES, nextPage + wave.length - 1 + 2)
    }

    const pageResults = await mapWithConcurrency(wave, concurrency, async (pageNumber) => {
      if (getSyncSignal()?.aborted) throw new DOMException('Sync cancelled by user', 'AbortError')
      const res = await fetchPageWithRetry(branch, statusParam, pageNumber)
      return { pageNumber, rows: res.rows }
    }, (completedInWave) => {
      onProgress?.({
        phase: 'branch-page',
        branch: branch.name,
        page: nextPage + completedInWave - 1,
        totalPages: estimatedPages,
        pagesDone: pagesDone + completedInWave,
        count: all.length,
        claimedTotal,
      })
    })

    // Apply results in page order for stable progress/count.
    const ordered = pageResults
      .filter((r) => r.ok)
      .map((r) => r.value)
      .sort((a, b) => a.pageNumber - b.pageNumber)

    for (const failed of pageResults.filter((r) => !r.ok)) {
      if (isUserCancel(failed.error) || (failed.error?.name === 'AbortError' && getSyncSignal()?.aborted)) {
        throw new DOMException('Sync cancelled by user', 'AbortError')
      }
      // Mark this branch as having incomplete data — stale cleanup must be skipped
      hadPageErrors = true
      console.warn(`[LoanSync] Warning fetching branch ${branch.name} page:`, failed.error?.message)
    }

    for (const { pageNumber, rows } of ordered) {
      pagesDone++
      for (const rec of rows) {
        if (!seen.has(rec.loanId)) {
          seen.add(rec.loanId)
          all.push(rec)
        }
      }
      onProgress?.({
        phase: 'branch-page',
        branch: branch.name,
        page: pageNumber,
        totalPages: estimatedPages,
        pagesDone,
        count: all.length,
        claimedTotal,
      })
      if (rows.length < size) hitShortPage = true
    }

    nextPage += wave.length
    if (ordered.length === 0) break
  }

  onProgress?.({ phase: 'branch-done', branch: branch.name, count: all.length, pagesDone })
  return { rows: all, hadPageErrors }
}

/**
 * Fetch Active+Current loans across branches.
 *
 * Important: LoanDisk's combined filter `18||1` returns the same TotalResults as
 * Active alone — Current loans are NOT included via OR. So we fetch each status
 * id separately per branch and de-dupe by loan id / loan number.
 *
 * @param {number[]} statusIds
 * @param {function} onProgress
 * @param {function|null} onBatch  called after each branch with new records
 * @param {{ resume?: { completedBranchIds?: Array<string|number> } }} [options]
 */
export async function fetchAllLoansByStatus(statusIds, onProgress, onBatch = null, options = {}) {
  const branches = config.loandisk.branches
  const statuses = (Array.isArray(statusIds) ? statusIds : [statusIds]).filter((n) => Number.isFinite(Number(n)))
  const statusList = statuses.length ? statuses.map(Number) : [18, 1]
  const statusParam = statusList.join('+')
  const completedSet = new Set((options.resume?.completedBranchIds || []).map(String))
  const pending = branches.filter((b) => !completedSet.has(String(b.id)))
  const totalBranches = branches.length
  const alreadyDone = totalBranches - pending.length

  const seen = new Set()
  const records = []
  const counts = {}
  const errors = []
  const completedBranchIds = [...completedSet]
  let branchesFinished = alreadyDone

  // Global page counters for more honest % (updated as pages complete).
  let pagesCompleted = 0
  let pagesEstimated = Math.max(1, pending.length * 4)

  const emitOverall = (extra = {}) => {
    const pageRatio = Math.min(1, pagesCompleted / Math.max(1, pagesEstimated))
    const branchRatio = branchesFinished / Math.max(1, totalBranches)
    // Weight page progress heavily — LoanDisk takes ~50–60s/page, so without this
    // the UI sits on 5% for many minutes during the first branch.
    const percent = Math.min(
      88,
      Math.max(3, Math.round(branchRatio * 55 + pageRatio * 40))
    )
    onProgress?.({
      phase: extra.phase || 'fetching-loans',
      statusId: statusParam,
      totalBatches: totalBranches,
      batch: Math.min(totalBranches, branchesFinished + 1),
      percent,
      count: records.length,
      pagesCompleted,
      pagesEstimated,
      mode: options.mode || 'full',
      activeCount: counts.active || 0,
      currentCount: counts.current || 0,
      totalCount: records.length,
      ...extra,
    })
  }

  emitOverall({ phase: 'fetching-loans', resumedBranches: alreadyDone })

  const branchResults = await mapWithConcurrency(pending, branchConcurrency(), async (branch) => {
    if (getSyncSignal()?.aborted) throw new DOMException('Sync cancelled by user', 'AbortError')

    onProgress?.({
      phase: 'branch-starting',
      branch: branch.name,
      statusId: statusParam,
      batch: branchesFinished + 1,
      totalBatches: totalBranches,
      percent: Math.min(88, Math.round((branchesFinished / totalBranches) * 70) + 5),
      count: records.length,
      mode: options.mode || 'full',
    })

    try {
      const branchRows = []
      const statusFetchErrors = []
      for (const st of statusList) {
        const statusId = String(st)
        const label = STATUS_LABELS[statusId] || statusId
        try {
          const { rows, hadPageErrors: statusHadErrors } = await fetchBranchLoans(branch, statusId, (p) => {
            emitOverall({
              ...p,
              branch: branch.name,
              statusLabel: label,
              statusId,
              batch: branchesFinished + 1,
              totalBatches: totalBranches,
            })
          })
          branchRows.push(...rows)
          if (statusHadErrors) statusFetchErrors.push({ statusId, label, error: 'partial page failures' })
        } catch (statusErr) {
          if (isUserCancel(statusErr) || (statusErr?.name === 'AbortError' && getSyncSignal()?.aborted)) {
            throw statusErr
          }
          console.error(
            `[LoanSync] Status ${statusId} (${label}) fetch failed for branch ${branch.name}:`,
            statusErr.message
          )
          statusFetchErrors.push({ statusId, label, error: statusErr.message })
          emitOverall({
            phase: 'status-error',
            branch: branch.name,
            statusLabel: label,
            statusId,
            statusError: statusErr.message,
            batch: branchesFinished + 1,
            totalBatches: totalBranches,
          })
        }
      }

      // If the combined status fetch failed with no rows, treat the branch as failed.
      if (statusFetchErrors.length > 0 && branchRows.length === 0) {
        throw new Error(
          `All status fetches failed: ${statusFetchErrors.map((e) => `${e.label}: ${e.error}`).join('; ')}`
        )
      }

      const batchNew = []
      for (const rec of branchRows) {
        const key = rec.loanId || rec.loanNumber || `${rec.branchId}:${rec.loanNumber}`
        if (seen.has(key)) continue
        seen.add(key)
        records.push(rec)
        batchNew.push(rec)
        counts[rec.loanStatus] = (counts[rec.loanStatus] || 0) + 1
      }

      if (onBatch && batchNew.length > 0) {
        await onBatch({
          branch,
          statusId: statusParam,
          batchIndex: branchesFinished + 1,
          totalBatches: totalBranches,
          records: batchNew,
          totalCount: records.length,
          hadErrors: statusFetchErrors.length > 0,   // ← signals stale cleanup must be skipped
        })
      }

      completedBranchIds.push(String(branch.id))
      branchesFinished++
      emitOverall({
        phase: 'batch-done',
        branch: branch.name,
        statusId: statusParam,
        completedBranchIds: [...completedBranchIds],
        count: records.length,
      })
      return { branchId: branch.id, count: batchNew.length }
    } catch (err) {
      if (isUserCancel(err) || (err.name === 'AbortError' && getSyncSignal()?.aborted)) {
        throw err
      }
      console.error(`[LoanSync] Failed branch ${branch.name}:`, err.message)
      errors.push({ branch: branch.name, error: err.message })
      branchesFinished++
      return { branchId: branch.id, error: err.message }
    }
  }, () => {
    emitOverall({ phase: 'fetching-loans' })
  })

  for (const res of branchResults) {
    if (!res.ok && (isUserCancel(res.error) || res.error?.name === 'AbortError')) {
      console.log('[LoanSync] Cancelled by user, stopping.')
      throw res.error?.name === 'AbortError'
        ? res.error
        : new DOMException('Sync cancelled by user', 'AbortError')
    }
  }

  if (getSyncSignal()?.aborted) {
    throw new DOMException('Sync cancelled by user', 'AbortError')
  }

  return {
    records,
    errors,
    counts,
    completedBranchIds,
    activeCount: counts.active || 0,
    currentCount: counts.current || 0,
    totalCount: records.length,
  }
}

/**
 * Live LoanDisk totals: Active (1) + Current (18) per branch, then summed.
 * Uses count=1 pages so we only read TotalResults (fast-ish vs full sync).
 */
export async function countActiveAndCurrentLoans() {
  const branches = config.loandisk.branches || []
  let active = 0
  let current = 0
  const byBranch = []

  for (const branch of branches) {
    const url = branchUrl(branch.id, 'advanced_search_loans')
    const [activeRes, currentRes] = await Promise.all([
      loandiskRequest(url, {
        method: 'POST',
        body: { from: 1, count: 1, loan_status_id: '1' },
        timeoutMs: config.loandisk?.sync?.searchTimeoutMs || 60_000,
        maxRetries: 0,
      }).catch(() => null),
      loandiskRequest(url, {
        method: 'POST',
        body: { from: 1, count: 1, loan_status_id: '18' },
        timeoutMs: config.loandisk?.sync?.searchTimeoutMs || 60_000,
        maxRetries: 0,
      }).catch(() => null),
    ])
    const a = getTotalResults(getResponseNode(activeRes))
    const c = getTotalResults(getResponseNode(currentRes))
    active += a
    current += c
    byBranch.push({ branch: branch.name, branchId: branch.id, active: a, current: c, total: a + c })
  }

  return { active, current, total: active + current, byBranch }
}
