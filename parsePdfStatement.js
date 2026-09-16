import { extractPositionedBank } from './ingestion/bankPdf.js'
import { PDFParse } from 'pdf-parse'
import { extractNameFromParticulars, parsePipeParticulars, looksLikePersonName } from './particularsParse.js'
import { extractFromTextWithAI, extractFromImageWithAI } from './openrouter.js'

const SKIP_PARTICULARS = /balance (brought|carried) forward/i
const BANK_MARKERS = /Date Posted|Detailed Client Statement|Cheque No\.\s*\/\s*Reference|Available Balance|Ledger Balance|Current Balance/i
const EMPLOYER_MARKERS = /DEDUCTIONS TOTALS BY EMPLOYEE|Staff Deductions|Deduction Listing|Payroll Deductions|Employee Deductions|Salary Deductions|Staff Loans|Simplified Lending|Pay Date|DEDUCTIONS/i

function parseAmount(val) {
  if (val == null || val === '') return NaN
  return parseFloat(String(val).replace(/[^0-9.-]/g, ''))
}

function padDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function parseSlashDate(val) {
  const parts = String(val).trim().split('/')
  if (parts.length !== 3) return null
  const [a, b, c] = parts.map((x) => parseInt(x, 10))
  if (a > 31) return padDate(a, b, c)
  return padDate(c, a, b)
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
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
  const slash = parseSlashDate(val)
  if (slash) return slash
  return String(val).trim()
}

function detectPdfType(text, filename) {
  if (BANK_MARKERS.test(text) || /^\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}\/\d{1,2}\/\d{2}/m.test(text)) {
    return 'bank'
  }
  if (EMPLOYER_MARKERS.test(text) || /^Name\s+Amount/im.test(text)) {
    return 'employer'
  }
  if (/\bDEDUCTIONS\b/i.test(text) || /Simplified Lending/i.test(text)) {
    return 'employer'
  }
  return 'bank'
}

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
  const patterns = [
    /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/,
    /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/,
  ]
  for (const re of patterns) {
    const m = base.match(re)
    if (m) {
      if (re === patterns[0]) return parseMonthNameDate(`${m[1]} ${m[2]}, ${m[3]}`)
      return parseMonthNameDate(`${m[2]} ${m[1]}, ${m[3]}`)
    }
  }
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

  const dateLine = text.match(/^Date:\s*([^\n]+)/im)
  if (dateLine) {
    const d = parseMonthNameDate(dateLine[1].trim()) || parseSlashDate(dateLine[1].trim())
    if (d) statementDate = d
  }

  return { employer, statementDate }
}

function isSkipLine(line) {
  if (!line || line === '-' || line === '$') return true
  if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(line)) return true
  if (/^Simplified Lending/i.test(line) && !/\d+\.\d{2}/.test(line)) return true
  if (/^DEDUCTIONS TOTALS BY EMPLOYEE/i.test(line)) return true
  if (/^Name\s+Amount/i.test(line)) return true
  if (/^ACC\|?No Comments/i.test(line)) return true
  if (/^ACCT No\./i.test(line)) return true
  if (/^(total|subtotal|grand total|page \d+|date:?|pay period|company\s*name)/i.test(line.trim())) return true
  if (/^(emp(loyee)?\s*name|name\s+amount|deduction\s+amount|staff\s+deduction)/i.test(line.trim())) return true
  if (/^Cable Bahamas Ltd\./i.test(line) && /Pay Date/i.test(line)) return true
  if (/^Date:/i.test(line) && !/\d+\.\d{2}/.test(line)) return true
  return false
}

function isRemarkContinuation(line) {
  if (isSkipLine(line)) return false
  if (/\$\s*[\d,]+\.\d{2}/.test(line) || /[\d,]+\.\d{2}\s*\$/.test(line) || /\b\d+\.\d{2}\b/.test(line)) return false
  return /^[A-Za-z(]/.test(line)
}

function parseEmployerAmountLine(line) {
  if (!line || isSkipLine(line)) return null
  const trimmed = line.trim()

  // 1. Delimited by tabs, pipes, or 2+ consecutive spaces
  const parts = trimmed.split(/\t+|\s{2,}|\|/).map((s) => s.trim()).filter((s) => s && s !== '$')
  if (parts.length >= 2) {
    let amount = null
    let amountIdx = -1
    for (let i = parts.length - 1; i >= 0; i--) {
      const n = parseAmount(parts[i])
      if (!isNaN(n) && n > 0 && /^(?:\$|BSD|USD)?\s*[\d,]+(?:\.\d{2})?$/.test(parts[i])) {
        amount = n
        amountIdx = i
        break
      }
    }
    if (amount !== null && amountIdx > 0) {
      const before = parts.slice(0, amountIdx)
      const nameParts = before.filter((p) => !/^#?\d+$/.test(p) && !/^(emp|id|#|no\.?)[-_ ]*\d*$/i.test(p))
      const name = (nameParts.length ? nameParts : before).join(' ').trim()
      const comments = parts.slice(amountIdx + 1).join(' ').trim()
      if (name.length >= 2 && !/^(name|amount|total|employee|id|emp\s*id|grand total|subtotal)$/i.test(name)) {
        return { name, amount, comments }
      }
    }
  }

  // 2. Space-separated: "John Doe 450.00 optional remarks" or "10482 Jane Smith $450.00"
  const m = trimmed.match(
    /^(?:(?:(?:#?\d+|[A-Za-z]{1,4}[-#]\d+)\s+)?)((?:[A-Za-z][A-Za-z.,\x27-]+\s*)+?)\s+(?:\$|BSD|USD)?\s*([\d,]+(?:\.\d{2})?)(?:\s+(.*))?$/i
  )
  if (m) {
    const name = m[1].trim()
    const amount = parseAmount(m[2])
    const comments = (m[3] || '').trim()
    if (!isNaN(amount) && amount > 0 && name.length >= 3 && !/^(name|amount|total|employee|grand total|subtotal)$/i.test(name)) {
      return { name, amount, comments }
    }
  }

  return null
}

function parseEmployerStatement(text, filename, fileParticulars = '') {
  const meta = extractEmployerMeta(text, filename)
  const employer = String(fileParticulars || '').trim() || meta.employer
  const statementDate = meta.statementDate
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

  const rows = []
  let pendingRemark = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isSkipLine(line)) continue

    const parsed = parseEmployerAmountLine(line)
    if (parsed) {
      if (pendingRemark && rows.length) {
        const last = rows[rows.length - 1]
        last.remarks = [last.remarks, pendingRemark.trim()].filter(Boolean).join(' — ')
      }
      pendingRemark = ''

      const rowDate = parseDatedComment(parsed.comments) || statementDate
      let remarks = parsed.comments
      if (!remarks) remarks = `Salary deduction — ${employer}`
      else if (!/deduction|salary|emi|staff/i.test(remarks) && !/^dated/i.test(remarks)) {
        remarks = `${remarks} — ${employer}`
      }

      rows.push({
        name: parsed.name,
        amount: parsed.amount,
        remarks,
        employer,
        date: rowDate,
        statementDate,
      })
      continue
    }

    // Lookahead pairing: line i is a name and line i+1 is an amount
    if (i + 1 < lines.length && /^[A-Za-z][A-Za-z\s.,'-]{2,40}$/.test(line) && !/^(name|amount|total|deduction|employee)$/i.test(line)) {
      const nextLine = lines[i + 1]
      const nextAmount = parseAmount(nextLine)
      if (!isNaN(nextAmount) && nextAmount > 0 && /^(?:\$|BSD|USD)?\s*[\d,]+(?:\.\d{2})?$/.test(nextLine)) {
        const rowDate = statementDate
        const remarks = `Salary deduction — ${employer}`
        rows.push({
          name: line.trim(),
          amount: nextAmount,
          remarks,
          employer,
          date: rowDate,
          statementDate,
        })
        i++ // Skip the amount line
        continue
      }
    }

    if (isRemarkContinuation(line) && rows.length) {
      pendingRemark += (pendingRemark ? ' ' : '') + line
    }
  }

  if (pendingRemark && rows.length) {
    const last = rows[rows.length - 1]
    last.remarks = [last.remarks, pendingRemark.trim()].filter(Boolean).join(' — ')
  }

  return rows
}

function toEmployerCreditRows(rows) {
  return rows.map((r) => ({
    datePosted: r.date || r.statementDate,
    valueDate: r.date || r.statementDate,
    reference: r.reference && String(r.reference).toLowerCase() !== 'customer' ? r.reference : '',
    particulars: r.remarks,
    rawParticulars: r.remarks,
    creditAmount: r.amount,
    name: r.name,
    employer: r.employer,
    remarks: r.remarks,
  }))
}

function toEmployerImportRows(rows) {
  return rows.map((r) => ({
    datePosted: r.date || r.statementDate,
    valueDate: r.date || r.statementDate,
    reference: r.reference && String(r.reference).toLowerCase() !== 'customer' ? r.reference : '',
    particulars: r.remarks,
    rawParticulars: r.remarks,
    creditAmount: r.amount,
    name: r.name,
    employer: r.employer,
    remarks: r.remarks,
    date: r.date || r.statementDate,
    payer: r.name,
    description: r.remarks,
    amount: r.amount,
  }))
}

// --- Bank statement parser ---

function toBankImportRows(creditRows) {
  return creditRows.map((r) => {
    const parsed = parsePipeParticulars(r.particulars)
    const borrowerName = r.name || parsed.borrowerName || ''
    const personName = looksLikePersonName(borrowerName) ? borrowerName : ''
    const raw = String(r.particulars || '').trim()
    const ref = r.reference && String(r.reference).toLowerCase() !== 'customer' ? r.reference : ''
    return {
      ...r,
      datePosted: r.datePosted,
      valueDate: r.valueDate,
      reference: ref,
      particulars: raw,
      rawParticulars: raw,
      creditAmount: r.creditAmount,
      name: personName,
      date: r.datePosted,
      payer: personName,
      transactionDescription: parsed.description,
      description: raw,
      amount: r.creditAmount,
      employerOrBank: parsed.companyAccount || 'Bank of The Bahamas',
    }
  })
}

export async function parsePdfBuffer(buffer, filename = 'statement.pdf', options = {}) {
  const { documentType, fileParticulars } = options
  const forceEmployer = documentType === 'employer'
  const forceBank = documentType === 'bank'

  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    const rawText = (result.text || '').trim()
    const detected = detectPdfType(rawText, filename)
    const tryEmployer = forceEmployer || (!forceBank && detected === 'employer')

    // 1. Try deterministic employer parsing
    if (tryEmployer && rawText.length > 0) {
      const employerRows = parseEmployerStatement(rawText, filename, fileParticulars)
      if (employerRows.length) {
        const creditRows = toEmployerCreditRows(employerRows)
        return {
          method: 'pdf',
          source: 'employer',
          documentType: 'employer',
          creditRows,
          rows: toEmployerImportRows(employerRows),
        }
      }
    }

    // 2. Try deterministic bank statement parsing
    if ((forceBank || !forceEmployer) && rawText.length > 0) {
      const extracted = await extractPositionedBank(parser)
      if (extracted.recognizedPages) {
        const creditRows = extracted.rows.filter(r => r.direction === 'credit')
        return {
          method: 'pdf', source: 'bank', documentType: 'bank',
          creditRows, rows: toBankImportRows(creditRows),
          extractedRows: extracted.rows, diagnostics: extracted.diagnostics,
        }
      }
      // A bank layout without identifiable columns is not safe to import.
      if (forceBank || BANK_MARKERS.test(rawText)) {
        return { method: 'pdf', source: 'bank', documentType: 'bank', creditRows: [], rows: [],
          diagnostics: { complete: false, warnings: ['Bank debit/credit columns could not be verified. Supply a searchable bank PDF or a bank CSV with explicit credit/debit columns.'] } }
      }
    }

    if (forceBank) return { method: 'pdf', source: 'bank', documentType: 'bank', creditRows: [], rows: [], diagnostics: { complete: false, warnings: ['Scanned bank statement requires verified credit/debit columns. Upload the bank CSV or searchable PDF.'] } }

    // 3. Fallback: try employer parsing on rawText if not yet tried
    if (rawText.length > 0) {
      const fallbackEmployer = parseEmployerStatement(rawText, filename, fileParticulars)
      if (fallbackEmployer.length) {
        const creditRows = toEmployerCreditRows(fallbackEmployer)
        return {
          method: 'pdf',
          source: 'employer',
          documentType: 'employer',
          creditRows,
          rows: toEmployerImportRows(fallbackEmployer),
        }
      }
    }

    // 4. AI Text Fallback: If text was extracted but line parsing missed it, use AI extraction
    if (rawText.length >= 20 && process.env.OPENROUTER_API_KEY) {
      try {
        const aiRows = await extractFromTextWithAI(rawText, {
          documentType: documentType || (detected === 'employer' ? 'employer' : 'bank'),
          fileParticulars,
        })
        if (aiRows.length) {
          const mappedRows = aiRows.map((r) => ({
            datePosted: r.date,
            valueDate: r.date,
            reference: r.reference || '',
            particulars: r.description || (documentType === 'employer' ? 'Salary deduction' : 'Credit deposit'),
            creditAmount: r.amount,
            name: r.payer,
            date: r.date,
            payer: r.payer,
            description: r.description,
            amount: r.amount,
            employer: documentType === 'employer' ? (fileParticulars || employerFromFilename(filename)) : undefined,
            remarks: r.description,
          }))
          return {
            method: 'ai',
            source: documentType === 'employer' ? 'employer' : detected,
            documentType: documentType || detected,
            creditRows: mappedRows,
            rows: mappedRows,
          }
        }
      } catch (aiErr) {
        console.warn('AI PDF text extraction fallback attempt failed:', aiErr.message)
      }
    }

    // 5. Scanned PDF / Image PDF Fallback: If text is empty or too short, extract page screenshot / embedded image
    if (process.env.OPENROUTER_API_KEY) {
      try {
        const screenshotResult = await parser.getScreenshot({ imageBuffer: true, imageDataUrl: true })
        const aiRows = []
        for (const page of screenshotResult.pages || []) {
          if (!page.data?.length) throw new Error('PDF page image unavailable')
          aiRows.push(...await extractFromImageWithAI(Buffer.from(page.data), 'image/png', {
            documentType: documentType || (detected === 'employer' ? 'employer' : 'bank'),
            fileParticulars,
          }))
        }
        {
          if (aiRows.length) {
            const mappedRows = aiRows.map((r) => ({
              datePosted: r.date,
              valueDate: r.date,
              reference: r.reference || '',
              particulars: r.description,
              creditAmount: r.amount,
              name: r.payer,
              date: r.date,
              payer: r.payer,
              description: r.description,
              amount: r.amount,
              employer: documentType === 'employer' ? (fileParticulars || employerFromFilename(filename)) : undefined,
              remarks: r.description,
            }))
            return {
              method: 'ai',
              source: documentType === 'employer' ? 'employer' : 'image',
              documentType: documentType || 'image',
              creditRows: mappedRows,
              rows: mappedRows,
            }
          }
        }
      } catch (ocrErr) {
        console.warn('AI PDF OCR screenshot extraction failed:', ocrErr.message)
      }
    }

    if (forceEmployer) {
      throw new Error(
        'No employee repayment rows found in this PDF. Check the file format or add notes in File particulars (employer name, pay period).'
      )
    }

    if (forceBank) {
      throw new Error('No credit transactions found in bank statement PDF')
    }

    throw new Error('No credit or employee repayment rows found in PDF')
  } finally {
    await parser.destroy()
  }
}
