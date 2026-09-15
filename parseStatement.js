import * as XLSX from 'xlsx'
import { createHash } from 'crypto'
import { extractFromImageWithAI } from './openrouter.js'
import { parsePdfBuffer } from './parsePdfStatement.js'
import { parsePipeParticulars } from './particularsParse.js'

const MAX_BYTES = 10 * 1024 * 1024
const EXCEL_EXT = /\.(xlsx|xls|xlsm|csv)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i

const HEADER_ALIASES = {
  date: ['date posted', 'posting date', 'transaction date', 'date', 'transaction date', 'txn date', 'posting date', 'value date', 'trans date', 'date posted'],
  valueDate: ['value date'],
  payer: [
    'payer', 'payor', 'name', 'borrower', 'employer', 'customer', 'from', 'sender',
    'beneficiary', 'remitter', 'originator', 'paid by', 'account name', 'employee', 'payee',
  ],
  description: ['description', 'memo', 'narrative', 'details', 'particulars'],
  amount: ['amount', 'value', 'payment', 'transaction amount', 'txn amount', 'trans amount'],
  credit: ['credit', 'credit amount', 'cr amount', 'cr', 'deposit', 'deposits', 'money in'],
  debit: ['debit', 'debit amount', 'dr amount', 'withdrawal', 'withdrawals', 'money out'],
  reference: ['reference', 'ref', 'reference no', 'reference number', 'transaction id', 'txn id', 'cheque no'],
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
  if (val instanceof Date && !isNaN(val)) return `${val.getFullYear()}-${String(val.getMonth()+1).padStart(2,'0')}-${String(val.getDate()).padStart(2,'0')}`
  if (typeof val === 'number') {
    const parsed = XLSX.SSF.parse_date_code(val)
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`
  }
  const text = String(val).trim()
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const parts = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/)
  if (parts) {
    const year = parts[3].length === 2 ? `20${parts[3]}` : parts[3]
    return `${year}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
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
  for (const col of ['date', 'valueDate', 'payer', 'description', 'amount', 'credit', 'debit', 'reference', 'type']) {
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
  if (hasDebit) return null

  if (mapped.credit !== undefined || mapped.debit !== undefined) return null

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
  for (const [sourceIndex, rawRow] of rawRows.entries()) {
    if (isEmptyRow(rawRow)) continue
    const m = mapHeaders(rawRow)
    const amount = extractCreditAmount(m)
    if (amount == null) continue
    const date = normalizeDate(m.date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) continue
    const descriptionRaw = String(m.description ?? '').trim()
    const parsed = parsePipeParticulars(descriptionRaw)
    const payer = String(m.payer ?? parsed.borrowerName ?? '').trim()
    out.push({
      sourceSerial: sourceIndex+1,
      datePosted: date, valueDate: normalizeDate(m.valueDate) || date, direction: 'credit',
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

const REQUIRED_COLUMNS = ['date', 'amount']

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
  const workbook = XLSX.read(text, { type: 'string', raw: true })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  return { rawRows: XLSX.utils.sheet_to_json(sheet, { defval: '' }), sheetRows: XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) }
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

  if (isImage && documentType !== 'employer') return { method: 'image', source: 'bank', documentType: 'bank', rows: [], creditRows: [], diagnostics: { complete: false, warnings: ['Bank image requires verified debit/credit columns. Please provide a searchable PDF or bank CSV.'] } }

  if (isImage) {
    const mimeType =
      filename.toLowerCase().endsWith('.png')
        ? 'image/png'
        : filename.toLowerCase().endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg'
    const aiRows = await extractFromImageWithAI(buffer, mimeType, { documentType, fileParticulars })
    if (!aiRows.length) throw new Error('No repayment or deduction rows found in image')

    const creditRows = aiRows.map((r) => ({
      datePosted: r.date,
      valueDate: r.date,
      reference: r.reference || '',
      particulars: r.description || (documentType === 'employer' ? 'Salary deduction' : 'Deposit'),
      creditAmount: r.amount,
      name: r.payer,
      employer: documentType === 'employer' ? (fileParticulars || 'Employer') : undefined,
      remarks: r.description,
      date: r.date,
      payer: r.payer,
      description: r.description,
      amount: r.amount,
    }))

    const rows = enrichParsedRows(
      creditRows.map((r) => ({ ...r, import_hash: rowHash(r) })),
      { documentType: documentType || 'image', fileParticulars }
    )
    return {
      method: 'ai',
      source: documentType === 'employer' ? 'employer' : documentType || 'image',
      documentType: documentType || 'image',
      rawRows: aiRows.slice(0, 12),
      creditRows,
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
      diagnostics: pdf.diagnostics,
      extractedRows: pdf.extractedRows,
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

  if (documentType === 'bank') {
    const uncertain = rawRows.filter(r => !isEmptyRow(r)).filter(r => {
      const m = mapHeaders(r)
      return m.credit === undefined && m.debit === undefined && creditTypeVerdict(m.type) === null
    })
    if (uncertain.length) return { method: 'standard', source: 'bank', documentType: 'bank', rows: [], creditRows: [], diagnostics: { complete: false, warnings: [`${uncertain.length} rows lack explicit credit/debit direction. Map the bank direction column before import.`] } }
  }
  let cleaned = filterCreditRows(rawRows.filter((row) => !isEmptyRow(row)))
  let method = 'standard'
  let rows = normalizeRows(cleaned)

  const keys = getColumnKeys(cleaned)
  const missing = missingColumns(keys)

  if (!rows.length && process.env.OPENROUTER_API_KEY) {
    return { method: 'standard', source: documentType || 'spreadsheet', documentType, rows: [], creditRows: [], diagnostics: { complete: false, warnings: ['Spreadsheet columns could not be mapped. No sample-only import was performed. Supply date, description and explicit credit/debit columns.'] } }
  } else if (missing.length) {
    throw new Error(`Missing columns: ${missing.join(', ')}. Found: ${keys.join(', ')}`)
  }

  if (!rows.length) throw new Error('No credit transactions found in file (debits are excluded)')

  const enriched = enrichParsedRows(
    rows.map((r) => ({ ...r, import_hash: rowHash(r) })),
    { documentType: documentType || 'spreadsheet', fileParticulars }
  )

  return {
    diagnostics: { complete: enriched.length === cleaned.length, warnings: enriched.length === cleaned.length ? [] : ['Some credit rows could not be normalized. Review dates and amounts.'], debitCount: rawRows.filter(r => { const m=mapHeaders(r); return creditTypeVerdict(m.type) === false || parseAmount(m.debit)>0 }).length },
    method,
    source: documentType === 'employer' ? 'employer' : 'spreadsheet',
    documentType: documentType || 'spreadsheet',
    rawRows: cleaned.slice(0, 8),
    rows: enriched,
  }
}
