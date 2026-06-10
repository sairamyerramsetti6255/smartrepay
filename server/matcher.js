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

export function amountsClose(a, b, tolerance = 0.02) {
  const x = Number(a)
  const y = Number(b)
  if (!x || !y || isNaN(x) || isNaN(y)) return false
  if (Math.abs(x - y) <= tolerance) return true
  const denom = Math.max(Math.abs(x), Math.abs(y), 1)
  return Math.abs(x - y) / denom <= 0.02
}

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

export function pickLoanForAmount(amount, loans = []) {
  const amt = Number(amount)
  if (!amt || isNaN(amt) || !loans.length) return null
  const withEmi = loans.filter((l) => l.emi != null && !isNaN(Number(l.emi)))
  for (const loan of withEmi) {
    if (amountsClose(amt, loan.emi)) return loan
  }
  const sum = withEmi.reduce((s, l) => s + Number(l.emi), 0)
  if (withEmi.length > 1 && amountsClose(amt, sum)) return withEmi[0]
  return withEmi[0] || loans[0] || null
}

export function emiFitScore(amount, loans = []) {
  const amt = Number(amount)
  if (!amt || isNaN(amt)) return 0
  const withEmi = loans.filter((l) => l.emi != null && !isNaN(Number(l.emi)))
  if (!withEmi.length) return 0
  for (const loan of withEmi) {
    if (amountsClose(amt, loan.emi)) return 40
  }
  const sum = withEmi.reduce((s, l) => s + Number(l.emi), 0)
  if (withEmi.length > 1 && amountsClose(amt, sum)) return 45
  return 0
}

function resolveNameTies(tx, ties, loansByBorrowerId) {
  if (!ties.length) return { borrower: null, score: 0, loan: null }
  if (ties.length === 1) {
    const loans = loansByBorrowerId?.get(ties[0].borrower.id) || []
    const emi = emiFitScore(tx.amount, loans)
    return {
      borrower: ties[0].borrower,
      score: emi > 0 ? 100 : ties[0].nameScore,
      loan: pickLoanForAmount(tx.amount, loans),
    }
  }
  let best = null
  let bestTotal = -1
  for (const t of ties) {
    const loans = loansByBorrowerId?.get(t.borrower.id) || []
    const emi = emiFitScore(tx.amount, loans)
    const total = t.nameScore + emi
    if (total > bestTotal) {
      bestTotal = total
      best = {
        borrower: t.borrower,
        score: emi > 0 ? 100 : t.nameScore >= 96 ? 82 : 75,
        loan: pickLoanForAmount(tx.amount, loans),
      }
    }
  }
  return best || { borrower: ties[0].borrower, score: 75, loan: null }
}

function scoreAgainstCandidates(tx, candidates, fuse, loansByBorrowerId) {
  const payer = tx.payer || ''
  let idBest = { borrower: null, score: 0, loan: null }
  const nameTies = []

  for (const b of candidates) {
    const idScore = idMatchScore(tx, b)
    if (idScore > idBest.score) {
      const loans = loansByBorrowerId?.get(b.id) || []
      idBest = { borrower: b, score: idScore, loan: pickLoanForAmount(tx.amount, loans) }
    }
    const ns = firstLastNameScore(payer, b)
    if (ns >= 95) nameTies.push({ borrower: b, nameScore: ns })
  }

  if (idBest.score >= 98) return idBest
  if (nameTies.length) return resolveNameTies(tx, nameTies, loansByBorrowerId)

  let best = { borrower: null, score: 0, loan: null }
  for (const b of candidates) {
    const loans = loansByBorrowerId?.get(b.id) || []
    const ns = firstLastNameScore(payer, b)
    const emi = emiFitScore(tx.amount, loans)
    const score = ns > 0 ? Math.min(100, ns + (emi > 0 ? Math.min(emi, 20) : 0)) : emi > 0 ? 72 : 0
    if (score > best.score) best = { borrower: b, score, loan: pickLoanForAmount(tx.amount, loans) }
  }
  if (best.score >= 80) return best

  if (!fuse) return best
  const results = fuse.search(`${payer} ${tx.description || ''} ${tx.reference || ''}`.trim())
  if (results.length) {
    const item = results[0].item
    const loans = loansByBorrowerId?.get(item.id) || []
    const fuseScore = Math.round((1 - results[0].score) * 100)
    const emi = emiFitScore(tx.amount, loans)
    const score = Math.min(100, fuseScore + (emi > 0 ? 15 : 0))
    if (score > best.score) best = { borrower: item, score, loan: pickLoanForAmount(tx.amount, loans) }
  }
  return best
}

const FUSE_OPTIONS = {
  keys: [
    { name: 'full_name', weight: 0.35 },
    { name: 'first_name', weight: 0.25 },
    { name: 'last_name', weight: 0.25 },
    { name: 'loandisk_id', weight: 0.08 },
    { name: 'unique_number', weight: 0.07 },
  ],
  includeScore: true,
  threshold: 0.38,
  ignoreLocation: true,
}

export function createCandidateMatcher(candidates, loansByBorrowerId = null) {
  if (!candidates?.length) return () => ({ borrower: null, score: 0, loan: null })
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
  return (tx) => scoreAgainstCandidates(tx, candidates, fuse, loansByBorrowerId)
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
