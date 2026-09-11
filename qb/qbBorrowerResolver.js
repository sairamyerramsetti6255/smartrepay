// SmartRepay Matching Algorithm & Conservative Entity Linking for QuickBooks Receipts & Payments
function cleanString(val) {
  return String(val || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

function tokens(value) {
  return cleanString(value)
    .replace(/\bpaid\s*off\b.*$/i, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

function parseAliases(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
  }
}

/**
 * Calculate name match score between query tokens and borrower name tokens.
 * Returns score 0-100.
 */
export function calculateNameScore(queryStr, borrowerFullName, borrowerAliases = []) {
  const q = tokens(queryStr)
  if (!q.length) return 0
  if (q.length === 1 && q[0].length < 3) return 0

  const allNames = [borrowerFullName, ...parseAliases(borrowerAliases)].filter(Boolean)
  let bestScore = 0

  for (const name of allNames) {
    const n = tokens(name)
    if (!n.length) continue

    const qJoined = q.join(' ')
    const nJoined = n.join(' ')

    // Exact match
    if (qJoined === nJoined) {
      bestScore = Math.max(bestScore, 100)
      continue
    }

    // Two+ tokens: first name and last name match (tolerates middle names, suffixes)
    if (q.length >= 2 && n.length >= 2) {
      const qFirst = q[0]
      const qLast = q[q.length - 1]
      const nFirst = n[0]
      const nLast = n[n.length - 1]

      // Same first & last (middle name added/omitted)
      if (qFirst === nFirst && qLast === nLast) {
        bestScore = Math.max(bestScore, 98)
        continue
      }

      // Transposed: "LastName, FirstName"
      if (qFirst === nLast && qLast === nFirst) {
        bestScore = Math.max(bestScore, 98)
        continue
      }

      // Subset match: all query tokens appear in borrower tokens in order
      const allFound = q.every((token) => n.includes(token))
      if (allFound) {
        bestScore = Math.max(bestScore, 95)
        continue
      }

      // First token matches, last token starts with or contains
      if (qFirst === nFirst && (nLast.startsWith(qLast) || qLast.startsWith(nLast)) && Math.min(qLast.length, nLast.length) >= 3) {
        bestScore = Math.max(bestScore, 85)
        continue
      }
    }
  }

  return bestScore
}

/**
 * Reconcile transaction amount against borrower loan expected EMI.
 */
export function reconcileEmiAmount(amount, loans = []) {
  const amt = Number(amount)
  if (!Number.isFinite(amt) || amt <= 0 || !loans.length) {
    return { emi_match_status: 'no_loan_emi', expected_emi: null, emi_diff: null, emi_multiple: 1 }
  }

  const validLoans = loans.filter((l) => l.expected_emi != null && Number(l.expected_emi) > 0)
  if (!validLoans.length) {
    return { emi_match_status: 'no_loan_emi', expected_emi: null, emi_diff: null, emi_multiple: 1 }
  }

  const target = Math.round(amt * 100)

  // 1. Check exact EMI on any active loan
  for (const loan of validLoans) {
    const expectedCents = Math.round(Number(loan.expected_emi) * 100)
    const diffCents = Math.abs(target - expectedCents)
    if (diffCents <= 5) {
      return {
        emi_match_status: 'exact_emi',
        expected_emi: Number(loan.expected_emi),
        emi_diff: 0,
        emi_multiple: 1,
        matched_loan_id: loan.loan_id,
      }
    }
  }

  // 2. Check multiple EMIs (2x, 3x, 4x, etc.)
  for (const loan of validLoans) {
    const expectedCents = Math.round(Number(loan.expected_emi) * 100)
    for (let count = 2; count <= 12; count++) {
      const multCents = expectedCents * count
      if (Math.abs(target - multCents) <= 5) {
        return {
          emi_match_status: 'multiple_emi',
          expected_emi: Number(loan.expected_emi),
          emi_diff: 0,
          emi_multiple: count,
          matched_loan_id: loan.loan_id,
        }
      }
    }
  }

  // 3. Check fraction EMIs (half EMI, quarter EMI)
  for (const loan of validLoans) {
    const expectedCents = Math.round(Number(loan.expected_emi) * 100)
    if (Math.abs(target - Math.round(expectedCents * 0.5)) <= 5) {
      return {
        emi_match_status: 'fraction_emi',
        expected_emi: Number(loan.expected_emi),
        emi_diff: 0,
        emi_multiple: 0.5,
        matched_loan_id: loan.loan_id,
      }
    }
    if (Math.abs(target - Math.round(expectedCents * 0.25)) <= 5) {
      return {
        emi_match_status: 'fraction_emi',
        expected_emi: Number(loan.expected_emi),
        emi_diff: 0,
        emi_multiple: 0.25,
        matched_loan_id: loan.loan_id,
      }
    }
  }

  // 4. Default difference comparison against primary loan
  const primaryLoan = validLoans[0]
  const exp = Number(primaryLoan.expected_emi)
  return {
    emi_match_status: 'differing_emi',
    expected_emi: exp,
    emi_diff: Math.round((amt - exp) * 100) / 100,
    emi_multiple: 1,
    matched_loan_id: primaryLoan.loan_id,
  }
}

/**
 * Look up and validate borrower identity, Borrower ID, and EMI amount using the matching algorithm.
 * Applies to both EMI Receipts and Payment Disbursements.
 *
 * @param {object} db - SQLite database
 * @param {string} query - Borrower / Payee Name, LoanDisk ID, or Loan Number
 * @param {number|null} amount - Transaction amount for EMI validation
 * @param {string|null} explicitBorrowerId - Explicit borrower ID if provided
 * @returns {{ matches: Array, top_match: object|null, match_count: number }}
 */
export function lookupBorrower(db, query, amount = null, explicitBorrowerId = null) {
  if (!query && !explicitBorrowerId) return { matches: [], top_match: null, match_count: 0 }

  const qRaw = String(query || '').trim()
  const qClean = cleanString(qRaw)
  const expId = explicitBorrowerId ? String(explicitBorrowerId).trim().toLowerCase() : null

  // Check columns available in borrowers and loans tables
  let hasAliases = false
  let hasEmi = false
  try {
    const bCols = db.prepare('pragma table_info(borrowers)').all().map((c) => c.name)
    hasAliases = bCols.includes('aliases')
    const lCols = db.prepare('pragma table_info(loans)').all().map((c) => c.name)
    hasEmi = lCols.includes('emi')
  } catch {
    // If pragma fails (e.g. in minimal mocks), proceed with default queries
  }

  const selectCols = `
    b.id as borrower_id,
    b.full_name,
    b.loandisk_id,
    ${hasAliases ? 'b.aliases,' : "'' as aliases,"}
    l.id as loan_pk,
    l.loan_number as loan_id,
    ${hasEmi ? 'l.emi as expected_emi,' : 'null as expected_emi,'}
    l.status as loan_status
  `

  let rows = []
  try {
    rows = db.prepare(`
      select ${selectCols}
      from borrowers b
      left join loans l on (l.borrower_id = b.id or l.borrower_id = b.loandisk_id)
      where l.id is null or lower(coalesce(l.status, 'active')) = 'active'
    `).all()
  } catch {
    try {
      rows = db.prepare(`
        select b.id as borrower_id, b.full_name, b.loandisk_id, l.loan_number as loan_id
        from borrowers b
        left join loans l on (l.borrower_id = b.id or l.borrower_id = b.loandisk_id)
        where l.id is null or lower(coalesce(l.status, 'active')) = 'active'
      `).all()
    } catch {
      return { matches: [], top_match: null, match_count: 0 }
    }
  }

  // Group by borrower
  const borrowerMap = new Map()
  for (const r of rows) {
    const bid = r.borrower_id || r.loandisk_id
    if (!bid) continue
    if (!borrowerMap.has(bid)) {
      borrowerMap.set(bid, {
        borrower_id: r.borrower_id,
        loandisk_id: r.loandisk_id || r.borrower_id,
        full_name: r.full_name,
        aliases: r.aliases,
        loans: [],
      })
    }
    if (r.loan_id) {
      const bEntry = borrowerMap.get(bid)
      if (!bEntry.loans.some((l) => l.loan_id === r.loan_id)) {
        bEntry.loans.push({
          loan_id: r.loan_id,
          expected_emi: r.expected_emi != null ? Number(r.expected_emi) : null,
          loan_status: r.loan_status || 'active',
        })
      }
    }
  }

  const scoredMatches = []

  for (const b of borrowerMap.values()) {
    let score = 0
    let matchedFrom = 'none'

    // Check direct ID match (Loan Number, LoanDisk ID, Borrower ID)
    const bidStr = String(b.borrower_id || '').toLowerCase()
    const ldidStr = String(b.loandisk_id || '').toLowerCase()

    if (expId && (bidStr === expId || ldidStr === expId)) {
      score = 100
      matchedFrom = 'explicit_id'
    } else if (qClean && (bidStr === qClean || ldidStr === qClean)) {
      score = 100
      matchedFrom = 'id'
    } else if (qClean && b.loans.some((l) => String(l.loan_id || '').toLowerCase() === qClean)) {
      score = 100
      matchedFrom = 'loan_number'
    } else if (qRaw) {
      score = calculateNameScore(qRaw, b.full_name, b.aliases)
      if (score > 0) matchedFrom = 'name'
    }

    if (score >= 70) {
      const emiRecon = reconcileEmiAmount(amount, b.loans)
      const primaryLoanId = emiRecon.matched_loan_id || b.loans[0]?.loan_id || null
      const expEmi = emiRecon.expected_emi ?? b.loans[0]?.expected_emi ?? null

      let reasoning = `Matched by ${matchedFrom} (score: ${score}%)`
      if (emiRecon.emi_match_status === 'exact_emi') {
        reasoning += ` • EMI exact match: $${Number(amount).toFixed(2)}`
      } else if (emiRecon.emi_match_status === 'multiple_emi') {
        reasoning += ` • EMI multiple (${emiRecon.emi_multiple}x $${expEmi})`
      } else if (emiRecon.emi_match_status === 'differing_emi') {
        reasoning += ` • Differs from expected EMI $${expEmi} (diff: $${emiRecon.emi_diff})`
      }

      scoredMatches.push({
        borrower_id: b.borrower_id,
        loandisk_id: b.loandisk_id,
        full_name: b.full_name,
        loan_id: primaryLoanId,
        loans: b.loans,
        expected_emi: expEmi,
        score,
        matchedFrom,
        emi_match_status: emiRecon.emi_match_status,
        emi_diff: emiRecon.emi_diff,
        emi_multiple: emiRecon.emi_multiple,
        reasoning,
      })
    }
  }

  // Sort by score descending, then exact EMI match first
  scoredMatches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.emi_match_status === 'exact_emi' && b.emi_match_status !== 'exact_emi') return -1
    if (b.emi_match_status === 'exact_emi' && a.emi_match_status !== 'exact_emi') return 1
    return 0
  })

  // Unique top match determination:
  // If top 2 matches have identical score and both are >= 95 without EMI tie-breaker, mark as ambiguous (null top_match)
  let top_match = null
  if (scoredMatches.length === 1) {
    top_match = scoredMatches[0]
  } else if (scoredMatches.length > 1) {
    const first = scoredMatches[0]
    const second = scoredMatches[1]
    if (first.score > second.score) {
      top_match = first
    } else if (first.score === second.score) {
      if (first.emi_match_status === 'exact_emi' && second.emi_match_status !== 'exact_emi') {
        top_match = first
      } else {
        // Ambiguous across multiple borrowers with same name
        top_match = null
      }
    }
  }

  return {
    matches: scoredMatches.slice(0, 20),
    top_match,
    match_count: scoredMatches.length,
  }
}

/**
 * Resolve and link borrower to a QuickBooks transaction if an unambiguous match is found.
 */
export function resolveBorrower(db, t) {
  const partyName = t.customer_name || t.vendor_name || ''
  const lookup = lookupBorrower(db, partyName, t.amount, t.borrower_id)
  const candidates = lookup.matches.filter(
    (m) =>
      (!t.borrower_id || t.borrower_id === m.borrower_id || t.borrower_id === m.loandisk_id) &&
      (!t.loan_id || t.loan_id === m.loan_id)
  )

  if (lookup.match_count > 20 || candidates.length !== 1) return false
  const match = candidates[0]
  const resolvedBorrowerId = match.borrower_id || match.loandisk_id
  db.prepare(
    "update qb_transactions set borrower_id=?, loan_id=?, updated_at=datetime('now') where id=? and approval_status='pending_review'"
  ).run(resolvedBorrowerId, match.loan_id, t.id)
  return true
}

