/**
 * Bank particulars often look like: "Transaction description | Borrower Name"
 * We split on the last pipe so amount fragments inside the description are safe.
 * Also handles company destination labels (e.g. "SIMPLIFIED LEND") so company
 * headers are not mistaken for individual borrower names.
 */

const COMPANY_NAMES = /^(simplified\s+lend(ing)?(\s+lt|\s+ltd|\s+limited)?|slending)$/i

export function parsePipeParticulars(particulars) {
  const full = String(particulars || '').trim().replace(/\s+/g, ' ')
  const idx = full.lastIndexOf('|')
  if (idx < 0) {
    return { full, description: full, borrowerName: '', isCompanyAccount: false }
  }
  const description = full.slice(0, idx).trim()
  const rawName = full.slice(idx + 1).trim()
  const isCompany = COMPANY_NAMES.test(rawName)

  return {
    full,
    description,
    borrowerName: isCompany ? '' : rawName,
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

/** Resolve name + description from a staged/import row. */
export function resolveParticularsFields({ particulars, borrowerName, payer, description } = {}) {
  const full = String(particulars || description || '').trim()
  const parsed = parsePipeParticulars(full)
  
  // If the provided borrowerName/payer is a company name or empty, do not use it as borrower name
  let name = String(borrowerName || payer || '').trim()
  if (COMPANY_NAMES.test(name)) {
    name = ''
  }
  if (!name && parsed.borrowerName) {
    name = parsed.borrowerName
  }

  const desc = parsed.description || (name ? '' : full)
  return {
    full: full || parsed.full,
    description: desc,
    borrowerName: name,
    companyAccount: parsed.companyAccount,
  }
}
