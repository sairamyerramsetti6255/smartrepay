/**
 * Truncate Staging_LoandiskDueRecords and reload from active SILLoans
 * (LoanStatusId = '1') joined with SILBorrowers + latest repayment date.
 *
 * Usage: node scripts/refresh-staging-from-sil.mjs
 * Env (optional): DB_SERVER, DB_PORT, DB_DATABASE, DB_USER, DB_PASSWORD
 */
import sql from 'mssql';
import 'dotenv/config';

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
};

const INSERT_SQL = `
INSERT INTO dbo.Staging_LoandiskDueRecords (
  LoanNumber, BorrowerId, BorrowerFullName, ExpectedEMIAmount,
  PrincipalAmount, TotalLoanAmount, InterestAmount, InterestRate,
  TotalDue, TotalPaid, LoanBalanceAmount, BorrowerEmail, BorrowerPhone,
  EMILastPaidDate, LoanStatus, BranchId, BranchName, SyncedAt
)
SELECT
  CAST(l.LoanId AS NVARCHAR(100)) AS LoanNumber,
  CAST(l.BorrowerId AS VARCHAR(50)) AS BorrowerId,
  -- Prefer the structured FirstName+LastName: SILBorrowers.FullName is sometimes
  -- junk (e.g. mis-populated from BusinessName like "BROWN"), which breaks name
  -- matching against bank transactions. ~290 borrowers have a bad FullName.
  COALESCE(
    NULLIF(LTRIM(RTRIM(CONCAT(b.FirstName, ' ', b.LastName))), ''),
    NULLIF(LTRIM(RTRIM(b.FullName)), ''),
    NULLIF(LTRIM(RTRIM(b.BusinessName)), ''),
    CONCAT('Borrower ', l.BorrowerId)
  ) AS BorrowerFullName,
  COALESCE(
    NULLIF(CASE WHEN l.PendingDue > 0 THEN l.PendingDue END, NULL),
    CASE
      WHEN l.NumOfRepayments > 0 AND l.TotalAmountDue > 0
      THEN ROUND(l.TotalAmountDue / NULLIF(l.NumOfRepayments, 0), 2)
    END,
    NULLIF(l.BalanceAmount, 0)
  ) AS ExpectedEMIAmount,
  l.PrincipalAmount,
  l.PrincipalAmount AS TotalLoanAmount,
  l.InterestAmount,
  l.Interest AS InterestRate,
  l.TotalAmountDue AS TotalDue,
  l.TotalPaid,
  l.BalanceAmount AS LoanBalanceAmount,
  b.Email AS BorrowerEmail,
  b.Mobile AS BorrowerPhone,
  lr.LastRepaymentDate AS EMILastPaidDate,
  -- "current" = LoanDisk child status 18 (a sub-status of active); everything
  -- else with parent status 1 is plain "active".
  CASE
    WHEN ISJSON(l.RawJson) = 1 AND JSON_VALUE(l.RawJson, '$.child_status_id') = '18' THEN 'current'
    ELSE 'active'
  END AS LoanStatus,
  l.BranchId,
  l.BranchName,
  GETUTCDATE() AS SyncedAt
FROM dbo.SILLoans l
LEFT JOIN dbo.SILBorrowers b
  ON b.BorrowerId = l.BorrowerId AND b.BranchId = l.BranchId
OUTER APPLY (
  SELECT MAX(r.RepaymentCollectedDate) AS LastRepaymentDate
  FROM dbo.SILloanrepayments r
  WHERE r.LoanId = l.LoanId AND r.BranchId = l.BranchId
) lr
-- Active loans (parent status 1) plus any loan flagged current (child 18).
WHERE l.LoanStatusId = '1'
   OR (ISJSON(l.RawJson) = 1 AND JSON_VALUE(l.RawJson, '$.child_status_id') = '18');
`;

async function main() {
  if (!config.password) {
    throw new Error('Set DB_PASSWORD in server/.env before running refresh-staging.');
  }
  const pool = await sql.connect(config);
  console.log(`Connected to ${config.database} on ${config.server}:${config.port}`);

  const before = await pool.request().query('SELECT COUNT(*) AS c FROM dbo.Staging_LoandiskDueRecords');
  console.log(`Staging_LoandiskDueRecords before: ${before.recordset[0].c} rows`);

  const counts = await pool.request().query(`
    SELECT
      SUM(CASE WHEN ISJSON(RawJson) = 1 AND JSON_VALUE(RawJson,'$.child_status_id') = '18' THEN 1 ELSE 0 END) AS current18,
      SUM(CASE WHEN LoanStatusId = '1' THEN 1 ELSE 0 END) AS active1,
      SUM(CASE WHEN LoanStatusId = '1'
            OR (ISJSON(RawJson) = 1 AND JSON_VALUE(RawJson,'$.child_status_id') = '18') THEN 1 ELSE 0 END) AS toLoad
    FROM dbo.SILLoans
  `);
  const c = counts.recordset[0];
  console.log(`SILLoans -> current(child 18): ${c.current18}, active(status 1): ${c.active1}, total to load: ${c.toLoad}`);

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query('TRUNCATE TABLE dbo.Staging_LoandiskDueRecords');
    const insertResult = await new sql.Request(tx).query(INSERT_SQL);
    await tx.commit();
    console.log(`Inserted rows: ${insertResult.rowsAffected?.[0] ?? 'unknown'}`);
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }

  const after = await pool.request().query('SELECT COUNT(*) AS c FROM dbo.Staging_LoandiskDueRecords');
  console.log(`Staging_LoandiskDueRecords after: ${after.recordset[0].c} rows`);

  const breakdown = await pool.request().query(`
    SELECT LoanStatus, BranchName, COUNT(*) AS c
    FROM dbo.Staging_LoandiskDueRecords
    GROUP BY LoanStatus, BranchName ORDER BY LoanStatus, c DESC
  `);
  console.log('By status & branch:');
  for (const r of breakdown.recordset) {
    console.log(`  ${r.LoanStatus} / ${r.BranchName}: ${r.c}`);
  }

  const statusTotals = await pool.request().query(`
    SELECT LoanStatus, COUNT(*) AS c FROM dbo.Staging_LoandiskDueRecords GROUP BY LoanStatus
  `);
  console.log('Totals by status:', JSON.stringify(statusTotals.recordset));

  const sample = await pool.request().query(`
    SELECT TOP 3 LoanNumber, BorrowerFullName, ExpectedEMIAmount, LoanBalanceAmount, LoanStatus, BranchName
    FROM dbo.Staging_LoandiskDueRecords ORDER BY Id
  `);
  console.log('Sample rows:', JSON.stringify(sample.recordset, null, 2));

  await pool.close();
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exitCode = 1;
});
