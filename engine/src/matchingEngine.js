import { buildEngineConfig, extractIdsWithPatterns } from '../../matchingRules.js'
import { activeLoan, createIdentityIndex, nameCandidates, transactionIdentity, extractLoanIds, normalizeLoanId, confirmedHistory, compactName } from './borrowerIdentity.js'

let runtimeConfig = buildEngineConfig()
export const setMatchingEngineConfig = (value) => { runtimeConfig = value || buildEngineConfig() }
export const getMatchingEngineConfig = () => runtimeConfig
export const NAME_MIN = 70
export const NAME_STRONG = 92
export const AUTO_CONFIDENCE = 81
export const CONFIDENCE_BUCKET_LABELS = { same_person: 'Same person', very_likely_match: 'Very likely', possible_review: 'Review', different_person: 'Unmatched' }
export function confidenceBucket(value) {
  return value >= 98 ? 'same_person' : value >= 81 ? 'very_likely_match' : value > 70 ? 'possible_review' : 'different_person'
}
export const formatReasoningWithBucket = (bucket, text) => `[${bucket || 'different_person'}] ${String(text || '').trim()}`
export const parseBucketFromReasoning = (text) => String(text || '').match(/^\[([a-z_]+)\]/)?.[1] || null
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const number = (v) => v == null || String(v).trim() === '' ? null : Number(String(v).replace(/,/g, ''))
const tolerance = (amount, c) => Math.max(c.AMOUNT_TOL_MIN, Math.abs(amount) * c.AMOUNT_TOL_PCT)

function aliases(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [] } catch { return [] }
}

export function groupLoansByBorrower(loans) {
  const groups = new Map()
  for (const [row, loan] of loans.entries()) {
    const id = loan.BorrowerId != null && String(loan.BorrowerId).trim() ? String(loan.BorrowerId).trim() : null
    // Names are not unique identities. Missing IDs stay isolated and require review.
    const key = id ? `id:${id}` : `unknown:${row}`
    if (!groups.has(key)) groups.set(key, { key, borrowerId: id, borrowerName: loan.BorrowerFullName || '', names: [], employers: [], loans: [] })
    const g = groups.get(key)
    const rawFullName = String(loan.BorrowerFullName || '').trim()
    g.names = [...new Set([...g.names, rawFullName, ...aliases(loan.Aliases)].filter(Boolean))]
    g.employers = [...new Set([...g.employers, loan.EmployerName, loan.Employer].filter(Boolean))]
    if (!loan.LoanNumber || g.loans.some((l) => l.loanNumber === String(loan.LoanNumber) && l.branch === loan.BranchName)) continue
    g.loans.push({ loanNumber: String(loan.LoanNumber), expectedEMI: number(loan.ExpectedEMIAmount),
      frequency: loan.RepaymentFrequency || loan.PaymentFrequency || null, syncedAt: loan.SyncedAt || null,
      status: loan.LoanStatus, balance: number(loan.LoanBalanceAmount), branch: loan.BranchName,
      // TotalDue in existing staging is lifetime contractual due, NOT current arrears.
      currentDue: number(loan.TotalAmountDue ?? loan.CurrentAmountDue), pendingEMIs: number(loan.PendingEMICount),
      dueDate: loan.NextDueDate || loan.ExpectedPaymentDate || null,
      charges: number(loan.LateFeeAmount ?? loan.ChargesDue),
      historicalPaymentCents: Array.isArray(loan.HistoricalPaymentCents)
        ? loan.HistoricalPaymentCents.filter((n) => Number.isFinite(n) && n > 0)
        : [],
    })
  }
  for (const g of groups.values()) g.totalEMI = round2(g.loans.reduce((sum, l) => sum + (l.expectedEMI || 0), 0))
  return groups
}
export const buildBorrowerIndex = (groups, history = []) => createIdentityIndex(groups, history)
export const parseTxParticulars = transactionIdentity
export const findCandidateBorrowers = (name, index, limit = 5) => nameCandidates(name, index, runtimeConfig.TYPO_FLOOR).slice(0, limit)
export function mergeNameDescriptionCandidates(names, descriptions, limit = 8) {
  const map = new Map()
  for (const c of [...names, ...descriptions]) if (!map.has(c.group.key) || map.get(c.group.key).score < c.score) map.set(c.group.key, c)
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
export function findLoanNumberHints(text, groups) {
  const ids = new Set(extractLoanIds(text))
  if (!ids.size) return []
  const hints = []
  for (const group of groups.values()) for (const loan of group.loans) {
    if (ids.has(normalizeLoanId(loan.loanNumber))) hints.push({ group, score: 100, nameKind: 'exact_loan_id', matchedFrom: 'loan_number', hintedLoanNumber: loan.loanNumber, strongIdentity: true })
  }
  return hints
}
export function findBorrowerIdHints(tx, groups, patterns = []) {
  const ids = new Set()
  const fields = { reference: tx.ReferenceNo, description: transactionIdentity(tx).description, particulars: tx.Particulars, borrowerName: tx.BorrowerName }
  for (const pattern of patterns) for (const id of extractIdsWithPatterns(fields[pattern.field], [pattern])) ids.add(id)
  return [...groups.values()].filter((g) => g.borrowerId && ids.has(g.borrowerId)).map((group) => ({ group, score: 99, nameKind: 'exact_borrower_id', strongIdentity: true }))
}

function typicalHistoryCents(loan) {
  return (loan.historicalPaymentCents || []).filter((n) => Number.isFinite(n) && n > 0)
}

/** Unique loan whose recurring historical repayments equal the credit. */
function uniqueHistoryAllocation(cents, loans, c) {
  const hits = []
  for (const loan of loans) {
    if (!loan.loanNumber) continue
    for (const hist of typicalHistoryCents(loan)) {
      if (Math.abs(cents - hist) <= Math.round(tolerance(hist / 100, c) * 100)) {
        hits.push({ loan, hist })
        break
      }
    }
  }
  const ids = [...new Set(hits.map((h) => h.loan.loanNumber))]
  if (ids.length !== 1) return null
  const { hist } = hits[0]
  return {
    kind: 'history_installment',
    loanNumbers: ids,
    summedExpected: hist / 100,
    diff: (cents - hist) / 100,
    ambiguous: false,
    frequency: 'historical installment',
    emiCount: 1,
    historyMatched: true,
  }
}

function emiSubsets(emiList, c) {
  const subsets = emiList.map((l) => [l])
  const truncated = c.useSubsetSum && emiList.length > 12
  if (c.useSubsetSum && emiList.length <= 12) {
    for (let mask = 1; mask < (1 << emiList.length); mask++) {
      if ((mask & (mask - 1)) === 0) continue
      subsets.push(emiList.filter((_, i) => mask & (1 << i)))
    }
  }
  return { subsets, truncated }
}

/** Contractual EMI = full installment, integer multiples, subsets, charges. Fractions run after history. */
function collectEmiPossibilities(subsets, emiList, cents, amt, c, { fractions }) {
  const possibilities = []
  for (const subset of subsets) {
    const base = subset.reduce((sum, l) => sum + Math.round(l.expectedEMI * 100), 0)
    const scales = []
    if (fractions) {
      scales.push(...(c.installmentScales || []).filter((s) => s.scale > 0 && s.scale < 1))
    } else {
      scales.push({ scale: 1, freq: 'base installment' })
      const pct = c.AMOUNT_TOL_PCT
      const floorTolerance = c.AMOUNT_TOL_MIN * 100
      const low = Math.max(2, Math.ceil(Math.min((cents - floorTolerance) / base, cents / (base * (1 + pct)))))
      const high = Math.min(c.MAX_EMI_MULTIPLE || 60, Math.floor(Math.max((cents + floorTolerance) / base, cents / (base * (1 - pct)))))
      for (let count = low; count <= high; count++) scales.push({ scale: count, freq: `${count} EMIs` })
    }
    for (const { scale, freq } of scales) {
      const expected = Math.round(base * scale)
      const diff = cents - expected
      if (Math.abs(diff) > Math.round(tolerance(expected / 100, c) * 100)) continue
      possibilities.push({
        kind: scale > 1 ? 'emi_multiple' : subset.length === 1 ? 'exact_single' : subset.length === emiList.length ? 'sum_all' : 'subset',
        loanNumbers: subset.map((l) => l.loanNumber), summedExpected: base / 100, diff: diff / 100, frequency: freq, emiCount: scale,
      })
    }
    if (!fractions && subset.length === 1 && Number.isFinite(subset[0].charges) && subset[0].charges > 0) {
      const charges = Math.round(subset[0].charges * 100)
      const k = Math.round((cents - charges) / base)
      if (k >= 1 && k <= (c.MAX_EMI_MULTIPLE || 60) && Math.abs(cents - base * k - charges) <= Math.round(tolerance(amt, c) * 100)) {
        possibilities.push({ kind: 'emi_with_charges', loanNumbers: [subset[0].loanNumber], summedExpected: base / 100,
          diff: (cents - base * k - charges) / 100, frequency: `${k} EMIs + charges`, emiCount: k })
      }
    }
  }
  possibilities.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || a.loanNumbers.length - b.loanNumbers.length || a.emiCount - b.emiCount)
  return possibilities
}

function pickEmiBest(possibilities, truncated) {
  if (!possibilities.length) return null
  return { ...possibilities[0], ambiguous: truncated || possibilities.length > 1, alternatives: possibilities.slice(0, 5) }
}

/** Allocate only inside one borrower. Integer cents and all plausible allocations prevent first-hit bias. */
export function reconcileAmount(paid, loans, c = runtimeConfig) {
  const amt = number(paid)
  const list = loans.map((l) => ({ ...l, expectedEMI: number(l.expectedEMI) })).filter((l) => l.loanNumber)
  const none = { kind: 'none', loanNumbers: [], summedExpected: null, diff: null, ambiguous: false, frequency: null, emiCount: null }
  if (!Number.isFinite(amt) || amt <= 0 || !list.length) return none
  const cents = Math.round(amt * 100)
  const hist = uniqueHistoryAllocation(cents, list, c)
  const emiList = list.filter((l) => Number.isFinite(l.expectedEMI) && l.expectedEMI > 0)
  if (!emiList.length) return hist || none
  const { subsets, truncated } = emiSubsets(emiList, c)

  // 1) Contractual EMI. 2) If EMI does not uniquely match, repayment history. 3) Half/quarter EMI last.
  const contractual = pickEmiBest(collectEmiPossibilities(subsets, emiList, cents, amt, c, { fractions: false }), truncated)
  if (contractual && !contractual.ambiguous) {
    if (hist && hist.loanNumbers[0] === contractual.loanNumbers[0]) contractual.historyMatched = true
    return contractual
  }
  if (hist) return hist
  if (contractual) return contractual
  const fractional = pickEmiBest(collectEmiPossibilities(subsets, emiList, cents, amt, c, { fractions: true }), truncated)
  if (fractional) return fractional
  const closest = emiList.map((l) => ({ l, diff: round2(amt - l.expectedEMI) })).sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))[0]
  return { kind: amt < closest.l.expectedEMI ? 'partial' : 'mismatch', loanNumbers: [closest.l.loanNumber], summedExpected: closest.l.expectedEMI,
    diff: closest.diff, ambiguous: emiList.length > 1, frequency: null, emiCount: null }
}
const reconciled = (r) => ['exact_single', 'sum_all', 'subset', 'emi_multiple', 'emi_with_charges', 'history_installment'].includes(r.kind)

/** First and last tokens match independently, but the full name is not confirmed. */
function isIndependentFirstLast(cand) {
  const kind = String(cand?.nameKind || '')
  if (kind === 'exact_full' || kind.includes('+full')) return false
  if (cand?.strongIdentity) return false
  if (!/^(first\+last|last\+first|exact_first_last)/.test(kind)) return false
  // Initials (M Smith) are not a first+last identity even when the surname matches.
  if (cand?.nameBreakdown?.first?.initial || cand?.nameBreakdown?.last?.initial) return false
  return true
}

/** First and last names both match — full identity or independent first+last. Initials do not count. */
function hasFirstLastIdentity(cand) {
  if (cand?.nameBreakdown?.first?.initial || cand?.nameBreakdown?.last?.initial) return false
  if (cand?.strongIdentity || cand?.nameKind === 'exact_full' || String(cand?.nameKind || '').includes('+full')) return true
  return isIndependentFirstLast(cand)
}

function contextFor(cand, recon, tx, identity, historyId) {
  const employer = !!identity.employer && cand.group.employers.some((e) => compactName(e) === compactName(identity.employer))
  const history = historyId != null && historyId === cand.group.borrowerId
  const scoped = cand.group.loans.filter((l) => recon.loanNumbers.includes(l.loanNumber))
  const active = scoped.length > 0 && scoped.every(activeLoan)
  const due = scoped.length > 0 && scoped.every((l) => Number.isFinite(l.currentDue)) && Math.abs(scoped.reduce((s, l) => s + l.currentDue, 0) - Number(tx.EmiPaidAmount)) < 0.01
  const paidDate = Date.parse(tx.TransDate)
  const nearDue = Number.isFinite(paidDate) && scoped.some((l) => l.dueDate && Math.abs(Date.parse(l.dueDate) - paidDate) <= 7 * 86400000)
  const pendingCount = recon.emiCount >= 1 && scoped.length > 0 && scoped.every((l) => Number.isFinite(l.pendingEMIs) && l.pendingEMIs === recon.emiCount)
  return { employer, history, active, due, nearDue, pendingCount }
}

function emptyRecord(tx, reason) {
  return { bankTransactionId: tx.Id, fileName: tx.FileName, bankBorrowerName: transactionIdentity(tx).borrowerName || tx.BorrowerName,
    loanDiskBorrowerName: null, borrowerId: null, loanNumber: null, matchedLoanNumbers: [], loanCount: 0,
    emiPaidAmount: tx.EmiPaidAmount ?? null, expectedEmiAmount: null, summedExpectedEmi: null, amountDiff: null,
    matchType: 'unmatched', amountMatchKind: 'none', nameScore: 0, confidenceScore: 0, confidenceBucket: 'different_person',
    matchMethod: 'deterministic', reviewStatus: 'unmatched', reasoning: formatReasoningWithBucket('different_person', reason) }
}

export function classifyEvidence(tx, index, c = runtimeConfig) {
  const identity = transactionIdentity(tx)
  const base = emptyRecord(tx, 'No borrower identity found in the master.')
  if (!Number.isFinite(number(tx.EmiPaidAmount)) || number(tx.EmiPaidAmount) <= 0) {
    return { record: { ...base, reasoning: '[different_person] Matching requires a positive credit amount.' }, needsAi: false, candidates: [] }
  }
  const inputName = c.signals?.useBorrowerName?.enabled !== false ? identity.borrowerName : ''
  const descName = c.signals?.useDescription?.enabled !== false ? identity.descriptionName : ''
  let candidates = mergeNameDescriptionCandidates(inputName ? nameCandidates(inputName, index, c.TYPO_FLOOR) : [],
    descName ? nameCandidates(descName, index, c.TYPO_FLOOR).map((v) => ({ ...v, matchedFrom: 'description' })) : [], Infinity)
  const hints = c.signals?.useLoanNumberHint?.enabled !== false
    ? findLoanNumberHints([identity.full, tx.ReferenceNo].filter(Boolean).join(' '), index.groups)
    : []
  const referencedIds = c.signals?.useLoanNumberHint?.enabled !== false
    ? [...new Set([...extractLoanIds(identity.full), ...extractLoanIds(tx.ReferenceNo)])]
    : []
  const unknownReference = referencedIds.some((id) => !hints.some((h) => normalizeLoanId(h.hintedLoanNumber) === id))
  const conflictingReference = hints.length > 1
  const nameConflict = hints.length === 1 && candidates.some((v) => v.score >= 92 && v.group.key !== hints[0].group.key)
  if (hints.length) candidates = hints
  const anonymousCash = identity.cash && !inputName && !descName && !hints.length
  if (anonymousCash) candidates = [...index.groups.values()].filter((g) => g.loans.some(activeLoan)).map((group) => ({ group, score: 0, nameKind: 'cash_amount', partialIdentity: true }))
  const historyId = confirmedHistory(tx, identity, index)
  const scored = candidates.map((cand) => {
    const scope = cand.hintedLoanNumber ? cand.group.loans.filter((l) => l.loanNumber === cand.hintedLoanNumber)
      : anonymousCash ? cand.group.loans.filter(activeLoan) : cand.group.loans
    const recon = reconcileAmount(tx.EmiPaidAmount, scope, c)
    const context = contextFor(cand, recon, tx, identity, historyId)
    const amountScore = reconciled(recon) ? 100 : c.amountComponents?.[recon.kind] ?? 0
    let confidence
    if (cand.hintedLoanNumber) confidence = 100
    else if (anonymousCash) {
      // Cash deposits (no payer name) can only be matched on amount alone.
      // Only surface for review when the amount is an EXACT single-loan match —
      // partial fractions, multi-EMI guesses, and mismatches are pure coincidence.
      const exactCash = recon.kind === 'exact_single' || recon.kind === 'emi_multiple'
      confidence = exactCash ? 80 + (context.due ? 5 : 0) + (context.nearDue ? 3 : 0) + (context.pendingCount ? 3 : 0) : 0
    }
    else if (cand.partialIdentity) confidence = cand.score + (reconciled(recon) ? 10 : 0) + (context.employer ? 5 : 0) + (context.history ? 10 : 0)
    else {
      // The score describes borrower identity. A partial credit cannot make
      // an otherwise strong person-name match disappear. Amount can add evidence.
      confidence = Math.max(cand.score, cand.score * c.NAME_WEIGHT + amountScore * c.AMOUNT_WEIGHT)
      // Exact full names retain identity evidence when the payment is partial.
      if (cand.nameKind === 'exact_full') confidence = Math.max(confidence, 98)
      confidence += (context.employer ? 3 : 0) + (context.history ? 5 : 0)
    }
    const historyAuto = hasFirstLastIdentity(cand) && recon.historyMatched && reconciled(recon)
    if (historyAuto) confidence = 100
    else if (!cand.hintedLoanNumber) confidence = Math.min(confidence, 99)
    if ((cand.partialIdentity || anonymousCash) && !historyAuto) confidence = Math.min(confidence, 91)
    // Independent first + last is not a full identity; cap below exact/same-person.
    if (isIndependentFirstLast(cand) && reconciled(recon) && !historyAuto) confidence = Math.min(confidence, 91)
    return { cand, recon, context, confidence: round2(confidence), historyAuto }
  }).filter((s) => anonymousCash ? reconciled(s.recon) : s.cand.score >= c.NAME_MIN)
    .sort((a, b) => b.confidence - a.confidence || b.cand.score - a.cand.score || a.cand.group.key.localeCompare(b.cand.group.key))
  if (!scored.length) return { record: { ...base, reasoning: '[different_person] No qualifying borrower candidate; cash credits require an active loan and a reconcilable EMI amount.' }, needsAi: false, candidates: [] }
  const best = scored[0], second = scored[1]
  const gap = second ? round2(best.confidence - second.confidence) : 100
  const ambiguous = conflictingReference || nameConflict || gap < Math.max(8, c.AMBIGUITY_GAP)
  const { cand, recon, context, historyAuto } = best
  const identityBlocked = ambiguous || unknownReference || !cand.group.borrowerId || !context.active
    || (cand.partialIdentity && !historyAuto && !isIndependentFirstLast(cand)) || anonymousCash
  const allocationBlocked = recon.ambiguous || recon.kind === 'none' || recon.kind === 'mismatch'
  // A uniquely identified loan can receive a partial repayment. Multiple loans
  // or unexplained overpayments still need allocation review.
  const blocked = identityBlocked || allocationBlocked
  const confidence = identityBlocked ? Math.min(best.confidence, 91) : best.confidence
  const autoFloor = Math.max(AUTO_CONFIDENCE, Number(c.AUTO_CONFIDENCE) || AUTO_CONFIDENCE)
  const identityOk = cand.strongIdentity || cand.score >= autoFloor || historyAuto || isIndependentFirstLast(cand) || hasFirstLastIdentity(cand)
  const status = !blocked && confidence >= autoFloor && identityOk
    ? 'auto_matched' : confidence >= 80 || ambiguous ? 'needs_review' : 'unmatched'
  const bucket = confidenceBucket(confidence)
  const reasons = [
    `${anonymousCash ? 'Cash deposit: amount identifies candidates, not a person' : cand.nameKind}; score ${confidence}; margin ${gap}`,
    `Candidates: ${scored.slice(0, 3).map((s) => `${s.cand.group.borrowerName} (${s.cand.group.borrowerId || 'missing ID'}): ${s.confidence}`).join('; ')}`,
    `${recon.kind}${recon.emiCount ? ` (${recon.emiCount} × base EMI)` : ''}; residual ${recon.diff ?? 'unknown'}`,
    ambiguous && 'Ambiguous or conflicting identities — manual review', unknownReference && 'Labelled loan reference not found — manual review',
    recon.ambiguous && 'Multiple possible loan allocations — manual review', allocationBlocked && 'Borrower identified; payment allocation requires review; no fees inferred',
    recon.kind === 'partial' && !allocationBlocked && 'Partial repayment against the uniquely identified loan',
    historyAuto && 'First and last name match; credit equals historical repayment EMI — 100% match',
    isIndependentFirstLast(cand) && reconciled(recon) && !historyAuto && (status === 'auto_matched'
      ? 'Independent first name, last name, and exact EMI — matched (≥81%)'
      : 'Independent first name, last name, and exact EMI — needs review'),
    !context.active && 'Active loan status not established',
    cand.partialIdentity && !historyAuto && !isIndependentFirstLast(cand) && 'Insufficient full name tokens to auto-identify a borrower',
    context.employer && 'Employer agrees', context.history && 'Previously confirmed name and employer agree', context.due && 'Current amount due agrees', context.pendingCount && 'Pending EMI count agrees',
  ].filter(Boolean).join('. ')
  const assigned = status !== 'unmatched'
  const record = { ...base, loanDiskBorrowerName: assigned ? cand.group.borrowerName : null, borrowerId: assigned ? cand.group.borrowerId : null,
    loanNumber: assigned && !recon.ambiguous ? recon.loanNumbers[0] || null : null,
    matchedLoanNumbers: assigned && !recon.ambiguous ? recon.loanNumbers : [], loanCount: assigned && !recon.ambiguous ? recon.loanNumbers.length : 0,
    expectedEmiAmount: recon.loanNumbers.length === 1 ? recon.summedExpected : null, summedExpectedEmi: recon.summedExpected, amountDiff: recon.diff,
    matchType: status === 'unmatched' ? 'unmatched' : cand.hintedLoanNumber ? 'loan_id' : anonymousCash ? 'cash_amount' : reconciled(recon) ? 'name_and_amount' : 'name_only',
    amountMatchKind: recon.kind, nameScore: cand.score, confidenceScore: confidence, confidenceBucket: bucket, reviewStatus: status,
    nameKind: cand.nameKind || null,
    independentFirstLast: isIndependentFirstLast(cand),
    firstLastIdentity: hasFirstLastIdentity(cand),
    historyMatched: !!recon.historyMatched,
    reasoning: formatReasoningWithBucket(bucket, reasons).slice(0, 1000),
    emiCount: status === 'auto_matched' ? recon.emiCount : null, candidateCount: scored.length,
  }
  return { record, needsAi: false, candidates: scored.slice(0, 8).map((s) => ({ ...s.cand, confidence: s.confidence })) }
}

/** User policy: 81% and above is matched; posting readiness is separate. */
export function matchStatusFor(confidence) {
  return Number(confidence) >= AUTO_CONFIDENCE ? 'auto_matched' : 'unmatched'
}

export function classify(tx, index, c = runtimeConfig) {
  const result = classifyEvidence(tx, index, c)
  const original = result.record
  const anonymous = result.candidates[0]?.nameKind === 'cash_amount'
  const score = Number(original.confidenceScore)
  const historyPerfect = original.historyMatched && score >= 100
  const status = anonymous
    ? 'needs_review'
    : historyPerfect || score >= AUTO_CONFIDENCE
      ? 'auto_matched'
      : original.reviewStatus
  const ready = original.reviewStatus === 'auto_matched' || historyPerfect
  const candidate = result.candidates[0]
  const keepSuggestion = status !== 'unmatched'
  result.record = {
    ...original,
    reviewStatus: status,
    borrowerId: keepSuggestion ? original.borrowerId || candidate?.group.borrowerId || null : null,
    loanDiskBorrowerName: keepSuggestion ? original.loanDiskBorrowerName || candidate?.group.borrowerName || null : null,
    loanNumber: anonymous ? null : original.loanNumber,
    matchedLoanNumbers: anonymous ? [] : original.matchedLoanNumbers,
    matchType: historyPerfect || ready ? original.matchType : status !== 'unmatched' ? 'review_required' : original.matchType,
    emiCount: ready ? original.emiCount : null,
    reasoning: status === 'auto_matched' && !ready
      ? original.reasoning.replace(/^(\[[^\]]+\] )/, '$1Matched by ≥81% rule; review required before posting. ').slice(0, 1000)
      : original.reasoning,
  }
  return result
}

/** Recurring ledger amounts in cents, keyed by loan number. */
export function typicalCentsFromRepaymentRows(rows = []) {
  const byLoan = new Map()
  for (const row of rows) {
    const loan = String(row?.loanNumber || '').trim()
    const cents = Math.round(Number(row?.amount) * 100)
    if (!loan || !Number.isFinite(cents) || cents <= 0) continue
    if (!byLoan.has(loan)) byLoan.set(loan, new Map())
    const counts = byLoan.get(loan)
    counts.set(cents, (counts.get(cents) || 0) + 1)
  }
  const typical = new Map()
  for (const [loan, counts] of byLoan) {
    const recurring = [...counts.entries()].filter(([, n]) => n >= 2).map(([cents]) => cents)
    if (recurring.length) typical.set(loan, recurring)
    else if (counts.size === 1) typical.set(loan, [...counts.keys()])
  }
  return typical
}

/**
 * After first+last identity is established and EMI did not uniquely match,
 * promote a unique historical repayment amount to a 100% match.
 */
export function applyRepaymentHistoryMatch(record, loans = [], typicalCentsByLoan = new Map(), c = runtimeConfig) {
  if (!record?.firstLastIdentity && !record?.independentFirstLast) return record
  if (record.historyMatched && Number(record.confidenceScore) >= 100) return record
  if (!record.borrowerId) return record
  const list = (loans || []).map((l) => ({
    ...l,
    historicalPaymentCents: typicalCentsByLoan.get(String(l.loanNumber)) || l.historicalPaymentCents || [],
  }))
  const hist = uniqueHistoryAllocation(Math.round(Number(record.emiPaidAmount) * 100), list, c)
  if (!hist) return record
  const bucket = confidenceBucket(100)
  return {
    ...record,
    historyMatched: true,
    confidenceScore: 100,
    confidenceBucket: bucket,
    reviewStatus: 'auto_matched',
    matchType: 'name_and_amount',
    amountMatchKind: 'history_installment',
    loanNumber: hist.loanNumbers[0],
    matchedLoanNumbers: hist.loanNumbers,
    loanCount: hist.loanNumbers.length,
    expectedEmiAmount: hist.summedExpected,
    summedExpectedEmi: hist.summedExpected,
    amountDiff: hist.diff,
    emiCount: 1,
    reasoning: formatReasoningWithBucket(bucket,
      `First and last name match; EMI did not match contractual installment; credit equals historical repayment EMI — 100% match. ${String(record.reasoning || '').replace(/^\[[^\]]+\]\s*/, '')}`
    ).slice(0, 1000),
  }
}

// Compatibility for optional AI callers: model text can never select a financial identity or invent loans.
export function buildMatchPrompt(tx, candidates) {
  return { system: 'Explain the candidate evidence for manual review. Do not choose an identity or approve posting.',
    user: JSON.stringify({ transaction: tx, candidates: candidates.map((c) => ({ borrower: c.group.borrowerName, score: c.score })) }) }
}
export function applyAi(tx, candidates, ai) {
  const index = buildBorrowerIndex(new Map(candidates.map((c) => [c.group.key, c.group])))
  const result = classify(tx, index).record
  return { ...result, reviewStatus: result.reviewStatus === 'unmatched' ? 'unmatched' : 'needs_review',
    confidenceScore: Math.min(result.confidenceScore, 91), confidenceBucket: confidenceBucket(Math.min(result.confidenceScore, 91)),
    reasoning: formatReasoningWithBucket(confidenceBucket(Math.min(result.confidenceScore, 91)), `Manual review required. ${result.reasoning.replace(/^\[[^\]]+\]\s*/, '')}`).slice(0, 1000) }
}
