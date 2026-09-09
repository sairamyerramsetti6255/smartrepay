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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

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
  // Try direct parse first
  try { return JSON.parse(content) } catch {}
  // Try extracting JSON object from markdown fences
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
 * @param {object} context - { documentType, fileParticulars, sourceType }
 * @returns {object} QB extraction schema result
 */
export async function extractFromText(text, context = {}) {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('AI extraction unavailable — set OPENROUTER_API_KEY in server/.env')

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

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`AI extraction failed (${res.status}): ${err.slice(0, 200)}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content || ''
  return parseAiJson(content)
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
