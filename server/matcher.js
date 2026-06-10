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

/** Pull LoanDisk / loan numbers from reference, description, payer. */
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

function amountsClose(a, b, tolerance = 0.02) {
  const x = Number(a)
  const y = Number(b)
  if (!x || !y || isNaN(x) || isNaN(y)) return false
  if (Math.abs(x - y) <= tolerance) return true
  const denom = Math.max(Math.abs(x), Math.abs(y), 1)
  return Math.abs(x - y) / denom <= 0.02
}

function amountMatchBoost(txAmount, borrower, loan) {
  const amt = Number(txAmount)
  if (!amt || isNaN(amt)) return 0
  const targets = [borrower?.emi, borrower?.loan_amount, loan?.emi, loan?.outstanding_balance].filter(
    (v) => v != null && !isNaN(Number(v))
  )
  for (const t of targets) {
    if (amountsClose(amt, t)) return 25
  }
  return 0
}

function idMatchScore(tx, borrower) {
  const ids = extractBorrowerIdsFromTx(tx)
  if (!ids.length) return 0
  const bid = String(borrower.loandisk_id || '')
  const unum = String(borrower.unique_number || '')
  const loanNum = String(borrower.loan_number || '')
  for (const id of ids) {
    if (bid && (bid === id || bid.endsWith(id))) return 100
    if (unum && (unum === id || unum.includes(id))) return 99
    if (loanNum && (loanNum === id || loanNum.replace(/\D/g, '') === id)) return 98
  }
  return 0
}

function exactNameScore(payer, borrower) {
  const p = parsePayerName(payer)
  const b = borrowerNames(borrower)
  const pf = normalizeName(p.first)
  const pl = normalizeName(p.last)
  const pfull = normalizeName(p.full)
  const bf = normalizeName(b.first)
  const bl = normalizeName(b.last)
  const bfull = normalizeName(b.full)

  if (!pfull && !pf) return 0
  if (pfull && bfull && pfull === bfull) return 100
  if (pf && pl && bf === pf && bl === pl) return 98
  if (pf && pl && bf === pf && bl.includes(pl)) return 93
  if (pf && pl && bf.includes(pf) && bl === pl) return 93
  if (pf && !pl && bf === pf) return 80
  if (pfull && bfull && (bfull.includes(pfull) || pfull.includes(bfull))) return 85
  return 0
}

const FUSE_OPTIONS = {
  keys: [
    { name: 'full_name', weight: 0.35 },
    { name: 'first_name', weight: 0.15 },
    { name: 'last_name', weight: 0.15 },
    { name: 'loandisk_id', weight: 0.1 },
    { name: 'unique_number', weight: 0.1 },
    { name: 'aliases', weight: 0.1 },
    { name: 'employer', weight: 0.05 },
  ],
  includeScore: true,
  threshold: 0.4,
  ignoreLocation: true,
}

function combineScore(tx, borrower, nameScore, loan) {
  const idScore = idMatchScore(tx, borrower)
  if (idScore >= 98) return { borrower, score: idScore }

  const boost = amountMatchBoost(tx.amount, borrower, loan)
  let score = nameScore
  if (boost && nameScore >= 50) score = Math.min(100, nameScore + boost)
  else if (boost && nameScore >= 30) score = Math.min(95, nameScore + boost)
  else if (boost && nameScore > 0) score = Math.min(85, nameScore + boost)

  // Strong amount + weak name still worth reviewing
  if (boost >= 25 && nameScore >= 40) score = Math.max(score, 82)

  return { borrower, score }
}

function scoreAgainstCandidates(tx, candidates, fuse, loanByBorrowerId) {
  const payer = tx.payer || ''
  let best = { borrower: null, score: 0 }

  for (const b of candidates) {
    const loan = loanByBorrowerId?.get(b.id) || loanByBorrowerId?.get(b.loandisk_id)
    const idScore = idMatchScore(tx, b)
    if (idScore > best.score) best = { borrower: b, score: idScore }
    const exact = exactNameScore(payer, b)
    const combined = combineScore(tx, b, exact, loan)
    if (combined.score > best.score) best = combined
  }

  if (best.score >= 80) return best
  if (!fuse) return best

  const results = fuse.search(`${payer} ${tx.description || ''} ${tx.reference || ''}`.trim())
  if (results.length) {
    const item = results[0].item
    const fuseScore = Math.round((1 - results[0].score) * 100)
    const loan = loanByBorrowerId?.get(item.id) || loanByBorrowerId?.get(item.loandisk_id)
    const combined = combineScore(tx, item, fuseScore, loan)
    if (combined.score > best.score) best = combined
  }
  return best
}

/** Build a reusable matcher — avoids rebuilding Fuse index on every transaction. */
export function createCandidateMatcher(candidates, loanByBorrowerId = null) {
  if (!candidates?.length) {
    return () => ({ borrower: null, score: 0 })
  }
  const searchable = candidates.map((b) => {
    const names = borrowerNames(b)
    return {
      ...b,
      first_name: names.first,
      last_name: names.last,
      loandisk_id: b.loandisk_id ? String(b.loandisk_id) : '',
      unique_number: b.unique_number ? String(b.unique_number) : '',
      aliases: Array.isArray(b.aliases) ? b.aliases.join(' ') : b.aliases || '',
    }
  })
  const fuse = new Fuse(searchable, FUSE_OPTIONS)
  return (tx) => scoreAgainstCandidates(tx, candidates, fuse, loanByBorrowerId)
}

/** Score payer against a list of API/local borrower candidates. */
export function bestMatchFromCandidates(tx, candidates, loanByBorrowerId = null) {
  if (!candidates?.length) return { borrower: null, score: 0 }
  if (candidates.length > 40) {
    return createCandidateMatcher(candidates, loanByBorrowerId)(tx)
  }
  const searchable = candidates.map((b) => {
    const names = borrowerNames(b)
    return {
      ...b,
      first_name: names.first,
      last_name: names.last,
      loandisk_id: b.loandisk_id ? String(b.loandisk_id) : '',
      unique_number: b.unique_number ? String(b.unique_number) : '',
      aliases: Array.isArray(b.aliases) ? b.aliases.join(' ') : b.aliases || '',
    }
  })
  const fuse = new Fuse(searchable, FUSE_OPTIONS)
  return scoreAgainstCandidates(tx, candidates, fuse, loanByBorrowerId)
}

export function matchTransaction(tx, borrowers, loanByBorrowerId = null) {
  return bestMatchFromCandidates(tx, borrowers, loanByBorrowerId)
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
