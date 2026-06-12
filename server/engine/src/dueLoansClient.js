import { config } from './config.js'
import { branchUrl, loandiskRequest } from './httpClient.js'
import { mapWithConcurrency } from './concurrency.js'

/**
 * due_loans client — optimised replacement for manager.cs's 3-stage pipeline.
 *
 * Two phases:
 *   1. `due_loans` (paginated)  -> WHICH loans are due in the window (+ loan_id).
 *      Note: due_loans amounts are INSTALLMENT-level (its `principal` is the
 *      current installment's principal, not the loan principal).
 *   2. `loan/{loan_id}` (parallel, bounded) -> accurate LOAN-level financials
 *      (loan_principal_amount, total_amount_due, total_paid, balance_amount,
 *      loan_interest, borrower_id) — the same numbers the LoanDisk loan page shows.
 *
 * Still far cheaper than the legacy 1 + 2N sequential calls, and every detail
 * call runs concurrently.
 */

const PAGE_SIZE = 500

const RETURN_FIELDS = [
  'loan_number',
  'full_name',
  'email_address',
  'mobile',
  'amortization_due',
  'principal',
  'loan_balance',
  'last_repayment',
  'loan_status',
].join(',')

// Statuses that mean the loan is no longer collectable — skipped, as in repay.md.
const INACTIVE_STATUSES = new Set(['closed', 'fully paid', 'settled', '2'])

function formatDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}/${dd}/${d.getFullYear()}`
}

function collectionWindow() {
  const today = new Date()
  const from = new Date(today)
  from.setMonth(today.getMonth() - 1)
  const to = new Date(today)
  to.setMonth(today.getMonth() + 1)
  return { from: formatDate(from), to: formatDate(to) }
}

function toNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const n = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

function toDate(value) {
  if (!value || String(value).trim() === '') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** last_repayment arrives as "05/27/2026 <br>353.74" — keep only the date part. */
function parseLastRepaymentDate(value) {
  if (!value) return null
  const datePart = String(value)
    .split(/<br\s*\/?>/i)[0]
    .trim()
  return toDate(datePart)
}

function pick(row, ...keys) {
  for (const key of keys) {
    const v = row?.[key]
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return null
}

function getResponseNode(payload) {
  return payload?.response ?? payload?.Response ?? null
}

/**
 * Flatten the due_loans Results node. The API returns an array whose single
 * element is an object keyed by row number, e.g.
 *   Results: [ { "1": {...}, "2": {...}, "3": {...}, "4": { total: "Total" } } ]
 * (older/other endpoints use the array-of-arrays shape, handled too).
 */
function flattenResults(responseNode) {
  const results = responseNode?.Results ?? responseNode?.results
  if (!Array.isArray(results)) return []

  const rows = []
  for (const entry of results) {
    if (Array.isArray(entry)) {
      for (const r of entry) if (r && typeof r === 'object') rows.push(r)
    } else if (entry && typeof entry === 'object') {
      for (const r of Object.values(entry)) if (r && typeof r === 'object') rows.push(r)
    }
  }
  return rows
}

/** Map a raw due_loans row into the staging record shape (mirrors LocalStagingRecord). */
export function mapDueLoanRecord(row, branch) {
  const loanNumber = pick(row, 'loan_number', 'LoanNumber')
  const loanId = pick(row, 'loan_id', 'LoanId')

  // Skip the per-page totals/summary row ({ total: "Total", principal, interest... }).
  if ((!loanNumber && !loanId) || String(pick(row, 'total') ?? '').toLowerCase() === 'total') {
    return null
  }

  const status = String(pick(row, 'loan_status', 'LoanStatus') ?? '').trim()
  if (INACTIVE_STATUSES.has(status.toLowerCase())) return null

  return {
    loanId: loanId != null ? String(loanId) : null,
    loanNumber: loanNumber ?? (loanId != null ? String(loanId) : null),
    borrowerId: pick(row, 'loan_borrower_id', 'borrower_id') ?? null,
    borrowerFullName: pick(row, 'full_name', 'BorrowerFullName'),
    borrowerEmail: pick(row, 'email_address', 'BorrowerEmail'),
    borrowerPhone: pick(row, 'mobile', 'BorrowerPhone'),
    // Installment due for the period (correct as-is).
    expectedEmiAmount: toNumber(pick(row, 'amortization_due', 'ExpectedEMIAmount')),
    // Loan-level figures: filled in by enrichWithLoanDetails(); due_loans values
    // are only fallbacks if the detail call fails.
    totalLoanAmount: null,
    principalAmount: null,
    interestAmount: null,
    interestRate: null,
    totalDue: null,
    totalPaid: null,
    loanBalanceAmount: toNumber(pick(row, 'loan_balance', 'LoanBalanceAmount')),
    emiLastPaidDate: parseLastRepaymentDate(pick(row, 'last_repayment', 'EMILastPaidDate')),
    loanStatus: status,
    branchId: branch.id,
    branchName: branch.name,
  }
}

/** Extract the single loan object from a loan/{id} or loan/borrower/{id} payload. */
function extractLoanDetail(payload) {
  const node = getResponseNode(payload)
  const results = node?.Results ?? node?.results
  if (!Array.isArray(results)) return null
  for (const entry of results) {
    if (Array.isArray(entry)) {
      const obj = entry.find((x) => x && typeof x === 'object')
      if (obj) return obj
    } else if (entry && typeof entry === 'object') {
      return entry
    }
  }
  return null
}

/** Fetch accurate loan-level financials for one loan via loan/{loan_id}. */
async function fetchLoanDetail(branchId, loanId) {
  const url = branchUrl(branchId, `loan/${loanId}`)
  const data = await loandiskRequest(url, { allowEmpty: true })
  const loan = data && extractLoanDetail(data)
  if (!loan) return null

  return {
    borrowerId: pick(loan, 'borrower_id', 'loan_borrower_id'),
    principalAmount: toNumber(pick(loan, 'loan_principal_amount')),
    interestAmount: toNumber(pick(loan, 'loan_interest_amount')),
    interestRate: toNumber(pick(loan, 'loan_interest')),
    totalDue: toNumber(pick(loan, 'total_amount_due')),
    totalPaid: toNumber(pick(loan, 'total_paid')),
    balanceAmount: toNumber(pick(loan, 'balance_amount')),
  }
}

/**
 * Enrich each due loan with accurate loan-level financials. Detail calls run
 * with bounded concurrency; a failed detail call leaves the due_loans fallbacks.
 */
export async function enrichWithLoanDetails(records, onProgress) {
  const results = await mapWithConcurrency(
    records,
    config.performance.borrowerConcurrency,
    async (rec) => {
      if (!rec.loanId) return rec
      const detail = await fetchLoanDetail(rec.branchId, rec.loanId)
      if (!detail) return rec
      return {
        ...rec,
        borrowerId: rec.borrowerId ?? detail.borrowerId ?? null,
        principalAmount: detail.principalAmount,
        totalLoanAmount: detail.principalAmount, // total loan amount == loan principal
        interestAmount: detail.interestAmount,
        interestRate: detail.interestRate,
        totalDue: detail.totalDue,
        totalPaid: detail.totalPaid,
        loanBalanceAmount: detail.balanceAmount ?? rec.loanBalanceAmount,
      }
    },
    (done, total) => {
      if (done % 25 === 0 || done === total) onProgress?.({ phase: 'loan_details', processed: done, total })
    }
  )

  const enriched = []
  let failures = 0
  for (const r of results) {
    if (r.ok) enriched.push(r.value)
    else failures++
  }
  return { enriched, failures }
}

async function fetchDueLoanPage(branch, from, window) {
  const url = branchUrl(branch.id, 'due_loans')
  const payload = {
    from,
    count: PAGE_SIZE,
    from_collection_date: window.from,
    to_collection_date: window.to,
    return_fields: RETURN_FIELDS,
  }
  const data = await loandiskRequest(url, { method: 'POST', body: payload })
  const responseNode = getResponseNode(data)
  const records = flattenResults(responseNode)
    .map((row) => mapDueLoanRecord(row, branch))
    .filter(Boolean)
  return { records }
}

// Hard safety cap so a misbehaving API can never loop forever.
const MAX_PAGES = 200

/**
 * Fetch every due loan for a branch.
 *
 * The API caps page size server-side and its TotalResults count is unreliable,
 * so we cannot pre-compute the page count. Instead we page sequentially (`from`
 * is a 1-based page number) until a page yields no new records. For due_loans
 * this is only a handful of calls — still vastly fewer than the legacy 1 + 2N.
 */
async function fetchBranchDueLoans(branch, window, onProgress) {
  const all = []
  const seen = new Set()

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { records } = await fetchDueLoanPage(branch, page, window)
    if (!records.length) break

    let added = 0
    for (const rec of records) {
      const key = rec.loanNumber || `${rec.branchId}:${rec.borrowerFullName}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(rec)
      added++
    }

    onProgress?.({ phase: 'due_loans', branch: branch.name, page, count: all.length })

    // Stop on an empty page or when a page repeats already-seen rows
    // (defends against a server that clamps `from` to the last page).
    if (added === 0) break
  }

  return all
}

/** Fetch due loans across all configured branches concurrently. */
export async function fetchAllDueLoans(onProgress) {
  const window = collectionWindow()
  const branchResults = await mapWithConcurrency(
    config.loandisk.branches,
    config.loandisk.branches.length || 1,
    (branch) => fetchBranchDueLoans(branch, window, onProgress)
  )

  const records = []
  const errors = []
  for (let i = 0; i < branchResults.length; i++) {
    const r = branchResults[i]
    if (r.ok) records.push(...r.value)
    else errors.push({ branch: config.loandisk.branches[i]?.name, error: r.error.message })
  }

  // De-dupe by loan number (a loan can appear once per page overlap).
  const seen = new Set()
  const deduped = []
  for (const rec of records) {
    const key = rec.loanNumber || `${rec.branchId}:${rec.borrowerFullName}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(rec)
  }

  return { records: deduped, errors }
}
