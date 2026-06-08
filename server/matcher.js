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

export function matchTransaction(tx, borrowers) {
  const payer = tx.payer || ''
  let best = { borrower: null, score: 0 }

  for (const b of borrowers) {
    const exact = exactNameScore(payer, b)
    if (exact > best.score) best = { borrower: b, score: exact }
  }

  if (best.score >= 80) return best

  const searchable = borrowers.map((b) => {
    const names = borrowerNames(b)
    return {
      ...b,
      first_name: names.first,
      last_name: names.last,
      aliases: Array.isArray(b.aliases) ? b.aliases.join(' ') : b.aliases || '',
    }
  })

  const fuse = new Fuse(searchable, {
    keys: [
      { name: 'full_name', weight: 0.45 },
      { name: 'first_name', weight: 0.2 },
      { name: 'last_name', weight: 0.2 },
      { name: 'aliases', weight: 0.1 },
      { name: 'employer', weight: 0.05 },
    ],
    includeScore: true,
    threshold: 0.38,
    ignoreLocation: true,
  })

  const results = fuse.search(`${payer} ${tx.description || ''}`.trim())
  if (results.length) {
    const fuseScore = Math.round((1 - results[0].score) * 100)
    if (fuseScore > best.score) best = { borrower: results[0].item, score: fuseScore }
  }

  return best
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
