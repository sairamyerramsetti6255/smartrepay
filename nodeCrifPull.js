/**
 * Excel borrower IDs → LoanDisk API → NodeCRIF_SubjectData / NodeCRIF_ContractData
 * on online SQL Server (Simplified_db).
 */
import sql from 'mssql'
import { getSqlServerConfig } from './scripts/sqlServerConfig.mjs'
import {
  buildSubjectRow,
  buildContractRow,
  lastDayPrevMonthDDMMYYYY,
  todayDDMMYYYY,
  pick,
} from './crifLoandiskMap.js'

const DEFAULT_BRANCHES = ['18279', '26281']
const API_DELAY_MS = Number(process.env.CRIF_LOANDISK_DELAY_MS) || 80
const LOAN_PAGE_SIZE = 50

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function loandiskConfig() {
  const baseUrl = (process.env.LOANDISK_BASE_URL || 'https://api-main.loandisk.com').replace(/\/+$/, '')
  const publicKey = process.env.LOANDISK_PUBLIC_KEY || ''
  const authToken = process.env.LOANDISK_AUTH_TOKEN || ''
  if (!publicKey || !authToken) {
    throw new Error('Set LOANDISK_PUBLIC_KEY and LOANDISK_AUTH_TOKEN in server/.env')
  }
  return { baseUrl, publicKey, authToken }
}

function flattenResults(payload) {
  const results = payload?.response?.Results ?? payload?.Results ?? []
  if (!Array.isArray(results)) return []
  return results.flatMap((inner) => (Array.isArray(inner) ? inner : [inner])).filter(Boolean)
}

async function loandiskGet(branchId, path) {
  const { baseUrl, publicKey, authToken } = loandiskConfig()
  const url = `${baseUrl}/${publicKey}/${branchId}/${String(path).replace(/^\/+/, '')}`
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${authToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (data?.error) {
    const code = data.error.code || res.status
    const msg = data.error.message || 'LoanDisk error'
    const err = new Error(`LoanDisk ${code}: ${msg}`)
    err.loandiskCode = code
    err.notFound = String(code) === '404' || /not found/i.test(msg)
    throw err
  }
  if (!res.ok) {
    const err = new Error(`LoanDisk HTTP ${res.status}`)
    err.notFound = res.status === 404
    throw err
  }
  return data
}

async function findBorrowerAcrossBranches(borrowerId, branchIds) {
  let lastError = null
  for (const branchId of branchIds) {
    try {
      const rows = flattenResults(await loandiskGet(branchId, `borrower/${borrowerId}`))
      if (rows[0]) return { borrower: rows[0], branchId }
    } catch (err) {
      lastError = err
      if (!err.notFound) throw err
    }
  }
  if (lastError?.notFound) return null
  if (lastError) throw lastError
  return null
}

function pickLoan(loans) {
  if (!loans?.length) return null
  return loans.find((l) => String(l.loan_status_id) === '1') || loans[0]
}

async function insertRow(requestFactory, table, row, extra = {}) {
  const all = { ...row, ...extra }
  const cols = Object.keys(all).filter((c) => all[c] !== undefined)
  const req = requestFactory()
  cols.forEach((c, i) => req.input(`p${i}`, all[c] ?? null))
  await req.query(
    `INSERT INTO dbo.${table} (${cols.map((c) => `[${c}]`).join(',')}) VALUES (${cols.map((_, i) => `@p${i}`).join(',')})`
  )
}

async function replaceBorrowerRows(pool, subjectCode, subjectRow, contractRow, raw) {
  const tx = new sql.Transaction(pool)
  await tx.begin()
  try {
    const makeRequest = () => new sql.Request(tx)
    await makeRequest()
      .input('code', sql.NVarChar(50), String(subjectCode))
      .query(`
        DELETE FROM dbo.NodeCRIF_ContractData WHERE LTRIM(RTRIM(FISubjectCode)) = LTRIM(RTRIM(@code));
        DELETE FROM dbo.NodeCRIF_SubjectData WHERE LTRIM(RTRIM(FISubjectCode)) = LTRIM(RTRIM(@code));
      `)

    await insertRow(makeRequest, 'NodeCRIF_SubjectData', subjectRow, {
      RawBorrowerJson: raw.borrowerJson,
      IsGenerated: false,
    })
    await insertRow(makeRequest, 'NodeCRIF_ContractData', contractRow, {
      RawLoanJson: raw.loanJson,
      RawRepaymentJson: raw.repaymentJson,
      IsGenerated: false,
    })
    await tx.commit()
  } catch (err) {
    try {
      await tx.rollback()
    } catch {
      /* ignore */
    }
    throw err
  }
}

async function resolveBatchMeta(pool) {
  const existing = (
    await pool.request().query(`
      SELECT TOP 1 AccountingDate, ProductionDate, PrograssiveNumber, FICode
      FROM dbo.NodeCRIF_SubjectData
      ORDER BY Id DESC
    `)
  ).recordset[0]

  return {
    AccountingDate: existing?.AccountingDate || lastDayPrevMonthDDMMYYYY(),
    ProductionDate: todayDDMMYYYY(),
    PrograssiveNumber: String(existing?.PrograssiveNumber || '001').padStart(3, '0').slice(-3),
    FICode: existing?.FICode || 'SILML',
  }
}

/**
 * Pull borrowers from LoanDisk and upsert into NodeCRIF_* tables.
 * @param {{ borrowerIds: string[], branchIds?: string[], onProgress?: Function }} opts
 */
export async function pullBorrowersToNodeCrif({
  borrowerIds = [],
  branchIds = DEFAULT_BRANCHES,
  onProgress,
} = {}) {
  const ids = [...new Set((borrowerIds || []).map((id) => String(id).trim()).filter(Boolean))]
  if (!ids.length) throw new Error('No borrower IDs provided')

  const branches = (branchIds?.length ? branchIds : DEFAULT_BRANCHES).map(String)
  const pool = await new sql.ConnectionPool(getSqlServerConfig()).connect()

  const synced = []
  const failed = []
  const batch = await resolveBatchMeta(pool)

  try {
    for (let i = 0; i < ids.length; i++) {
      const borrowerId = ids[i]
      onProgress?.({ index: i + 1, total: ids.length, borrowerId })

      try {
        const found = await findBorrowerAcrossBranches(borrowerId, branches)
        if (!found) {
          failed.push({
            borrowerId,
            name: null,
            errorType: 'NOT_FOUND',
            errorCode: '404',
            errorMessage: `Borrower not found in LoanDisk branches ${branches.join(', ')}`,
            issueCount: 1,
            issues: [],
          })
          await sleep(API_DELAY_MS)
          continue
        }

        const { borrower, branchId } = found
        const loans = flattenResults(
          await loandiskGet(branchId, `loan/borrower/${borrowerId}/from/1/count/${LOAN_PAGE_SIZE}`)
        )
        const loan = pickLoan(loans)
        if (!loan) {
          failed.push({
            borrowerId,
            name: `${pick(borrower, 'borrower_firstname')} ${pick(borrower, 'borrower_lastname')}`.trim() || null,
            errorType: 'NO_LOAN',
            errorCode: 'NO_LOAN',
            errorMessage: 'Borrower found in LoanDisk but has no loans',
            branchId,
            issueCount: 1,
            issues: [],
          })
          await sleep(API_DELAY_MS)
          continue
        }

        let repayment = null
        if (loan.loan_id) {
          try {
            const repPayload = await loandiskGet(
              branchId,
              `repayment/loan/${loan.loan_id}/from/1/count/1?sort_by=repayment_id&sort_direction=desc`
            )
            repayment = flattenResults(repPayload)[0] || null
          } catch {
            repayment = null
          }
        }

        batch.FICode = pick(borrower, 'custom_field_6813') || batch.FICode
        const subjectRow = buildSubjectRow(borrower, loan, batch, branchId)
        const contractRow = buildContractRow(loan, borrower, repayment, batch, branchId)
        const subjectCode = subjectRow.FISubjectCode || borrowerId

        await replaceBorrowerRows(pool, subjectCode, subjectRow, contractRow, {
          borrowerJson: JSON.stringify(borrower),
          loanJson: JSON.stringify(loan),
          repaymentJson: repayment ? JSON.stringify(repayment) : null,
        })

        synced.push({
          borrowerId: String(subjectCode),
          name:
            `${pick(borrower, 'borrower_firstname')} ${pick(borrower, 'borrower_lastname')}`.trim() ||
            null,
          branchId,
          loanId: String(loan.loan_id || ''),
          contractCode: contractRow.FIContractCode || null,
          uniqueNumber: pick(borrower, 'borrower_unique_number') || null,
        })
      } catch (err) {
        failed.push({
          borrowerId,
          name: null,
          errorType: 'PULL_ERROR',
          errorCode: err.loandiskCode || 'ERROR',
          errorMessage: String(err.message || err).slice(0, 400),
          issueCount: 1,
          issues: [],
        })
      }

      await sleep(API_DELAY_MS)
    }
  } finally {
    await pool.close()
  }

  return {
    ok: true,
    message: `Pulled ${synced.length} of ${ids.length} borrowers into NodeCRIF tables`,
    syncResult: {
      summary: {
        totalFound: ids.length,
        totalMoved: synced.length,
        totalFailed: failed.length,
      },
      movedBorrowerIds: synced.map((r) => r.borrowerId),
      failedBorrowerIds: failed.map((r) => r.borrowerId),
      failedBorrowers: failed,
      syncedBorrowers: synced,
      failures: failed.map((f) => ({
        borrowerId: f.borrowerId,
        contractId: null,
        errorType: f.errorType,
        errorCode: f.errorCode,
        errorMessage: f.errorMessage,
      })),
      errorSummary: Object.entries(
        failed.reduce((acc, f) => {
          const t = f.errorType || 'UNKNOWN'
          acc[t] = (acc[t] || 0) + 1
          return acc
        }, {})
      ).map(([type, count]) => ({ type, count })),
    },
    batch,
    branchIds: branches,
  }
}
