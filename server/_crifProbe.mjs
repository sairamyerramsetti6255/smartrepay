// Smoke test: the rewired stagingDb functions over the HTTP CRIF client
import {
  getDocuments,
  getBankTransactions,
  getSqlMatchResults,
  getStagingCounts,
  getActiveLoans,
} from './stagingDb.js'

const docs = await getDocuments()
console.log('getDocuments         ->', docs.length, 'files', docs[0]?.filename ?? '')

const bt = await getBankTransactions()
console.log('getBankTransactions  ->', bt.length, 'rows')

const { transactions, counts } = await getSqlMatchResults()
console.log('getSqlMatchResults   ->', transactions.length, 'tx', JSON.stringify(counts))

const counts2 = await getStagingCounts()
console.log('getStagingCounts     ->', JSON.stringify(counts2))

const loans = await getActiveLoans({ limit: 5 })
console.log('getActiveLoans       ->', loans.length, '(0 until SQL condition applied)')
