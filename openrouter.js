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

export function parseJsonArrayFromText(content) {
  if (!content) return []
  // Remove markdown code blocks if present
  let clean = content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
  
  // Look for JSON array [...]
  const match = clean.match(/\[[\s\S]*\]/)
  if (!match) return []

  try {
    const parsed = JSON.parse(match[0])
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // Attempt cleanup of trailing commas
    const fixed = match[0].replace(/,\s*([\]}])/g, '$1')
    try {
      const parsed = JSON.parse(fixed)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
}

async function callOpenRouterWithFallback({ messages, models, temperature = 0.1 }) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('AI extraction unavailable — set OPENROUTER_API_KEY in server/.env')

  let lastError = null
  for (const model of models) {
    if (!model) continue
    try {
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
          messages,
          temperature,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        lastError = new Error(`Model ${model} returned ${res.status}: ${errText.slice(0, 200)}`)
        continue
      }

      const data = await res.json()
      if (data.error) {
        lastError = new Error(`Model ${model} error: ${data.error.message || JSON.stringify(data.error)}`)
        continue
      }

      const content = data.choices?.[0]?.message?.content || ''
      if (content) return content
    } catch (e) {
      lastError = e
    }
  }

  throw lastError || new Error('All AI extraction models failed')
}

export async function extractWithAI(headers, sampleRows, context = {}) {
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
Sample rows: ${JSON.stringify(sampleRows.slice(0, 8))}

Return ONLY a JSON array of objects with keys: date, payer, description, amount, reference.
Skip header rows and empty rows. Include ONLY credit/incoming payment rows (amount > 0). Exclude debits, withdrawals, and negative amounts.`

  const models = [
    process.env.OPENROUTER_MODEL,
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
  ].filter(Boolean)

  const content = await callOpenRouterWithFallback({
    messages: [{ role: 'user', content: prompt }],
    models,
  })

  const parsed = parseJsonArrayFromText(content)
  if (!parsed.length) throw new Error('AI returned invalid format')

  return parsed
    .map((r) => ({
      date: normalizeDate(r.date),
      payer: String(r.payer || r.beneficiary || r.name || r.employee || '').trim(),
      description: String(r.description || r.memo || '').trim(),
      amount: parseAmount(r.amount),
      reference: String(r.reference || r['reference number'] || '').trim(),
    }))
    .filter((r) => r.date && !isNaN(r.amount) && r.amount > 0)
}

/** Extract credit / deduction rows from unstructured PDF or raw statement text */
export async function extractFromTextWithAI(rawText, context = {}) {
  const docHint = context.fileParticulars ? `Uploader notes: ${context.fileParticulars}. ` : ''
  const isEmployer = context.documentType === 'employer' || /deduction|payroll/i.test(rawText)
  const typeHint = isEmployer
    ? 'This is an employer payroll deduction listing. Extract every employee name and their deduction/repayment amount.'
    : 'This is a bank or credit statement. Extract every incoming credit/deposit transaction.'

  const today = new Date().toISOString().slice(0, 10)
  const prompt = `You are a high-accuracy financial document parser for SmartRepay (Simplified Lending Bahamas).
${docHint}${typeHint}

Document Text:
"""
${rawText.slice(0, 45000)}
"""

Extract all individual payment/deduction transactions.
Return ONLY a valid JSON array of objects:
[
  {
    "date": "YYYY-MM-DD",
    "payer": "Employee or Borrower Full Name",
    "description": "Salary deduction / loan payment notes",
    "amount": 123.45,
    "reference": "Emp ID, Ref, or Account number if present"
  }
]
Rules:
1. "payer" must be the individual person's name (clean up IDs and titles).
2. "amount" must be a positive numeric amount (never negative, exclude total/subtotal summary lines).
3. If no specific transaction date is on a row, use the document statement/pay date, or "${today}".
4. Exclude debit/fee/summary lines. Return ONLY the JSON array.`

  const models = [
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
    process.env.OPENROUTER_MODEL,
  ].filter(Boolean)

  const content = await callOpenRouterWithFallback({
    messages: [{ role: 'user', content: prompt }],
    models,
  })

  const parsed = parseJsonArrayFromText(content)
  if (!parsed.length) throw new Error('AI could not identify deduction or repayment rows in this document')

  return parsed
    .map((r) => ({
      date: normalizeDate(r.date) || today,
      payer: String(r.payer || r.name || r.employee || '').trim(),
      description: String(r.description || r.remarks || context.fileParticulars || (isEmployer ? 'Salary deduction' : 'Credit deposit')).trim(),
      amount: parseAmount(r.amount),
      reference: String(r.reference || '').trim(),
    }))
    .filter((r) => r.payer && !isNaN(r.amount) && r.amount > 0)
}

/** Extract credit rows from a scanned statement image (photo / screenshot / raster PDF page). */
export async function extractFromImageWithAI(buffer, mimeType, context = {}) {
  const base64 = buffer.toString('base64')
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`
  const docHint = context.fileParticulars ? `Uploader notes: ${context.fileParticulars}. ` : ''
  const isEmployer = context.documentType === 'employer'
  const typeHint = isEmployer
    ? 'This is an employer payroll / staff deduction list — one row per employee with employee name and deduction amount.'
    : context.documentType === 'bank'
      ? 'This is a bank statement — extract credit/deposit lines only.'
      : 'Extract employee repayment or bank credit lines (amounts received).'

  const today = new Date().toISOString().slice(0, 10)
  const prompt = `You are a high-accuracy document OCR parser for SmartRepay (Simplified Lending Bahamas).
${docHint}${typeHint}

Read this statement/deduction document image and extract all individual deduction/repayment rows.
Return ONLY a valid JSON array of objects:
[
  {
    "date": "YYYY-MM-DD",
    "payer": "Employee or Borrower Full Name",
    "description": "Salary deduction or payment particulars",
    "amount": 123.45,
    "reference": "Employee ID or reference code if present"
  }
]
Rules:
1. "payer" must be the individual employee/borrower's name.
2. "amount" must be the numeric amount (positive number). Exclude grand totals and subtotals.
3. If no row date is visible, use the document header date or "${today}".
4. Return ONLY the JSON array.`

  const models = [
    process.env.OPENROUTER_VISION_MODEL,
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
  ].filter(Boolean)

  const content = await callOpenRouterWithFallback({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    models,
  })

  const parsed = parseJsonArrayFromText(content)
  if (!parsed.length) throw new Error('AI could not read repayment rows from this image')

  return parsed
    .map((r) => ({
      date: normalizeDate(r.date) || today,
      payer: String(r.payer || r.name || r.employee || '').trim(),
      description: String(r.description || r.remarks || context.fileParticulars || (isEmployer ? 'Salary deduction' : 'Deposit')).trim(),
      amount: parseAmount(r.amount),
      reference: String(r.reference || '').trim(),
    }))
    .filter((r) => r.payer && !isNaN(r.amount) && r.amount > 0)
}
