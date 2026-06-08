import * as XLSX from 'xlsx'
import { createHash } from 'crypto'
import { extractWithAI } from './openrouter.js'
import { parsePdfBuffer } from './parsePdfStatement.js'

const MAX_BYTES = 10 * 1024 * 1024
const EXCEL_EXT = /\.(xlsx|xls|xlsm|csv)$/i

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

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/\s+/g, ' ')
}

function parseAmount(val) {
  if (val == null || val === '') return NaN
  if (typeof val === 'number') return val
  return parseFloat(String(val).replace(/[^0-9.-]/g, ''))
}

function normalizeDate(val) {
  if (val == null || val === '') return ''
  if (val instanceof Date && !isNaN(val)) return val.toISOString().slice(0, 10)
  if (typeof val === 'number') {
    const parsed = XLSX.SSF.parse_date_code(val)
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`
  }
  const d = new Date(val)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  const parts = String(val).split(/[/-]/)
  if (parts.length === 3) {
    const [a, b, c] = parts.map(Number)
    if (a > 31) return `${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`
    return `${c}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`
  }
  return String(val).trim()
}

function isEmptyRow(row) {
  if (Array.isArray(row)) return row.every((v) => v == null || String(v).trim() === '')
  return Object.values(row).every((v) => v == null || String(v).trim() === '')
}

function mapHeaders(rawRow) {
  const normalized = {}
  for (const [key, val] of Object.entries(rawRow)) {
    normalized[normalizeKey(key)] = val
  }
  const mapped = {}
  for (const col of ['date', 'payer', 'description', 'amount', 'reference']) {
    const aliases = HEADER_ALIASES[col]
    const found = aliases.find((a) => normalized[a] !== undefined)
    if (found) mapped[col] = normalized[found]
    else if (normalized[col] !== undefined) mapped[col] = normalized[col]
  }
  return mapped
}

function normalizeRows(rawRows) {
  return rawRows
    .filter((row) => !isEmptyRow(row))
    .map(mapHeaders)
    .filter((r) => r.date != null && r.date !== '' && r.amount != null && r.amount !== '')
    .map((r) => ({
      date: normalizeDate(r.date),
      payer: String(r.payer ?? '').trim(),
      description: String(r.description ?? r.payer ?? '').trim(),
      amount: parseAmount(r.amount),
      reference: String(r.reference ?? '').trim(),
    }))
    .filter((r) => !isNaN(r.amount) && r.amount !== 0)
}

function getColumnKeys(rawRows) {
  if (!rawRows.length) return []
  return Object.keys(rawRows[0]).map(normalizeKey)
}

const REQUIRED_COLUMNS = ['date', 'payer', 'amount']

function missingColumns(keys) {
  return REQUIRED_COLUMNS.filter((col) => {
    const aliases = HEADER_ALIASES[col]
    return !aliases.some((a) => keys.includes(a)) && !keys.includes(col)
  })
}

function filterCreditRows(rawRows) {
  const keys = getColumnKeys(rawRows)
  const typeKey = keys.find((k) => ['transaction type', 'type', 'txn type', 'dr/cr'].includes(k))
  if (!typeKey) return rawRows
  return rawRows.filter((row) => {
    const normalized = {}
    for (const [key, val] of Object.entries(row)) {
      normalized[normalizeKey(key)] = val
    }
    const type = String(normalized[typeKey] || '').trim().toLowerCase()
    return !type || type === 'credit' || type === 'cr'
  })
}

function parseExcelBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return { rawRows: [], sheetRows: [] }
  const sheet = workbook.Sheets[sheetName]
  const sheetRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  return { rawRows, sheetRows }
}

function parseCsvText(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return { rawRows: [], sheetRows: [] }
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''))
  const sheetRows = [headers, ...lines.slice(1).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))]
  const rawRows = lines.slice(1).map((line) => {
    const vals = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const row = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
  return { rawRows, sheetRows }
}

export function rowHash(row) {
  return createHash('sha256').update(`${row.date}|${row.payer}|${row.amount}|${row.reference}`).digest('hex')
}

export async function parseStatementBuffer(buffer, filename) {
  if (buffer.length > MAX_BYTES) throw new Error('File exceeds 10MB limit')

  if (/\.pdf$/i.test(filename)) {
    const pdf = await parsePdfBuffer(buffer, filename)
    return {
      method: pdf.method,
      source: pdf.source,
      rawRows: pdf.creditRows.slice(0, 12),
      creditRows: pdf.creditRows,
      rows: pdf.rows.map((r) => ({ ...r, import_hash: rowHash(r) })),
    }
  }

  const isExcel = EXCEL_EXT.test(filename) && !filename.toLowerCase().endsWith('.csv')
  const { rawRows, sheetRows } = isExcel
    ? parseExcelBuffer(buffer)
    : parseCsvText(buffer.toString('utf8'))

  let cleaned = filterCreditRows(rawRows.filter((row) => !isEmptyRow(row)))
  let method = 'standard'
  let rows = normalizeRows(cleaned)

  const keys = getColumnKeys(cleaned)
  const missing = missingColumns(keys)

  if (!rows.length && process.env.OPENROUTER_API_KEY) {
    const headerRow = sheetRows.find((r) => Array.isArray(r) && r.some((c) => String(c).trim())) || []
    const dataSamples = sheetRows
      .filter((r) => Array.isArray(r) && r.some((c) => String(c).trim()))
      .slice(1, 8)
      .map((r) => (Array.isArray(r) ? r : []))

    rows = await extractWithAI(headerRow, dataSamples)
    method = 'ai'
    cleaned = rows
  } else if (missing.length) {
    throw new Error(`Missing columns: ${missing.join(', ')}. Found: ${keys.join(', ')}`)
  }

  if (!rows.length) throw new Error('No valid transactions found in file')

  return {
    method,
    rawRows: cleaned.slice(0, 8),
    rows: rows.map((r) => ({ ...r, import_hash: rowHash(r) })),
  }
}
