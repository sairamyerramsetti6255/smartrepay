import { nameTokens, scoreNameMatch, normalizeNameKey } from './nameMatch.js'

/**
 * Reconciliation engine that matches a bank/payroll credit (a deposit) to the
 * correct borrower and loan(s) in Staging_LoandiskDueRecords.
 *
 * Two layers:
 *   1. Deterministic — fuzzy first/last name match + EMI amount reconciliation,
 *      including SUBSET-SUM so a single deposit can settle several of the same
 *      borrower's loans at once (sum of EMIs).
 *   2. AI (OpenRouter) — adjudicates the borderline / ambiguous cases and
 *      assigns a confidence score. See buildMatchPrompt().
 */

// --- tuning knobs -----------------------------------------------------------
export const NAME_MIN = 55 // below this we treat it as "no borrower candidate"
export const NAME_STRONG = 85 // strong enough name match for name_and_amount
export const AUTO_CONFIDENCE = 70 // >= this => MATCHED, below => UNMATCHED (binary)
const GRAY_LO = 60

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** Amount tolerance: 2% of the deposit, floored at $1.50 (covers fees/rounding). */
function toleranceFor(amount) {
  return Math.max(1.5, Math.abs(Number(amount) || 0) * 0.02)
}

// --- LoanDisk grouping ------------------------------------------------------

/** Group due loans by borrower (BorrowerId, falling back to a normalized name key). */
export function groupLoansByBorrower(loans) {
  const groups = new Map()
  for (const ln of loans) {
    const id = ln.BorrowerId != null && String(ln.BorrowerId).trim() !== '' ? String(ln.BorrowerId).trim() : null
    const key = id ? `id:${id}` : `name:${normalizeNameKey(ln.BorrowerFullName)}`
    if (!groups.has(key)) {
      groups.set(key, { key, borrowerId: id, borrowerName: ln.BorrowerFullName, loans: [] })
    }
    groups.get(key).loans.push({
      loanNumber: ln.LoanNumber,
      expectedEMI: Number(ln.ExpectedEMIAmount) || 0,
      status: ln.LoanStatus || null,
      balance: ln.LoanBalanceAmount ?? null,
      branch: ln.BranchName || null,
    })
  }
  for (const g of groups.values()) {
    g.totalEMI = round2(g.loans.reduce((s, l) => s + (Number(l.expectedEMI) || 0), 0))
  }
  return groups
}

/** Inverted index token -> borrower groups, for fast fuzzy lookup. */
export function buildBorrowerIndex(groups) {
  const index = new Map()
  for (const g of groups.values()) {
    for (const t of new Set(nameTokens(g.borrowerName))) {
      if (!index.has(t)) index.set(t, [])
      index.get(t).push(g)
    }
  }
  return index
}

/**
 * Top-N borrower groups by name similarity. Each candidate carries the matched
 * combination (first+last, last+first, last_only, first_only, with/without
 * typos) so the confidence reflects HOW the name matched.
 */
export function findCandidateBorrowers(bankName, index, limit = 5) {
  const seen = new Map()
  for (const t of new Set(nameTokens(bankName))) {
    for (const g of index.get(t) || []) if (!seen.has(g.key)) seen.set(g.key, g)
  }
  return [...seen.values()]
    .map((group) => {
      const m = scoreNameMatch(bankName, group.borrowerName)
      return { group, score: m.score, nameKind: m.kind }
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// --- amount reconciliation (subset-sum) -------------------------------------

// Installment frequencies a single deposit may represent. Many borrowers are on
// payroll deduction and pay HALF the monthly EMI every two weeks (bi-weekly), or
// a quarter weekly — so a deposit of EMI/2 (or EMI/4) is still a clean match.
const INSTALLMENT_SCALES = [
  { scale: 1, freq: 'monthly' },
  { scale: 0.5, freq: 'bi-weekly' },
  { scale: 0.25, freq: 'weekly' },
]

/** All within-tolerance subsets whose EMI-sum equals `target`. */
function subsetsMatching(list, target, tol) {
  const n = list.length
  const within = []
  if (n <= 16) {
    for (let mask = 1; mask < 1 << n; mask++) {
      let sum = 0
      const nums = []
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          sum += list[i].emi
          nums.push(list[i].loanNumber)
        }
      }
      if (Math.abs(target - sum) <= tol) within.push({ loanNumbers: nums, sum, size: nums.length })
    }
  } else {
    const total = list.reduce((s, l) => s + l.emi, 0)
    for (const l of list) if (Math.abs(target - l.emi) <= tol) within.push({ loanNumbers: [l.loanNumber], sum: l.emi, size: 1 })
    if (Math.abs(target - total) <= tol) within.push({ loanNumbers: list.map((l) => l.loanNumber), sum: total, size: n })
  }
  return within
}

/**
 * Find which of a borrower's loans the deposited `paid` amount settles.
 * Handles a single EMI, the sum of ALL loans, or any subset of loans — and
 * crucially supports installment frequencies (full / half / quarter EMI), so a
 * bi-weekly payroll deduction of EMI/2 reconciles cleanly.
 *
 * Returns { kind, loanNumbers, summedExpected, diff, ambiguous, frequency }.
 *   kind: exact_single | sum_all | subset | partial | mismatch | none
 */
export function reconcileAmount(paid, loans) {
  const amt = Number(paid)
  const list = loans
    .map((l) => ({ loanNumber: l.loanNumber, emi: Number(l.expectedEMI) || 0 }))
    .filter((l) => l.emi > 0)

  if (!amt || !list.length) {
    return { kind: 'none', loanNumbers: [], summedExpected: null, diff: null, ambiguous: false, frequency: null }
  }

  const n = list.length

  for (const { scale, freq } of INSTALLMENT_SCALES) {
    // deposit ≈ (subset EMI sum) * scale  ->  match subset sum against amt/scale
    const target = amt / scale
    const tol = toleranceFor(target)
    const within = subsetsMatching(list, target, tol)
    if (!within.length) continue

    within.sort((a, b) => (a.size !== b.size ? a.size - b.size : Math.abs(target - a.sum) - Math.abs(target - b.sum)))
    const primary = within[0]
    const distinct = new Set(within.map((w) => [...w.loanNumbers].sort().join('|')))
    const kind = primary.size === 1 ? 'exact_single' : primary.size === n ? 'sum_all' : 'subset'
    return {
      kind,
      loanNumbers: primary.loanNumbers,
      summedExpected: round2(primary.sum), // full (monthly) EMI of the matched loans
      diff: round2(amt - primary.sum * scale), // residual vs the actual installment paid
      ambiguous: distinct.size > 1,
      frequency: freq,
    }
  }

  // No clean installment reconciliation — record the closest single loan / total.
  const total = list.reduce((s, l) => s + l.emi, 0)
  let best = null
  for (const l of list) {
    const d = Math.abs(amt - l.emi)
    if (!best || d < best.d) best = { loanNumbers: [l.loanNumber], sum: l.emi, d }
  }
  const dAll = Math.abs(amt - total)
  if (n > 1 && dAll < best.d) best = { loanNumbers: list.map((l) => l.loanNumber), sum: total, d: dAll }

  const ratio = best.sum ? amt / best.sum : 0
  let kind = 'mismatch'
  if (ratio >= 0.1 && ratio <= 0.9) kind = 'partial' // a fractional / part EMI payment
  else if (best.d <= best.sum * 0.25) kind = 'partial'

  return {
    kind,
    loanNumbers: best.loanNumbers,
    summedExpected: round2(best.sum),
    diff: round2(amt - best.sum),
    ambiguous: false,
    frequency: null,
  }
}

// --- scoring / record building ----------------------------------------------

function amountComponent(kind) {
  switch (kind) {
    case 'exact_single':
    case 'sum_all':
    case 'subset':
      return 100
    case 'partial':
      return 55
    case 'mismatch':
      return 25
    default:
      return 10
  }
}

// Binary classification: a deposit is MATCHED when we are >= AUTO_CONFIDENCE (70%)
// sure of the borrower, otherwise it stays UNMATCHED for manual review.
function reviewStatusFor(confidence, hasBorrower) {
  if (!hasBorrower) return 'unmatched'
  return confidence >= AUTO_CONFIDENCE ? 'auto_matched' : 'unmatched'
}

function emiOfLoans(group, loanNumbers) {
  const set = new Set(loanNumbers)
  return round2(group.loans.filter((l) => set.has(l.loanNumber)).reduce((s, l) => s + (Number(l.expectedEMI) || 0), 0))
}

function unmatchedRecord(tx, candidates) {
  const top = candidates[0]
  return {
    bankTransactionId: tx.Id,
    fileName: tx.FileName,
    bankBorrowerName: tx.BorrowerName,
    loanDiskBorrowerName: top ? top.group.borrowerName : null,
    borrowerId: top ? top.group.borrowerId : null,
    loanNumber: null,
    matchedLoanNumbers: [],
    loanCount: 0,
    emiPaidAmount: tx.EmiPaidAmount ?? null,
    expectedEmiAmount: null,
    summedExpectedEmi: null,
    amountDiff: null,
    matchType: 'unmatched',
    amountMatchKind: 'none',
    nameScore: top ? top.score : 0,
    confidenceScore: top ? Math.round(0.45 * top.score) : 0,
    matchMethod: 'deterministic',
    reviewStatus: 'unmatched',
    reasoning: top ? `Closest name "${top.group.borrowerName}" scored ${top.score} (< ${NAME_MIN}).` : 'No borrower name candidate found.',
  }
}

/** Confidence for a single (borrower candidate, amount reconciliation) pair. */
function scoreCandidate(cand, recon) {
  const amtComp = amountComponent(recon.kind)
  const reconciled = recon.kind === 'exact_single' || recon.kind === 'sum_all' || recon.kind === 'subset'
  let confidence = Math.round(0.6 * cand.score + 0.4 * amtComp)
  if (cand.score >= NAME_STRONG && reconciled) confidence = Math.max(confidence, 90)
  if (cand.score >= 95 && reconciled) confidence = Math.max(confidence, 97)
  if (recon.ambiguous) confidence = Math.min(confidence, 80)
  return { cand, recon, amtComp, reconciled, confidence: clamp(confidence, 0, 100) }
}

/**
 * Deterministic classification for one deposit. Returns { record, needsAi }.
 *
 * Evaluates EVERY viable borrower candidate (not just the top name) and lets the
 * AMOUNT reconciliation break name ties — so two people who share a surname are
 * separated by which one's EMI the deposit actually pays, with no AI needed.
 */
export function classify(tx, index) {
  if (!tx.BorrowerName) {
    return { record: unmatchedRecord(tx, []), needsAi: false, candidates: [] }
  }
  const candidates = findCandidateBorrowers(tx.BorrowerName, index)
  const viable = candidates.filter((c) => c.score >= NAME_MIN)

  if (!viable.length) {
    return { record: unmatchedRecord(tx, candidates), needsAi: false, candidates }
  }

  // Score each viable borrower by name + their own amount reconciliation.
  const scored = viable
    .map((cand) => scoreCandidate(cand, reconcileAmount(tx.EmiPaidAmount, cand.group.loans)))
    .sort(
      (a, b) =>
        b.confidence - a.confidence || b.amtComp - a.amtComp || b.cand.score - a.cand.score
    )

  const best = scored[0]
  const runnerUp = scored[1]

  // True ambiguity: a runner-up is essentially as convincing — similar name AND
  // the same amount-reconciliation outcome (both reconcile, or neither does).
  const ambiguous =
    !!runnerUp &&
    best.confidence - runnerUp.confidence < 8 &&
    best.reconciled === runnerUp.reconciled &&
    Math.abs(best.cand.score - runnerUp.cand.score) < 8

  let confidence = best.confidence
  if (ambiguous) confidence = Math.min(confidence, 72)

  const { cand: top, recon } = best
  const matchType = best.reconciled && top.score >= NAME_STRONG ? 'name_and_amount' : 'name_only'

  const record = {
    bankTransactionId: tx.Id,
    fileName: tx.FileName,
    bankBorrowerName: tx.BorrowerName,
    loanDiskBorrowerName: top.group.borrowerName,
    borrowerId: top.group.borrowerId,
    loanNumber: recon.loanNumbers[0] || null,
    matchedLoanNumbers: recon.loanNumbers,
    loanCount: recon.loanNumbers.length,
    emiPaidAmount: tx.EmiPaidAmount ?? null,
    expectedEmiAmount: recon.loanNumbers.length === 1 ? recon.summedExpected : null,
    summedExpectedEmi: recon.summedExpected,
    amountDiff: recon.diff,
    matchType,
    amountMatchKind: recon.kind,
    nameScore: top.score,
    confidenceScore: confidence,
    matchMethod: 'deterministic',
    reviewStatus: reviewStatusFor(confidence, true),
    reasoning: buildDeterministicReason(top, recon, ambiguous),
  }

  // Escalate to the LLM ONLY when the amount could NOT break a genuine name tie.
  const needsAi = confidence < AUTO_CONFIDENCE && ambiguous

  return { record, needsAi, candidates }
}

function buildDeterministicReason(top, recon, ambiguousName) {
  const freq = recon.frequency && recon.frequency !== 'monthly' ? ` (${recon.frequency} installment)` : ''
  const bits = [`name ${top.nameKind || 'match'} ~${top.score}% vs "${top.group.borrowerName}"`]
  if (recon.kind === 'exact_single') bits.push(`amount matches one EMI${freq}`)
  else if (recon.kind === 'sum_all') bits.push(`amount = sum of all ${recon.loanNumbers.length} EMIs${freq}`)
  else if (recon.kind === 'subset') bits.push(`amount = sum of ${recon.loanNumbers.length} EMIs${freq}`)
  else if (recon.kind === 'partial') bits.push('amount partially covers an EMI')
  else if (recon.kind === 'mismatch') bits.push('amount does not reconcile')
  if (recon.ambiguous) bits.push('multiple EMI combinations possible')
  if (ambiguousName) bits.push('several borrowers with similar names')
  return bits.join('; ')
}

// --- AI adjudication --------------------------------------------------------

export const MATCH_SYSTEM_PROMPT = [
  'You are a loan reconciliation assistant for a lending company.',
  'You match ONE incoming bank/payroll CREDIT (money received from a borrower) to the correct borrower and loan(s) recorded in the lender\'s system (LoanDisk due records).',
  '',
  'NAME MATCHING:',
  '- Match on the borrower\'s FIRST and LAST name. Consider every combination: first+last (same order), last+first (reversed, e.g. "Russell, Calvin" == "Calvin Russell"), last name only, and first name only.',
  '- Allow minor typos / spelling mistakes, middle names or initials, abbreviations, case, punctuation and titles (Mr/Mrs).',
  '- The name must clearly identify ONE person. Each candidate includes "matchedBy" and "nameScore" from a pre-filter — use them as a guide but apply your own judgement.',
  '- Generic / non-borrower payers like "Cash Deposit", "Simplified Lending", "Simplified Lending Ltd", transfers or the lender\'s own name are NOT borrowers — return a null match.',
  '',
  'AMOUNT MATCHING (very important):',
  '- The loan EMI in the data is the MONTHLY amount, but borrowers often pay on a different schedule. A single deposit may equal: the FULL monthly EMI, HALF the EMI (bi-weekly payroll deduction), or a QUARTER of the EMI (weekly). Treat EMI, EMI/2 and EMI/4 as valid installment amounts (allow ~2% for fees/rounding).',
  '- A borrower can have SEVERAL active loans. A single deposit may settle ONE loan, or SEVERAL loans at once — in which case the deposit equals the SUM of those loans\' installments (full, half or quarter of each). Find the exact set of loans that explains the amount.',
  '- Pick the borrower and the EXACT set of loan(s) whose expected EMI(s) best explain the deposited amount. Prefer a clean reconciliation over a loose one.',
  '',
  'OUTPUT:',
  '- confidence (0-100 integer) reflects how sure you are about BOTH the borrower identity AND the loan selection. A confident full name + a clean amount reconciliation should be 85-100; a weak/partial identification should be below 70.',
  '- If the name does not convincingly match any candidate, return matchedBorrowerId=null, matchedLoanNumbers=[] and a low confidence.',
  '- Respond with STRICT JSON only. No prose, no markdown, no explanation outside the JSON object.',
].join('\n')

/** Build the user prompt for one deposit + its candidate borrowers. */
export function buildMatchPrompt(tx, candidates) {
  const deposit = {
    name: tx.BorrowerName || '',
    amount: tx.EmiPaidAmount ?? null,
    date: tx.TransDate ? new Date(tx.TransDate).toISOString().slice(0, 10) : null,
    particulars: tx.Particulars || '',
    source: tx.EmployerOrBank || tx.SourceType || '',
  }
  const candidatePayload = candidates.map((c) => ({
    borrowerId: c.group.borrowerId,
    name: c.group.borrowerName,
    nameScore: c.score,
    matchedBy: c.nameKind,
    totalEMI: c.group.totalEMI,
    loans: c.group.loans.slice(0, 12).map((l) => ({
      loanNumber: l.loanNumber,
      expectedEMI: round2(l.expectedEMI),
      status: l.status,
    })),
  }))

  const user = [
    'DEPOSIT (a credit received in a bank/payroll statement):',
    JSON.stringify(deposit, null, 2),
    '',
    'CANDIDATE BORROWERS (from the lender\'s due loans):',
    JSON.stringify(candidatePayload, null, 2),
    '',
    'Decide the single best borrower and which loan(s) this deposit pays.',
    'Return JSON with EXACTLY these keys:',
    '{',
    '  "matchedBorrowerId": string | null,',
    '  "matchedBorrowerName": string | null,',
    '  "matchedLoanNumbers": string[],          // loan numbers this deposit settles; [] if none',
    '  "summedExpectedEMI": number | null,      // sum of the matched loans\' EMIs',
    '  "amountMatchKind": "exact_single" | "sum_all" | "subset" | "partial" | "mismatch" | "none",',
    '  "confidence": number,                    // 0-100 integer',
    '  "reasoning": string                      // one short sentence',
    '}',
  ].join('\n')

  return { system: MATCH_SYSTEM_PROMPT, user }
}

/** Merge an AI JSON response back into a persistable match record. */
export function applyAi(tx, candidates, ai) {
  const byId = new Map(candidates.map((c) => [String(c.group.borrowerId), c]))
  let chosen = ai?.matchedBorrowerId != null ? byId.get(String(ai.matchedBorrowerId)) : null
  if (!chosen && ai?.matchedBorrowerName) {
    chosen = candidates.find((c) => normalizeNameKey(c.group.borrowerName) === normalizeNameKey(ai.matchedBorrowerName)) || null
  }

  const confidence = clamp(Math.round(Number(ai?.confidence) || 0), 0, 100)
  const noMatch = !chosen || !Array.isArray(ai?.matchedLoanNumbers) || ai.matchedLoanNumbers.length === 0

  if (noMatch) {
    const base = unmatchedRecord(tx, candidates)
    return {
      ...base,
      matchMethod: 'ai',
      confidenceScore: confidence || base.confidenceScore,
      reasoning: (ai?.reasoning || base.reasoning || '').slice(0, 1000),
      reviewStatus: 'unmatched',
    }
  }

  const validLoans = new Set(chosen.group.loans.map((l) => l.loanNumber))
  const loanNumbers = ai.matchedLoanNumbers.map(String).filter((ln) => validLoans.has(ln))
  const finalLoans = loanNumbers.length ? loanNumbers : ai.matchedLoanNumbers.map(String)
  const summed = loanNumbers.length ? emiOfLoans(chosen.group, loanNumbers) : (Number(ai.summedExpectedEMI) || null)
  const paid = tx.EmiPaidAmount != null ? Number(tx.EmiPaidAmount) : null
  const kind = ai.amountMatchKind || 'none'
  const amtComp = amountComponent(kind)
  const matchType = amtComp === 100 && chosen.score >= NAME_STRONG ? 'name_and_amount' : 'name_only'

  return {
    bankTransactionId: tx.Id,
    fileName: tx.FileName,
    bankBorrowerName: tx.BorrowerName,
    loanDiskBorrowerName: chosen.group.borrowerName,
    borrowerId: chosen.group.borrowerId,
    loanNumber: finalLoans[0] || null,
    matchedLoanNumbers: finalLoans,
    loanCount: finalLoans.length,
    emiPaidAmount: paid,
    expectedEmiAmount: finalLoans.length === 1 ? summed : null,
    summedExpectedEmi: summed,
    amountDiff: paid != null && summed != null ? round2(paid - summed) : null,
    matchType,
    amountMatchKind: kind,
    nameScore: chosen.score,
    confidenceScore: confidence,
    matchMethod: 'ai',
    reviewStatus: reviewStatusFor(confidence, true),
    reasoning: (ai.reasoning || '').slice(0, 1000),
  }
}
