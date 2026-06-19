import { config } from './config.js'
import { branchUrl, loandiskRequest } from './httpClient.js'
import { mapWithConcurrency } from './concurrency.js'

/**
 * Fast loan export — LoanDisk API Advanced Search Loans (status filter).
 *
 *   loan_status_id: 18  -> "Current" loans
 *   loan_status_id: 1   -> "Active"  (open) loans
 *
 * One paginated POST per (branch, status) returns full loan + borrower fields,
 * so no per-loan loan/{id} enrichment is needed. Branches and pages are fetched
 * concurrently. The first match wins on de-dupe (status ids are ordered so
 * "current" is preferred over the broader "active" set for the same loan).
 */

// Large pages = fewer requests. LoanDisk enforces an hourly login/rate limit
// (API error 19), so keeping the request count and parallelism low matters more
// than raw speed. TotalResults is unreliable (it over-counts), so we page until
// a page comes back empty rather than trusting it.
const PAGE_SIZE = 1000
const MAX_PAGES = 200
const SEARCH_CONCURRENCY = 3
const PAGE_RETRIES = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isRateLimit(err) {
  return err?.loandiskCode === 19 || /limit per hour/i.test(err?.message || '')
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
export function mapLoanRecord(row, branch, statusLabel) {
  const loanId = pick(row, 'loan_id', 'LoanId')
  if (!loanId) return null

  const loanNumber =
    pick(row, 'loan_application_id', 'loan_number', 'loan_unique_number') ?? String(loanId)

  return {
    loanId: String(loanId),
    loanNumber: String(loanNumber),
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

async function fetchPage(branch, statusId, page) {
  const url = branchUrl(branch.id, 'advanced_search_loans')
  const payload = { from: page, count: PAGE_SIZE, loan_status_id: statusId }
  const data = await loandiskRequest(url, {
    method: 'POST',
    body: payload,
    timeoutMs: config.loandisk.sync.searchTimeoutMs,
  })
  const responseNode = getResponseNode(data)
  const label = STATUS_LABELS[statusId] || String(statusId)
  const rows = flattenResults(responseNode)
    .map((row) => mapLoanRecord(row, branch, label))
    .filter(Boolean)
  return { rows, total: getTotalResults(responseNode) }
}

/** Fetch one page, retrying transient drops and waiting out rate limits. */
async function fetchPageWithRetry(branch, statusId, page) {
  let lastError
  for (let attempt = 0; attempt < PAGE_RETRIES; attempt++) {
    try {
      return await fetchPage(branch, statusId, page)
    } catch (err) {
      lastError = err
      if (isRateLimit(err)) {
        // Hourly login limit — back off hard before retrying.
        await sleep(30_000)
        continue
      }
      await sleep(1_000 * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Fetch every loan of one status for one branch, paging until a page comes back
 * empty (TotalResults is unreliable). De-dupes by loanId within the branch.
 */
async function fetchBranchStatus(branch, statusId, onProgress) {
  const all = []
  const seen = new Set()

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { rows } = await fetchPageWithRetry(branch, statusId, page)
    let added = 0
    for (const rec of rows) {
      if (seen.has(rec.loanId)) continue
      seen.add(rec.loanId)
      all.push(rec)
      added++
    }
    onProgress?.({ phase: 'search', branch: branch.name, statusId, page, count: all.length })
    if (added === 0 || rows.length < PAGE_SIZE) break
  }

  onProgress?.({ phase: 'branch-done', branch: branch.name, statusId, count: all.length })
  return all
}

/**
 * Fetch all loans for the configured status ids across all branches.
 * (branch, status) tasks run with low concurrency; pages within a task are
 * sequential. De-dupes by loan number with the first status id winning
 * (e.g. current over active).
 */
export async function fetchAllLoansByStatus(statusIds, onProgress) {
  const tasks = []
  for (const statusId of statusIds) {
    for (const branch of config.loandisk.branches) tasks.push({ branch, statusId })
  }

  const results = await mapWithConcurrency(tasks, SEARCH_CONCURRENCY, (t) =>
    fetchBranchStatus(t.branch, t.statusId, onProgress)
  )

  const ordered = []
  const errors = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.ok) ordered.push({ statusId: tasks[i].statusId, rows: r.value })
    else errors.push({ branch: tasks[i].branch?.name, statusId: tasks[i].statusId, error: r.error.message })
  }
  ordered.sort((a, b) => statusIds.indexOf(a.statusId) - statusIds.indexOf(b.statusId))

  const seen = new Set()
  const records = []
  const counts = {}
  for (const group of ordered) {
    for (const rec of group.rows) {
      const key = rec.loanNumber || `${rec.branchId}:${rec.loanId}`
      if (seen.has(key)) continue
      seen.add(key)
      records.push(rec)
      counts[rec.loanStatus] = (counts[rec.loanStatus] || 0) + 1
    }
  }

  return { records, errors, counts }
}
