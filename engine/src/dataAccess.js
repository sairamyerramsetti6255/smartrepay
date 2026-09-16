import sql from 'mssql'
import { config } from './config.js'
import { chunk } from './concurrency.js'
import { crif } from '../../crifClient.js'
import { isRematchProtected, isIdentityGuess } from './matchProtection.js'

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

export function getPool() {
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
    T.BorrowerPhone = S.BorrowerPhone,
    T.EMILastPaidDate = COALESCE(S.EMILastPaidDate, T.EMILastPaidDate),
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
/** Remove all rows from Staging_LoandiskDueRecords (full refresh). */
export async function truncateStagingDueRecords() {
  const pool = await getPool()
  await pool.request().query('TRUNCATE TABLE dbo.Staging_LoandiskDueRecords')
}

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

/**
 * Upsert LoanDisk repayment history into dbo.SILLoanRepayments (MERGE on RepaymentId).
 * This is what Get_LoanRepayments reads — Staging_LoandiskDueRecords does NOT store repayments.
 */
export async function bulkUpsertSilLoanRepayments(rows) {
  if (!rows?.length) return { upserted: 0, inserted: 0, updated: 0 }

  const byKey = new Map()
  for (const r of rows) {
    const id = r.repaymentId != null ? String(r.repaymentId) : null
    if (!id) continue
    byKey.set(id, r)
  }
  const unique = [...byKey.values()]
  if (!unique.length) return { upserted: 0, inserted: 0, updated: 0 }

  const pool = await getPool()
  const tx = new sql.Transaction(pool)
  await tx.begin()

  const BATCH = 80
  let inserted = 0
  let updated = 0

  try {
    for (let i = 0; i < unique.length; i += BATCH) {
      const batch = unique.slice(i, i + BATCH)
      const req = new sql.Request(tx)
      const values = batch.map((r, idx) => {
        const p = (name) => `r${idx}_${name}`
        req.input(p('RepaymentId'), sql.BigInt, String(r.repaymentId))
        req.input(p('LoanId'), sql.BigInt, String(r.loanId))
        req.input(p('BranchId'), sql.VarChar(50), r.branchId != null ? String(r.branchId) : null)
        req.input(p('BranchName'), sql.NVarChar(300), r.branchName ?? null)
        req.input(p('Amount'), sql.Decimal(18, 2), r.amount ?? null)
        req.input(p('Principal'), sql.Decimal(18, 2), r.principalAmount ?? null)
        req.input(p('Interest'), sql.Decimal(18, 2), r.interestAmount ?? null)
        req.input(p('Fees'), sql.Decimal(18, 2), r.feesAmount ?? null)
        req.input(p('Penalty'), sql.Decimal(18, 2), r.penaltyAmount ?? null)
        req.input(p('Method'), sql.VarChar(50), r.method != null ? String(r.method).slice(0, 50) : null)
        req.input(p('Collector'), sql.VarChar(50), r.collectorId != null ? String(r.collectorId).slice(0, 50) : null)
        req.input(p('CollectedDate'), sql.VarChar(50), r.collectedDate != null ? String(r.collectedDate).slice(0, 50) : null)
        req.input(p('SystemDate'), sql.VarChar(50), r.systemDate != null ? String(r.systemDate).slice(0, 50) : null)
        req.input(p('Description'), sql.NVarChar(500), r.description ?? null)
        return `(@${p('RepaymentId')}, @${p('LoanId')}, @${p('BranchId')}, @${p('BranchName')}, @${p('Amount')}, @${p('Principal')}, @${p('Interest')}, @${p('Fees')}, @${p('Penalty')}, @${p('Method')}, @${p('Collector')}, @${p('CollectedDate')}, @${p('SystemDate')}, @${p('Description')})`
      })

      const sqlText = `
        DECLARE @R TABLE (
          RepaymentId BIGINT,
          LoanId BIGINT,
          BranchId VARCHAR(50),
          BranchName NVARCHAR(300),
          RepaymentAmount DECIMAL(18,2),
          PrincipalRepaymentAmount DECIMAL(18,2),
          InterestRepaymentAmount DECIMAL(18,2),
          FeesRepaymentAmount DECIMAL(18,2),
          PenaltyRepaymentAmount DECIMAL(18,2),
          RepaymentMethodId VARCHAR(50),
          CollectorId VARCHAR(50),
          RepaymentCollectedDate VARCHAR(50),
          LoandiskSystemDate VARCHAR(50),
          RepaymentDescription NVARCHAR(500)
        );
        INSERT INTO @R VALUES ${values.join(', ')};
        MERGE dbo.SILLoanRepayments AS T
        USING @R AS S ON T.RepaymentId = S.RepaymentId
        WHEN MATCHED AND (T.EntryType IS NULL OR T.EntryType <> 'manual') THEN UPDATE SET
          T.LoanId = S.LoanId,
          T.BranchId = S.BranchId,
          T.BranchName = COALESCE(S.BranchName, T.BranchName),
          T.RepaymentAmount = S.RepaymentAmount,
          T.PrincipalRepaymentAmount = S.PrincipalRepaymentAmount,
          T.InterestRepaymentAmount = S.InterestRepaymentAmount,
          T.FeesRepaymentAmount = S.FeesRepaymentAmount,
          T.PenaltyRepaymentAmount = S.PenaltyRepaymentAmount,
          T.RepaymentMethodId = S.RepaymentMethodId,
          T.CollectorId = S.CollectorId,
          T.RepaymentCollectedDate = S.RepaymentCollectedDate,
          T.LoandiskSystemDate = S.LoandiskSystemDate,
          T.RepaymentDescription = S.RepaymentDescription,
          T.SyncedAt = GETUTCDATE()
        WHEN NOT MATCHED BY TARGET THEN INSERT (
          RepaymentId, LoanId, BranchId, BranchName, RepaymentAmount,
          PrincipalRepaymentAmount, InterestRepaymentAmount, FeesRepaymentAmount, PenaltyRepaymentAmount,
          RepaymentMethodId, CollectorId, RepaymentCollectedDate, LoandiskSystemDate, RepaymentDescription, SyncedAt
        ) VALUES (
          S.RepaymentId, S.LoanId, S.BranchId, S.BranchName, S.RepaymentAmount,
          S.PrincipalRepaymentAmount, S.InterestRepaymentAmount, S.FeesRepaymentAmount, S.PenaltyRepaymentAmount,
          S.RepaymentMethodId, S.CollectorId, S.RepaymentCollectedDate, S.LoandiskSystemDate, S.RepaymentDescription, GETUTCDATE()
        )
        OUTPUT $action AS Action;`

      const result = await req.query(sqlText)
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
export async function getMatchHistory() {
  return execCrif('{}', 'Get_TransactionMatches')
}

/** Drop confirmed amount-only guesses so Save_TransactionMatches can overwrite them. */
export async function releaseIdentityGuesses(history = []) {
  const rows = (history || []).filter((r) =>
    ['confirmed', 'auto_matched'].includes(String(r.ReviewStatus || '')) && isIdentityGuess(r)
  )
  for (const r of rows) {
    await execCrif({ BankTransactionId: Number(r.Id), ReviewStatus: 'unmatched' }, 'Update_MatchReview')
  }
  return rows.length
}

/**
 * Recurring repayment amounts per loan (cents), from the synced LoanDisk ledger.
 * An amount that appears at least twice is treated as the observed EMI.
 */
export async function getTypicalRepaymentAmounts() {
  try {
    const pool = await getPool()
    const result = await pool.request().query(`
      SELECT CAST(LoanId AS NVARCHAR(100)) AS LoanNumber,
             CAST(RepaymentAmount AS DECIMAL(18,2)) AS Amount
      FROM dbo.SILLoanRepayments
      WHERE RepaymentAmount IS NOT NULL AND RepaymentAmount > 0
        AND (EntryType IS NULL OR EntryType <> 'manual')
      GROUP BY LoanId, CAST(RepaymentAmount AS DECIMAL(18,2))
      HAVING COUNT(*) >= 2
    `)
    const map = new Map()
    for (const row of result.recordset || []) {
      const id = String(row.LoanNumber || '').trim()
      const cents = Math.round(Number(row.Amount) * 100)
      if (!id || !Number.isFinite(cents) || cents <= 0) continue
      if (!map.has(id)) map.set(id, [])
      map.get(id).push(cents)
    }
    return map
  } catch {
    return new Map()
  }
}

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
  const protectedIds = new Set((await getMatchHistory()).filter((r) => isRematchProtected(r)).map((r) => String(r.Id)))
  matches = matches.filter((m) => !protectedIds.has(String(m.bankTransactionId)))
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

/**
 * Mark loans in a branch as 'inactive' if they are no longer returned by LoanDisk's
 * Active/Current API call.  This prevents paid-off or status-changed loans from
 * lingering indefinitely with stale 'active'/'current' labels.
 *
 * Uses STRING_SPLIT (SQL Server 2016+). All LoanDisk loan_ids are numeric so a
 * comma delimiter is safe.
 *
 * @param {string|number} branchId
 * @param {string[]} activeLoanNumbers  All loan numbers currently returned by LoanDisk
 *   for this branch (both Active and Current statuses combined).
 */
export async function markStaleLoansInBranch(branchId, activeLoanNumbers) {
  if (!branchId || !activeLoanNumbers?.length) return { deactivated: 0 }

  const pool = await getPool()

  // Deduplicate and build the comma-separated list.
  const unique = [...new Set(activeLoanNumbers.map(String).filter(Boolean))]
  if (!unique.length) return { deactivated: 0 }

  // Pass the list as a single NVarChar(MAX) parameter — avoids parameter-count
  // limits that a per-row approach would hit for large branches (e.g. E&S: 2931).
  const req = pool.request()
  req.input('BranchId', sql.VarChar(50), String(branchId))
  req.input('LoanList', sql.NVarChar(sql.MAX), unique.join(','))

  const result = await req.query(`
    UPDATE dbo.Staging_LoandiskDueRecords
    SET    LoanStatus = 'inactive',
           SyncedAt   = GETUTCDATE()
    WHERE  BranchId   = @BranchId
      AND  LoanStatus IN ('active', 'current')
      AND  LoanNumber NOT IN (
             SELECT LTRIM(RTRIM(value))
             FROM   STRING_SPLIT(@LoanList, ',')
             WHERE  LTRIM(RTRIM(value)) <> ''
           )
  `)

  return { deactivated: result.rowsAffected?.[0] ?? 0 }
}
