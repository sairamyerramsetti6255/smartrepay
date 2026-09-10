import { getBankTransactions, getLoanDiskDueRecords, getMatchHistory, saveTransactionMatches } from '../src/dataAccess.js'
import { groupLoansByBorrower, buildBorrowerIndex, classify } from '../src/matchingEngine.js'

// --dry-run is read-only. Legacy --no-ai is accepted; models never assign identities.
const dryRun = process.argv.includes('--dry-run')
try {
  const [transactions, loans, history] = await Promise.all([getBankTransactions(), getLoanDiskDueRecords(), getMatchHistory()])
  const protectedIds = new Set(history.filter((r) => (['confirmed', 'rejected'].includes(r.ReviewStatus) || (r.ReviewStatus === 'auto_matched' && r.MatchMethod === 'manual'))).map((r) => String(r.Id)))
  const index = buildBorrowerIndex(groupLoansByBorrower(loans), history)
  const records = transactions.filter((tx) => !protectedIds.has(String(tx.Id))).map((tx) => classify(tx, index).record)
  const counts = records.reduce((out, row) => { out[row.reviewStatus] = (out[row.reviewStatus] || 0) + 1; return out }, {})
  const saved = dryRun ? 0 : await saveTransactionMatches(records)
  console.log(JSON.stringify({ dryRun, evaluated: records.length, saved, preserved: transactions.length - records.length, counts }, null, 2))
} catch (error) {
  console.error('Matching failed:', error.message)
  process.exitCode = 1
}
