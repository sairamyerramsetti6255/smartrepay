/** Split bank particulars: "description text | Borrower Name" */
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

export function resolveParticularsDisplay({ particulars, description, payer, borrowerName, transactionDescription } = {}) {
  const parsed = parsePipeParticulars(particulars || description)
  return {
    description: transactionDescription || parsed.description || '',
    borrowerName: borrowerName || payer || parsed.borrowerName || '',
    full: particulars || description || parsed.full,
  }
}
