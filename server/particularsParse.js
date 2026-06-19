/**
 * Bank particulars often look like: "Transaction description | Borrower Name"
 * We split on the last pipe so amount fragments inside the description are safe.
 */

export function parsePipeParticulars(particulars) {
  const full = String(particulars || '').trim().replace(/\s+/g, ' ')
  const idx = full.lastIndexOf('|')
  if (idx < 0) {
    return { full, description: full, borrowerName: '' }
  }
  return {
    full,
    description: full.slice(0, idx).trim(),
    borrowerName: full.slice(idx + 1).trim(),
  }
}

/** Borrower name is the text after the last `|` in the particulars. */
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
  const name =
    String(borrowerName || payer || parsed.borrowerName || '').trim() || parsed.borrowerName
  const desc = parsed.description || (parsed.borrowerName ? '' : full)
  return {
    full: full || parsed.full,
    description: desc,
    borrowerName: name,
  }
}
