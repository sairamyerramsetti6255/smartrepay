import { buildEngineConfig, extractIdsWithPatterns } from '../../matchingRules.js'
import { activeLoan, createIdentityIndex, nameCandidates, transactionIdentity, extractLoanIds, normalizeLoanId, confirmedHistory, compactName } from './borrowerIdentity.js'

let runtimeConfig = buildEngineConfig()
export const setMatchingEngineConfig = (value) => { runtimeConfig = value || buildEngineConfig() }
export const getMatchingEngineConfig = () => runtimeConfig
export const NAME_MIN = 70
export const NAME_STRONG = 92
export const AUTO_CONFIDENCE = 92
export const CONFIDENCE_BUCKET_LABELS = { same_person: 'Same person', very_likely_match: 'Very likely', possible_review: 'Review', different_person: 'Unmatched' }
export function confidenceBucket(value) {
  return value >= 98 ? 'same_person' : value >= 92 ? 'very_likely_match' : value > 70 ? 'possible_review' : 'different_person'
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
    g.names = [...new Set([...g.names, loan.BorrowerFullName, ...aliases(loan.Aliases)].filter(Boolean))]
    g.employers = [...new Set([...g.employers, loan.EmployerName, loan.Employer].filter(Boolean))]
    if (!loan.LoanNumber || g.loans.some((l) => l.loanNumber === String(loan.LoanNumber))) continue
    g.loans.push({ loanNumber: String(loan.LoanNumber), expectedEMI: number(loan.ExpectedEMIAmount),
      status: loan.LoanStatus, balance: number(loan.LoanBalanceAmount), branch: loan.BranchName,
      // TotalDue in existing staging is lifetime contractual due, NOT current arrears.
      currentDue: number(loan.TotalAmountDue ?? loan.CurrentAmountDue), pendingEMIs: number(loan.PendingEMICount),
      dueDate: loan.NextDueDate || loan.ExpectedPaymentDate || null,
      charges: number(loan.LateFeeAmount ?? loan.ChargesDue),
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

/** Allocate only inside one borrower. Integer cents and all plausible allocations prevent first-hit bias. */
export function reconcileAmount(paid, loans, c = runtimeConfig) {
  const amt = number(paid)
  const list = loans.map((l) => ({ ...l, expectedEMI: number(l.expectedEMI) })).filter((l) => Number.isFinite(l.expectedEMI) && l.expectedEMI > 0 && l.loanNumber)
  const none = { kind: 'none', loanNumbers: [], summedExpected: null, diff: null, ambiguous: false, frequency: null, emiCount: null }
  if (!Number.isFinite(amt) || amt <= 0 || !list.length) return none
  const cents = Math.round(amt * 100)
  const subsets = list.map((l) => [l])
  // Bounded search. If the book is too large, do not claim a unique allocation.
  const truncated = c.useSubsetSum && list.length > 12
  if (c.useSubsetSum && list.length <= 12) {
    for (let mask = 1; mask < (1 << list.length); mask++) {
      if ((mask & (mask - 1)) === 0) continue
      subsets.push(list.filter((_, i) => mask & (1 << i)))
    }
  }
  const possibilities = []
  for (const subset of subsets) {
    const base = subset.reduce((sum, l) => sum + Math.round(l.expectedEMI * 100), 0)
    const scales = [{ scale: 1, freq: 'monthly' }, ...(c.installmentScales || []).filter((s) => s.scale > 0 && s.scale < 1)]
    // Include every count within the tolerance window, not just the rounded ratio.
    const pct = c.AMOUNT_TOL_PCT
    const floorTolerance = c.AMOUNT_TOL_MIN * 100
    const low = Math.max(2, Math.ceil(Math.min((cents - floorTolerance) / base, cents / (base * (1 + pct)))))
    const high = Math.min(c.MAX_EMI_MULTIPLE || 60, Math.floor(Math.max((cents + floorTolerance) / base, cents / (base * (1 - pct)))))
    for (let count = low; count <= high; count++) scales.push({ scale: count, freq: `${count} EMIs` })
    for (const { scale, freq } of scales) {
      const expected = Math.round(base * scale)
      const diff = cents - expected
      if (Math.abs(diff) > Math.round(tolerance(expected / 100, c) * 100)) continue
      possibilities.push({ kind: scale > 1 ? 'emi_multiple' : subset.length === 1 ? 'exact_single' : subset.length === list.length ? 'sum_all' : 'subset',
        loanNumbers: subset.map((l) => l.loanNumber), summedExpected: base / 100, diff: diff / 100, frequency: freq, emiCount: scale })
    }
    if (subset.length === 1 && Number.isFinite(subset[0].charges) && subset[0].charges > 0) {
      const charges = Math.round(subset[0].charges * 100)
      const k = Math.round((cents - charges) / base)
      if (k >= 1 && k <= (c.MAX_EMI_MULTIPLE || 60) && Math.abs(cents - base * k - charges) <= Math.round(tolerance(amt, c) * 100)) {
        possibilities.push({ kind: 'emi_with_charges', loanNumbers: [subset[0].loanNumber], summedExpected: base / 100,
          diff: (cents - base * k - charges) / 100, frequency: `${k} EMIs + charges`, emiCount: k })
      }
    }
  }
  possibilities.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || a.loanNumbers.length - b.loanNumbers.length || a.emiCount - b.emiCount)
  if (possibilities.length) return { ...possibilities[0], ambiguous: truncated || possibilities.length > 1, alternatives: possibilities.slice(0, 5) }
  const closest = list.map((l) => ({ l, diff: round2(amt - l.expectedEMI) })).sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff))[0]
  // A residual is evidence for review; never invent late fees or infer a schedule.
  return { kind: amt < closest.l.expectedEMI ? 'partial' : 'mismatch', loanNumbers: [closest.l.loanNumber], summedExpected: closest.l.expectedEMI,
    diff: closest.diff, ambiguous: list.length > 1, frequency: null, emiCount: null }
}
const reconciled = (r) => ['exact_single', 'sum_all', 'subset', 'emi_multiple', 'emi_with_charges'].includes(r.kind)

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
  const hints = c.signals?.useLoanNumberHint?.enabled !== false ? findLoanNumberHints(`${identity.full} ${tx.ReferenceNo || ''}`, index.groups) : []
  const referencedIds = c.signals?.useLoanNumberHint?.enabled !== false ? extractLoanIds(`${identity.full} ${tx.ReferenceNo || ''}`) : []
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
    else if (anonymousCash) confidence = reconciled(recon) ? 80 + (context.due ? 5 : 0) + (context.nearDue ? 3 : 0) + (context.pendingCount ? 3 : 0) : 0
    else if (cand.partialIdentity) confidence = cand.score + (reconciled(recon) ? 10 : 0) + (context.employer ? 5 : 0) + (context.history ? 10 : 0)
    else {
      // The score describes borrower identity. A partial credit cannot make
      // an otherwise strong person-name match disappear. Amount can add evidence.
      confidence = Math.max(cand.score, cand.score * c.NAME_WEIGHT + amountScore * c.AMOUNT_WEIGHT)
      // Exact full names retain identity evidence when the payment is partial.
      if (cand.nameKind === 'exact_full') confidence = Math.max(confidence, 98)
      confidence += (context.employer ? 3 : 0) + (context.history ? 5 : 0)
    }
    if (!cand.hintedLoanNumber) confidence = Math.min(confidence, 99)
    if (cand.partialIdentity || anonymousCash) confidence = Math.min(confidence, 91)
    return { cand, recon, context, confidence: round2(confidence) }
  }).filter((s) => anonymousCash ? reconciled(s.recon) : s.cand.score >= c.NAME_MIN)
    .sort((a, b) => b.confidence - a.confidence || b.cand.score - a.cand.score || a.cand.group.key.localeCompare(b.cand.group.key))
  if (!scored.length) return { record: { ...base, reasoning: '[different_person] No qualifying borrower candidate; cash credits require an active loan and a reconcilable EMI amount.' }, needsAi: false, candidates: [] }
  const best = scored[0], second = scored[1]
  const gap = second ? round2(best.confidence - second.confidence) : 100
  const ambiguous = conflictingReference || nameConflict || gap < Math.max(8, c.AMBIGUITY_GAP)
  const { cand, recon, context } = best
  const identityBlocked = ambiguous || unknownReference || !cand.group.borrowerId || !context.active || cand.partialIdentity || anonymousCash
  const allocationBlocked = recon.ambiguous || recon.kind === 'none' || recon.kind === 'mismatch'
  // A uniquely identified loan can receive a partial repayment. Multiple loans
  // or unexplained overpayments still need allocation review.
  const blocked = identityBlocked || allocationBlocked
  const confidence = identityBlocked ? Math.min(best.confidence, 91) : best.confidence
  const status = !blocked && confidence >= Math.max(92, c.AUTO_CONFIDENCE) && (cand.strongIdentity || cand.score >= Math.max(92, c.NAME_STRONG))
    ? 'auto_matched' : confidence >= 80 || ambiguous ? 'needs_review' : 'unmatched'
  const bucket = confidenceBucket(confidence)
  const reasons = [
    `${anonymousCash ? 'Cash deposit: amount identifies candidates, not a person' : cand.nameKind}; score ${confidence}; margin ${gap}`,
    `Candidates: ${scored.slice(0, 3).map((s) => `${s.cand.group.borrowerName} (${s.cand.group.borrowerId || 'missing ID'}): ${s.confidence}`).join('; ')}`,
    `${recon.kind}${recon.emiCount ? ` (${recon.emiCount} × base EMI)` : ''}; residual ${recon.diff ?? 'unknown'}`,
    ambiguous && 'Ambiguous or conflicting identities — manual review', unknownReference && 'Labelled loan reference not found — manual review',
    recon.ambiguous && 'Multiple possible loan allocations — manual review', allocationBlocked && 'Borrower identified; payment allocation requires review; no fees inferred',
    recon.kind === 'partial' && !allocationBlocked && 'Partial repayment against the uniquely identified loan',
    !context.active && 'Active loan status not established', cand.partialIdentity && 'Insufficient full name tokens to auto-identify a borrower',
    context.employer && 'Employer agrees', context.history && 'Previously confirmed name and employer agree', context.due && 'Current amount due agrees', context.pendingCount && 'Pending EMI count agrees',
  ].filter(Boolean).join('. ')
  const assigned = status !== 'unmatched'
  const record = { ...base, loanDiskBorrowerName: assigned ? cand.group.borrowerName : null, borrowerId: assigned ? cand.group.borrowerId : null,
    loanNumber: assigned && !recon.ambiguous ? recon.loanNumbers[0] || null : null,
    matchedLoanNumbers: assigned && !recon.ambiguous ? recon.loanNumbers : [], loanCount: assigned && !recon.ambiguous ? recon.loanNumbers.length : 0,
    expectedEmiAmount: recon.loanNumbers.length === 1 ? recon.summedExpected : null, summedExpectedEmi: recon.summedExpected, amountDiff: recon.diff,
    matchType: status === 'unmatched' ? 'unmatched' : cand.hintedLoanNumber ? 'loan_id' : anonymousCash ? 'cash_amount' : reconciled(recon) ? 'name_and_amount' : 'name_only',
    amountMatchKind: recon.kind, nameScore: cand.score, confidenceScore: confidence, confidenceBucket: bucket, reviewStatus: status,
    reasoning: formatReasoningWithBucket(bucket, reasons).slice(0, 1000),
    emiCount: status === 'auto_matched' ? recon.emiCount : null, candidateCount: scored.length,
  }
  return { record, needsAi: false, candidates: scored.slice(0, 8).map((s) => ({ ...s.cand, confidence: s.confidence })) }
}

/** User policy: a score strictly above 70 is matched; posting readiness is separate. */
export function matchStatusFor(confidence) {
  return Number(confidence) > 70 ? 'auto_matched' : 'unmatched'
}

export function classify(tx, index, c = runtimeConfig) {
  const result = classifyEvidence(tx, index, c)
  const original = result.record
  const status = matchStatusFor(original.confidenceScore)
  const ready = original.reviewStatus === 'auto_matched'
  const candidate = result.candidates[0]
  result.record = {
    ...original,
    reviewStatus: status,
    borrowerId: status === 'auto_matched' ? original.borrowerId || candidate?.group.borrowerId || null : null,
    loanDiskBorrowerName: status === 'auto_matched' ? original.loanDiskBorrowerName || candidate?.group.borrowerName || null : null,
    matchType: status === 'auto_matched' && !ready ? 'review_required' : original.matchType,
    emiCount: ready ? original.emiCount : null,
    reasoning: status === 'auto_matched' && !ready
      ? original.reasoning.replace(/^(\[[^\]]+\] )/, '$1Matched by >70% rule; review required before posting. ').slice(0, 1000)
      : original.reasoning,
  }
  return result
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
