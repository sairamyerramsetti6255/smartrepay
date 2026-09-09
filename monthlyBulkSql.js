import sql from 'mssql'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function getSqlConfig() {
  const password = process.env.DB_PASSWORD
  if (!password) return null

  return {
    server: process.env.DB_SERVER || '185.136.157.11',
    port: Number(process.env.DB_PORT || 9933),
    database: process.env.DB_DATABASE || 'Simplified_db',
    user: process.env.DB_USER || 'Simplified_user',
    password,
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
    },
    connectionTimeout: 30_000,
    requestTimeout: 120_000,
  }
}

/**
 * Populate borrowerUniqueNumber from LoanDisk JSON already stored on MonthlyBulk rows.
 * Runs after PullBorrowerFromMonthlyBull when meanhost does not map the column yet.
 */
export async function backfillMonthlyBulkBorrowerUniqueNumber({ borrowerIds = null } = {}) {
  const config = getSqlConfig()
  if (!config) {
    return { skipped: true, reason: 'DB_PASSWORD not configured' }
  }

  const pool = await sql.connect(config)
  try {
    const ids = (borrowerIds || []).map((id) => String(id).trim()).filter(Boolean)
    const hasFilter = ids.length > 0

    const subjectWhere = hasFilter
      ? `AND (s.FISubjectCode IN (${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')})
            OR s.borrowerUniqueNumber IN (${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}))`
      : ''

    const contractWhere = hasFilter
      ? `AND (c.FISubjectCode IN (${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')})
            OR c.borrowerUniqueNumber IN (${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')}))`
      : ''

    const subjectResult = await pool.request().query(`
      UPDATE s
      SET borrowerUniqueNumber = NULLIF(LTRIM(RTRIM(JSON_VALUE(s.RawBorrowerJson, '$.borrower_unique_number'))), '')
      FROM dbo.MonthlyBulkSubjectData s
      WHERE (s.borrowerUniqueNumber IS NULL OR LTRIM(RTRIM(s.borrowerUniqueNumber)) = '')
        AND s.RawBorrowerJson IS NOT NULL
        AND ISJSON(s.RawBorrowerJson) = 1
        AND JSON_VALUE(s.RawBorrowerJson, '$.borrower_unique_number') IS NOT NULL
        ${subjectWhere};
      SELECT @@ROWCOUNT AS updated;
    `)

    const contractResult = await pool.request().query(`
      UPDATE c
      SET borrowerUniqueNumber = NULLIF(LTRIM(RTRIM(JSON_VALUE(c.RawLoanJson, '$.borrower_unique_number'))), '')
      FROM dbo.MonthlyBulkContractData c
      WHERE (c.borrowerUniqueNumber IS NULL OR LTRIM(RTRIM(c.borrowerUniqueNumber)) = '')
        AND c.RawLoanJson IS NOT NULL
        AND ISJSON(c.RawLoanJson) = 1
        AND JSON_VALUE(c.RawLoanJson, '$.borrower_unique_number') IS NOT NULL
        ${contractWhere};
      SELECT @@ROWCOUNT AS updated;
    `)

    return {
      skipped: false,
      subjectUpdated: Number(subjectResult.recordset?.[0]?.updated) || 0,
      contractUpdated: Number(contractResult.recordset?.[0]?.updated) || 0,
      filteredBorrowerIds: hasFilter ? ids.length : 0,
    }
  } finally {
    await pool.close()
  }
}

/**
 * Apply column migration + full backfill (npm script / one-off).
 */
export async function applyMonthlyBulkBorrowerUniqueNumberMigration() {
  const config = getSqlConfig()
  if (!config) throw new Error('Set DB_PASSWORD in server/.env before running SQL migrations.')

  const sqlText = fs.readFileSync(
    path.join(__dirname, 'sql', 'add-monthly-bulk-borrower-unique-number.sql'),
    'utf8'
  )
  const batches = sqlText.split(/^\s*GO\s*$/gim).map((b) => b.trim()).filter(Boolean)

  const pool = await sql.connect(config)
  try {
    for (const batch of batches) {
      await pool.request().query(batch)
    }

    const verify = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.MonthlyBulkSubjectData WHERE borrowerUniqueNumber IS NOT NULL AND borrowerUniqueNumber <> '') AS subjectWithUnique,
        (SELECT COUNT(*) FROM dbo.MonthlyBulkContractData WHERE borrowerUniqueNumber IS NOT NULL AND borrowerUniqueNumber <> '') AS contractWithUnique,
        (SELECT COUNT(*) FROM dbo.MonthlyBulkSubjectData) AS subjectTotal,
        (SELECT COUNT(*) FROM dbo.MonthlyBulkContractData) AS contractTotal
    `)

    return verify.recordset[0]
  } finally {
    await pool.close()
  }
}
