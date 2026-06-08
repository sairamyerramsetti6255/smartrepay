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

export async function extractWithAI(headers, sampleRows) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('AI extraction unavailable — set OPENROUTER_API_KEY in server/.env')

  const prompt = `You are a bank statement parser for loan repayment reconciliation (Simplified Lending Bahamas).

Map the spreadsheet columns to this schema for EACH transaction row:
- date: YYYY-MM-DD
- payer: person or company who paid (use Beneficiary column if present)
- description: transaction description
- amount: numeric only (strip BSD, $, commas)
- reference: reference number or transaction id

Headers: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(sampleRows.slice(0, 6))}

Return ONLY a JSON array of objects with keys: date, payer, description, amount, reference.
Skip header rows and empty rows. Credits only if Transaction Type column exists.`

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
