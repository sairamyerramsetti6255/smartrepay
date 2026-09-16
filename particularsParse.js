/**
 * Bank particulars often look like: "Transaction description | Borrower Name"
 * We split on the last pipe so amount fragments inside the description are safe.
 * Also handles company destination labels (e.g. "SIMPLIFIED LEND") so company
 * headers are not mistaken for individual borrower names.
 */

const COMPANY_NAMES = /^(simplified\s*(?:lend(?:ing)?|lean)(?:\s*(?:lt|ltd|limited))?|slending)$/i
const BANK_NARRATION =
  /direct\s+credit|cash\s+deposit|cheque\s+deposit|check\s+deposit|wire\s+transfer|bank\s+transfer|\||simplified\s*lend|ach\s*tfr|dirpay|dom\s+pay|loan\s+payment/i
const DIRECT_CREDIT_PREFIX = /^(?:direct\s+credit|ebank|internal|same\s+cust)\s+/i
const DIRECT_CREDIT_TAIL = /\s+-\s+(?:salar(?:y|ies)|loans?|ach\b.*|dirpay.*|payment|repayment|dom\s+pay|payroll).*$/i
/** Employer payroll / remittance narrations — middle token is the employer, not a person. */
const EMPLOYER_REMIT_TAIL =
  /\s+-\s+(?:salar(?:y|ies)|payroll|dom\s+pay|employer\s+remit)\b/i

/** Words that appear in bank txn labels — never part of a person name alone. */
const NON_PERSON_TOKEN =
  /^(cheque|check|deposit|transfer|credit|debit|cash|salary|salaries|payment|repayment|loan|loans|local|branch|wire|ach|tfr|dirpay|dom|pay|internal|ebank|customer|reference|balance|available|ledger|same|cust|from|to|the|and|of|for|via|inc|ltd|limited|corp|llc|co|company|banking|remittance|payroll|employer|org|organization|bahamas|broadcasting|broadcast|sbdc|zns|easyterms)$/i

const BANK_TXN_PHRASE =
  /cheque\s+deposit|check\s+deposit|cash\s+deposit|direct\s+credit|wire\s+transfer|bank\s+transfer|loan\s+pay|salary|salaries|dirpay|dom\s+pay|ach\s*tfr|simplified\s*lend/i

export function isCompanyName(value) {
  return COMPANY_NAMES.test(String(value || '').replace(/[^a-z\s]/gi, ' ').replace(/\s+/g, ' ').trim())
}

/** Full bank narration, not a person's name. */
export function looksLikeBankNarration(value) {
  return BANK_NARRATION.test(String(value || ''))
}

/** Employer/company codes like STRACHANSORA, EASYTERMSLTD, ZNSBROADCASTING — not CamelCase people. */
export function isFusedEmployerName(value) {
  const original = String(value || '').trim()
  if (!original || /\s/.test(original)) return false
  const letters = original.replace(/[^a-z]/gi, '')
  return letters.length >= 8 && /[A-Z]/.test(letters) && letters === letters.toUpperCase()
}

/**
 * Org acronyms like SBDC, ZNS — short ALL-CAPS with few/no vowels.
 * Person initials like "J." are handled separately; bare "JR"/"SR" are stop tokens.
 */
export function looksLikeOrgAcronym(token) {
  const t = String(token || '').replace(/[^A-Za-z]/g, '')
  if (t.length < 2 || t.length > 6) return false
  if (t !== t.toUpperCase()) return false
  if (/^(JR|SR|II|III|IV)$/i.test(t)) return false
  const vowels = (t.match(/[AEIOU]/gi) || []).length
  // SBDC / ZNS (no vowels). Person tokens like DOE / LEE / ANN have vowels.
  return vowels === 0
}

/**
 * True only for plausible human names (first + last, letters).
 * Rejects bank labels like "Cheque Deposit - Local" and employers like "SBDC BAHAMAS".
 */
export function looksLikePersonName(value) {
  const s = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!s || s.length < 3 || s.length > 80) return false
  if (looksLikeBankNarration(s) || isCompanyName(s) || isFusedEmployerName(s)) return false
  if (BANK_TXN_PHRASE.test(s)) return false
  if (/[|/\\]/.test(s) || /\d{3,}/.test(s)) return false

  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Za-z]+|[^A-Za-z'.]+$/g, ''))
    .filter(Boolean)
  if (tokens.length < 1 || tokens.length > 6) return false

  for (const token of tokens) {
    if (NON_PERSON_TOKEN.test(token)) return false
    if (looksLikeOrgAcronym(token)) return false
    // Allow "O'Neil", "Mary-Jane", "J.", "Ann"
    if (!/^(?:[A-Za-z](?:[A-Za-z'.-]*[A-Za-z])?|[A-Z]\.)$/.test(token)) return false
  }
  // Prefer first+last; allow a single alphabetic token for weak/review identity only
  if (tokens.length === 1) return tokens[0].length >= 3
  return true
}

/** Person name from "Direct Credit Jane Doe - ACH TFR …". Employer codes are ignored. */
export function extractPayerFromNarration(text) {
  let s = String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
  const original = s
  const idx = s.lastIndexOf('|')
  if (idx >= 0) s = s.slice(0, idx).trim()
  // "Direct Credit EMPLOYER - Salaries" → employer remittance, not a person payer
  if (EMPLOYER_REMIT_TAIL.test(s) || EMPLOYER_REMIT_TAIL.test(original)) {
    return ''
  }
  s = s
    .replace(DIRECT_CREDIT_PREFIX, '')
    .replace(DIRECT_CREDIT_TAIL, '')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s || isCompanyName(s) || isFusedEmployerName(s)) return ''
  if (/ltd|limited|inc|corp|llc|broadcast/i.test(s)) return ''
  const tokens = s.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return ''
  if (isFusedEmployerName(tokens[0]) || looksLikeOrgAcronym(tokens[0])) return ''
  return looksLikePersonName(s) ? s : ''
}

export function parsePipeParticulars(particulars) {
  const full = String(particulars || '')
    .trim()
    .replace(/\s+/g, ' ')
  const idx = full.lastIndexOf('|')
  if (idx < 0) {
    return { full, description: full, borrowerName: '', isCompanyAccount: false }
  }
  const description = full.slice(0, idx).trim()
  const rawName = full.slice(idx + 1).trim()
  const isCompany = isCompanyName(rawName)

  return {
    full,
    description,
    borrowerName: isCompany ? '' : looksLikePersonName(rawName) ? rawName : '',
    companyAccount: isCompany ? 'Simplified Lending' : null,
    isCompanyAccount: isCompany,
  }
}

/** Borrower name is the text after the last `|` in the particulars (excluding company headers). */
export function extractNameFromParticulars(particulars) {
  return parsePipeParticulars(particulars).borrowerName
}

/** Transaction narrative is the text before the last `|` in the particulars. */
export function extractDescriptionFromParticulars(particulars) {
  return parsePipeParticulars(particulars).description
}

function sanitizePersonName(value) {
  const s = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!s) return ''
  if (isCompanyName(s) || looksLikeBankNarration(s) || isFusedEmployerName(s) || !looksLikePersonName(s)) {
    return ''
  }
  return s
}

function tokenCount(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

/**
 * Prefer the fullest human name. A truncated staged BorrowerName like "TRACEY"
 * must not block "TRACEY MARIA CLARKE" recovered from the bank description.
 */
function preferFullerPersonName(...candidates) {
  const cleaned = candidates.map(sanitizePersonName).filter(Boolean)
  if (!cleaned.length) return ''
  cleaned.sort((a, b) => {
    const tc = tokenCount(b) - tokenCount(a)
    if (tc !== 0) return tc
    return b.length - a.length
  })
  const best = cleaned[0]
  // If a shorter candidate is a prefix of the best (TRACEY ⊂ TRACEY MARIA CLARKE), keep best
  return best
}

/** Resolve name + description from a staged/import row. */
export function resolveParticularsFields({ particulars, borrowerName, payer, description } = {}) {
  const rawName = String(borrowerName || payer || '').trim()
  const full = String(
    particulars || description || (looksLikeBankNarration(rawName) ? rawName : '') || ''
  ).trim()
  const parsed = parsePipeParticulars(full)
  const fromNarration = extractPayerFromNarration(parsed.description || full)

  // Prefer full name from Direct Credit / pipe over a truncated staged BorrowerName.
  let name = preferFullerPersonName(rawName, parsed.borrowerName, fromNarration)

  const desc = parsed.description || (name ? '' : full)
  return {
    full: full || parsed.full,
    description: desc,
    borrowerName: name,
    companyAccount: parsed.companyAccount || (isCompanyName(borrowerName || payer) ? 'Simplified Lending' : null),
  }
}

