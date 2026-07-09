import * as XLSX from 'xlsx'

const BORROWER_HEADER_ALIASES = new Set([
  'borrowerid',
  'borrower id',
  'borrower_id',
  'borrowerids',
  'borrower ids',
  'id',
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
  if (!rows.length) return []

  const sample = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row))
  if (!sample) return []

  const keys = Object.keys(sample)
  const matchKey =
    keys.find((key) => isBorrowerHeader(key)) ||
    keys.find((key) => normalizeHeader(key).includes('borrower')) ||
    keys[0]

  if (!matchKey) return []

  return uniqueIds(rows.map((row) => toIdString(row?.[matchKey])).filter(Boolean))
}

function extractFromArrayRows(rows) {
  if (!rows.length) return []

  let start = 0
  const firstCell = rows[0]?.[0]
  if (isBorrowerHeader(firstCell)) start = 1

  const colIndex = rows.some((row) => isBorrowerHeader(row?.[0])) ? 0 : 0
  return uniqueIds(
    rows.slice(start).map((row) => toIdString(row?.[colIndex])).filter(Boolean)
  )
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
  let ids = extractFromObjectRows(objectRows)

  if (!ids.length) {
    const arrayRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
    ids = extractFromArrayRows(arrayRows)
  }

  if (!ids.length) {
    throw new Error('No borrower IDs found — use a BorrowerId column like the sample file')
  }

  return {
    borrowerIDs: ids.join(','),
    count: ids.length,
    ids,
  }
}
