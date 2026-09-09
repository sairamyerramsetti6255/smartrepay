import { config } from './config.js'
import { branchUrl, loandiskRequest } from './httpClient.js'
import { mapWithConcurrency } from './concurrency.js'

/**
 * LoanDisk API client — the network layer extracted from manager.cs.
 *
 * Optimisations vs. the original C#:
 *  - All branches are fetched concurrently (kept from the original).
 *  - Borrower search supports parallel pagination (repay.md goal #2).
 *  - A single shared keep-alive HTTP client is reused everywhere.
 */

const SEARCH_PAGE_SIZE = 500

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

/** Pull the nested response node regardless of casing the gateway returns. */
function getResponseNode(payload) {
  return payload?.response ?? payload?.Response ?? null
}

/** Flatten the multi-dimensional Results array (response -> Results -> [[...]]). */
function flattenResults(responseNode) {
  const results = responseNode?.Results ?? responseNode?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((inner) => asArray(inner)).filter((row) => row && typeof row === 'object')
}

function getTotalResults(responseNode) {
  const total = responseNode?.TotalResults ?? responseNode?.totalResults
  return Number(total) || 0
}

/**
 * Fetch a single page of borrowers for a branch via advanced_search_borrowers.
 * Returns { rows, total }.
 */
async function fetchBorrowerPage(branch, from) {
  const url = branchUrl(branch.id, 'advanced_search_borrowers')
  const payload = { from, count: SEARCH_PAGE_SIZE }
  const data = await loandiskRequest(url, { method: 'POST', body: payload })
  const responseNode = getResponseNode(data)
  const rows = flattenResults(responseNode).map((row) => ({
    ...row,
    branchId: branch.id,
    branchName: branch.name,
  }))
  return { rows, total: getTotalResults(responseNode) }
}

/**
 * Fetch every borrower for one branch. Page 1 is fetched first to learn the
 * total count, then the remaining pages are fetched in parallel
 * (repay.md optimisation #2: parallel pagination).
 */
async function fetchBranchBorrowers(branch) {
  const first = await fetchBorrowerPage(branch, 1)
  const all = [...first.rows]

  const totalPages = Math.max(1, Math.ceil(first.total / SEARCH_PAGE_SIZE))
  if (totalPages <= 1) return all

  const pageNumbers = []
  for (let p = 2; p <= totalPages; p++) pageNumbers.push(p)

  const pages = await mapWithConcurrency(
    pageNumbers,
    config.performance.borrowerConcurrency,
    (page) => fetchBorrowerPage(branch, page)
  )

  for (const result of pages) {
    if (result.ok) all.push(...result.value.rows)
  }
  return all
}

/**
 * STEP 1 — fetch all borrowers across all configured branches concurrently.
 * Returns a flat, de-duplicated array of borrower rows.
 */
export async function fetchAllBorrowers(onProgress) {
  const branchResults = await mapWithConcurrency(
    config.loandisk.branches,
    config.loandisk.branches.length || 1,
    async (branch) => {
      const rows = await fetchBranchBorrowers(branch)
      onProgress?.({ phase: 'borrowers', branch: branch.name, count: rows.length })
      return rows
    }
  )

  const flat = []
  const errors = []
  for (let i = 0; i < branchResults.length; i++) {
    const result = branchResults[i]
    if (result.ok) flat.push(...result.value)
    else errors.push({ branch: config.loandisk.branches[i]?.name, error: result.error.message })
  }
  return { borrowers: flat, errors }
}

function isEmptyResultsPayload(payload) {
  const responseNode = getResponseNode(payload)
  if (!responseNode) return true
  return flattenResults(responseNode).length === 0
}

/** Parse the active loan_id out of a loan payload (response -> Results[0][0]). */
function parseLoanId(payload) {
  const rows = flattenResults(getResponseNode(payload))
  const loanId = rows[0]?.loan_id ?? rows[0]?.LoanId ?? rows[0]?.loanId
  const parsed = Number(loanId)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * STEP 3 (per borrower) — fetch the newest loan, then its newest repayment.
 * These two calls are dependent so they stay sequential *within* a borrower,
 * but the manager runs many borrowers through this concurrently.
 *
 * Returns { loanJson, repaymentJson, loanId } where the JSON values are the
 * raw stringified payloads expected by the SaveLatestBorrowerLoan SP, or null
 * when the borrower has no loan / no repayment.
 */
export async function fetchLatestLoanAndRepayment(branchId, borrowerId) {
  const loanUrl = branchUrl(
    branchId,
    `loan/borrower/${borrowerId}/from/1/count/1?sort_by=loan_id&sort_direction=desc`
  )
  const loanPayload = await loandiskRequest(loanUrl, { allowEmpty: true })

  if (!loanPayload || isEmptyResultsPayload(loanPayload)) {
    return { loanJson: null, repaymentJson: null, loanId: 0 }
  }

  const loanId = parseLoanId(loanPayload)
  let repaymentJson = null

  if (loanId > 0) {
    const repaymentUrl = branchUrl(
      branchId,
      `repayment/loan/${loanId}/from/1/count/1?sort_by=repayment_id&sort_direction=desc`
    )
    const repaymentPayload = await loandiskRequest(repaymentUrl, { allowEmpty: true })
    if (repaymentPayload && !isEmptyResultsPayload(repaymentPayload)) {
      repaymentJson = JSON.stringify(repaymentPayload)
    }
  }

  return { loanJson: JSON.stringify(loanPayload), repaymentJson, loanId }
}
