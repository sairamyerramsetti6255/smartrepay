/**
 * Incremental Loan Disk → SQL Server sync (append/upsert only).
 * Populates SILBorrowers, SILLoans, SILloanrepayments via existing SPs,
 * and MERGEs Staging_LoandiskDueRecords without TRUNCATE.
 */
import { config } from './engine/src/config.js'
import { fetchAllLoansByStatus } from './engine/src/currentLoansClient.js'
import { fetchLatestLoanAndRepayment } from './engine/src/loandiskClient.js'
import { saveBorrowersToDb, saveLatestLoansBulk, bulkInsertStagingRecords } from './engine/src/dataAccess.js'
import { mapWithConcurrency } from './engine/src/concurrency.js'

function parseStatusIds() {
  const raw = config.loandisk?.sync?.statusIds || process.env.LOANDISK_STATUS_IDS || '18,1'
  return String(raw)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

/** Build SaveBorrowers JSON rows from active/current loan export. */
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

/**
 * Fetch active (1) + current (18) loans, upsert SIL tables + staging.
 * Never truncates or deletes existing SQL rows.
 */
export async function runSqlBorrowerLoanSync(onProgress = () => {}) {
  const startedAt = Date.now()
  const statusIds = parseStatusIds()

  onProgress({ phase: 'fetching-loans', statusIds })
  const { records, errors: fetchErrors, counts } = await fetchAllLoansByStatus(statusIds, onProgress)

  if (!records.length) {
    return {
      success: true,
      strategy: 'advanced_search_loans',
      statusIds,
      loansFetched: 0,
      borrowersSaved: 0,
      loansProcessed: 0,
      stagingUpserted: 0,
      branchErrors: fetchErrors,
      durationMs: Date.now() - startedAt,
      message: `No active/current loans returned for status ids ${statusIds.join(', ')}.`,
    }
  }

  onProgress({ phase: 'staging-merge', count: records.length })
  const { upserted: stagingUpserted, inserted: stagingInserted, updated: stagingUpdated } =
    await bulkInsertStagingRecords(records)

  const borrowers = buildBorrowerRowsFromLoans(records)
  onProgress({ phase: 'borrowers-built', count: borrowers.length })

  let mappingRows = []
  if (borrowers.length) {
    mappingRows = await saveBorrowersToDb(JSON.stringify(borrowers))
    onProgress({ phase: 'borrowers-saved', count: mappingRows.length })
  }

  const loanPayloads = []
  if (mappingRows.length) {
    const results = await mapWithConcurrency(
      mappingRows,
      config.performance.borrowerConcurrency,
      async (row) => {
        const internalId = Number(row.InternalId)
        const branchId = String(row.BranchId)
        const borrowerId = Number(row.BorrowerId)
        const { loanJson, repaymentJson } = await fetchLatestLoanAndRepayment(branchId, borrowerId)
        if (!loanJson) return null
        return { internalId, branchId, borrowerId, loanJson, repaymentJson }
      },
      (done, total) => {
        if (done % 25 === 0 || done === total) {
          onProgress({ phase: 'loans-fetch', processed: done, total })
        }
      }
    )

    for (const result of results) {
      if (result.ok && result.value) loanPayloads.push(result.value)
    }

    onProgress({ phase: 'loans-persist', count: loanPayloads.length })
  }

  const loansProcessed = loanPayloads.length ? await saveLatestLoansBulk(loanPayloads, onProgress) : 0

  return {
    success: true,
    strategy: 'advanced_search_loans',
    statusIds,
    loansFetched: records.length,
    borrowersBuilt: borrowers.length,
    borrowersSaved: mappingRows.length,
    loansProcessed,
    stagingUpserted,
    stagingInserted,
    stagingUpdated,
    counts,
    branchErrors: fetchErrors,
    durationMs: Date.now() - startedAt,
    finishedAt: new Date().toISOString(),
    message: `Synced ${records.length} loans (${borrowers.length} borrowers), ${loansProcessed} loan/repayment rows to SIL, ${stagingUpserted} staging rows merged (${stagingInserted} new, ${stagingUpdated} updated).`,
  }
}

export default runSqlBorrowerLoanSync
