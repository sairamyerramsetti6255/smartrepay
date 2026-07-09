import { getLoanDiskToken } from './loandisk.js'

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

/**
 * Pull borrowers from Monthly Bull into the main borrower tables.
 * POST /SP/PullBorrowerFromMonthlyBull
 */
export async function pullBorrowerFromMonthlyBull({ branchIDs = '', borrowerIDs = '', performMigration = true } = {}) {
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

  return {
    ok: true,
    code: data.code ?? null,
    message: data.message || 'Migration started',
    branchIDs: data.branchIDs ?? String(branchIDs ?? '').trim(),
    borrowerIDs: data.borrowerIDs ?? String(borrowerIDs ?? '').trim(),
    performMigration: data.performMigration ?? Boolean(performMigration),
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

/**
 * Generate CRIF subject/contract file (matches simplified Generate File flow).
 * Borrower  → POST /SP/Generate_CRIFSubFileDynamic
 * Contract  → POST /SP/Generate_CRIFContractFileDynamic
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

  const jsonPayload = {
    Branch: branches.join(','),
    borrower_id: borrower,
  }

  const isContract = cat === 'Contract'
  const endpoint = isContract ? '/SP/Generate_CRIFContractFileDynamic' : '/SP/Generate_CRIFSubFileDynamic'
  const condition = isContract ? 'GetNodeContractdata' : 'GetBorrowerforNodeSubjectdata'

  const token = await getLoanDiskToken()
  const body = {
    Json: JSON.stringify(jsonPayload),
    Length: resolvedLength,
    CharType: charType,
    Condition: condition,
    Type: '',
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CRIF_TIMEOUT_MS),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || data.title || `Generate CRIF file HTTP ${res.status}`)
  if (!isSuccess(data.code)) throw new Error(data.message || 'Failed to generate CRIF file')

  const fileUrl = data.document != null ? String(data.document).trim() : ''
  if (!fileUrl) throw new Error('No data found — the API returned an empty file URL')

  return {
    ok: true,
    code: data.code ?? null,
    message: data.message || 'CRIF file generated successfully',
    fileUrl,
    category: cat,
    branchIds: branches,
    borrowerId: borrower || null,
    length: resolvedLength,
    charType,
    condition,
    endpoint,
  }
}
