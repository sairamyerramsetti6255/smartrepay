import * as XLSX from 'xlsx'

const BORROWER_HEADER_ALIASES = new Set([
  'borrowerid',
  'borrower id',
  'borrower_id',
  'borrowerids',
  'borrower ids',
  'id',
  'borroweruniquenumber',
  'borrower unique number',
  'borrower_unique_number',
  'uniquenumber',
  'unique number',
  'nibnumber',
  'nib number',
])

const NAME_HEADER_ALIASES = new Set([
  'borrowername',
  'borrower name',
  'borrower_name',
  'name',
  'fullname',
  'full name',
  'customername',
  'customer name',
])

function normalizeHeader(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

function isBorrowerHeader(value) {
  const key = normalizeHeader(value)
  return BORROWER_HEADER_ALIASES.has(key) || key === 'borrowerid'
}

function isNameHeader(value) {
  const key = normalizeHeader(value)
  if (BORROWER_HEADER_ALIASES.has(key)) return false
  return NAME_HEADER_ALIASES.has(key) || key.includes('name')
}

function toIdString(value) {
  if (value == null || value === '') return null
  const raw = String(value).trim()
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  return digits || null
}

function uniqueIds(ids) {
  const seen = new Set()
  const out = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function extractFromObjectRows(rows) {
  if (!rows.length) return { ids: [], rows: [] }

  const sample = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row))
  if (!sample) return { ids: [], rows: [] }

  const keys = Object.keys(sample)
  const matchKey =
    keys.find((key) => isBorrowerHeader(key)) ||
    keys.find((key) => normalizeHeader(key).includes('borrower')) ||
    keys[0]
  const nameKey = keys.find((key) => isNameHeader(key))

  if (!matchKey) return { ids: [], rows: [] }

  const parsedRows = []
  for (const row of rows) {
    const borrowerId = toIdString(row?.[matchKey])
    if (!borrowerId) continue
    const name = nameKey ? String(row?.[nameKey] ?? '').trim() : ''
    parsedRows.push({ borrowerId, name: name || null })
  }

  const ids = uniqueIds(parsedRows.map((row) => row.borrowerId))
  const byId = new Map(parsedRows.map((row) => [row.borrowerId, row]))
  return {
    ids,
    rows: ids.map((borrowerId) => byId.get(borrowerId)),
  }
}

function extractFromArrayRows(rows) {
  if (!rows.length) return { ids: [], rows: [] }

  const headerRow = rows[0] || []
  let start = 0
  let idCol = 0
  let nameCol = -1

  if (headerRow.some((cell) => isBorrowerHeader(cell) || isNameHeader(cell))) {
    start = 1
    idCol = headerRow.findIndex((cell) => isBorrowerHeader(cell))
    if (idCol < 0) idCol = 0
    nameCol = headerRow.findIndex((cell) => isNameHeader(cell))
  }

  const parsedRows = []
  for (const row of rows.slice(start)) {
    const borrowerId = toIdString(row?.[idCol])
    if (!borrowerId) continue
    const name = nameCol >= 0 ? String(row?.[nameCol] ?? '').trim() : ''
    parsedRows.push({ borrowerId, name: name || null })
  }

  const ids = uniqueIds(parsedRows.map((row) => row.borrowerId))
  const byId = new Map(parsedRows.map((row) => [row.borrowerId, row]))
  return {
    ids,
    rows: ids.map((borrowerId) => byId.get(borrowerId)),
  }
}

/**
 * Extract borrower IDs from an uploaded spreadsheet (.xlsx, .xls, .csv).
 * Expects a BorrowerId column (or first column of numeric IDs).
 */
export function parseBorrowerIdsFromBuffer(buffer, filename = '') {
  if (!buffer?.length) throw new Error('Empty file')

  const ext = String(filename).toLowerCase().split('.').pop()
  if (!['xlsx', 'xls', 'xlsm', 'csv'].includes(ext)) {
    throw new Error('Upload an Excel or CSV file (.xlsx, .xls, .csv)')
  }

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const sheetName = workbook.SheetNames?.[0]
  if (!sheetName) throw new Error('No worksheet found in file')

  const sheet = workbook.Sheets[sheetName]
  const objectRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
  let extracted = extractFromObjectRows(objectRows)

  if (!extracted.ids.length) {
    const arrayRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
    extracted = extractFromArrayRows(arrayRows)
  }

  if (!extracted.ids.length) {
    throw new Error('No borrower IDs found — use a BorrowerId column like the sample file')
  }

  return {
    borrowerIDs: extracted.ids.join(','),
    count: extracted.ids.length,
    ids: extracted.ids,
    rows: extracted.rows,
  }
}
