import Fuse from 'fuse.js'

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parsePayerName(payer) {
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

function exactMatchReason(payer, borrower, score) {
  const p = parsePayerName(payer)
  const b = borrowerNames(borrower)
  if (score >= 100) return `Full name "${p.full}" exactly matches borrower "${b.full}"`
  if (score >= 98) return `First "${p.first}" and last "${p.last}" match borrower record`
  if (score >= 93) return `First name matches and last name is a close partial match`
  if (score >= 85) return `Payer name is contained in or closely matches borrower full name`
  if (score >= 80) return `First name "${p.first}" matches borrower first name`
  return null
}

function fuzzyMatchReason(tx, borrower, score, fuseRaw) {
  const payer = tx.payer || ''
  const query = `${payer} ${tx.description || ''}`.trim()
  const names = borrowerNames(borrower)
  const reasons = []
  const pf = normalizeName(parsePayerName(payer).full)
  const bf = normalizeName(names.full)

  if (pf && bf && (bf.includes(pf) || pf.includes(bf))) {
    reasons.push({ label: 'Name similarity', detail: `"${payer}" ↔ "${names.full}"`, weight: 'high' })
  }
  if (tx.description && names.full) {
    reasons.push({ label: 'Description used', detail: `Searched with "${tx.description}"`, weight: 'medium' })
  }
  if (borrower.employer) {
    reasons.push({ label: 'Employer on file', detail: borrower.employer, weight: 'low' })
  }
  if (borrower.branch_name) {
    reasons.push({ label: 'Branch', detail: borrower.branch_name, weight: 'low' })
  }
  if (!reasons.length) {
    reasons.push({
      label: 'Fuzzy name match',
      detail: `LoanDisk BorrowerSerch returned "${names.full}" as closest match (${score}% confidence)`,
      weight: 'medium',
    })
  }
  return { method: 'fuzzy', fuseDistance: fuseRaw, reasons }
}

export function matchTransaction(tx, borrowers) {
  const explained = explainMatch(tx, borrowers)
  return { borrower: explained.borrower, score: explained.score }
}

/** Full match result with human-readable reasons for the UI. */
export function explainMatch(tx, borrowers) {
  const payer = tx.payer || ''
  let best = { borrower: null, score: 0, method: 'none', reasons: [], exactReason: null }

  for (const b of borrowers) {
    const exact = exactNameScore(payer, b)
    if (exact > best.score) {
      best = {
        borrower: b,
        score: exact,
        method: exact >= 80 ? 'exact' : 'partial',
        exactReason: exactMatchReason(payer, b, exact),
        reasons: [],
      }
    }
  }

  if (best.score >= 80) {
    best.reasons = best.exactReason
      ? [{ label: 'Exact name match', detail: best.exactReason, weight: 'high' }]
      : []
    return best
  }

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
    if (fuseScore > best.score) {
      const fuzzy = fuzzyMatchReason(tx, results[0].item, fuseScore, results[0].score)
      best = {
        borrower: results[0].item,
        score: fuseScore,
        method: 'fuzzy',
        exactReason: null,
        reasons: fuzzy.reasons,
      }
    }
  }

  if (!best.borrower) {
    best.reasons = [
      {
        label: 'No match found',
        detail: payer
          ? `LoanDisk BorrowerSerch had no close match for payer "${payer}"`
          : 'Transaction has no payer name to search',
        weight: 'high',
      },
    ]
  } else if (best.method === 'partial' && best.exactReason) {
    best.reasons = [{ label: 'Partial name match', detail: best.exactReason, weight: 'medium' }]
  }

  return best
}

export function confidenceVariant(score) {
  if (score >= 80) return 'matched'
  if (score >= 50) return 'exception'
  if (score > 0) return 'breached'
  return 'pending'
}

export function scoreBadgeClass(score) {
  if (score >= 80) return 'bg-[var(--success-bg)] text-[var(--success)]'
  if (score >= 50) return 'bg-[var(--warning-bg)] text-[var(--warning)]'
  if (score > 0) return 'bg-[var(--danger-bg)] text-[var(--danger)]'
  return 'bg-[var(--bg-subtle)] text-[var(--text-secondary)]'
}

export function confidenceLabel(score) {
  if (score >= 80) return 'High confidence'
  if (score >= 50) return 'Review recommended'
  if (score > 0) return 'Low confidence'
  return 'Unmatched'
}
