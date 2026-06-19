import { config } from './config.js'
import { fetchAllBorrowers, fetchLatestLoanAndRepayment } from './loandiskClient.js'
import { fetchAllDueLoans, enrichWithLoanDetails } from './dueLoansClient.js'
import { fetchAllLoansByStatus } from './currentLoansClient.js'
import {
  saveBorrowersToDb,
  saveLatestLoansBulk,
  bulkInsertStagingRecords,
  truncateStagingDueRecords,
} from './dataAccess.js'
import { mapWithConcurrency } from './concurrency.js'

/**
 * RECOMMENDED pipeline — single `due_loans` endpoint (repay.md strategy).
 *
 * One paginated, fully-parallel fetch returns everything needed, then the rows
 * are bulk-inserted. This is the fast path; runBorrowerSync below is the legacy
 * 3-stage port kept for compatibility.
 */
/**
 * Full refresh: TRUNCATE Staging_LoandiskDueRecords, then fetch every loan with
 * a configured status (18 = Current, 1 = Active) via advanced_search_loans and
 * bulk-insert them. Branches + pages are fetched concurrently.
 */
export async function runCurrentLoansStagingRefresh(onProgress = () => {}) {
  const startedAt = Date.now()
  const statusIds = config.loandisk.sync.statusIds

  await truncateStagingDueRecords()
  onProgress({ phase: 'truncated' })

  const { records, errors, counts } = await fetchAllLoansByStatus(statusIds, onProgress)
  onProgress({ phase: 'fetched', count: records.length, counts })

  if (!records.length) {
    return {
      success: true,
      strategy: 'advanced_search_loans',
      statusIds,
      recordsFetched: 0,
      recordsSaved: 0,
      counts,
      branchErrors: errors,
      durationMs: Date.now() - startedAt,
      message: `No loans returned from LoanDisk for status ids ${statusIds.join(', ')}.`,
    }
  }

  const { upserted, inserted } = await bulkInsertStagingRecords(records)
  onProgress({ phase: 'staged', count: upserted })

  return {
    success: true,
    strategy: 'advanced_search_loans',
    statusIds,
    recordsFetched: records.length,
    recordsSaved: upserted,
    inserted,
    counts,
    branchErrors: errors,
    durationMs: Date.now() - startedAt,
    message: `Truncated staging, fetched ${records.length} loans (${Object.entries(counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}), inserted ${inserted} rows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
  }
}

export async function runDueLoansSync(onProgress = () => {}) {
  const startedAt = Date.now()

  // Phase 1 — which loans are due (paginated due_loans).
  const { records, errors } = await fetchAllDueLoans(onProgress)
  onProgress({ phase: 'due_loans-fetched', count: records.length })

  if (!records.length) {
    return {
      success: true,
      strategy: 'due_loans',
      recordsFetched: 0,
      recordsSaved: 0,
      branchErrors: errors,
      durationMs: Date.now() - startedAt,
      message: 'No loans were returned by the server within the configured collection window.',
    }
  }

  // Phase 2 — enrich with accurate loan-level financials (loan/{id}).
  const { enriched, failures } = await enrichWithLoanDetails(records, onProgress)
  onProgress({ phase: 'enriched', count: enriched.length, failures })

  // Phase 3 — upsert (MERGE on LoanNumber); never truncates/deletes.
  const { upserted, inserted, updated } = await bulkInsertStagingRecords(enriched)
  onProgress({ phase: 'staged', count: upserted })

  return {
    success: true,
    strategy: 'due_loans',
    recordsFetched: records.length,
    detailsEnriched: enriched.length - failures,
    detailFailures: failures,
    recordsSaved: upserted,
    inserted,
    updated,
    branchErrors: errors,
    durationMs: Date.now() - startedAt,
    message: `Fetched ${records.length} due loans, enriched ${enriched.length - failures} with loan details, upserted ${upserted} rows (${inserted} new, ${updated} updated) in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s.`,
  }
}

/**
 * Orchestration layer — port of manager.cs GetAllBorrowersRawAsync.
 *
 * Pipeline:
 *   STEP 1  fetch all borrowers across branches (concurrent)
 *   STEP 2  bulk-insert borrowers, read back identity keys
 *   STEP 3  fetch latest loan + repayment per borrower (CONCURRENT — the fix)
 *   STEP 4  bulk-persist loan/repayment payloads
 */
export async function runBorrowerSync(onProgress = () => {}) {
  const startedAt = Date.now()

  // STEP 1 — fetch borrowers from every branch in parallel.
  const { borrowers, errors: fetchErrors } = await fetchAllBorrowers(onProgress)
  if (!borrowers.length) {
    return {
      success: true,
      borrowersFetched: 0,
      loansProcessed: 0,
      message: 'No active borrower records were returned by the server filters.',
      branchErrors: fetchErrors,
    }
  }
  onProgress({ phase: 'borrowers-fetched', count: borrowers.length })

  // STEP 2 — bulk persist borrowers and read back the identity mapping rows.
  const mappingRows = await saveBorrowersToDb(JSON.stringify(borrowers))
  if (!mappingRows.length || mappingRows[0].InternalId === undefined) {
    throw new Error('Borrower persistence failed or did not return identity mapping keys (InternalId).')
  }
  onProgress({ phase: 'borrowers-saved', count: mappingRows.length })

  // STEP 3 — fetch latest loan + repayment for every borrower CONCURRENTLY.
  // This replaces the sequential foreach that dominated the original runtime.
  const loanRecords = []
  let processed = 0

  const results = await mapWithConcurrency(
    mappingRows,
    config.performance.borrowerConcurrency,
    async (row) => {
      const internalId = Number(row.InternalId)
      const branchId = String(row.BranchId)
      const borrowerId = Number(row.BorrowerId)

      const { loanJson, repaymentJson, loanId } = await fetchLatestLoanAndRepayment(branchId, borrowerId)
      if (!loanJson) return null

      return { internalId, branchId, borrowerId, loanJson, repaymentJson, loanId }
    },
    (done, total) => {
      processed = done
      if (done % 25 === 0 || done === total) {
        onProgress({ phase: 'loans', processed: done, total })
      }
    }
  )

  const loanErrors = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    if (result.ok) {
      if (result.value) loanRecords.push(result.value)
    } else {
      loanErrors.push({ borrowerId: mappingRows[i]?.BorrowerId, error: result.error.message })
    }
  }

  // STEP 4 — bulk persist the loan/repayment payloads.
  const loansProcessed = await saveLatestLoansBulk(loanRecords, onProgress)

  return {
    success: true,
    borrowersFetched: borrowers.length,
    borrowersSaved: mappingRows.length,
    loansProcessed,
    loanRecords: loanRecords.length,
    branchErrors: fetchErrors,
    loanErrors,
    durationMs: Date.now() - startedAt,
    message: `Synchronized ${borrowers.length} borrowers and updated ${loansProcessed} loan/repayment records in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s.`,
  }
}
