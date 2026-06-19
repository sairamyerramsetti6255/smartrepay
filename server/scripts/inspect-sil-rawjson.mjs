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

  const sample = await pool.request().query(`
    SELECT TOP 1 SILLoanId, LoanId, LoanStatusId, RawJson
    FROM dbo.SILLoans WHERE LoanStatusId = '1' AND RawJson IS NOT NULL
  `)
  const row = sample.recordset[0]
  if (!row) {
    console.log('No active loan with RawJson found.')
  } else {
    console.log('SILLoanId:', row.SILLoanId, 'LoanId:', row.LoanId, 'LoanStatusId:', row.LoanStatusId)
    let json
    try {
      json = JSON.parse(row.RawJson)
    } catch {
      console.log('RawJson is not valid JSON. First 500 chars:\n', String(row.RawJson).slice(0, 500))
      await pool.close()
      return
    }
    const keys = Object.keys(json)
    console.log('\nRawJson keys with "status":')
    for (const k of keys) if (/status/i.test(k)) console.log(`  ${k} = ${json[k]}`)
    console.log('\nHas child_status_id key:', 'child_status_id' in json, '->', json.child_status_id)
  }

  // How many active loans have child_status_id = 18 inside RawJson?
  const counts = await pool.request().query(`
    SELECT
      SUM(CASE WHEN JSON_VALUE(RawJson,'$.child_status_id') = '18' THEN 1 ELSE 0 END) AS current18,
      SUM(CASE WHEN JSON_VALUE(RawJson,'$.loan_status_id') = '1' THEN 1 ELSE 0 END) AS active1,
      COUNT(*) AS total
    FROM dbo.SILLoans
    WHERE ISJSON(RawJson) = 1
  `)
  console.log('\nFrom RawJson across all SILLoans:')
  console.log('  child_status_id=18 (current):', counts.recordset[0].current18)
  console.log('  loan_status_id=1 (active):', counts.recordset[0].active1)
  console.log('  rows with valid JSON:', counts.recordset[0].total)

  await pool.close()
}

main().catch((e) => {
  console.error('Failed:', e.message)
  process.exitCode = 1
})
