import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEngineConfig, previewMatchSample, extractIdsWithPatterns } from '../../matchingRules.js'
import { groupLoansByBorrower, buildBorrowerIndex, classifyEvidence as classify, classify as classifyWithPolicy, matchStatusFor, reconcileAmount, applyAi, getMatchingEngineConfig, setMatchingEngineConfig } from '../src/matchingEngine.js'
import { extractLoanIds, identityNameScore } from '../src/borrowerIdentity.js'
import { isCompanyName } from '../../particularsParse.js'
const loan = (id, name, emi, extra = {}) => ({ BorrowerId: id, LoanNumber: `LN${id}`, BorrowerFullName: name, ExpectedEMIAmount: emi, LoanStatus: 'active', ...extra })
const tx = (name, amount = 350, extra = {}) => ({ Id: 1000, BorrowerName: name, Particulars: `Direct Credit BWAP - Salaries 260508|${name}`, EmiPaidAmount: amount, TransDate: '2026-05-08', ...extra })
const resolve = (transaction, loans, history = [], config = buildEngineConfig()) => classify(transaction, buildBorrowerIndex(groupLoansByBorrower(loans), history), config).record
const master = [loan('1', 'Michael Bowe', 350), loan('2', 'Christian Johnson', 425), loan('3', 'Latoya Mason-Cash', 280)]

test('exact full name and active EMI auto-match', () => {
  const r = resolve(tx('Michael Bowe'), master)
  assert.equal(r.reviewStatus, 'auto_matched'); assert.equal(r.borrowerId, '1'); assert.equal(r.loanNumber, 'LN1')
})
test('surname first compound name, punctuation, suffixes, accents, fused names', () => {
  for (const [input, name] of [['MASON-CASH, LATOYA', 'Latoya Mason-Cash'], ["LA MARA BURROWS", "LA’MARA BURROWS"], ['LAMARA BURROWS', "LA'MARA BURROWS"], ['derek walter dames, jr', 'Derek Walter Dames'], ['Jose Garcia', 'José García'], ['MichaelBowe', 'Michael Bowe']]) {
    assert.equal(resolve(tx(input), [loan('1', name, 350)]).reviewStatus, 'auto_matched', input)
  }
})
test('candidate retrieval finds typos in both tokens', () => {
  const r = resolve(tx('Micheal Bowee'), master)
  assert.equal(r.borrowerId, '1'); assert.ok(r.confidenceScore >= 80)
})
test('shared and unique single names remain review suggestions', () => {
  for (const name of ['Michael', 'Bowe']) {
    const r = resolve(tx(name), master)
    assert.equal(r.reviewStatus, 'needs_review'); assert.equal(r.borrowerId, '1')
  }
  const r = resolve(tx('Johnson', 425), [loan('1', 'Christian Johnson', 425), loan('2', 'Kristian Johnson', 425)])
  assert.equal(r.reviewStatus, 'needs_review'); assert.match(r.reasoning, /Ambiguous/)
})
test('initials are not promoted by amount', () => assert.equal(resolve(tx('M Bowe'), master).reviewStatus, 'needs_review'))
test('close names require an eight point margin, regardless of amount tie breakers', () => {
  const r = resolve(tx('Kristian Johnson', 350), [loan('1', 'Kristian Johnson', 350), loan('2', 'Christian Johnson', 350)])
  assert.notEqual(r.reviewStatus, 'auto_matched'); assert.match(r.reasoning, /Candidates/)
})
test('duplicate exact names never first-row win', () => {
  const loans = [loan('1', 'Michael Bowe', 350), loan('2', 'Michael Bowe', 350)]
  assert.equal(resolve(tx('Michael Bowe'), loans).reviewStatus, 'needs_review')
  assert.equal(resolve(tx('Michael Bowe'), loans.reverse()).reviewStatus, 'needs_review')
})
test('labelled loan IDs have exact priority; no salary batches or substring IDs', () => {
  assert.deepEqual(extractLoanIds('Salaries 260508'), [])
  const r = resolve(tx('', 350, { Particulars: 'Simplified Lending Limited, Top Up 4966' }), [loan('1', 'Michael Bowe', 350, { LoanNumber: '4966' })])
  assert.equal(r.reviewStatus, 'auto_matched'); assert.equal(r.matchType, 'loan_id'); assert.equal(r.confidenceScore, 100)
  assert.equal(resolve(tx('', 350, { Particulars: 'Loan 149660' }), [loan('1', 'Michael Bowe', 350, { LoanNumber: '4966' })]).reviewStatus, 'unmatched')
  assert.equal(resolve(tx('Michael Bowe', 350, { ReferenceNo: 'Loan 99999' }), master).reviewStatus, 'needs_review')
})
test('conflicting loan and full name, multiple references require review', () => {
  assert.equal(resolve(tx('Michael Bowe', 425, { ReferenceNo: 'Loan LN2' }), master).reviewStatus, 'needs_review')
  assert.equal(resolve(tx('', 350, { ReferenceNo: 'Loan LN1; Loan LN2' }), master).reviewStatus, 'needs_review')
})
test('company variants excluded; cash deposits find EMI candidates', () => {
  for (const value of ['SIMPLIFIED-LEND', 'Simplified Lean', 'SIMPLIFIED LENDING LTD', 'Simplified-Lending']) assert.equal(isCompanyName(value), true)
  for (const particulars of ['Cash Deposit In Branch', 'Direct Credit AdvantageBusine - Loans 260508|Simplified-Lend']) {
    const r = resolve(tx('', 350, { Particulars: particulars }), master)
    assert.equal(r.reviewStatus, 'needs_review'); assert.equal(r.borrowerId, '1'); assert.equal(r.matchType, 'cash_amount')
  }
})
test('anonymous amount cannot distinguish one EMI from two smaller EMIs', () => {
  const r = resolve(tx('', 700, { Particulars: 'Cash Deposit In Branch' }), [loan('1', 'Michael Bowe', 350), loan('2', 'John Smith', 700)])
  assert.equal(r.reviewStatus, 'needs_review'); assert.equal(r.candidateCount, 2); assert.match(r.reasoning, /Ambiguous/)
})
test('multiple EMIs supported after borrower identity established', () => {
  for (const count of [2, 3, 12]) {
    const r = resolve(tx('Michael Bowe', 350 * count), master)
    assert.equal(r.reviewStatus, 'auto_matched'); assert.equal(r.amountMatchKind, 'emi_multiple'); assert.equal(r.emiCount, count); assert.equal(r.amountDiff, 0)
  }
})
test('multiple loans and allocation ambiguity', () => {
  const loans = [loan('1', 'Michael Bowe', 350), loan('1', 'Michael Bowe', 700, { LoanNumber: 'LN9' })]
  const r = resolve(tx('Michael Bowe', 700), loans)
  assert.equal(r.reviewStatus, 'needs_review'); assert.equal(r.loanNumber, null); assert.deepEqual(r.matchedLoanNumbers, [])
  const sum = resolve(tx('Michael Bowe', 550), [loan('1', 'Michael Bowe', 350), loan('1', 'Michael Bowe', 200, { LoanNumber: 'LN9' })])
  assert.equal(sum.reviewStatus, 'auto_matched'); assert.equal(sum.loanCount, 2)
})
test('partial repayment matches a unique loan; unexplained excess requires review', () => {
  assert.equal(resolve(tx('Michael Bowe', 100), master).reviewStatus, 'auto_matched')
  for (const amt of [359, 410]) assert.equal(resolve(tx('Michael Bowe', amt), master).reviewStatus, 'needs_review')
})
test('only explicit master charges explain EMI plus fees', () => {
  const r = resolve(tx('Michael Bowe', 360), [loan('1', 'Michael Bowe', 350, { ChargesDue: 10 })])
  assert.equal(r.reviewStatus, 'auto_matched'); assert.equal(r.amountMatchKind, 'emi_with_charges')
})
test('zero, negative and non-finite credits never match', () => {
  for (const amount of [0, -350, NaN, Infinity, '', null]) assert.equal(resolve(tx('Michael Bowe', amount), master).reviewStatus, 'unmatched')
})
test('closed or unknown loan status cannot auto-post; excluded for anonymous cash', () => {
  for (const status of ['closed', '', null, 'settled']) {
    const loans = [loan('1', 'Michael Bowe', 350, { LoanStatus: status })]
    assert.equal(resolve(tx('Michael Bowe'), loans).reviewStatus, 'needs_review')
    assert.equal(resolve(tx('', 350, { Particulars: 'Cash Deposit In Branch' }), loans).reviewStatus, 'unmatched')
  }
})
test('aliases participate in retrieval; missing IDs do not merge people', () => {
  assert.equal(resolve(tx('Liz Smith'), [loan('1', 'Elizabeth Smith', 350, { Aliases: '["Liz Smith"]' })]).reviewStatus, 'auto_matched')
  const groups = groupLoansByBorrower([loan(null, 'Michael Bowe', 350), loan(null, 'Michael Bowe', 700)])
  assert.equal(groups.size, 2)
  assert.equal(resolve(tx('Michael Bowe'), [loan(null, 'Michael Bowe', 350)]).reviewStatus, 'needs_review')
})
test('confirmed history is source scoped, excludes current row and conflicting mappings', () => {
  const loans = [loan('1', 'Michael Bowe', 350)]
  const historyRow = { ...tx('M Bowe'), Id: 99, BorrowerId: '1', ReviewStatus: 'confirmed' }
  const r = resolve(tx('M Bowe'), loans, [historyRow])
  assert.match(r.reasoning, /Previously confirmed/)
  for (const history of [[{ ...historyRow, Id: 1000 }], [{ ...historyRow, ReviewStatus: 'auto_matched' }], [historyRow, { ...historyRow, Id: 98, BorrowerId: '2' }]]) {
    assert.doesNotMatch(resolve(tx('M Bowe'), loans, history).reasoning, /Previously confirmed/)
  }
})
test('AI cannot invent loan numbers or auto-post', () => {
  const index = buildBorrowerIndex(groupLoansByBorrower(master))
  const { candidates } = classify(tx('Michael Bowe'), index)
  const result = applyAi(tx('Michael Bowe'), candidates, { confidence: 100, matchedBorrowerId: '999', matchedLoanNumbers: ['FAKE'] })
  assert.notEqual(result.reviewStatus, 'auto_matched'); assert.ok(!result.matchedLoanNumbers.includes('FAKE'))
})
test('preview does not overwrite runtime configuration', async () => {
  const original = buildEngineConfig({ thresholds: { autoMatchConfidence: 97 } })
  setMatchingEngineConfig(original)
  await previewMatchSample({ payerName: 'Michael Bowe', borrowerName: 'Michael Bowe', amount: 350 })
  assert.equal(getMatchingEngineConfig(), original)
  setMatchingEngineConfig(buildEngineConfig())
})
test('currency precision and bounded allocation search', () => {
  const r = reconcileAmount(207.49 * 3, [{ loanNumber: '1', expectedEMI: 207.49 }])
  assert.equal(r.diff, 0); assert.equal(r.emiCount, 3)
  assert.equal(reconcileAmount(100, Array.from({ length: 13 }, (_, i) => ({ loanNumber: `${i}`, expectedEMI: 100 + i }))).ambiguous, true)
})
test('all candidate scores are considered before trimming the UI list', () => {
  const loans = Array.from({ length: 20 }, (_, i) => loan(String(i + 1), 'Michael Bowe', 350))
  const r = resolve(tx('Michael Bowe'), loans)
  assert.equal(r.candidateCount, 20); assert.equal(r.reviewStatus, 'needs_review')
})
test('disabled name signals cannot silently use employer description as a borrower', () => {
  const config = buildEngineConfig({ signals: { useBorrowerName: { enabled: false }, useDescription: { enabled: false } } })
  assert.equal(resolve(tx('Michael Bowe'), master, [], config).reviewStatus, 'unmatched')
})
test('legacy settings cannot lower the identity threshold or ambiguity margin', () => {
  const c = buildEngineConfig({ thresholds: { autoMatchConfidence: 10, ambiguityConfidenceGap: 1 } })
  assert.equal(c.AUTO_CONFIDENCE, 92); assert.equal(c.AMBIGUITY_GAP, 8)
})
test('multiple custom regex captures work without caller specifying global flag', () => {
  assert.deepEqual(extractIdsWithPatterns('ID123 ID456', [{ active: true, pattern: 'ID(\\d+)', flags: 'i' }]), ['123', '456'])
})
test('amount tolerance applies to the full payment in cents', () => {
  const c = buildEngineConfig({ thresholds: { amountTolerancePercent: 0 } })
  assert.equal(reconcileAmount(701.50, [{loanNumber: '1', expectedEMI: '350'}], c).kind, 'emi_multiple')
  assert.equal(reconcileAmount(701.51, [{loanNumber: '1', expectedEMI: 350}], c).kind, 'mismatch')
})
test('current due context is optional; lifetime TotalDue is not used as arrears', () => {
  const t = tx('', 700, {Particulars: 'Cash Deposit In Branch'})
  const r = resolve(t, [loan('1', 'Michael Bowe', 350, {TotalAmountDue: 700, PendingEMICount: 2, NextDueDate: '2026-05-08'})])
  assert.equal(r.reviewStatus, 'needs_review'); assert.match(r.reasoning, /Pending EMI count agrees/)
  assert.doesNotMatch(resolve(t, [loan('1', 'Michael Bowe', 350, {TotalDue: 700})]).reasoning, /Current amount due agrees/)
})

test('large payment counts with overlapping tolerance require allocation review', () => {
  const r = resolve(tx('Michael Bowe', 350 * 60), master)
  assert.equal(r.reviewStatus, 'needs_review'); assert.match(r.reasoning, /Multiple possible loan allocations/)
  const strict = buildEngineConfig({ thresholds: { amountTolerancePercent: 0 } })
  assert.equal(resolve(tx('Michael Bowe', 350 * 60), master, [], strict).emiCount, 60)
})

// Regressions reproduced from the July bank statement (synthetic identities).
test('quarter and half EMI payroll credits reconcile without losing identity', () => {
  for (const [paid, expected, fraction] of [[152.8,611.17,0.25],[210.54,421.03,0.5]]) {
    const r=resolve(tx('Martha Jane Smith',paid),[loan('1','Martha Jane Smith',expected)])
    assert.equal(r.reviewStatus,'auto_matched'); assert.equal(r.emiCount,fraction)
  }
})
test('middle initials and a truncated surname with two full names remain strong', () => {
  for (const [input, name] of [['Martha J Smith','Martha Jane Smith'],['Martha Jane S','Martha Jane Smith']]) {
    const r=resolve(tx(input,210.54),[loan('1',name,421.03)])
    assert.equal(r.reviewStatus,'auto_matched'); assert.ok(r.nameScore>=92)
  }
  assert.equal(resolve(tx('M Smith'),[loan('1','Martha Jane Smith',350)]).reviewStatus,'needs_review')
})
test('missing middle name and unexpected payment retain strong identity for review', () => {
  const r=resolve(tx('Martha Smith',402.45),[loan('1','Martha Jane Smith',222.99)])
  assert.equal(r.borrowerId,'1'); assert.ok(r.confidenceScore>=92); assert.equal(r.reviewStatus,'needs_review')
})
test('duplicate loan rows never erase a clear borrower or silently pick a loan', () => {
  const r=resolve(tx('Martha Jane Smith',208.69),[loan('1','Martha Jane Smith',834.75),loan('1','Martha Jane Smith',834.75,{LoanNumber:'LN99'})])
  assert.equal(r.borrowerId,'1'); assert.ok(r.confidenceScore>=98); assert.equal(r.reviewStatus,'needs_review'); assert.equal(r.loanNumber,null)
})
test('three-token truncated compound surname is a candidate, not a missing person', () => {
  assert.equal(resolve(tx('Martha Jane Smith',100),[loan('1','Martha Jane Smith Taylor II',350)]).reviewStatus,'auto_matched')
  assert.notEqual(resolve(tx('Martha Jane',100),[loan('1','Martha Jane Smith Taylor II',350)]).reviewStatus,'auto_matched')
})
test('legacy human confirmations can supply history; automatic guesses cannot', () => {
  const h={...tx('M Bowe'),Id:99,BorrowerId:'1',ReviewStatus:'auto_matched',MatchMethod:'manual'}
  assert.match(resolve(tx('M Bowe'),master,[h]).reasoning,/Previously confirmed/)
  assert.doesNotMatch(resolve(tx('M Bowe'),master,[{...h,MatchMethod:'deterministic'}]).reasoning,/Previously confirmed/)
})
test('different installment ratios on different loans still require review', () => {
  const r=resolve(tx('Martha Jane Smith',193.70),[loan('1','Martha Jane Smith',96.72),loan('1','Martha Jane Smith',387.39,{LoanNumber:'LN99'})])
  assert.equal(r.reviewStatus,'needs_review');assert.equal(r.loanNumber,null)
})

test('requested matching cutoff is strictly above seventy', () => {
  assert.equal(matchStatusFor(70),'unmatched')
  assert.equal(matchStatusFor(70.01),'auto_matched')
  assert.equal(matchStatusFor(71),'auto_matched')
  assert.equal(matchStatusFor(0),'unmatched')
})
test('above-seventy review candidates are matched but cannot bypass posting review', () => {
  const index=buildBorrowerIndex(groupLoansByBorrower([loan('1','Michael Bowe',350),loan('2','Michael Smith',350)]))
  const r=classifyWithPolicy(tx('Michael'),index).record
  assert.ok(r.confidenceScore>70)
  assert.equal(r.reviewStatus,'auto_matched')
  assert.equal(r.matchType,'review_required')
  assert.equal(r.emiCount,null)
})
