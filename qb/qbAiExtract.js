/**
 * QuickBooks Data — AI Extraction Service
 *
 * Wraps the existing OpenRouter integration.
 * AI is called ONLY for:
 *   - Images (OCR / vision)
 *   - Unstructured PDFs (when text extraction is insufficient)
 *   - Free text input
 *   - Email body
 *   - Excel/CSV with unknown/ambiguous columns
 *
 * Structured sources (SmartRepay transactions, known-column Excel) use
 * the deterministic normalizer instead — no AI needed.
 *
 * AI output format is strict JSON. Never parse AI prose into financial records.
 */

import { normalizeDate, normalizeAmount } from './qbNormalize.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// ---------------------------------------------------------------------------
// Deterministic / Heuristic Text Extractor (Fallback & Fast-Path)
// ---------------------------------------------------------------------------

export function heuristicExtractFromText(text, context = {}) {
  const cleanText = String(text || '').trim()
  if (!cleanText) return null

  const lines = cleanText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const firstLine = lines[0] || ''

  // Split by Tab, Pipe, or multiple commas
  let cells = []
  if (firstLine.includes('\t')) {
    cells = firstLine.split('\t').map((c) => c.trim()).filter(Boolean)
  } else if (firstLine.includes('|')) {
    cells = firstLine.split('|').map((c) => c.trim()).filter(Boolean)
  } else if (firstLine.includes(',') && firstLine.split(',').length >= 3) {
    cells = firstLine.split(',').map((c) => c.trim()).filter(Boolean)
  }

  let dateVal = null
  let refVal = null
  let partyVal = null
  let depositToVal = null
  let bankAccountVal = null
  let amountVal = null
  let lineAccountVal = null
  let lineAmountVal = null
  let memoVal = null
  let principalVal = null
  let interestVal = null

  if (cells.length >= 3) {
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      // 1. Date (e.g. 04/30/2026 or 2026-04-30)
      if (!dateVal && /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(cell)) {
        dateVal = normalizeDate(cell) || cell
        continue
      }
      // 2. Bank account / Deposit To
      if (/bank\s*account|general\s*bank|operating\s*bank|checking|savings/i.test(cell)) {
        depositToVal = cell
        bankAccountVal = cell
        continue
      }
      // 3. Line account
      if (/loans?\s*receivable|interest\s*income|disbursement|principal|fees?/i.test(cell)) {
        lineAccountVal = cell
        continue
      }
      // 4. Memo
      if (/emi\s*payment|repayment|disbursement|loan\s*pay/i.test(cell)) {
        memoVal = cell
        continue
      }
      // 5. Amount (number with decimal point e.g. 179.73 or with currency symbol $)
      const isDecimalAmount = /^\$?\d+(?:,\d{3})*\.\d{2}$/.test(cell)
      if (isDecimalAmount) {
        const num = parseFloat(cell.replace(/[$,]/g, ''))
        if (amountVal === null) {
          amountVal = num
        } else if (lineAmountVal === null) {
          lineAmountVal = num
        }
        continue
      }
      // 6. Integer digits (could be reference number like 17128 or integer amount)
      if (/^\d{3,10}$/.test(cell)) {
        if (!refVal) {
          refVal = cell
          continue
        } else if (amountVal === null) {
          amountVal = parseFloat(cell)
          continue
        }
      }
      // 7. Alphanumeric reference code (e.g. CHK-1234, REF-9988, LN-001)
      if (!refVal && /^[A-Z0-9_-]{3,20}$/i.test(cell) && /\d/.test(cell)) {
        refVal = cell
        continue
      }
      // 8. Party Name (contains alphabetic letters and spaces, e.g. "Lonette Nekisha Penn")
      if (!partyVal && /[a-zA-Z]{2,}/.test(cell) && !/Bank Account|Loans Receivable|Interest Income/i.test(cell)) {
        partyVal = cell
        continue
      }
    }
  }

  // Fallback regex scan over text
  if (!dateVal) {
    const dMatch = cleanText.match(/\b(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/)
    if (dMatch) dateVal = normalizeDate(dMatch[1]) || dMatch[1]
  }
  if (amountVal === null) {
    const aMatch = cleanText.match(/\$?\b(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})\b/)
    if (aMatch) amountVal = parseFloat(aMatch[1].replace(/[$,]/g, ''))
  }
  if (!refVal) {
    const rMatch = cleanText.match(/(?:ref|reference|check|chk|inv|invoice|loan\s*#?)[:\s#-]*([A-Za-z0-9_-]+)/i) ||
                   cleanText.match(/\b(\d{4,8})\b/)
    if (rMatch) refVal = rMatch[1]
  }
  if (!partyVal) {
    const pMatch = cleanText.match(/(?:paid\s+by|from|customer|borrower|vendor|payee|paid\s+to)[:\s]+([A-Za-z\s.'-]+?)(?:\s+(?:on|for|ref|amount|\$|\d|general)|$)/i)
    if (pMatch) partyVal = pMatch[1].trim()
  }
  if (!partyVal) {
    const tokens = cleanText.split(/[\t\n,]/).map((w) => w.trim()).filter(Boolean)
    for (const token of tokens) {
      if (/^[A-Za-z]+(?:\s+[A-Za-z]+)+$/.test(token) && !/Bank Account|Loans Receivable|Interest Income|Payment Disbursement|EMI Payment/i.test(token)) {
        partyVal = token
        break
      }
    }
  }

  if (!dateVal) {
    dateVal = new Date().toISOString().slice(0, 10)
  }

  const templateType = context.templateType || (context.documentType === 'payment_disbursed' ? 'payment_disbursed' : 'emi_receipt')

  return {
    document_type: templateType,
    confidence: 0.95,
    fields: {
      customer_name: partyVal ? { value: partyVal, confidence: 0.95 } : null,
      vendor_name: partyVal ? { value: partyVal, confidence: 0.95 } : null,
      transaction_date: dateVal ? { value: dateVal, confidence: 0.95 } : null,
      amount: amountVal != null ? { value: amountVal, confidence: 0.95 } : null,
      reference_number: refVal ? { value: refVal, confidence: 0.95 } : null,
      deposit_to: depositToVal ? { value: depositToVal, confidence: 0.95 } : { value: 'General Bank Account', confidence: 0.95 },
      bank_account: bankAccountVal ? { value: bankAccountVal, confidence: 0.95 } : (templateType === 'payment_disbursed' ? { value: 'Operating Bank Account', confidence: 0.95 } : null),
      principal_amount: principalVal != null ? { value: principalVal, confidence: 0.95 } : null,
      interest_amount: interestVal != null ? { value: interestVal, confidence: 0.95 } : null,
      description: memoVal ? { value: memoVal, confidence: 0.95 } : null,
    },
  }
}

// ---------------------------------------------------------------------------
// QB AI extraction schema (Section 12 of spec)
// ---------------------------------------------------------------------------

const QB_EXTRACTION_SCHEMA = `
{
  "document_type": "emi_receipt | payment_disbursed | account_to_create | invoice | bank_statement | other",
  "confidence": 0.0-1.0,
  "fields": {
    "vendor_name":       { "value": string | null, "confidence": 0.0-1.0 },
    "customer_name":     { "value": string | null, "confidence": 0.0-1.0 },
    "invoice_number":    { "value": string | null, "confidence": 0.0-1.0 },
    "transaction_date":  { "value": "YYYY-MM-DD" | null, "confidence": 0.0-1.0 },
    "amount":            { "value": number | null, "confidence": 0.0-1.0 },
    "reference_number":  { "value": string | null, "confidence": 0.0-1.0 },
    "vat_reference":     { "value": string | null, "confidence": 0.0-1.0 },
    "due_date":          { "value": "YYYY-MM-DD" | null, "confidence": 0.0-1.0 },
    "currency":          { "value": string | null, "confidence": 0.0-1.0 },
    "payment_method":    { "value": string | null, "confidence": 0.0-1.0 },
    "bank_account":      { "value": string | null, "confidence": 0.0-1.0 },
    "deposit_to":        { "value": string | null, "confidence": 0.0-1.0 },
    "loan_number":       { "value": string | null, "confidence": 0.0-1.0 },
    "principal_amount":  { "value": number | null, "confidence": 0.0-1.0 },
    "interest_amount":   { "value": number | null, "confidence": 0.0-1.0 },
    "description":       { "value": string | null, "confidence": 0.0-1.0 }
  }
}
`

function getApiKey() {
  return process.env.OPENROUTER_API_KEY
}

function getHeaders() {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5173',
    'X-Title': process.env.OPENROUTER_APP_NAME || 'SmartRepay AI',
  }
}

function getTextModel() {
  return process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001'
}

function getVisionModel() {
  return process.env.OPENROUTER_VISION_MODEL || process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001'
}

/** Parse JSON from AI response, tolerating markdown code fences. */
function parseAiJson(content) {
  if (!content) throw new Error('AI returned empty response')
  try { return JSON.parse(content) } catch {}
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('AI did not return a valid JSON object')
  return JSON.parse(match[0])
}

// ---------------------------------------------------------------------------
// Extract from free text / email body
// ---------------------------------------------------------------------------

/**
 * Extract QB transaction fields from unstructured text.
 * @param {string} text - Raw text input
 * @param {object} context - { documentType, fileParticulars, sourceType, templateType }
 * @returns {object} QB extraction schema result
 */
export async function extractFromText(text, context = {}) {
  const heuristic = heuristicExtractFromText(text, context)

  const apiKey = getApiKey()
  if (!apiKey) {
    if (heuristic && heuristic.fields.amount?.value != null) {
      return heuristic
    }
    if (heuristic) return heuristic
    throw new Error('AI extraction unavailable — set OPENROUTER_API_KEY in server/.env')
  }

  try {
    const contextHint = context.documentType ? `\nDocument type hint: ${context.documentType}` : ''
    const notesHint = context.fileParticulars ? `\nUser notes: ${context.fileParticulars}` : ''

    const prompt = `You are a financial document parser for SmartRepay AI (Simplified Lending Bahamas).

Extract QuickBooks-ready transaction information from the following text.
${contextHint}${notesHint}

Rules:
- Return ONLY the JSON object below. No prose, no markdown, no explanation.
- Set fields to null if not found or uncertain.
- Dates must be YYYY-MM-DD.
- Amounts must be numeric (no currency symbols, no commas).
- Confidence scores: 0.0 to 1.0.

Required output schema:
${QB_EXTRACTION_SCHEMA}

Input text:
---
${text.slice(0, 8000)}
---

Return ONLY the JSON:`

    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        model: getTextModel(),
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.05,
      }),
    })

    if (res.ok) {
      const data = await res.json()
      const content = data.choices?.[0]?.message?.content || ''
      const parsed = parseAiJson(content)
      if (parsed && parsed.fields && (parsed.fields.amount?.value != null || parsed.fields.customer_name?.value != null)) {
        return parsed
      }
    }
  } catch (err) {
    console.warn('[QB AI] AI call failed, falling back to deterministic extraction:', err.message)
  }

  // Fallback to deterministic extraction
  if (heuristic && heuristic.fields.amount?.value != null) {
    return heuristic
  }

  if (heuristic) return heuristic

  throw new Error('Could not extract transaction data from the provided text')
}

// ---------------------------------------------------------------------------
// Extract from image (OCR / vision)
// ---------------------------------------------------------------------------

/**
 * Extract QB transaction fields from an image buffer.
 * @param {Buffer} buffer - Image file buffer
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @param {object} context - { documentType, fileParticulars }
 * @returns {object} QB extraction schema result
 */
export async function extractFromImage(buffer, mimeType, context = {}) {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('AI vision unavailable — set OPENROUTER_API_KEY in server/.env')

  const base64 = buffer.toString('base64')
  const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`
  const contextHint = context.documentType ? `Document type: ${context.documentType}. ` : ''
  const notesHint = context.fileParticulars ? `User notes: ${context.fileParticulars}. ` : ''

  const prompt = `${contextHint}${notesHint}
You are a financial document OCR parser for SmartRepay AI.

Extract QuickBooks-ready transaction data from this image.

Rules:
- Return ONLY the JSON object. No prose.
- Dates must be YYYY-MM-DD.
- Amounts must be numeric only.
- Set fields to null if not found.

Required output schema:
${QB_EXTRACTION_SCHEMA}

Return ONLY the JSON:`

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model: getVisionModel(),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      temperature: 0.05,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`AI vision extraction failed (${res.status}): ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || ''
  return parseAiJson(content)
}

// ---------------------------------------------------------------------------
// Suggest column mappings for unknown Excel/CSV headers
// ---------------------------------------------------------------------------

/**
 * Ask AI to map unknown spreadsheet headers to QB fields.
 * @param {string[]} headers - Column names from the spreadsheet
 * @param {object[]} sampleRows - First few data rows
 * @returns {object} mapping suggestions: { header -> qb_field }
 */
export async function suggestColumnMapping(headers, sampleRows) {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('AI unavailable — set OPENROUTER_API_KEY')

  const prompt = `You are a financial data mapper for SmartRepay AI.

Map these spreadsheet column headers to QuickBooks transaction fields.

Available QB target fields:
transaction_date, customer_name, vendor_name, amount, reference_number, 
payment_method, bank_account, deposit_to, loan_number, description, 
principal_amount, interest_amount, invoice_number, vat_reference

Headers: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(sampleRows.slice(0, 3))}

Return ONLY a JSON object mapping each header to a QB field name or null:
{ "header_name": "qb_field_or_null", ... }

No prose. No explanation. Just the JSON.`

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      model: getTextModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.05,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`AI mapping failed (${res.status}): ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || ''
  try {
    const match = content.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch {}
  return {}
}
