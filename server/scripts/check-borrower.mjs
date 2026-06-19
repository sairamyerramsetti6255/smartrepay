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

const term = process.argv[2] || 'Henfield'

async function main() {
  if (!config.password) throw new Error('Set DB_PASSWORD in server/.env')
  const pool = await sql.connect(config)
  const like = `%${term}%`

  console.log(`\n=== SILBorrowers matching "${term}" ===`)
  const b = await pool.request().input('q', sql.NVarChar, like).query(`
    SELECT BorrowerId, BranchId, BranchName, FirstName, LastName, FullName, BusinessName, Email, Mobile
    FROM dbo.SILBorrowers
    WHERE FirstName LIKE @q OR LastName LIKE @q OR FullName LIKE @q OR BusinessName LIKE @q
       OR CONCAT(FirstName,' ',LastName) LIKE @q
  `)
  console.log(JSON.stringify(b.recordset, null, 2))

  console.log(`\n=== SILLoans for those borrowers (joined by name) ===`)
  const l = await pool.request().input('q', sql.NVarChar, like).query(`
    SELECT l.LoanId, l.BorrowerId, l.BranchName, l.LoanStatusId,
           JSON_VALUE(l.RawJson,'$.child_status_id') AS ChildStatusId,
           l.BalanceAmount, l.TotalAmountDue, l.PendingDue, l.LoanApplicationId
    FROM dbo.SILLoans l
    LEFT JOIN dbo.SILBorrowers b ON b.BorrowerId = l.BorrowerId AND b.BranchId = l.BranchId
    WHERE b.FirstName LIKE @q OR b.LastName LIKE @q OR b.FullName LIKE @q OR b.BusinessName LIKE @q
       OR CONCAT(b.FirstName,' ',b.LastName) LIKE @q
  `)
  console.log(JSON.stringify(l.recordset, null, 2))

  console.log(`\n=== Staging_LoandiskDueRecords matching "${term}" ===`)
  const s = await pool.request().input('q', sql.NVarChar, like).query(`
    SELECT LoanNumber, BorrowerId, BorrowerFullName, ExpectedEMIAmount, LoanBalanceAmount, LoanStatus, BranchName
    FROM dbo.Staging_LoandiskDueRecords
    WHERE BorrowerFullName LIKE @q
  `)
  console.log(JSON.stringify(s.recordset, null, 2))

  console.log(`\n=== Bank transactions (credits) matching "${term}" ===`)
  const t = await pool.request().input('q', sql.NVarChar, like).query(`
    SELECT TOP 20 Id, BorrowerName, NormalizedName, EmiPaidAmount, EmployerOrBank, TransDate, FileName
    FROM dbo.Staging_BankTransactions
    WHERE BorrowerName LIKE @q OR Particulars LIKE @q
  `).catch((e) => ({ recordset: [{ error: e.message }] }))
  console.log(JSON.stringify(t.recordset, null, 2))

  await pool.close()
}

main().catch((e) => {
  console.error('Failed:', e.message)
  process.exitCode = 1
})
