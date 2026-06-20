import * as XLSX from 'xlsx'
import { createHash } from 'crypto'
import { extractWithAI, extractFromImageWithAI } from './openrouter.js'
import { parsePdfBuffer } from './parsePdfStatement.js'
import { parsePipeParticulars } from './particularsParse.js'

const MAX_BYTES = 10 * 1024 * 1024
const EXCEL_EXT = /\.(xlsx|xls|xlsm|csv)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'txn date', 'posting date', 'value date', 'trans date'],
  payer: [
    'payer', 'payor', 'name', 'customer', 'from', 'sender',
    'beneficiary', 'remitter', 'originator', 'paid by', 'account name', 'employee',
  ],
  description: ['description', 'memo', 'narrative', 'details', 'particulars'],
  // Single amount column (signed or credits-only exports)
  amount: ['amount', 'value', 'payment', 'transaction amount', 'txn amount'],
  // Separate credit / debit columns (bank statements) — never treat debit as credit
  credit: ['credit', 'credit amount', 'cr amount', 'deposit', 'deposits', 'money in'],
  debit: ['debit', 'debit amount', 'dr amount', 'withdrawal', 'withdrawals', 'money out'],
  reference: ['reference', 'ref', 'reference no', 'reference number', 'transaction id', 'txn id'],
  type: ['transaction type', 'type', 'txn type', 'dr/cr', 'cr/dr'],
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
  for (const col of ['date', 'payer', 'description', 'amount', 'credit', 'debit', 'reference', 'type']) {
    const aliases = HEADER_ALIASES[col] || [col]
    const found = aliases.find((a) => normalized[a] !== undefined)
    if (found) mapped[col] = normalized[found]
    else if (normalized[col] !== undefined) mapped[col] = normalized[col]
  }
  return mapped
}

/** True = credit, false = debit, null = unknown / not specified. */
function creditTypeVerdict(typeRaw) {
  const type = String(typeRaw ?? '').trim().toLowerCase()
  if (!type) return null
  if (type === 'credit' || type === 'cr' || type === 'c' || /\bcredit\b/.test(type)) return true
  if (type === 'debit' || type === 'dr' || type === 'd' || /\bdebit\b/.test(type)) return false
  return null
}

/**
 * Resolve the credited amount for one spreadsheet row.
 * Returns a positive number for credits, or null to skip (debits / zero / invalid).
 */
function extractCreditAmount(mapped) {
  const typeVerdict = creditTypeVerdict(mapped.type)
  if (typeVerdict === false) return null

  const creditAmt = parseAmount(mapped.credit)
  if (!isNaN(creditAmt) && creditAmt > 0) return creditAmt

  const debitAmt = parseAmount(mapped.debit)
  const hasDebit = !isNaN(debitAmt) && Math.abs(debitAmt) > 0

  const singleAmt = parseAmount(mapped.amount)
  const hasSingle = !isNaN(singleAmt) && singleAmt !== 0

  // Row has a debit column value but no credit — skip (withdrawal / payment out)
  if (hasDebit && !hasSingle && (isNaN(creditAmt) || creditAmt <= 0)) return null

  if (hasSingle) {
    // Signed amount column: positive = credit, negative = debit
    if (singleAmt > 0) {
      if (typeVerdict === true || typeVerdict === null) return singleAmt
      return null
    }
    return null
  }

  // Type explicitly says credit but amount missing
  return null
}

function normalizeRows(rawRows) {
  const out = []
  for (const rawRow of rawRows) {
    if (isEmptyRow(rawRow)) continue
    const m = mapHeaders(rawRow)
    const amount = extractCreditAmount(m)
    if (amount == null) continue
    const date = normalizeDate(m.date)
    if (!date) continue
    const descriptionRaw = String(m.description ?? '').trim()
    const parsed = parsePipeParticulars(descriptionRaw)
    const payer = String(m.payer ?? parsed.borrowerName ?? '').trim()
    out.push({
      date,
      payer: payer || parsed.borrowerName,
      description: parsed.full || descriptionRaw || payer,
      transactionDescription: parsed.description || descriptionRaw,
      amount,
      reference: String(m.reference ?? '').trim(),
    })
  }
  return out
}

function getColumnKeys(rawRows) {
  if (!rawRows.length) return []
  return Object.keys(rawRows[0]).map(normalizeKey)
}

const REQUIRED_COLUMNS = ['date', 'payer', 'amount']

function missingColumns(keys) {
  return REQUIRED_COLUMNS.filter((col) => {
    if (col === 'amount') {
      const amountOrCredit = [...HEADER_ALIASES.amount, ...HEADER_ALIASES.credit]
      return !amountOrCredit.some((a) => keys.includes(a)) && !keys.includes('amount') && !keys.includes('credit')
    }
    const aliases = HEADER_ALIASES[col]
    return !aliases.some((a) => keys.includes(a)) && !keys.includes(col)
  })
}

function filterCreditRows(rawRows) {
  return rawRows.filter((row) => {
    if (isEmptyRow(row)) return false
    const m = mapHeaders(row)
    return extractCreditAmount(m) != null
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

function enrichParsedRows(rows, { documentType, fileParticulars } = {}) {
  const sourceType =
    documentType === 'employer' ? 'employer' : documentType === 'bank' ? 'bank' : documentType || 'spreadsheet'
  const employerLabel = fileParticulars?.trim() || null
  return rows.map((r) => ({
    ...r,
    documentType: documentType || r.documentType || sourceType,
    sourceType: r.sourceType || sourceType,
    employerOrBank: r.employerOrBank || r.employer || employerLabel,
    employer: r.employer || employerLabel,
    fileParticulars: fileParticulars || null,
  }))
}

export async function parseStatementBuffer(buffer, filename, options = {}) {
  if (buffer.length > MAX_BYTES) throw new Error('File exceeds 10MB limit')

  const { documentType, fileParticulars } = options
  const isImage = documentType === 'image' || IMAGE_EXT.test(filename)

  if (isImage) {
    const mimeType =
      filename.toLowerCase().endsWith('.png')
        ? 'image/png'
        : filename.toLowerCase().endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg'
    const aiRows = await extractFromImageWithAI(buffer, mimeType, { documentType, fileParticulars })
    if (!aiRows.length) throw new Error('No repayment rows found in image')
    const rows = enrichParsedRows(
      aiRows.map((r) => ({ ...r, import_hash: rowHash(r) })),
      { documentType: documentType || 'image', fileParticulars }
    )
    return {
      method: 'ai',
      source: documentType === 'employer' ? 'employer' : documentType || 'image',
      documentType: documentType || 'image',
      rawRows: aiRows.slice(0, 12),
      creditRows: aiRows,
      rows,
    }
  }

  if (/\.pdf$/i.test(filename)) {
    const pdf = await parsePdfBuffer(buffer, filename, { documentType, fileParticulars })
    const rows = enrichParsedRows(
      pdf.rows.map((r) => ({ ...r, import_hash: rowHash(r) })),
      { documentType: pdf.documentType || documentType, fileParticulars }
    )
    return {
      method: pdf.method,
      source: pdf.source,
      documentType: pdf.documentType || documentType,
      rawRows: pdf.creditRows.slice(0, 12),
      creditRows: pdf.creditRows,
      rows,
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

    rows = await extractWithAI(headerRow, dataSamples, { documentType, fileParticulars })
    method = 'ai'
    cleaned = rows
  } else if (missing.length) {
    throw new Error(`Missing columns: ${missing.join(', ')}. Found: ${keys.join(', ')}`)
  }

  if (!rows.length) throw new Error('No credit transactions found in file (debits are excluded)')

  const enriched = enrichParsedRows(
    rows.map((r) => ({ ...r, import_hash: rowHash(r) })),
    { documentType: documentType || 'spreadsheet', fileParticulars }
  )

  return {
    method,
    source: documentType === 'employer' ? 'employer' : 'spreadsheet',
    documentType: documentType || 'spreadsheet',
    rawRows: cleaned.slice(0, 8),
    rows: enriched,
  }
}
