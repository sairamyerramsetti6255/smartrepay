/**
 * Truncate Staging_LoandiskDueRecords and reload loans from LoanDisk
 * advanced_search_loans for the configured statuses (18 = Current, 1 = Active).
 *
 * Usage: npm run refresh-staging-loandisk
 */
import { runCurrentLoansStagingRefresh } from '../engine/src/reconciliationManager.js'
import { closePool, getPool } from '../engine/src/dataAccess.js'
import { config } from '../engine/src/config.js'

function requireConfig() {
  if (!config.loandisk.publicKey || !config.loandisk.authToken) {
    throw new Error('Set LOANDISK_PUBLIC_KEY and LOANDISK_AUTH_TOKEN in server/.env')
  }
  if (!config.db.password) {
    throw new Error('Set DB_PASSWORD in server/.env')
  }
}

async function main() {
  requireConfig()

  const pool = await getPool()
  const before = await pool.request().query('SELECT COUNT(*) AS c FROM dbo.Staging_LoandiskDueRecords')
  console.log(`Staging_LoandiskDueRecords before: ${before.recordset[0].c} rows`)
  console.log(
    `LoanDisk branches: ${config.loandisk.branches.map((b) => `${b.name}:${b.id}`).join(', ')}`
  )
  console.log(`Status ids: ${config.loandisk.sync.statusIds.join(', ')} (18=current, 1=active)`)
  console.log(`Search timeout: ${config.loandisk.sync.searchTimeoutMs} ms`)

  const result = await runCurrentLoansStagingRefresh((p) => {
    if (p.phase === 'search') {
      process.stdout.write(`\r  ${p.branch} [status ${p.statusId}]: page ${p.page} (${p.count} loans)   `)
    } else if (p.phase === 'branch-done') {
      console.log(`\n  ${p.branch} [status ${p.statusId}]: ${p.count} loans`)
    } else if (p.phase === 'fetched') {
      console.log(`  fetched total: ${p.count}  ${JSON.stringify(p.counts)}`)
    } else if (p.phase === 'truncated' || p.phase === 'staged') {
      console.log(`  ${p.phase}${p.count != null ? `: ${p.count}` : ''}`)
    }
  })
  console.log('\n' + JSON.stringify(result, null, 2))

  const after = await pool.request().query('SELECT COUNT(*) AS c FROM dbo.Staging_LoandiskDueRecords')
  console.log(`Staging_LoandiskDueRecords after: ${after.recordset[0].c} rows`)

  const sample = await pool.request().query(`
    SELECT TOP 3 LoanNumber, BorrowerFullName, ExpectedEMIAmount, LoanBalanceAmount, LoanStatus, BranchName
    FROM dbo.Staging_LoandiskDueRecords ORDER BY Id
  `)
  console.log('Sample rows:', JSON.stringify(sample.recordset, null, 2))
}

main()
  .catch((e) => {
    console.error('Failed:', e.message)
    process.exitCode = 1
  })
  .finally(() => closePool())
