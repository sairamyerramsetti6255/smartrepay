import Papa from 'papaparse'
import * as XLSX from 'xlsx'

export const REQUIRED_COLS = ['date', 'payer', 'description', 'amount', 'reference']
const MAX_BYTES = 10 * 1024 * 1024
const EXCEL_EXT = /\.(xlsx|xls|xlsm)$/i

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'txn date', 'posting date', 'value date'],
  payer: [
    'payer', 'payor', 'name', 'customer', 'from', 'sender',
    'beneficiary', 'remitter', 'originator', 'paid by', 'account name',
  ],
  description: ['description', 'memo', 'narrative', 'details', 'particulars'],
  amount: ['amount', 'value', 'debit', 'credit', 'payment'],
  reference: ['reference', 'ref', 'reference no', 'reference number', 'transaction id', 'txn id'],
}

export function isExcelFile(file) {
  return EXCEL_EXT.test(file.name) || /spreadsheet|excel/.test(file.type)
}

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/\s+/g, ' ')
}

function mapHeaders(rawRow) {
  const normalized = {}
  for (const [key, val] of Object.entries(rawRow)) {
    normalized[normalizeKey(key)] = val
  }

  const mapped = {}
  for (const col of REQUIRED_COLS) {
    const aliases = HEADER_ALIASES[col]
    const found = aliases.find((a) => normalized[a] !== undefined)
    if (found) mapped[col] = normalized[found]
    else if (normalized[col] !== undefined) mapped[col] = normalized[col]
  }
  return mapped
}

function parseAmount(val) {
  if (val == null || val === '') return NaN
  if (typeof val === 'number') return val
  const cleaned = String(val).replace(/[^0-9.-]/g, '')
  return parseFloat(cleaned)
}

function isEmptyRow(row) {
  return Object.values(row).every((v) => v == null || String(v).trim() === '')
}

function normalizeDate(val) {
  if (val == null || val === '') return ''
  if (val instanceof Date && !isNaN(val)) return val.toISOString().slice(0, 10)
  if (typeof val === 'number') {
    const parsed = XLSX.SSF.parse_date_code(val)
    if (parsed) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`
    }
  }
  const d = new Date(val)
  if (!isNaN(d)) return d.toISOString().slice(0, 10)
  const parts = String(val).split(/[/-]/)
  if (parts.length === 3) {
    const [a, b, c] = parts.map(Number)
    if (a > 31) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`
    return `${c}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`
  }
  return String(val)
}

function normalizeRows(rawRows) {
  return rawRows
    .filter((row) => !isEmptyRow(row))
    .map(mapHeaders)
    .filter((r) => r.date != null && r.date !== '' && r.amount != null && r.amount !== '')
    .map((r) => ({
      date: normalizeDate(r.date),
      payer: String(r.payer ?? '').trim(),
      description: String(r.description ?? '').trim(),
      amount: parseAmount(r.amount),
      reference: String(r.reference ?? '').trim(),
    }))
    .filter((r) => !isNaN(r.amount) && r.amount !== 0)
}

function validateHeaders(rawRows) {
  if (!rawRows.length) return { ok: false, error: 'File is empty' }
  const headerRow = rawRows.find((row) => !isEmptyRow(row)) || rawRows[0]
  const keys = Object.keys(headerRow).map(normalizeKey)
  const missing = REQUIRED_COLS.filter((col) => {
    const aliases = HEADER_ALIASES[col]
    return !aliases.some((a) => keys.includes(a)) && !keys.includes(col)
  })
  if (missing.length) {
    return { ok: false, error: `Missing columns: ${missing.join(', ')}. Found: ${keys.join(', ')}` }
  }
  return { ok: true }
}

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
      complete: (results) => resolve(results.data),
      error: reject,
    })
  })
}

async function parseExcel(file) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return []
  const sheet = workbook.Sheets[sheetName]
  return XLSX.utils.sheet_to_json(sheet, { defval: '' })
}

export async function parseStatementFile(file) {
  if (file.size > MAX_BYTES) {
    throw new Error('File exceeds 10MB limit')
  }

  let rawRows = isExcelFile(file) ? await parseExcel(file) : await parseCsv(file)
  rawRows = rawRows.filter((row) => !isEmptyRow(row))

  const check = validateHeaders(rawRows)
  if (!check.ok) throw new Error(check.error)

  const rows = normalizeRows(rawRows)
  if (!rows.length) throw new Error('No valid transactions found in file')

  return {
    rawRows: rawRows.slice(0, 8),
    rows,
  }
}
