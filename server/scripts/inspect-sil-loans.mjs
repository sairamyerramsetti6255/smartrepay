import sql from 'mssql'
import 'dotenv/config'

const config = {
  server: process.env.DB_SERVER || '185.136.157.11',
  port: Number(process.env.DB_PORT || 9933),
  database: process.env.DB_DATABASE || 'Simplified_db',
  user: process.env.DB_USER || 'Simplified_user',
  password: process.env.DB_PASSWORD || '',
  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
  },
  connectionTimeout: 30000,
  requestTimeout: 120000,
}

async function main() {
  if (!config.password) throw new Error('Set DB_PASSWORD in server/.env')
  const pool = await sql.connect(config)
  console.log(`Connected to ${config.database} on ${config.server}:${config.port}\n`)

  const cols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'SILLoans'
    ORDER BY ORDINAL_POSITION
  `)
  console.log('SILLoans columns:')
  for (const c of cols.recordset) {
    console.log(`  ${c.COLUMN_NAME} ${c.DATA_TYPE}${c.CHARACTER_MAXIMUM_LENGTH ? `(${c.CHARACTER_MAXIMUM_LENGTH})` : ''}`)
  }

  const total = await pool.request().query('SELECT COUNT(*) AS c FROM dbo.SILLoans')
  console.log(`\nTotal SILLoans rows: ${total.recordset[0].c}`)

  const byStatus = await pool.request().query(`
    SELECT LoanStatusId, COUNT(*) AS c, SUM(CASE WHEN ISNULL(BalanceAmount,0) > 0 THEN 1 ELSE 0 END) AS withBalance
    FROM dbo.SILLoans GROUP BY LoanStatusId ORDER BY c DESC
  `)
  console.log('\nLoans by LoanStatusId (c = rows, withBalance = balance>0):')
  for (const r of byStatus.recordset) {
    console.log(`  status ${r.LoanStatusId}: ${r.c} rows, ${r.withBalance} with balance`)
  }

  const byBranch = await pool.request().query(`
    SELECT BranchId, BranchName, COUNT(*) AS c
    FROM dbo.SILLoans GROUP BY BranchId, BranchName ORDER BY c DESC
  `)
  console.log('\nLoans by branch:')
  for (const r of byBranch.recordset) {
    console.log(`  ${r.BranchName} (${r.BranchId}): ${r.c}`)
  }

  await pool.close()
}

main().catch((e) => {
  console.error('Failed:', e.message)
  process.exitCode = 1
})
