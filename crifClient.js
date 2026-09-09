import { getLoanDiskToken } from './loandisk.js'
import { backfillMonthlyBulkBorrowerUniqueNumber } from './monthlyBulkSql.js'

/**
 * HTTP client for the dbo.CRIF_Operations stored procedure, called through the
 * meanhost API gateway (POST /SP/CRIF_Operations) instead of a direct mssql
 * connection.
 *
 * WHY: the deployment host (Coolify) cannot open a TCP connection to the SQL
 * Server (it is firewalled to specific IPs), but the meanhost API CAN reach the
 * same database. Routing every CRIF call over HTTPS removes the need for the app
 * server to ever talk to port 1433/9933 directly.
 *
 * Contract (verified live):
 *   request  : { Json: "<stringified json>", Condition: "<name>", Type: "" }
 *   response : { code: "SUCCESS", document: "{\"Table\":[ ...rows... ]}" }
 * The `document` is itself a JSON string; its `.Table` array is the recordset
 * (equivalent to mssql's `result.recordset`).
 */
const API_BASE = (process.env.LOANDISK_API_URL || 'https://simplifiedapi.meanhost.in/v1/api').replace(/\/+$/, '')
const CRIF_TIMEOUT_MS = Number(process.env.CRIF_TIMEOUT_MS) || 120_000

function isSuccess(code) {
  return code === undefined || code === 'SUCCESS' || code === 'success' || code === 1
}

/**
 * Execute a CRIF_Operations condition and return its recordset (array of rows).
 * @param {object|array|string} json  payload (object/array is stringified)
 * @param {string} condition          condition selector (e.g. 'Get_Documents')
 * @param {string} [type]
 * @returns {Promise<object[]>}
 */
export async function crif(json, condition, type = '') {
  const token = await getLoanDiskToken()
  const payload = typeof json === 'string' ? json : JSON.stringify(json ?? {})

  const res = await fetch(`${API_BASE}/SP/CRIF_Operations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Json: payload, Condition: condition, Type: type }),
    signal: AbortSignal.timeout(CRIF_TIMEOUT_MS),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || data.title || `CRIF ${condition} HTTP ${res.status}`)
  if (!isSuccess(data.code)) throw new Error(data.message || `CRIF ${condition} failed`)

  let table = []
  try {
    const doc = typeof data.document === 'string' ? JSON.parse(data.document) : data.document
    table = doc?.Table ?? []
  } catch {
    table = []
  }
  return Array.isArray(table) ? table : []
}

function pickField(row, ...keys) {
  for (const key of keys) {
    const val = row?.[key]
    if (val !== undefined && val !== null && String(val).trim() !== '') return val
  }
  return null
}

function normalizeMigrationSummaryRow(row) {
  return {
    id: pickField(row, 'Id', 'id'),
    migrationDate: pickField(row, 'MigrationDate', 'migrationDate'),
    totalFound: Number(pickField(row, 'TotalFound', 'totalFound')) || 0,
    totalMoved: Number(pickField(row, 'TotalMoved', 'totalMoved')) || 0,
    totalFailed: Number(pickField(row, 'TotalFailed', 'totalFailed')) || 0,
    status: pickField(row, 'Status', 'status'),
    errorCodes: pickField(row, 'ErrorCodes', 'errorCodes'),
    totalCount: Number(pickField(row, 'TotalCount', 'totalCount')) || 0,
    nextPage: pickField(row, 'NextPage', 'nextPage'),
    message: pickField(row, 'Message', 'message'),
  }
}

function normalizeMigrationDetailRow(row) {
  return {
    id: pickField(row, 'Id', 'id'),
    migrationLogId: pickField(row, 'MigrationLogId', 'migrationLogId'),
    borrowerId: pickField(row, 'BorrowerId', 'BorrowerID', 'borrowerId', 'borrower_id'),
    contractId: pickField(row, 'ContractId', 'ContractID', 'contractId'),
    errorType: pickField(row, 'ErrorType', 'errorType'),
    errorCode: pickField(row, 'ErrorCode', 'errorCode'),
    errorMessage: pickField(row, 'ErrorMessage', 'errorMessage'),
    borrowerName: pickField(row, 'BorrowerName', 'borrowerName'),
    branchCode: pickField(row, 'BranchCode', 'branchCode'),
    bureauDescription: pickField(row, 'BureauDescription', 'bureauDescription'),
    bureauField: pickField(row, 'BureauField', 'bureauField'),
    message: pickField(row, 'Message', 'message'),
  }
}

function buildErrorSummary(rows) {
  const typeCounts = new Map()
  for (const row of rows) {
    if (!row.errorType) continue
    typeCounts.set(row.errorType, (typeCounts.get(row.errorType) || 0) + 1)
  }
  return [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Query dbo.CRIF_Operations / Get_MigrationLogs.
 * @param {'Summary'|'List'|''} [viewType]
 */
export async function getMigrationLogs({
  pageIndex = 1,
  pageSize = 10,
  viewType = 'Summary',
  id = null,
  borrowerId = null,
  fromDate = null,
  toDate = null,
} = {}) {
  const json = {}
  if (pageIndex) json.PageIndex = Number(pageIndex)
  if (pageSize) json.PageSize = Number(pageSize)
  if (id != null && id !== '') json.Id = Number(id)
  if (borrowerId) json.borrower_id = String(borrowerId).trim()
  if (fromDate) json.FromDate = fromDate
  if (toDate) json.ToDate = toDate

  const type = id != null && id !== '' || borrowerId ? '' : viewType || 'Summary'
  const table = await crif(json, 'Get_MigrationLogs', type)

  if (type === 'Summary' || type === 'List') {
    const runs = table.map(normalizeMigrationSummaryRow)
    return {
      view: type === 'List' ? 'list' : 'summary',
      runs,
      totalCount: runs[0]?.totalCount ?? runs.length,
      nextPage: runs[0]?.nextPage === 'Yes',
      pageIndex: Number(pageIndex) || 1,
      pageSize: Number(pageSize) || 10,
    }
  }

  const rows = table.map(normalizeMigrationDetailRow)

  return {
    view: 'detail',
    migrationLogId: id != null && id !== '' ? Number(id) : rows[0]?.migrationLogId ?? null,
    rows,
    errorSummary: buildErrorSummary(rows),
    borrowersWithIssues: new Set(rows.map((r) => r.borrowerId).filter(Boolean)).size,
    totalCount: rows.length,
  }
}

const FAILED_RECORD_TYPES = new Set(['Subject', 'Contract'])

function normalizeFailedSubjectRow(row) {
  return {
    kind: 'Subject',
    id: pickField(row, 'Id', 'id'),
    errorCode: pickField(row, 'ErrorCode', 'errorCode'),
    errorMessage: pickField(row, 'ErrorMessage', 'errorMessage'),
    errorType: pickField(row, 'ErrorType', 'errorType'),
    accountingDate: pickField(row, 'AccountingDate', 'accountingDate'),
    productionDate: pickField(row, 'ProductionDate', 'productionDate'),
    branchCode: pickField(row, 'BranchCode', 'branchCode'),
    fiCode: pickField(row, 'FICode', 'fiCode'),
    fiSubjectCode: pickField(row, 'FISubjectCode', 'fiSubjectCode'),
    firstName: pickField(row, 'FirstName', 'firstName'),
    lastName: pickField(row, 'LastName', 'lastName'),
    middleName: pickField(row, 'MiddleName', 'middleName'),
    gender: pickField(row, 'Gender', 'gender'),
    dateOfBirth: pickField(row, 'DateOfBirth', 'dateOfBirth'),
    nibNumber: pickField(row, 'NIBNumber', 'nibNumber'),
    addressStreet: pickField(row, 'AddressStreet', 'addressStreet'),
    addressCity: pickField(row, 'AddressCity', 'addressCity'),
    addressCountry: pickField(row, 'AddressCountry', 'addressCountry'),
    mobilePhone: pickField(row, 'MobilePhone', 'mobilePhone'),
    email: pickField(row, 'Email', 'email'),
    employerName: pickField(row, 'EmployerName', 'employerName'),
    occupation: pickField(row, 'Occupation', 'occupation'),
    createdAt: pickField(row, 'CreatedAt', 'createdAt'),
    result: pickField(row, 'Result', 'result'),
    message: pickField(row, 'Message', 'message'),
  }
}

function normalizeFailedContractRow(row) {
  return {
    kind: 'Contract',
    id: pickField(row, 'Id', 'id'),
    errorCode: pickField(row, 'ErrorCode', 'errorCode'),
    errorMessage: pickField(row, 'ErrorMessage', 'errorMessage'),
    errorType: pickField(row, 'ErrorType', 'errorType'),
    accountingDate: pickField(row, 'AccountingDate', 'accountingDate'),
    productionDate: pickField(row, 'ProductionDate', 'productionDate'),
    branchCode: pickField(row, 'BranchCode', 'branchCode'),
    fiCode: pickField(row, 'FICode', 'fiCode'),
    fiSubjectCode: pickField(row, 'FISubjectCode', 'fiSubjectCode'),
    fiContractCode: pickField(row, 'FIContractCode', 'fiContractCode'),
    contractType: pickField(row, 'ContractType', 'contractType'),
    contractPhase: pickField(row, 'ContractPhase', 'contractPhase'),
    contractStatus: pickField(row, 'ContractStatus', 'contractStatus'),
    currency: pickField(row, 'Currency', 'currency'),
    startDate: pickField(row, 'StartDate', 'startDate'),
    maturityDate: pickField(row, 'MaturityDate', 'maturityDate'),
    financedAmount: pickField(row, 'FinancedAmount', 'financedAmount'),
    monthlyInstalmentAmount: pickField(row, 'MonthlyInstalmentAmount', 'monthlyInstalmentAmount'),
    outstandingBalance: pickField(row, 'OutstandingBalance', 'outstandingBalance'),
    daysPastDue: pickField(row, 'DaysPastDue', 'daysPastDue'),
    paymentFrequency: pickField(row, 'PaymentFrequency', 'paymentFrequency'),
    nextPaymentDate: pickField(row, 'NextPaymentDate', 'nextPaymentDate'),
    nextPaymentAmount: pickField(row, 'NextPaymentAmount', 'nextPaymentAmount'),
    createdAt: pickField(row, 'CreatedAt', 'createdAt'),
    result: pickField(row, 'Result', 'result'),
    message: pickField(row, 'Message', 'message'),
  }
}

/**
 * Query dbo.CRIF_Operations / Get_MigrationFailedRecords.
 * EXEC dbo.CRIF_Operations '{"Type":"Subject"}', 'Get_MigrationFailedRecords', 'Subject'
 * EXEC dbo.CRIF_Operations '{"Type":"Contract"}', 'Get_MigrationFailedRecords', 'Contract'
 */
export async function getMigrationFailedRecords({ type = 'Subject' } = {}) {
  const recordType = String(type ?? '').trim()
  if (!FAILED_RECORD_TYPES.has(recordType)) {
    throw new Error('Type must be Subject or Contract')
  }

  const table = await crif({ Type: recordType }, 'Get_MigrationFailedRecords', recordType)
  const rows =
    recordType === 'Contract'
      ? table.map(normalizeFailedContractRow)
      : table.map(normalizeFailedSubjectRow)

  // API may return a single "no data" sentinel row
  const hasData = rows.some((r) => r.errorCode || r.errorMessage || r.errorType || r.fiSubjectCode)
  const dataRows = hasData ? rows.filter((r) => r.errorCode || r.errorMessage || r.errorType) : []

  return {
    type: recordType,
    rows: dataRows,
    errorSummary: buildErrorSummary(dataRows),
    totalCount: dataRows.length,
    message: dataRows[0]?.message || (dataRows.length ? null : 'No failed records found'),
  }
}

const NODE_DATA_TYPES = new Set(['', 'Subject', 'Contract'])
const NODE_BRANCH_IDS = new Set(['18279', '26281', '16209', '36198'])

/** Convert YYYY-MM-DD or DDMMYYYY → DDMMYYYY for Get_NodeCRIFData. */
export function toCrifAccountingDate(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (/^\d{8}$/.test(raw)) {
    const dd = Number(raw.slice(0, 2))
    const mm = Number(raw.slice(2, 4))
    const yyyy = Number(raw.slice(4, 8))
    const d = new Date(yyyy, mm - 1, dd)
    if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) {
      throw new Error('Accounting date is invalid — use a real calendar date (DDMMYYYY)')
    }
    return raw
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [yyyy, mm, dd] = raw.split('-').map(Number)
    const d = new Date(yyyy, mm - 1, dd)
    if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) {
      throw new Error('Accounting date is invalid — use a real calendar date')
    }
    return `${String(dd).padStart(2, '0')}${String(mm).padStart(2, '0')}${yyyy}`
  }
  throw new Error('Accounting date must be DDMMYYYY (e.g. 30062026) or YYYY-MM-DD')
}

function detectNodeRowKind(row) {
  if (row?.FIContractCode != null || row?.ContractRT != null || row?.ContractType != null) return 'Contract'
  if (row?.PersonRT != null || row?.FirstName != null || row?.NIBNumber != null) return 'Subject'
  return 'Unknown'
}

function normalizeNodeCrifRow(row) {
  const kind = detectNodeRowKind(row)
  const base = {
    id: pickField(row, 'Id', 'id'),
    kind,
    accountingDate: pickField(row, 'AccountingDate', 'accountingDate'),
    productionDate: pickField(row, 'ProductionDate', 'productionDate'),
    branchCode: pickField(row, 'BranchCode', 'branchCode'),
    fiSubjectCode: pickField(row, 'FISubjectCode', 'fiSubjectCode'),
    fiCode: pickField(row, 'FICode', 'fiCode'),
    rowNum: Number(pickField(row, 'RowNum', 'rowNum')) || null,
    totalCount: Number(pickField(row, 'TotalCount', 'totalCount')) || 0,
    nextPage: pickField(row, 'NextPage', 'nextPage'),
    message: pickField(row, 'Message', 'message'),
  }

  if (kind === 'Contract') {
    return {
      ...base,
      fiContractCode: pickField(row, 'FIContractCode', 'fiContractCode'),
      contractType: pickField(row, 'ContractType', 'contractType'),
      contractPhase: pickField(row, 'ContractPhase', 'contractPhase'),
      contractStatus: pickField(row, 'ContractStatus', 'contractStatus'),
      currency: pickField(row, 'Currency', 'currency'),
      startDate: pickField(row, 'StartDate', 'startDate'),
      maturityDate: pickField(row, 'MaturityDate', 'maturityDate'),
      financedAmount: pickField(row, 'FinancedAmount', 'financedAmount'),
      monthlyInstalmentAmount: pickField(row, 'MonthlyInstalmentAmount', 'monthlyInstalmentAmount'),
      outstandingBalance: pickField(row, 'OutstandingBalance', 'outstandingBalance'),
      daysPastDue: pickField(row, 'DaysPastDue', 'daysPastDue'),
      paymentFrequency: pickField(row, 'PaymentFrequency', 'paymentFrequency'),
      nextPaymentDate: pickField(row, 'NextPaymentDate', 'nextPaymentDate'),
      nextPaymentAmount: pickField(row, 'NextPaymentAmount', 'nextPaymentAmount'),
    }
  }

  return {
    ...base,
    firstName: pickField(row, 'FirstName', 'firstName'),
    lastName: pickField(row, 'LastName', 'lastName'),
    middleName: pickField(row, 'MiddleName', 'middleName'),
    gender: pickField(row, 'Gender', 'gender'),
    dateOfBirth: pickField(row, 'DateOfBirth', 'dateOfBirth'),
    placeOfBirth: pickField(row, 'PlaceOfBirth', 'placeOfBirth'),
    countryOfCitizenship: pickField(row, 'CountryOfCitizenship', 'countryOfCitizenship'),
    maritalStatus: pickField(row, 'MaritalStatus', 'maritalStatus'),
    nibNumber: pickField(row, 'NIBNumber', 'nibNumber'),
    addressStreet: pickField(row, 'AddressStreet', 'addressStreet'),
    addressCity: pickField(row, 'AddressCity', 'addressCity'),
    addressDistrict: pickField(row, 'AddressDistrict', 'addressDistrict'),
    addressCountry: pickField(row, 'AddressCountry', 'addressCountry'),
    mobilePhone: pickField(row, 'MobilePhone', 'mobilePhone'),
    email: pickField(row, 'Email', 'email'),
    employerName: pickField(row, 'EmployerName', 'employerName'),
    occupation: pickField(row, 'Occupation', 'occupation'),
  }
}

/**
 * Query dbo.CRIF_Operations / Get_NodeCRIFData (Subject / Contract / both).
 */
export async function getNodeCrifData({
  pageIndex = 1,
  pageSize = 20,
  type = '',
  accountingDate,
  branch = null,
  borrowerId = null,
} = {}) {
  if (!accountingDate) throw new Error('Accounting date is required')

  let accounting
  try {
    accounting = toCrifAccountingDate(accountingDate)
  } catch (e) {
    throw new Error(e.message)
  }

  const page = Number(pageIndex)
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('Page number must be a whole number of 1 or greater')
  }

  let size = pageSize
  if (size === '' || size == null) {
    size = ''
  } else {
    size = Number(size)
    if (!Number.isInteger(size) || size < 1) {
      throw new Error('Page size must be a whole number of 1 or greater, or left blank')
    }
    if (size > 500) {
      throw new Error('Page size cannot exceed 500')
    }
  }

  const dataType = String(type ?? '').trim()
  if (!NODE_DATA_TYPES.has(dataType)) {
    throw new Error('Type must be Subject, Contract, or All')
  }

  const branchId = branch != null && String(branch).trim() !== '' ? String(branch).trim() : null
  if (branchId) {
    if (!/^\d+$/.test(branchId)) throw new Error('Branch must be a numeric branch ID')
    if (!NODE_BRANCH_IDS.has(branchId)) {
      throw new Error('Branch must be one of: Simplified Lending, E&S, SBDC, or SL Business loan')
    }
  }

  const borrower = borrowerId != null && String(borrowerId).trim() !== '' ? String(borrowerId).trim() : null
  if (borrower && !/^\d+$/.test(borrower)) {
    throw new Error('Borrower ID must contain digits only')
  }

  const json = {
    PageIndex: page,
    PageSize: size === '' ? '' : size,
    AccountingDate: accounting,
  }
  if (dataType) json.Type = dataType
  if (branchId) json.Branch = branchId
  if (borrower) json.borrower_id = borrower

  const crifType = dataType // Subject | Contract | ''
  const table = await crif(json, 'Get_NodeCRIFData', crifType)
  const rows = table.map(normalizeNodeCrifRow)

  return {
    type: dataType || 'All',
    accountingDate: accounting,
    pageIndex: page,
    pageSize: size === '' ? null : size,
    branch: branchId,
    borrowerId: borrower,
    rows,
    totalCount: rows[0]?.totalCount ?? rows.length,
    nextPage: rows[0]?.nextPage === 'Yes',
    message: rows[0]?.message || null,
  }
}

function normalizePullFailureRow(row) {
  return {
    borrowerId: pickField(row, 'BorrowerId', 'BorrowerID', 'borrowerId', 'borrower_id'),
    contractId: pickField(row, 'ContractId', 'ContractID', 'contractId'),
    errorType: pickField(row, 'ErrorType', 'errorType'),
    errorCode: pickField(row, 'ErrorCode', 'errorCode'),
    errorMessage: pickField(row, 'ErrorMessage', 'errorMessage'),
  }
}

function groupFailuresByBorrower(rows) {
  const map = new Map()
  for (const row of rows) {
    const id = row.borrowerId ? String(row.borrowerId) : ''
    if (!id) continue
    if (!map.has(id)) map.set(id, { borrowerId: id, issues: [] })
    map.get(id).issues.push(row)
  }

  return [...map.values()].map((group) => {
    const primary =
      group.issues.find((issue) => !issue.contractId && issue.errorType) ||
      group.issues.find((issue) => issue.errorType) ||
      group.issues[0]
    return {
      borrowerId: group.borrowerId,
      contractId: primary?.contractId ?? null,
      errorType: primary?.errorType ?? null,
      errorCode: primary?.errorCode ?? null,
      errorMessage: primary?.errorMessage ?? null,
      issueCount: group.issues.length,
      issues: group.issues,
    }
  })
}

/**
 * Parse PullBorrowerFromMonthlyBull `document` payload into sync outcomes.
 * @param {string|object} document
 * @param {string[]} [requestedIds]
 */
export function parsePullBorrowerDocument(document, requestedIds = []) {
  let doc = document
  if (typeof document === 'string') {
    try {
      doc = JSON.parse(document)
    } catch {
      doc = {}
    }
  }

  const summaryRaw = doc?.Summary ?? {}
  const failureRows = Array.isArray(doc?.Data) ? doc.Data.map(normalizePullFailureRow) : []
  const failedBorrowers = groupFailuresByBorrower(failureRows)
  const failedBorrowerIds = failedBorrowers.map((row) => row.borrowerId)
  const failedIdSet = new Set(failedBorrowerIds)

  const requested = (requestedIds || []).map((id) => String(id).trim()).filter(Boolean)
  const movedBorrowerIds = requested.length
    ? requested.filter((id) => !failedIdSet.has(id))
    : []

  return {
    summary: {
      totalFound: Number(summaryRaw.TotalFound) || requested.length || 0,
      totalMoved: Number(summaryRaw.TotalMoved) || movedBorrowerIds.length || 0,
      totalFailed: Number(summaryRaw.TotalFailed) || failedBorrowers.length || 0,
    },
    failures: failureRows,
    failedBorrowers,
    failedBorrowerIds,
    movedBorrowerIds,
    errorSummary: buildErrorSummary(failureRows),
  }
}

/**
 * Pull borrowers from Monthly Bull into the main borrower tables.
 * POST /SP/PullBorrowerFromMonthlyBull
 */
export async function pullBorrowerFromMonthlyBull({
  branchIDs = '',
  borrowerIDs = '',
  performMigration = true,
  requestedIds = null,
} = {}) {
  const token = await getLoanDiskToken()
  const res = await fetch(`${API_BASE}/SP/PullBorrowerFromMonthlyBull`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branchIDs: String(branchIDs ?? '').trim(),
      borrowerIDs: String(borrowerIDs ?? '').trim(),
      performMigration: Boolean(performMigration),
    }),
    signal: AbortSignal.timeout(CRIF_TIMEOUT_MS),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || data.title || `PullBorrowerFromMonthlyBull HTTP ${res.status}`)
  if (!isSuccess(data.code)) throw new Error(data.message || 'PullBorrowerFromMonthlyBull failed')

  const idsFromParam =
    requestedIds ??
    String(borrowerIDs ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  const syncResult = parsePullBorrowerDocument(data.document, idsFromParam)

  let uniqueNumberBackfill = { skipped: true, reason: 'not run' }
  try {
    uniqueNumberBackfill = await backfillMonthlyBulkBorrowerUniqueNumber({
      borrowerIds: idsFromParam.length ? idsFromParam : null,
    })
  } catch (err) {
    uniqueNumberBackfill = { skipped: true, reason: err.message }
  }

  return {
    ok: true,
    code: data.code ?? null,
    message: data.message || 'Migration started',
    branchIDs: data.branchIDs ?? String(branchIDs ?? '').trim(),
    borrowerIDs: data.borrowerIDs ?? String(borrowerIDs ?? '').trim(),
    performMigration: data.performMigration ?? Boolean(performMigration),
    syncResult,
    uniqueNumberBackfill,
  }
}

/** Universal sync branches — matches db-check pipeline and Simplified dashboard. */
export const CRIF_SYNC_BRANCHES = [
  { id: '18279', label: 'Simplified Lending' },
  { id: '26281', label: 'E&S' },
]
export const CRIF_SYNC_BRANCH_IDS = CRIF_SYNC_BRANCHES.map((b) => b.id)

function newestTimestamp(...values) {
  const dates = values
    .map((v) => (v ? new Date(v) : null))
    .filter((d) => d && !Number.isNaN(d.getTime()))
  if (!dates.length) return null
  return new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString()
}

/** Snapshot from NodeCRIF_* via Get_NodeCRIFData (CreatedAt ≈ last row load on SQL). */
async function fetchBranchNodeSnapshot(branchId, type) {
  const table = await crif(
    { Type: type, Branch: branchId, PageIndex: 1, PageSize: 1 },
    'Get_NodeCRIFData',
    type
  )
  const row = table[0] || {}
  return {
    recordCount: Number(pickField(row, 'TotalCount', 'totalCount')) || 0,
    lastUpdated: pickField(row, 'CreatedAt', 'createdAt'),
    accountingDate: pickField(row, 'AccountingDate', 'accountingDate'),
    productionDate: pickField(row, 'ProductionDate', 'productionDate'),
  }
}

/**
 * Branch sync status for universal CRIF pull (18279 + 26281).
 * Last updated comes from NodeCRIF_SubjectData / NodeCRIF_ContractData CreatedAt on SQL.
 */
export async function getCrifSyncStatus() {
  const migration = await getMigrationLogs({ viewType: 'Summary', pageIndex: 1, pageSize: 1 })
  const latestMigration = migration.runs[0] || null

  const branches = await Promise.all(
    CRIF_SYNC_BRANCHES.map(async (branch) => {
      const [subject, contract] = await Promise.all([
        fetchBranchNodeSnapshot(branch.id, 'Subject'),
        fetchBranchNodeSnapshot(branch.id, 'Contract'),
      ])
      return {
        branchId: branch.id,
        label: branch.label,
        subjectCount: subject.recordCount,
        contractCount: contract.recordCount,
        accountingDate: subject.accountingDate || contract.accountingDate,
        productionDate: subject.productionDate || contract.productionDate,
        subjectLastUpdated: subject.lastUpdated,
        contractLastUpdated: contract.lastUpdated,
        lastUpdated: newestTimestamp(subject.lastUpdated, contract.lastUpdated),
      }
    })
  )

  return {
    branches,
    latestMigration,
    lastUpdated: newestTimestamp(
      ...branches.map((b) => b.lastUpdated),
      latestMigration?.migrationDate
    ),
  }
}

/** Pull + migrate all borrowers for Simplified Lending and E&S. */
export async function runUniversalCrifSync({ performMigration = true } = {}) {
  const branchIDs = CRIF_SYNC_BRANCH_IDS.join(',')
  const result = await pullBorrowerFromMonthlyBull({
    branchIDs,
    borrowerIDs: '',
    performMigration,
  })
  return {
    ...result,
    branchIds: [...CRIF_SYNC_BRANCH_IDS],
    universal: true,
  }
}

const GENERATE_BRANCH_IDS = new Set(['18279', '26281', '16209', '36198', '51238'])
const SPECIAL_ASCII_LABELS = new Set(['RS', 'GS', 'US', 'FS'])

function resolveAsciiCharType(asciiCode, asciiCustom) {
  if (!asciiCode) throw new Error('ASCII code is required')
  if (asciiCode === 'Other') {
    const custom = String(asciiCustom ?? '').trim()
    if (!custom) throw new Error('Enter a hard stop code when ASCII is set to Other')
    if (!/^\d+$/.test(custom)) throw new Error('Hard stop code must contain digits only')
    return custom
  }
  return String(asciiCode)
}

function resolveCharacterLength(category, length, lengthCustom, asciiLabel) {
  const cat = category === 'Contract' ? 'Contract' : 'Borrower'
  let resolved = ''
  if (length === 'Other') {
    resolved = String(lengthCustom ?? '').trim()
    if (!resolved) throw new Error('Enter a character length when Other is selected')
    if (!/^\d+$/.test(resolved)) throw new Error('Character length must contain digits only')
  } else if (length) {
    resolved = String(length)
    if (!/^\d+$/.test(resolved)) throw new Error('Character length must contain digits only')
  } else {
    throw new Error('Character length is required')
  }

  const asciiValue = asciiLabel === 'CR+LF' ? 'CR+LF' : asciiLabel
  if (SPECIAL_ASCII_LABELS.has(asciiValue)) {
    return String(Number(resolved) - 1)
  }
  return resolved
}

const LEGACY_GENERATE_CONFIG = {
  Borrower: {
    endpoint: '/SP/Generate_CRIFFile1',
    condition: 'GetBorrowerforSubjectdata',
  },
  Contract: {
    endpoint: '/SP/Generate_CRIFContractFile1',
    condition: 'GetContractdata',
  },
}

async function postGenerateCrifEndpoint(token, endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CRIF_TIMEOUT_MS),
  })
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

function extractFileUrl(data) {
  const fileUrl = data?.document != null ? String(data.document).trim() : ''
  return fileUrl.startsWith('http') ? fileUrl : ''
}

function isTransientSpError(message) {
  const msg = String(message ?? '').toLowerCase()
  return (
    msg.includes('invalid data returned from sp') ||
    msg.includes('exception in crif') ||
    msg.includes('timeout') ||
    msg.includes('temporar')
  )
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** Call generate endpoint with short retries — the meanhost SP is intermittently flaky. */
async function postGenerateWithRetries(token, endpoint, body, { retries = 3, delayMs = 1500 } = {}) {
  let last = { res: null, data: {} }
  for (let attempt = 1; attempt <= retries; attempt++) {
    last = await postGenerateCrifEndpoint(token, endpoint, body)
    if (last.res?.ok && isSuccess(last.data.code) && extractFileUrl(last.data)) {
      return last
    }
    const msg = last.data?.message || ''
    const shouldRetry =
      attempt < retries &&
      (isTransientSpError(msg) || !last.res?.ok)
    if (!shouldRetry) break
    await sleep(delayMs * attempt)
  }
  return last
}

/**
 * Dynamic generate often fails with "Invalid data returned from SP" when the
 * node generate tables are empty/stale. A Monthly Bull pull + migration
 * refreshes them — then generate succeeds (verified live).
 */
async function attemptGenerateVariants({
  token,
  category,
  branches,
  borrower,
  resolvedLength,
  charType,
}) {
  const isContract = category === 'Contract'
  const dynamicEndpoint = isContract
    ? '/SP/Generate_CRIFContractFileDynamic'
    : '/SP/Generate_CRIFSubFileDynamic'
  const dynamicCondition = isContract ? 'GetNodeContractdata' : 'GetBorrowerforNodeSubjectdata'
  const legacy = LEGACY_GENERATE_CONFIG[category]
  const allBranches = branches.join(',')

  const buildAttempts = () => {
    const orderedBranches = isContract
      ? [...branches].sort((a, b) => Number(b === '26281') - Number(a === '26281'))
      : branches
    const branchCombos = [orderedBranches.join(','), ...orderedBranches]
    const seen = new Set()
    const attempts = []
    for (const combo of branchCombos) {
      if (!combo || seen.has(combo)) continue
      seen.add(combo)
      attempts.push({
        endpoint: dynamicEndpoint,
        condition: dynamicCondition,
        body: {
          Json: JSON.stringify({ Branch: combo, borrower_id: borrower }),
          Length: resolvedLength,
          CharType: charType,
          Condition: dynamicCondition,
          Type: '',
        },
        usedFallback: false,
        pulledFresh: false,
        branchIds: combo.split(','),
        retries: 2,
      })
    }
    if (!isContract) {
      for (const combo of [...seen]) {
        attempts.push({
          endpoint: legacy.endpoint,
          condition: legacy.condition,
          body: {
            Json: JSON.stringify({ Branch: combo, borrower_id: borrower }),
            Condition: legacy.condition,
            Type: '',
          },
          usedFallback: true,
          pulledFresh: false,
          branchIds: combo.split(','),
          retries: 1,
        })
      }
    }
    return attempts
  }

  async function runAttempts(attempts, pulledFresh = false) {
    let lastError = 'Failed to generate CRIF file'
    for (const attempt of attempts) {
      const { res, data } = await postGenerateWithRetries(
        token,
        attempt.endpoint,
        attempt.body,
        { retries: attempt.retries, delayMs: 800 }
      )
      if (!res?.ok) {
        lastError = data.message || data.title || `Generate CRIF file HTTP ${res?.status || 'error'}`
        continue
      }
      if (!isSuccess(data.code)) {
        lastError = data.message || lastError
        continue
      }
      const fileUrl = extractFileUrl(data)
      if (!fileUrl) {
        lastError = 'No data found — the API returned an empty file URL'
        continue
      }
      return {
        data,
        fileUrl,
        endpoint: attempt.endpoint,
        condition: attempt.condition,
        usedFallback: attempt.usedFallback,
        pulledFresh,
        branchIds: attempt.branchIds,
      }
    }
    const err = new Error(lastError)
    err.lastError = lastError
    throw err
  }

  // Pass 1 — try with current node data
  let firstError = null
  try {
    return await runAttempts(buildAttempts(), false)
  } catch (err) {
    firstError = err
    if (!isTransientSpError(err.message) && !String(err.message).toLowerCase().includes('no data')) {
      throw err
    }
  }

  // Pass 2 — refresh node tables via Monthly Bull pull, then generate again
  try {
    await pullBorrowerFromMonthlyBull({
      branchIDs: allBranches,
      borrowerIDs: borrower || '',
      performMigration: true,
    })
  } catch (pullErr) {
    throw new Error(
      `Generate failed (${firstError?.message || 'Invalid data returned from SP'}) and refresh pull also failed: ${pullErr.message}`
    )
  }

  await sleep(500)
  return await runAttempts(buildAttempts(), true)
}

/**
 * Generate CRIF subject/contract file (matches simplified Generate File flow).
 * Borrower  → POST /SP/Generate_CRIFSubFileDynamic (auto-pulls Monthly Bull if SP has no data)
 * Contract  → POST /SP/Generate_CRIFContractFileDynamic (auto-pulls Monthly Bull if SP has no data)
 */
export async function generateCrifFile({
  category = 'Borrower',
  branchIds = [],
  borrowerId = '',
  asciiCode = '1',
  asciiCustom = '',
  length = '1500',
  lengthCustom = '',
} = {}) {
  const cat = String(category).trim()
  if (!['Borrower', 'Contract'].includes(cat)) {
    throw new Error('Category must be Borrower or Contract')
  }

  const branches = [...new Set((Array.isArray(branchIds) ? branchIds : String(branchIds).split(','))
    .map((id) => String(id).trim())
    .filter(Boolean))]

  if (!branches.length) throw new Error('Select at least one company')

  for (const branch of branches) {
    if (!GENERATE_BRANCH_IDS.has(branch)) {
      throw new Error(`Invalid branch ID: ${branch}`)
    }
  }

  const borrower = String(borrowerId ?? '').trim()
  if (borrower && !/^\d+$/.test(borrower)) {
    throw new Error('Borrower ID must contain digits only')
  }

  const asciiLabel =
    asciiCode === '1' ? 'CR+LF' : asciiCode === 'Other' ? String(asciiCustom ?? '').trim() : String(asciiCode)
  const charType = resolveAsciiCharType(asciiCode, asciiCustom)
  const resolvedLength = resolveCharacterLength(cat, length, lengthCustom, asciiLabel)

  const token = await getLoanDiskToken()

  let result
  try {
    result = await attemptGenerateVariants({
      token,
      category: cat,
      branches,
      borrower,
      resolvedLength,
      charType,
    })
  } catch (e) {
    const hint =
      cat === 'Contract'
        ? ' Try again, or run CRIF → Borrower pull for the selected companies first.'
        : ' Try again, or run CRIF → Borrower pull for the selected companies first.'
    throw new Error((e.message || 'Failed to generate CRIF file') + hint)
  }

  return {
    ok: true,
    code: result.data.code ?? null,
    message: result.pulledFresh
      ? `${result.data.message || 'CRIF file generated successfully'} (refreshed Monthly Bull data first)`
      : result.data.message || 'CRIF file generated successfully',
    fileUrl: result.fileUrl,
    category: cat,
    branchIds: result.branchIds,
    requestedBranchIds: branches,
    borrowerId: borrower || null,
    length: result.usedFallback ? null : resolvedLength,
    charType: result.usedFallback ? null : charType,
    condition: result.condition,
    endpoint: result.endpoint,
    usedFallback: result.usedFallback,
    pulledFresh: Boolean(result.pulledFresh),
  }
}
