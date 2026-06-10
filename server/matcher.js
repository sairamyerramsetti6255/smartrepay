import Fuse from 'fuse.js'

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parsePayerName(payer) {
  const clean = String(payer || '').trim().replace(/\s+/g, ' ')
  if (!clean) return { first: '', last: '', full: '' }
  const parts = clean.split(' ')
  if (parts.length === 1) return { first: parts[0], last: '', full: clean }
  return { first: parts[0], last: parts.slice(1).join(' '), full: clean }
}

function borrowerNames(b) {
  const first = b.first_name || String(b.full_name || '').split(' ')[0] || ''
  const last = b.last_name || String(b.full_name || '').split(' ').slice(1).join(' ') || ''
  return { first, last, full: b.full_name || `${first} ${last}`.trim() }
}

export function extractBorrowerIdsFromText(text) {
  const ids = new Set()
  const s = String(text || '')
  for (const m of s.matchAll(/\b(\d{5,10})\b/g)) ids.add(m[1])
  for (const m of s.matchAll(/\b(?:LD|BRW|LN)[-\s#]?(\d+)\b/gi)) ids.add(m[1])
  return [...ids]
}

export function extractBorrowerIdsFromTx(tx) {
  return extractBorrowerIdsFromText(`${tx.reference || ''} ${tx.description || ''} ${tx.payer || ''}`)
}

/** Priority 1: first name + last name (space-separated). No EMI matching. */
export function firstLastNameScore(payer, borrower) {
  const p = parsePayerName(payer)
  const b = borrowerNames(borrower)
  if (!p.first) return 0
  const pf = normalizeName(p.first)
  const pl = normalizeName(p.last)
  const bf = normalizeName(b.first)
  const bl = normalizeName(b.last)

  if (p.last && pf && pl && bf && bl && pf === bf && pl === bl) return 100
  if (p.last && pf && pl && bf && bl && pf === bf && (bl.includes(pl) || pl.includes(bl))) return 96
  if (!p.last && pf && bf === pf) return 78
  return 0
}

function idMatchScore(tx, borrower) {
  const ids = extractBorrowerIdsFromTx(tx)
  if (!ids.length) return 0
  const bid = String(borrower.loandisk_id || '')
  const unum = String(borrower.unique_number || '')
  for (const id of ids) {
    if (bid && (bid === id || bid.endsWith(id))) return 100
    if (unum && (unum === id || unum.includes(id))) return 99
  }
  return 0
}

/** First linked loan for borrower (no EMI amount matching). */
export function pickLoanForBorrower(loans = []) {
  return loans.length ? loans[0] : null
}

function resolveNameTies(ties, loansByBorrowerId) {
  if (!ties.length) return { borrower: null, score: 0, loan: null }
  const sorted = [...ties].sort((a, b) => b.nameScore - a.nameScore)
  const best = sorted[0]
  const loans = loansByBorrowerId?.get(best.borrower.id) || loansByBorrowerId?.get(best.borrower.loandisk_id) || []
  return {
    borrower: best.borrower,
    score: best.nameScore,
    loan: pickLoanForBorrower(loans),
  }
}

function buildNameIndex(candidates) {
  const exact = new Map()
  const firstOnly = new Map()
  for (const b of candidates) {
    const n = borrowerNames(b)
    const fk = `${normalizeName(n.first)}|${normalizeName(n.last)}`
    if (!exact.has(fk)) exact.set(fk, [])
    exact.get(fk).push(b)
    if (n.first) {
      const fKey = normalizeName(n.first)
      if (!firstOnly.has(fKey)) firstOnly.set(fKey, [])
      firstOnly.get(fKey).push(b)
    }
  }
  return { exact, firstOnly }
}

function scoreAgainstCandidates(tx, candidates, fuse, loansByBorrowerId, nameIndex) {
  const payer = tx.payer || ''
  let idBest = { borrower: null, score: 0, loan: null }

  for (const b of candidates) {
    const idScore = idMatchScore(tx, b)
    if (idScore > idBest.score) {
      const loans = loansByBorrowerId?.get(b.id) || loansByBorrowerId?.get(b.loandisk_id) || []
      idBest = { borrower: b, score: idScore, loan: pickLoanForBorrower(loans) }
    }
  }
  if (idBest.score >= 98) return idBest

  const p = parsePayerName(payer)
  const key = `${normalizeName(p.first)}|${normalizeName(p.last)}`
  const exactHits = nameIndex?.exact.get(key) || []
  if (exactHits.length) {
    const nameTies = exactHits.map((b) => ({ borrower: b, nameScore: firstLastNameScore(payer, b) })).filter((t) => t.nameScore >= 95)
    if (nameTies.length) return resolveNameTies(nameTies, loansByBorrowerId)
  }

  if (!p.last && p.first) {
    const firstHits = nameIndex?.firstOnly.get(normalizeName(p.first)) || []
    const nameTies = firstHits.map((b) => ({ borrower: b, nameScore: firstLastNameScore(payer, b) })).filter((t) => t.nameScore >= 78)
    if (nameTies.length) return resolveNameTies(nameTies, loansByBorrowerId)
  }

  let best = { borrower: null, score: 0, loan: null }
  for (const b of candidates) {
    const ns = firstLastNameScore(payer, b)
    if (ns > best.score) {
      const loans = loansByBorrowerId?.get(b.id) || []
      best = { borrower: b, score: ns, loan: pickLoanForBorrower(loans) }
    }
  }
  if (best.score >= 80) return best

  if (!fuse) return best
  const results = fuse.search(`${payer} ${tx.description || ''} ${tx.reference || ''}`.trim())
  if (results.length) {
    const item = results[0].item
    const loans = loansByBorrowerId?.get(item.id) || []
    const fuseScore = Math.round((1 - results[0].score) * 100)
    if (fuseScore > best.score) best = { borrower: item, score: fuseScore, loan: pickLoanForBorrower(loans) }
  }
  return best
}

const FUSE_OPTIONS = {
  keys: [
    { name: 'full_name', weight: 0.5 },
    { name: 'first_name', weight: 0.25 },
    { name: 'last_name', weight: 0.25 },
  ],
  includeScore: true,
  threshold: 0.38,
  ignoreLocation: true,
}

export function createCandidateMatcher(candidates, loansByBorrowerId = null) {
  if (!candidates?.length) return () => ({ borrower: null, score: 0, loan: null })
  const nameIndex = buildNameIndex(candidates)
  const searchable = candidates.map((b) => {
    const names = borrowerNames(b)
    return {
      ...b,
      first_name: names.first,
      last_name: names.last,
      aliases: Array.isArray(b.aliases) ? b.aliases.join(' ') : b.aliases || '',
    }
  })
  const fuse = new Fuse(searchable, FUSE_OPTIONS)
  return (tx) => scoreAgainstCandidates(tx, candidates, fuse, loansByBorrowerId, nameIndex)
}

export function bestMatchFromCandidates(tx, candidates, loansByBorrowerId = null) {
  if (!candidates?.length) return { borrower: null, score: 0, loan: null }
  return createCandidateMatcher(candidates, loansByBorrowerId)(tx)
}

export function matchTransaction(tx, borrowers, loansByBorrowerId = null) {
  return bestMatchFromCandidates(tx, borrowers, loansByBorrowerId)
}

export function detectExceptionType(tx, allTransactions, score) {
  const dup = allTransactions.filter(
    (t) => t.id !== tx.id && t.amount === tx.amount && t.payer === tx.payer && t.date === tx.date
  )
  if (dup.length) return 'duplicate'
  if (score > 0 && score < 50) return 'suspicious'
  if (score >= 50 && score < 80) return 'partial'
  return 'unmatched'
}
