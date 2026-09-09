/**
 * Apply Receipts Upload schema to online SQL Server (idempotent).
 *
 * 1. Staging_ManualReceipts table
 * 2. SILloanrepayments columns (ReceiptSource, EntryType, Particulars, ReceiptFileName)
 * 3. CRIF_Operations conditions (Get_LoansByBorrowerId, Save_ManualReceipt, Get_ManualReceipts)
 *
 * Usage (from repo root):
 *   npm run apply-receipts-schema --prefix server
 *
 * Requires server/.env: DB_SERVER, DB_PORT, DB_DATABASE, DB_USER, DB_PASSWORD
 */
import sql from 'mssql'
import { getSqlServerConfig } from './sqlServerConfig.mjs'
import { applyCrifAdditions } from '../engine/scripts/_applyCrifAdditions.js'

const DDL_STAGING_MANUAL_RECEIPTS = `
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Staging_ManualReceipts')
BEGIN
  CREATE TABLE dbo.Staging_ManualReceipts (
    Id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    BorrowerId VARCHAR(50) NOT NULL,
    LoanNumber NVARCHAR(100) NOT NULL,
    BranchId VARCHAR(50) NULL,
    BorrowerFullName NVARCHAR(255) NULL,
    AmountReceived DECIMAL(18,2) NOT NULL,
    Particulars NVARCHAR(500) NULL,
    SourceChannel VARCHAR(20) NOT NULL,
    EntryType VARCHAR(20) NOT NULL CONSTRAINT DF_Staging_ManualReceipts_EntryType DEFAULT ('manual'),
    CollectedDate DATE NOT NULL,
    ReceiptFileName NVARCHAR(260) NULL,
    ReceiptDocumentId VARCHAR(36) NULL,
    EnteredBy NVARCHAR(255) NULL,
    CreatedAt DATETIME NOT NULL CONSTRAINT DF_Staging_ManualReceipts_CreatedAt DEFAULT (GETUTCDATE())
  );
  CREATE INDEX IX_Staging_ManualReceipts_Borrower ON dbo.Staging_ManualReceipts (BorrowerId, CreatedAt DESC);
  CREATE INDEX IX_Staging_ManualReceipts_Loan ON dbo.Staging_ManualReceipts (LoanNumber, CreatedAt DESC);
END
`

const DDL_SIL_REPAYMENT_COLUMNS = `
IF COL_LENGTH('dbo.SILloanrepayments', 'ReceiptSource') IS NULL
  ALTER TABLE dbo.SILloanrepayments ADD ReceiptSource NVARCHAR(50) NULL;

IF COL_LENGTH('dbo.SILloanrepayments', 'EntryType') IS NULL
  ALTER TABLE dbo.SILloanrepayments ADD EntryType NVARCHAR(20) NULL;

IF COL_LENGTH('dbo.SILloanrepayments', 'Particulars') IS NULL
  ALTER TABLE dbo.SILloanrepayments ADD Particulars NVARCHAR(500) NULL;

IF COL_LENGTH('dbo.SILloanrepayments', 'ReceiptFileName') IS NULL
  ALTER TABLE dbo.SILloanrepayments ADD ReceiptFileName NVARCHAR(260) NULL;
`

async function runBatch(pool, label, batchSql) {
  await pool.request().batch(batchSql)
  console.log(`✓ ${label}`)
}

async function verify(pool) {
  const tables = await pool.request().query(`
    SELECT name FROM sys.tables WHERE name IN ('Staging_ManualReceipts', 'SILloanrepayments')
  `)
  console.log('Tables present:', tables.recordset.map((r) => r.name).join(', ') || '(none)')

  const cols = await pool.request().query(`
    SELECT c.name
    FROM sys.columns c
    INNER JOIN sys.tables t ON t.object_id = c.object_id
    WHERE t.name = 'SILloanrepayments'
      AND c.name IN ('ReceiptSource', 'EntryType', 'Particulars', 'ReceiptFileName')
    ORDER BY c.name
  `)
  console.log('SILloanrepayments receipt columns:', cols.recordset.map((r) => r.name).join(', ') || '(none)')
}

async function main() {
  console.log('Connecting to SQL Server…')
  const pool = await new sql.ConnectionPool(getSqlServerConfig()).connect()
  console.log(`Connected to ${getSqlServerConfig().database} on ${getSqlServerConfig().server}:${getSqlServerConfig().port}`)

  try {
    await runBatch(pool, 'Staging_ManualReceipts table', DDL_STAGING_MANUAL_RECEIPTS)
    await runBatch(pool, 'SILloanrepayments receipt columns', DDL_SIL_REPAYMENT_COLUMNS)
    await verify(pool)

    console.log('\nApplying CRIF_Operations additions…')
    await applyCrifAdditions(pool)

    console.log('\nReceipts schema migration complete.')
  } finally {
    await pool.close()
  }
}

main().catch((e) => {
  console.error('Migration FAILED:', e.message)
  process.exit(1)
})
