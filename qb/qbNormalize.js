import { createHash } from 'crypto'

/**
 * QuickBooks Data — Normalization Utilities
 * Pure functions. No DB access. No AI calls.
 * These are deterministic and safe to call anywhere.
 */

// ---------------------------------------------------------------------------
// Date normalization
// ---------------------------------------------------------------------------

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function pad(n) { return String(n).padStart(2, '0') }

/** Normalize any date representation to YYYY-MM-DD. Returns null if unparseable. */
export function normalizeDate(val) {
  if (!val) return null
  const str = String(val).trim()

  // Already ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str

  // ISO datetime: 2026-09-15T...
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`

  // MM/DD/YYYY or DD/MM/YYYY or YYYY/MM/DD
  const slashParts = str.split('/')
  if (slashParts.length === 3) {
    const [a, b, c] = slashParts.map((x) => parseInt(x, 10))
    if (a > 31) return `${a}-${pad(b)}-${pad(c)}`          // YYYY/MM/DD
    if (c > 31) return `${c}-${pad(a)}-${pad(b)}`          // MM/DD/YYYY (US)
    return null
  }

  // "Sep 15, 2026" or "15 Sep 2026"
  const monthNameMatch = str.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/) ||
                         str.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/)
  if (monthNameMatch) {
    const parts = monthNameMatch.slice(1)
    let day, monthName, year
    if (isNaN(parseInt(parts[0]))) {
      [monthName, day, year] = parts
    } else {
      [day, monthName, year] = parts
    }
    const month = MONTHS[String(monthName).toLowerCase()]
    if (month) return `${year}-${pad(month)}-${pad(parseInt(day))}`
  }

  // Try native Date as last resort
  const d = new Date(str)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)

  return null
}

/** Format internal YYYY-MM-DD to QuickBooks MM/DD/YYYY format */
export function toQbDate(isoDate) {
  if (!isoDate) return ''
  const [y, m, d] = isoDate.split('-')
  return `${m}/${d}/${y}`
}

// ---------------------------------------------------------------------------
// Amount normalization
// ---------------------------------------------------------------------------

/** Parse any amount string/number to a clean float. Returns NaN on failure. */
export function normalizeAmount(val) {
  if (val == null || val === '') return NaN
  if (typeof val === 'number') return isFinite(val) ? val : NaN
  // Remove currency symbols, commas, spaces; keep minus and decimal
  const cleaned = String(val).replace(/[^0-9.\-]/g, '')
  return parseFloat(cleaned)
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/** Normalize a person/company name. Preserves raw value. */
export function normalizeName(val) {
  const raw = String(val || '').trim()
  const normalized = raw
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { raw, normalized }
}

// ---------------------------------------------------------------------------
// Reference normalization
// ---------------------------------------------------------------------------

/** Trim spaces from reference numbers. Preserve hyphens, slashes, prefixes. */
export function normalizeReference(val) {
  if (!val) return ''
  return String(val).trim().replace(/\s+/g, ' ')
}

// ---------------------------------------------------------------------------
// Duplicate hash
// ---------------------------------------------------------------------------

/**
 * Build a deterministic transaction hash for duplicate detection.
 * Components: template_type | date | normalized_name | reference | amount
 * All components are normalized before hashing.
 */
export function buildTransactionHash(templateType, date, name, reference, amount) {
  const { normalized: normName } = normalizeName(name)
  const normDate = normalizeDate(date) || String(date || '').trim()
  const normRef = normalizeReference(reference)
  const normAmount = isNaN(parseFloat(amount)) ? '0' : parseFloat(amount).toFixed(2)

  const signature = [
    String(templateType).toUpperCase(),
    normDate,
    normName,
    normRef.toUpperCase(),
    normAmount,
  ].join('|')

  return createHash('sha256').update(signature).digest('hex')
}

// ---------------------------------------------------------------------------
// QB template date format
// ---------------------------------------------------------------------------

/** Validate that a date string is a real calendar date. */
export function isValidDate(isoDate) {
  if (!isoDate) return false
  const d = new Date(isoDate)
  return !isNaN(d.getTime())
}

/** Confidence band label */
export function confidenceBand(score) {
  if (score == null) return 'unknown'
  if (score >= 0.95) return 'high'
  if (score >= 0.85) return 'acceptable'
  if (score >= 0.70) return 'needs_review'
  return 'low'
}
