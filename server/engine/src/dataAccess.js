import sql from 'mssql'
import { config } from './config.js'
import { chunk } from './concurrency.js'
import { crif } from '../../crifClient.js'

/**
 * Data access layer — port of dataaccess.cs.
 *
 * Key optimisation: the original opened a brand new connection implicitly for
 * every SaveLatestLoanToDb call (one round trip per borrower). Here we use a
 * single shared mssql connection pool, so the SP calls reuse pooled, already
 * authenticated connections, and the loan/repayment writes are flushed in
 * parallel batches instead of one-at-a-time.
 */

let poolPromise = null

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({
      server: config.db.server,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      options: config.db.options,
      pool: {
        max: Math.max(10, config.performance.borrowerConcurrency),
        min: 0,
        idleTimeoutMillis: 30_000,
      },
      requestTimeout: 120_000,
    })
      .connect()
      .catch((e) => {
        poolPromise = null
        throw e
      })
  }
  return poolPromise
}

/**
 * Call dbo.CRIF_Operations over HTTP (meanhost API gateway) — see crifClient.js.
 * The app/match path no longer opens a direct mssql connection (the deploy host
 * is firewalled off port 1433/9933). @Json is the payload, @Condition the branch.
 */
async function execCrif(json, condition, type = '') {
  return crif(json, condition, type)
}

/**
 * STEP 2 — persist all borrowers in one shot and return the identity mapping
 * rows ({ InternalId, BranchId, BorrowerId }) produced by the SP OUTPUT clause.
 * Mirrors DataAccess.SaveBorrowersToDb.
 */
export async function saveBorrowersToDb(jsonData) {
  const pool = await getPool()
  const result = await pool
    .request()
    .input('JsonData', sql.NVarChar(sql.MAX), jsonData)
    .execute('SaveBorrowers')

  return result.recordset || []
}

/** Persist a single loan/repayment pair. Mirrors DataAccess.SaveLatestLoanToDb. */
async function saveLatestLoan(pool, record) {
  await pool
    .request()
    .input('JsonData', sql.NVarChar(sql.MAX), record.loanJson ?? null)
    .input('PaymentJsonData', sql.NVarChar(sql.MAX), record.repaymentJson ?? null)
    .input('BorrowerInternalId', sql.Int, record.internalId)
    .input('BranchId', sql.VarChar(50), String(record.branchId))
    .input('BorrowerId', sql.Int, record.borrowerId)
    .execute('SaveLatestBorrowerLoan')
}

/**
 * STEP 4 — bulk persist loan/repayment records. Records are flushed in batches
 * with the calls inside a batch running in parallel over the pool, replacing
 * the original blocking per-iteration ExecuteNonQuery.
 */
export async function saveLatestLoansBulk(records, onProgress) {
  if (!records.length) return 0
  const pool = await getPool()
  let saved = 0

  for (const batch of chunk(records, config.performance.dbBatchSize)) {
    await Promise.all(
      batch.map(async (record) => {
        try {
          await saveLatestLoan(pool, record)
          saved++
        } catch (e) {
          // Fault isolation: one bad row must not abort the whole sync.
          console.error(`SaveLatestBorrowerLoan failed for borrower ${record.borrowerId}: ${e.message}`)
        }
      })
    )
    onProgress?.({ phase: 'persisting', saved, total: records.length })
  }

  return saved
}

// Column descriptor for the due-loan staging upsert (name, SQL type, value getter).
const DUE_COLUMNS = [
  ['LoanNumber', sql.NVarChar(100), (r) => r.loanNumber ?? null],
  ['BorrowerId', sql.VarChar(50), (r) => (r.borrowerId != null ? String(r.borrowerId) : null)],
  ['BorrowerFullName', sql.NVarChar(255), (r) => r.borrowerFullName ?? null],
  ['ExpectedEMIAmount', sql.Decimal(18, 2), (r) => r.expectedEmiAmount ?? null],
  ['PrincipalAmount', sql.Decimal(18, 2), (r) => r.principalAmount ?? null],
  ['TotalLoanAmount', sql.Decimal(18, 2), (r) => r.totalLoanAmount ?? null],
  ['InterestAmount', sql.Decimal(18, 2), (r) => r.interestAmount ?? null],
  ['InterestRate', sql.Decimal(9, 4), (r) => r.interestRate ?? null],
  ['TotalDue', sql.Decimal(18, 2), (r) => r.totalDue ?? null],
  ['TotalPaid', sql.Decimal(18, 2), (r) => r.totalPaid ?? null],
  ['LoanBalanceAmount', sql.Decimal(18, 2), (r) => r.loanBalanceAmount ?? null],
  ['BorrowerEmail', sql.NVarChar(255), (r) => r.borrowerEmail ?? null],
  ['BorrowerPhone', sql.NVarChar(50), (r) => r.borrowerPhone ?? null],
  ['EMILastPaidDate', sql.DateTime, (r) => r.emiLastPaidDate ?? null],
  ['LoanStatus', sql.NVarChar(50), (r) => r.loanStatus ?? null],
  ['BranchId', sql.VarChar(50), (r) => r.branchId ?? null],
  ['BranchName', sql.NVarChar(150), (r) => r.branchName ?? null],
]

// Table-variable column DDL (mirrors DUE_COLUMNS / the target table types).
const DUE_TABLEVAR_DDL = `(
  LoanNumber NVARCHAR(100), BorrowerId VARCHAR(50), BorrowerFullName NVARCHAR(255),
  ExpectedEMIAmount DECIMAL(18,2), PrincipalAmount DECIMAL(18,2), TotalLoanAmount DECIMAL(18,2),
  InterestAmount DECIMAL(18,2), InterestRate DECIMAL(9,4), TotalDue DECIMAL(18,2), TotalPaid DECIMAL(18,2),
  LoanBalanceAmount DECIMAL(18,2), BorrowerEmail NVARCHAR(255), BorrowerPhone NVARCHAR(50),
  EMILastPaidDate DATETIME, LoanStatus NVARCHAR(50), BranchId VARCHAR(50), BranchName NVARCHAR(150)
)`

const DUE_MERGE_TAIL = `
  MERGE dbo.Staging_LoandiskDueRecords AS T
  USING @T AS S ON T.LoanNumber = S.LoanNumber
  WHEN MATCHED THEN UPDATE SET
    T.PreviousBranchId = CASE WHEN ISNULL(T.BranchId,'') <> ISNULL(S.BranchId,'') THEN T.BranchId ELSE T.PreviousBranchId END,
    T.PreviousBranchName = CASE WHEN ISNULL(T.BranchId,'') <> ISNULL(S.BranchId,'') THEN T.BranchName ELSE T.PreviousBranchName END,
    T.BorrowerId = S.BorrowerId, T.BorrowerFullName = S.BorrowerFullName,
    T.ExpectedEMIAmount = S.ExpectedEMIAmount, T.PrincipalAmount = S.PrincipalAmount,
    T.TotalLoanAmount = S.TotalLoanAmount, T.InterestAmount = S.InterestAmount,
    T.InterestRate = S.InterestRate, T.TotalDue = S.TotalDue, T.TotalPaid = S.TotalPaid,
    T.LoanBalanceAmount = S.LoanBalanceAmount, T.BorrowerEmail = S.BorrowerEmail,
    T.BorrowerPhone = S.BorrowerPhone, T.EMILastPaidDate = S.EMILastPaidDate,
    T.LoanStatus = S.LoanStatus, T.BranchId = S.BranchId, T.BranchName = S.BranchName,
    T.SyncedAt = GETUTCDATE()
  WHEN NOT MATCHED BY TARGET THEN INSERT
    (LoanNumber, BorrowerId, BorrowerFullName, ExpectedEMIAmount, PrincipalAmount,
     TotalLoanAmount, InterestAmount, InterestRate, TotalDue, TotalPaid,
     LoanBalanceAmount, BorrowerEmail, BorrowerPhone, EMILastPaidDate, LoanStatus,
     BranchId, BranchName)
    VALUES
    (S.LoanNumber, S.BorrowerId, S.BorrowerFullName, S.ExpectedEMIAmount, S.PrincipalAmount,
     S.TotalLoanAmount, S.InterestAmount, S.InterestRate, S.TotalDue, S.TotalPaid,
     S.LoanBalanceAmount, S.BorrowerEmail, S.BorrowerPhone, S.EMILastPaidDate, S.LoanStatus,
     S.BranchId, S.BranchName)
  OUTPUT $action AS Action;`

// 17 cols * 100 rows = 1700 params, safely under SQL Server's 2100 limit.
const DUE_INSERT_BATCH = 100

/**
 * Upsert due-loan staging records into Staging_LoandiskDueRecords.
 *
 * NON-DESTRUCTIVE: each chunk runs a single self-contained batch — a table
 * variable is populated then MERGE'd on LoanNumber. Matched loans are UPDATED in
 * place, new loans are INSERTED, and rows not present in this batch (e.g.
 * previously synced branches) are left untouched. No TRUNCATE/DELETE.
 */
export async function bulkInsertStagingRecords(records) {
  if (!records.length) return { upserted: 0, inserted: 0, updated: 0 }

  // De-dupe by LoanNumber (MERGE forbids multiple source rows hitting one target).
  const byKey = new Map()
  for (const r of records) {
    const key = r.loanNumber ?? (r.loanId != null ? String(r.loanId) : null)
    if (key == null) continue
    byKey.set(key, r)
  }
  const rows = [...byKey.values()]
  const colNames = DUE_COLUMNS.map((c) => c[0])

  const pool = await getPool()
  const tx = new sql.Transaction(pool)
  await tx.begin()

  try {
    let inserted = 0
    let updated = 0

    for (let i = 0; i < rows.length; i += DUE_INSERT_BATCH) {
      const batch = rows.slice(i, i + DUE_INSERT_BATCH)
      const req = new sql.Request(tx)
      const valueClauses = batch.map((row, idx) => {
        const params = DUE_COLUMNS.map(([name, type, get]) => {
          const p = `p${idx}_${name}`
          req.input(p, type, get(row))
          return `@${p}`
        })
        return `(${params.join(', ')})`
      })

      // One batch: declare table var, fill it, MERGE — table var is visible
      // throughout the batch, avoiding cross-request temp-table issues.
      const batchSql =
        `DECLARE @T TABLE ${DUE_TABLEVAR_DDL};\n` +
        `INSERT INTO @T (${colNames.join(', ')}) VALUES ${valueClauses.join(', ')};\n` +
        DUE_MERGE_TAIL

      const result = await req.query(batchSql)
      for (const a of result.recordset || []) {
        if (a.Action === 'INSERT') inserted++
        else if (a.Action === 'UPDATE') updated++
      }
    }

    await tx.commit()
    return { upserted: inserted + updated, inserted, updated }
  } catch (e) {
    await tx.rollback().catch(() => {})
    throw e
  }
}

const cut = (v, n) => (v == null ? null : String(v).slice(0, n))

/**
 * Insert parsed credit rows into Staging_BankTransactions.
 * Idempotent per file: existing rows for the same FileName are removed first, so
 * re-uploading a file replaces its rows while other files' rows are preserved.
 */
export async function bulkInsertBankTransactions(records, { fileName, uploadedDate }) {
  if (!records.length) return 0

  // Idempotent per file: drop this file's prior rows (+ their matches) first via
  // CRIF_Operations / Delete_Documents, then re-insert via Save_BankTransactions.
  await crif({ FileName: fileName }, 'Delete_Documents')

  const isoDate = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null)
  const uploaded = (uploadedDate ? new Date(uploadedDate) : new Date()).toISOString()

  const payload = records.map((r) => ({
    FileName: cut(fileName, 260),
    FileType: cut(r.fileType, 20),
    SourceType: cut(r.sourceType, 20),
    EmployerOrBank: cut(r.employerOrBank, 255),
    TransDate: isoDate(r.transDate),
    ReferenceNo: cut(r.referenceNo, 100),
    Particulars: cut(r.particulars, 500),
    BorrowerName: cut(r.borrowerName || null, 255),
    NormalizedName: cut(r.normalizedName || null, 255),
    EmiPaidAmount: r.emiPaidAmount ?? null,
    UploadedDate: uploaded,
  }))

  for (const part of chunk(payload, 500)) {
    await execCrif(part, 'Save_BankTransactions')
  }
  return records.length
}

/** All credit transactions awaiting / available for matching (via CRIF_Operations). */
export async function getBankTransactions() {
  return execCrif('{}', 'Get_BankTransactions')
}

/** LoanDisk due loans to match against (via CRIF_Operations). */
export async function getLoanDiskDueRecords() {
  return execCrif('{}', 'Get_LoandiskDueRecords')
}

/**
 * Upsert the supplied matches into Staging_TransactionMatches through
 * dbo.CRIF_Operations / Save_TransactionMatches (MERGE on BankTransactionId).
 * Non-destructive: existing rows are overwritten, nothing is truncated/deleted.
 */
export async function saveTransactionMatches(matches) {
  if (!matches.length) return 0
  let saved = 0

  for (const part of chunk(matches, 200)) {
    const payload = part.map((m) => ({
      BankTransactionId: m.bankTransactionId ?? null,
      FileName: cut(m.fileName, 260),
      BankBorrowerName: cut(m.bankBorrowerName, 255),
      LoanDiskBorrowerName: cut(m.loanDiskBorrowerName, 255),
      BorrowerId: cut(m.borrowerId, 50),
      LoanNumber: cut(m.loanNumber, 100),
      MatchedLoanNumbers: cut(
        Array.isArray(m.matchedLoanNumbers) ? m.matchedLoanNumbers.join(', ') : m.matchedLoanNumbers,
        1000
      ),
      LoanCount: m.loanCount ?? null,
      EmiPaidAmount: m.emiPaidAmount ?? null,
      ExpectedEMIAmount: m.expectedEmiAmount ?? null,
      SummedExpectedEMI: m.summedExpectedEmi ?? null,
      AmountDiff: m.amountDiff ?? null,
      MatchType: cut(m.matchType, 30),
      AmountMatchKind: cut(m.amountMatchKind, 30),
      NameScore: m.nameScore ?? null,
      ConfidenceScore: m.confidenceScore ?? null,
      MatchMethod: cut(m.matchMethod, 20),
      ReviewStatus: cut(m.reviewStatus, 20),
      Reasoning: cut(m.reasoning, 1000),
    }))

    await execCrif(payload, 'Save_TransactionMatches')
    saved += part.length
  }
  return saved
}

export async function closePool() {
  if (poolPromise) {
    const pool = await poolPromise.catch(() => null)
    poolPromise = null
    if (pool) await pool.close().catch(() => {})
  }
}
