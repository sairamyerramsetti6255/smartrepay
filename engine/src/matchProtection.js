/** Human loan-id or named confirms stay; amount-only / nameless guesses are rematched. */
export function isIdentityGuess(row) {
  const type = String(row?.MatchType || row?.matchType || '').toLowerCase()
  const nameScore = row?.NameScore ?? row?.nameScore
  if (type === 'loan_id') return false
  if (type === 'cash_amount') return true
  return nameScore == null || Number(nameScore) < 70
}

export function isRematchProtected(row) {
  const status = String(row?.ReviewStatus || row?.reviewStatus || '')
  if (status === 'rejected') return true
  if (status === 'confirmed' && !isIdentityGuess(row)) return true
  return false
}
