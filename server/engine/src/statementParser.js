import * as XLSX from 'xlsx'
import { PDFParse } from 'pdf-parse'
import {
  extractNameFromParticulars,
  parsePipeParticulars,
} from '../../particularsParse.js'

export { extractNameFromParticulars, parsePipeParticulars } from '../../particularsParse.js'

/**
 * Unified statement parser for client-uploaded transaction files.
 *
 * Supports four shapes seen across employers/banks:
 *   - Bank statement PDF  (Bank of The Bahamas, multi-line, credits by balance)
 *   - Employer PDF        ("DEDUCTIONS TOTALS BY EMPLOYEE" / "Name  Amount")
 *   - Excel / CSV         (columnar, Transaction Type = Credit)
 *   - Text                (tab/comma delimited, treated like CSV)
 *
 * Output is a list of CREDIT rows only, normalized to:
 *   { sourceType, employerOrBank, transDate, referenceNo, particulars,
 *     borrowerName, emiPaidAmount }
 * where emiPaidAmount is the credited amount = EMI paid by the borrower.
 *
 * Ported/consolidated from the app's server/parsePdfStatement.js and
 * server/parseStatement.js.
 */

// ---------------------------------------------------------------- shared utils

function parseAmount(val) {
  if (val == null || val === '') return NaN
  if (typeof val === 'number') return val
  return parseFloat(String(val).replace(/[^0-9.-]/g, ''))
}

function padDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function parseSlashDate(val) {
  const parts = String(val).trim().split('/')
  if (parts.length !== 3) return null
  const [a, b, c] = parts.map((x) => parseInt(x, 10))
  if (a > 31) return padDate(a, b, c)
  return padDate(c, a, b)
}

function parseMonthNameDate(val) {
  const m = String(val).match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (m) {
    const month = MONTHS[m[1].toLowerCase()]
    if (month) return padDate(parseInt(m[3], 10), month, parseInt(m[2], 10))
  }
  return null
}

function parseDatedComment(val) {
  const m = String(val).match(/Dated\s+([A-Za-z]+)-(\d{2})-(\d{4})/i)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (month) return padDate(parseInt(m[3], 10), month, parseInt(m[2], 10))
  return null
}

function normalizeBankDate(val) {
  const parts = String(val).trim().split('/')
  if (parts.length === 3) {
    const [m, d, y] = parts
    const year = y.length === 2 ? `20${y}` : y
    return padDate(parseInt(year, 10), parseInt(m, 10), parseInt(d, 10))
  }
  return parseSlashDate(val) || String(val).trim()
}

// --------------------------------------------------------------- type detection

const BANK_MARKERS = /Date Posted|Detailed Client Statement|Cheque No\.\s*\/\s*Reference/i
const EMPLOYER_MARKERS = /DEDUCTIONS TOTALS BY EMPLOYEE|Staff Deductions/i

function detectPdfType(text) {
  if (BANK_MARKERS.test(text) || /^\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}\/\d{1,2}\/\d{2}/m.test(text)) {
    return 'bank'
  }
  if (EMPLOYER_MARKERS.test(text) || /^Name\s+Amount/im.test(text)) return 'employer'
  if (/\bDEDUCTIONS\b/i.test(text)) return 'employer'
  return 'bank'
}

function detectBankName(text) {
  if (/BankBahamas|Bank of (the )?Bahamas/i.test(text)) return 'Bank of The Bahamas'
  return 'Bank'
}

// ----------------------------------------------------------------- bank PDF

const SKIP_PARTICULARS = /balance (brought|carried) forward/i

function cleanBankText(text) {
  return text
    .replace(/-- \d+ of \d+ --/g, '\n')
    .replace(/ONE JFK WEST[\s\S]*?AC\. STATUS: NORM/g, '\n')
    .replace(/Date Posted\s+Value[\s\S]*?Balance\n/gi, '\n')
    .replace(/Detailed Client Statement/gi, '\n')
    .replace(/Balance Brought Forward[^\n]*/gi, '\n')
    .replace(/Balance Carried Forward[^\n]*/gi, '\n')
    .replace(/Statement Message Items Amount[\s\S]*?Total Value Added Taxes[^\n]*/gi, '\n')
    .replace(/Page\.\s*\d+\s+of\s*\d+/gi, '\n')
    .replace(/Important Notice:[\s\S]*$/i, '\n')
    .replace(/Dr\s*=\s*Overdrawn Balance/gi, ' ')
}

function groupBankBlocks(text) {
  const lines = cleanBankText(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const txStart = /^\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}\/\d{1,2}\/\d{2}\s+\S+/
  const blocks = []
  let current = null
  for (const line of lines) {
    if (txStart.test(line)) {
      if (current) blocks.push(current)
      current = line
    } else if (current) {
      current += ` ${line}`
    }
  }
  if (current) blocks.push(current)
  return blocks
}

function parseBankBlock(block) {
  const head = block.match(/^(\d{1,2}\/\d{1,2}\/\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+(\S+)\s+(.*)$/)
  if (!head) return null
  const [, datePosted, valueDate, reference, rest] = head
  const amounts = [...rest.matchAll(/([\d,]+\.\d{2})/g)].map((m) => m[1])
  if (amounts.length < 2) return null

  const txnAmount = parseAmount(amounts[amounts.length - 2])
  const balance = parseAmount(amounts[amounts.length - 1])

  let particulars = rest
  for (let i = amounts.length - 1; i >= amounts.length - 2; i--) {
    const idx = particulars.lastIndexOf(amounts[i])
    if (idx >= 0) particulars = particulars.slice(0, idx) + particulars.slice(idx + amounts[i].length)
  }
  particulars = particulars.replace(/\s+/g, ' ').trim()
  if (!particulars.includes('|')) particulars = particulars.replace(/\s+[A-Za-z]{1,12}$/, '').trim()
  if (!particulars || SKIP_PARTICULARS.test(particulars)) return null

  return {
    valueDate: normalizeBankDate(valueDate),
    datePosted: normalizeBankDate(datePosted),
    reference,
    particulars,
    amount: txnAmount,
    balance,
  }
}

function extractOpeningBalance(text) {
  const m = text.match(/Balance Brought Forward\s+([\d,]+\.\d{2})/i)
  return m ? parseAmount(m[1]) : null
}

function filterBankCredits(rows, openingBalance) {
  let prevBalance = openingBalance ?? null
  const credits = []
  for (const row of rows) {
    if (prevBalance === null) { prevBalance = row.balance; continue }
    const isCredit = Math.abs(row.balance - prevBalance - row.amount) < 0.02
    if (isCredit) credits.push(row)
    prevBalance = row.balance
  }
  return credits
}

function parseBankPdf(text) {
  const bankName = detectBankName(text)
  const opening = extractOpeningBalance(text)
  const parsed = groupBankBlocks(text).map(parseBankBlock).filter(Boolean)
  return filterBankCredits(parsed, opening).map((r) => ({
    sourceType: 'bank',
    employerOrBank: bankName,
    transDate: r.valueDate,
    referenceNo: r.reference,
    particulars: r.particulars,
    borrowerName: extractNameFromParticulars(r.particulars),
    emiPaidAmount: r.amount,
  }))
}

// --------------------------------------------------------------- employer PDF

function employerFromFilename(filename) {
  const base = filename.replace(/\.pdf$/i, '').trim()
  const stripDate = (name) => name.replace(/\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}$/i, '').trim()
  const part = base.match(/^(.+?)\s+-\s+Part\s+\d+/i)
  if (part) return stripDate(part[1]) || part[1].trim()
  const dated = base.match(/^(.+?)\s+-\s+[A-Za-z]+\s+\d{1,2},?\s+\d{4}/i)
  if (dated) return dated[1].trim()
  const suffixDate = base.match(/^(.+?)\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}/i)
  if (suffixDate) return suffixDate[1].trim()
  return base.split(' - ')[0]?.trim() || 'Employer'
}

function dateFromFilename(filename) {
  const base = filename.replace(/\.pdf$/i, '')
  const m1 = base.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (m1) return parseMonthNameDate(`${m1[1]} ${m1[2]}, ${m1[3]}`)
  const m2 = base.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/)
  if (m2) return parseMonthNameDate(`${m2[2]} ${m2[1]}, ${m2[3]}`)
  return null
}

function extractEmployerMeta(text, filename) {
  let employer = employerFromFilename(filename)
  let statementDate = dateFromFilename(filename) || new Date().toISOString().slice(0, 10)
  const companyPay = text.match(/([^,\n]+),\s*Pay Date:\s*([^\n]+)/i)
  if (companyPay) {
    employer = companyPay[1].trim()
    const d = parseSlashDate(companyPay[2].trim()) || parseMonthNameDate(companyPay[2].trim())
    if (d) statementDate = d
  }
  return { employer, statementDate }
}

function isSkipLine(line) {
  if (!line || line === '-' || line === '$') return true
  if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(line)) return true
  if (/^Simplified Lending/i.test(line)) return true
  if (/^DEDUCTIONS TOTALS BY EMPLOYEE/i.test(line)) return true
  if (/^Name\s+Amount/i.test(line)) return true
  if (/^ACC\|?No Comments/i.test(line)) return true
  if (/^ACCT No\./i.test(line)) return true
  if (/^\d[\d,]*\.\d{2}\s*\$?$/.test(line.replace(/\t/g, '').trim())) return true
  if (/^Cable Bahamas Ltd\./i.test(line) && /Pay Date/i.test(line)) return true
  if (/^Date:/i.test(line)) return true
  return false
}

function isRemarkContinuation(line) {
  if (isSkipLine(line)) return false
  if (/\$\s*[\d,]+\.\d{2}/.test(line) || /[\d,]+\.\d{2}\s*\$/.test(line)) return false
  return /^[A-Za-z(]/.test(line)
}

function parseEmployerAmountLine(line) {
  const parts = line.split('\t').map((s) => s.trim()).filter((s) => s !== '' && s !== '$')
  if (parts.length < 2) return null
  let amount = null
  let amountIdx = -1
  for (let i = 0; i < parts.length; i++) {
    const n = parseAmount(parts[i])
    if (!isNaN(n) && n > 0 && /[\d,]+\.\d{2}/.test(parts[i])) { amount = n; amountIdx = i; break }
  }
  if (amount === null || amountIdx < 1) return null
  const name = parts.slice(0, amountIdx).join(' ').trim()
  if (!name || /^(name|amount)$/i.test(name)) return null
  const comments = parts.slice(amountIdx + 1).join(' ').trim()
  return { name, amount, comments }
}

function parseEmployerPdf(text, filename) {
  const { employer, statementDate } = extractEmployerMeta(text, filename)
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const rows = []
  let pendingRemark = ''

  const flush = () => {
    if (pendingRemark && rows.length) {
      const last = rows[rows.length - 1]
      last.particulars = [last.particulars, pendingRemark.trim()].filter(Boolean).join(' — ')
    }
    pendingRemark = ''
  }

  for (const line of lines) {
    if (isSkipLine(line)) continue
    const parsed = parseEmployerAmountLine(line)
    if (parsed) {
      flush()
      const rowDate = parseDatedComment(parsed.comments) || statementDate
      let particulars = parsed.comments
      if (!particulars) particulars = `Salary deduction — ${employer}`
      else if (!/deduction|salary|emi|staff/i.test(particulars) && !/^dated/i.test(particulars)) {
        particulars = `${particulars} — ${employer}`
      }
      rows.push({
        sourceType: 'employer',
        employerOrBank: employer,
        transDate: rowDate,
        referenceNo: '',
        particulars,
        borrowerName: parsed.name,
        emiPaidAmount: parsed.amount,
      })
      continue
    }
    if (isRemarkContinuation(line) && rows.length) {
      pendingRemark += (pendingRemark ? ' ' : '') + line
    }
  }
  flush()
  return rows
}

// --------------------------------------------------------------- excel / csv

const HEADER_ALIASES = {
  date: ['date', 'transaction date', 'txn date', 'posting date', 'value date', 'trans date'],
  payer: ['payer', 'payor', 'name', 'customer', 'from', 'sender', 'beneficiary', 'remitter', 'originator', 'paid by', 'account name', 'employee'],
  description: ['description', 'memo', 'narrative', 'details', 'particulars'],
  amount: ['amount', 'value', 'payment', 'transaction amount', 'txn amount'],
  credit: ['credit', 'credit amount', 'cr amount', 'deposit', 'deposits', 'money in'],
  debit: ['debit', 'debit amount', 'dr amount', 'withdrawal', 'withdrawals', 'money out'],
  reference: ['reference', 'ref', 'reference no', 'reference number', 'transaction id', 'txn id'],
  type: ['transaction type', 'type', 'txn type', 'dr/cr', 'cr/dr'],
}

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/\s+/g, ' ')
}

function excelDate(val) {
  if (val == null || val === '') return ''
  if (val instanceof Date && !isNaN(val)) return val.toISOString().slice(0, 10)
  if (typeof val === 'number') {
    const p = XLSX.SSF.parse_date_code(val)
    if (p) return padDate(p.y, p.m, p.d)
  }
  const slash = parseSlashDate(val)
  if (slash) return slash
  const d = new Date(val)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return String(val).trim()
}

function isEmptyRow(row) {
  return Object.values(row).every((v) => v == null || String(v).trim() === '')
}

function mapHeaders(rawRow) {
  const normalized = {}
  for (const [k, v] of Object.entries(rawRow)) normalized[normalizeKey(k)] = v
  const mapped = {}
  for (const col of Object.keys(HEADER_ALIASES)) {
    const found = HEADER_ALIASES[col].find((a) => normalized[a] !== undefined)
    if (found) mapped[col] = normalized[found]
    else if (normalized[col] !== undefined) mapped[col] = normalized[col]
  }
  return mapped
}

function parseExcelBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const name = wb.SheetNames[0]
  if (!name) return []
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' })
}

function parseDelimitedText(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const delim = lines[0].includes('\t') ? '\t' : ','
  const split = (l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''))
  const headers = split(lines[0])
  return lines.slice(1).map((line) => {
    const vals = split(line)
    const row = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
}

function creditTypeVerdict(typeRaw) {
  const type = String(typeRaw ?? '').trim().toLowerCase()
  if (!type) return null
  if (type === 'credit' || type === 'cr' || type === 'c' || /\bcredit\b/.test(type)) return true
  if (type === 'debit' || type === 'dr' || type === 'd' || /\bdebit\b/.test(type)) return false
  return null
}

function extractCreditAmount(mapped) {
  const typeVerdict = creditTypeVerdict(mapped.type)
  if (typeVerdict === false) return null

  const creditAmt = parseAmount(mapped.credit)
  if (!isNaN(creditAmt) && creditAmt > 0) return creditAmt

  const debitAmt = parseAmount(mapped.debit)
  const hasDebit = !isNaN(debitAmt) && Math.abs(debitAmt) > 0

  const singleAmt = parseAmount(mapped.amount)
  const hasSingle = !isNaN(singleAmt) && singleAmt !== 0

  if (hasDebit && !hasSingle && (isNaN(creditAmt) || creditAmt <= 0)) return null

  if (hasSingle) {
    if (singleAmt > 0 && (typeVerdict === true || typeVerdict === null)) return singleAmt
    return null
  }

  return null
}

function parseColumnar(rawRows, fileName) {
  const cleaned = rawRows.filter((r) => !isEmptyRow(r)).map((r) => ({ raw: r, m: mapHeaders(r) }))
  const isBankish = cleaned.some(({ m }) =>
    /BSD|Direct Credit|Cash Deposit/i.test(`${m.amount ?? ''} ${m.description ?? ''} ${m.credit ?? ''}`))
  const employerOrBank = isBankish ? 'Bank of The Bahamas' : (employerFromFilename(fileName) || 'Bank Statement')

  const out = []
  for (const { m } of cleaned) {
    const amount = extractCreditAmount(m)
    if (amount == null) continue
    const date = excelDate(m.date)
    if (!date) continue
    const description = String(m.description ?? '').trim()
    const borrowerName = extractNameFromParticulars(description) || String(m.payer ?? '').trim()
    out.push({
      sourceType: isBankish ? 'bank' : 'employer',
      employerOrBank,
      transDate: date,
      referenceNo: String(m.reference ?? '').trim(),
      particulars: description || String(m.payer ?? '').trim(),
      borrowerName,
      emiPaidAmount: amount,
    })
  }
  return out
}

// ----------------------------------------------------------------- entrypoint

export function detectFileType(filename) {
  if (/\.pdf$/i.test(filename)) return 'pdf'
  if (/\.(xlsx|xls|xlsm)$/i.test(filename)) return 'excel'
  if (/\.csv$/i.test(filename)) return 'csv'
  if (/\.(txt|tsv|text)$/i.test(filename)) return 'text'
  return 'unknown'
}

/**
 * Parse any supported statement buffer into normalized CREDIT rows.
 * Returns { fileType, sourceType, rows }.
 */
export async function parseStatement(buffer, fileName) {
  const fileType = detectFileType(fileName)

  if (fileType === 'pdf') {
    const parser = new PDFParse({ data: buffer })
    try {
      const { text } = await parser.getText()
      const rows = detectPdfType(text) === 'employer'
        ? parseEmployerPdf(text, fileName)
        : parseBankPdf(text)
      return { fileType, sourceType: rows[0]?.sourceType ?? 'bank', rows }
    } finally {
      await parser.destroy()
    }
  }

  let rawRows = []
  if (fileType === 'excel') rawRows = parseExcelBuffer(buffer)
  else if (fileType === 'csv' || fileType === 'text') rawRows = parseDelimitedText(buffer.toString('utf8'))
  else throw new Error(`Unsupported file type: ${fileName}`)

  const rows = parseColumnar(rawRows, fileName)
  return { fileType, sourceType: rows[0]?.sourceType ?? 'bank', rows }
}
