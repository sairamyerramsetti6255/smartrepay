const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

function parseAmount(val) {
  if (val == null || val === '') return 0
  if (typeof val === 'number') return val
  return parseFloat(String(val).replace(/[^0-9.-]/g, '')) || 0
}

function normalizeDate(val) {
  if (!val) return ''
  const d = new Date(val)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  const m = String(val).match(/(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return String(val).trim()
}

export async function extractWithAI(headers, sampleRows, context = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('AI extraction unavailable — set OPENROUTER_API_KEY in server/.env')

  const docHint = context.fileParticulars
    ? `\nFile notes from uploader: ${context.fileParticulars}`
    : ''
  const typeHint = context.documentType
    ? `\nDocument type: ${context.documentType} (employer payroll = employee name + deduction amount per row).`
    : ''

  const prompt = `You are a bank statement parser for loan repayment reconciliation (Simplified Lending Bahamas).

Map the spreadsheet columns to this schema for EACH transaction row:
- date: YYYY-MM-DD
- payer: person or company who paid (employee/borrower name)
- description: transaction description
- amount: numeric credit amount only — positive incoming payments (strip BSD, $, commas). Use Credit column when present; never use Debit column values.
- reference: reference number or transaction id
${typeHint}${docHint}

Headers: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(sampleRows.slice(0, 6))}

Return ONLY a JSON array of objects with keys: date, payer, description, amount, reference.
Skip header rows and empty rows. Include ONLY credit/incoming payment rows (amount > 0). Exclude debits, withdrawals, and negative amounts.`

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5173',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SmartRepay AI',
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`AI extraction failed: ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || ''
  const match = content.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('AI returned invalid format')

  const parsed = JSON.parse(match[0])
  return parsed
    .map((r) => ({
      date: normalizeDate(r.date),
      payer: String(r.payer || r.beneficiary || '').trim(),
      description: String(r.description || '').trim(),
      amount: parseAmount(r.amount),
      reference: String(r.reference || r['reference number'] || '').trim(),
    }))
    .filter((r) => r.date && !isNaN(r.amount) && r.amount > 0)
}

/** Extract credit rows from a scanned statement image (photo / screenshot). */
export async function extractFromImageWithAI(buffer, mimeType, context = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('AI extraction unavailable — set OPENROUTER_API_KEY in server/.env')

  const base64 = buffer.toString('base64')
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`
  const docHint = context.fileParticulars ? `Uploader notes: ${context.fileParticulars}. ` : ''
  const typeHint =
    context.documentType === 'employer'
      ? 'This is an employer payroll / staff deduction list — one row per employee with name and deduction amount.'
      : context.documentType === 'bank'
        ? 'This is a bank statement — extract credit/deposit lines only.'
        : 'Extract employee repayment or bank credit lines (amounts received).'

  const prompt = `${docHint}${typeHint}

Return ONLY a JSON array of credit/repayment rows with keys: date (YYYY-MM-DD), payer (person name), description, amount (positive number), reference.
Include ONLY incoming payments / EMI deductions with amount > 0. Use today's date if no date visible.`

  const model = process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001'

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5173',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SmartRepay AI',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.1,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`AI image extraction failed: ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || ''
  const match = content.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('AI could not read repayment rows from this image')

  const parsed = JSON.parse(match[0])
  return parsed
    .map((r) => ({
      date: normalizeDate(r.date) || new Date().toISOString().slice(0, 10),
      payer: String(r.payer || r.name || r.employee || '').trim(),
      description: String(r.description || r.remarks || context.fileParticulars || '').trim(),
      amount: parseAmount(r.amount),
      reference: String(r.reference || '').trim(),
    }))
    .filter((r) => r.payer && !isNaN(r.amount) && r.amount > 0)
}
