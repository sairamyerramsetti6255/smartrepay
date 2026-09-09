// Identify the loans that the new-branch upsert UPDATED in place (re-attributed
// from SimplifiedLending to a new branch). They are loans returned by BOTH
// SimplifiedLending's due_loans AND a new branch's due_loans — MERGE keys on
// LoanNumber, so they were updated, not duplicated.
process.env.LOANDISK_BRANCHES = 'SimplifiedLending:18279'

const sql = (await import('mssql')).default
const { config } = await import('../src/config.js')
const { fetchAllDueLoans } = await import('../src/dueLoansClient.js')
const { closePool } = await import('../src/dataAccess.js')

const NEW_BRANCH_IDS = ['26281', '16209', '36198', '51238']

// 1) SimplifiedLending's current due-loan numbers (paginated, no enrichment).
const { records } = await fetchAllDueLoans(() => {})
const slLoanNumbers = new Set(records.map((r) => String(r.loanNumber)))
console.log(`SimplifiedLending due loans: ${slLoanNumbers.size}`)

// 2) Rows now sitting under a new branch.
const pool = await new sql.ConnectionPool({
  server: config.db.server, port: config.db.port, database: config.db.database,
  user: config.db.user, password: config.db.password, options: config.db.options,
}).connect()

const res = await pool.request().query(`
  SELECT LoanNumber, BorrowerId, BorrowerFullName, ExpectedEMIAmount,
         PrincipalAmount, LoanBalanceAmount, LoanStatus, BranchName, BranchId, SyncedAt
  FROM Staging_LoandiskDueRecords
  WHERE BranchId IN ('${NEW_BRANCH_IDS.join("','")}')
  ORDER BY BranchName, LoanNumber`)

// 3) Intersect → the re-attributed (updated) loans.
const reattributed = res.recordset.filter((r) => slLoanNumbers.has(String(r.LoanNumber)))

// 4) Backfill PreviousBranch = SimplifiedLending for any not yet recorded.
const toBackfill = reattributed.filter((r) => !r.PreviousBranchId)
if (toBackfill.length) {
  const req = pool.request()
  const params = toBackfill.map((r, i) => {
    req.input(`ln${i}`, sql.NVarChar(100), String(r.LoanNumber))
    return `@ln${i}`
  })
  req.input('pbid', sql.VarChar(50), '18279')
  req.input('pbname', sql.NVarChar(150), 'SimplifiedLending')
  await req.query(`
    UPDATE Staging_LoandiskDueRecords
    SET PreviousBranchId = @pbid, PreviousBranchName = @pbname
    WHERE LoanNumber IN (${params.join(', ')}) AND PreviousBranchId IS NULL`)
  console.log(`Backfilled PreviousBranch on ${toBackfill.length} rows.`)
}

const final = await pool.request().query(`
  SELECT LoanNumber, BorrowerFullName, BorrowerId, PreviousBranchName, BranchName AS CurrentBranch,
         ExpectedEMIAmount, LoanBalanceAmount, LoanStatus
  FROM Staging_LoandiskDueRecords
  WHERE PreviousBranchId IS NOT NULL
  ORDER BY CurrentBranch, LoanNumber`)

console.log(`\nRe-attributed loans (with previous branch): ${final.recordset.length}\n`)
console.table(
  final.recordset.map((r) => ({
    LoanNumber: r.LoanNumber,
    Borrower: r.BorrowerFullName,
    BorrowerId: r.BorrowerId,
    PreviousBranch: r.PreviousBranchName,
    CurrentBranch: r.CurrentBranch,
    EMI: r.ExpectedEMIAmount,
    Balance: r.LoanBalanceAmount,
    Status: r.LoanStatus,
  }))
)

await pool.close()
await closePool()
