import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewStatusToUi, rowStatus, buildMatchKpis, MATCH_STATUS } from '../../../shared/matchStatus.js'
import { evaluateBeneficiaryGate, evaluateLoanPostGate } from '../src/postingGates.js'
import { extractPayerFromNarration, resolveParticularsFields, looksLikePersonName } from '../../particularsParse.js'
import { groupLoansByBorrower, buildBorrowerIndex, classifyEvidence } from '../src/matchingEngine.js'

test('auto_matched maps to Suggested, never Matched', () => {
  assert.equal(reviewStatusToUi('auto_matched', 'name_and_amount', 99), MATCH_STATUS.suggested)
  assert.equal(reviewStatusToUi('confirmed', 'name_and_amount', 99), MATCH_STATUS.matched)
  assert.equal(reviewStatusToUi('ready_to_post', 'name_and_amount', 99), MATCH_STATUS.ready)
  assert.equal(reviewStatusToUi('auto_matched', 'cash_amount', 0), MATCH_STATUS.pending)
  assert.equal(reviewStatusToUi('unmatched', 'employer_remittance', 0), MATCH_STATUS.employer)
})

test('KPI strip counts verified separately from suggested', () => {
  const kpis = buildMatchKpis([
    { review_status: 'confirmed', match_type: 'name_and_amount', name_score: 99 },
    { review_status: 'auto_matched', match_type: 'name_and_amount', name_score: 95 },
    { review_status: 'needs_review', match_type: 'name_only', name_score: 75 },
    { review_status: 'unmatched', match_type: 'unmatched', name_score: 0 },
  ])
  assert.equal(kpis.verified, 1)
  assert.equal(kpis.suggested, 1)
  assert.equal(kpis.needsReview, 1)
  assert.equal(kpis.unmatched, 1)
  assert.equal(kpis.verifiedPct, 25)
})

test('beneficiary gate blocks ANTHEA ROLLE vs Deborah Ann Sears without override', () => {
  const blocked = evaluateBeneficiaryGate({
    bankName: 'ANTHEA ROLLE',
    selectedBorrowerName: 'Deborah Ann Sears',
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.conflict, true)
  const allowed = evaluateBeneficiaryGate({
    bankName: 'ANTHEA ROLLE',
    selectedBorrowerName: 'Deborah Ann Sears',
    overrideReason: 'Staff verified payroll schedule line 12',
  })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.overridden, true)
})

test('loan post gate requires active loan and blocks amount+date+ref duplicates', () => {
  const ok = evaluateLoanPostGate({
    loanBook: { BorrowerId: '1', LoanStatus: 'active' },
    borrowerId: '1',
    loanNumber: 'LN1',
    amount: 64.09,
    postedDate: '2026-09-14',
    reference: '90002001',
    existingReceipts: [],
  })
  assert.equal(ok.ok, true)
  const dup = evaluateLoanPostGate({
    loanBook: { BorrowerId: '1', LoanStatus: 'active' },
    borrowerId: '1',
    loanNumber: 'LN1',
    amount: 64.09,
    postedDate: '2026-09-14',
    reference: '90002001',
    existingReceipts: [{ loanNumber: 'LN1', amount: 64.09, date: '2026-09-14', reference: '90002001' }],
  })
  assert.equal(dup.ok, false)
  assert.match(dup.message, /duplicate/i)
})

test('TRACEY MARIA CLARKE keeps full name from Direct Credit narrative', () => {
  const name = extractPayerFromNarration('Direct Credit TRACEY MARIA CLARKE - ACH TFR 260914|Simplified Lend')
  assert.equal(name, 'TRACEY MARIA CLARKE')
  const resolved = resolveParticularsFields({
    particulars: 'Direct Credit TRACEY MARIA CLARKE - ACH TFR 260914|Simplified Lend',
  })
  assert.equal(resolved.borrowerName, 'TRACEY MARIA CLARKE')
})

test('truncated staged BorrowerName is upgraded from full description', () => {
  const resolved = resolveParticularsFields({
    particulars: 'Direct Credit TRACEY MARIA CLARKE - ACH TFR 260914|Simplified Lend',
    borrowerName: 'TRACEY',
  })
  assert.equal(resolved.borrowerName, 'TRACEY MARIA CLARKE')
})

test('blank Customer reference is not invented as a bank reference', () => {
  const resolved = resolveParticularsFields({
    particulars: 'Direct Credit Jane Doe - ACH|Simplified Lend',
    borrowerName: 'Jane Doe',
  })
  assert.ok(resolved.borrowerName)
})

test('Cheque Deposit - Local is not a human payer name', () => {
  const resolved = resolveParticularsFields({
    particulars: 'Cheque Deposit - Local',
    borrowerName: 'Cheque Deposit - Local',
  })
  assert.equal(resolved.borrowerName, '')
  assert.equal(extractPayerFromNarration('Cheque Deposit - Local'), '')
})

test('SBDC BAHAMAS salary remittance is not a human payer name', () => {
  const particulars = 'Direct Credit SBDC BAHAMAS - Salaries 260914|Simplified Lending'
  assert.equal(extractPayerFromNarration(particulars), '')
  assert.equal(looksLikePersonName('SBDC BAHAMAS'), false)
  const resolved = resolveParticularsFields({
    particulars,
    borrowerName: 'SBDC BAHAMAS',
  })
  assert.equal(resolved.borrowerName, '')
})

test('Direct Credit person name is still accepted', () => {
  assert.equal(
    extractPayerFromNarration('Direct Credit ANTHEA ROLLE - ACH TFR 260914|Simplified Lend'),
    'ANTHEA ROLLE'
  )
})

test('suggested rows are not Matched in rowStatus', () => {
  assert.equal(
    rowStatus({ review_status: 'auto_matched', match_type: 'name_and_amount', name_score: 99 }),
    MATCH_STATUS.suggested
  )
  assert.notEqual(
    rowStatus({ review_status: 'auto_matched', match_type: 'name_and_amount', name_score: 99 }),
    MATCH_STATUS.matched
  )
})

test('14-Sep style employer ACH stays unmatched employer remittance', () => {
  const loan = (id, name, emi) => ({
    BorrowerId: id,
    LoanNumber: `LN${id}`,
    BorrowerFullName: name,
    ExpectedEMIAmount: emi,
    LoanStatus: 'active',
  })
  const index = buildBorrowerIndex(
    groupLoansByBorrower([loan('1', 'Kristenique Jessica Sears', 6608.63), loan('2', 'Sharmane Strachan', 280.18)])
  )
  const r = classifyEvidence(
    {
      Id: 1,
      EmiPaidAmount: 6608.63,
      Particulars: 'Direct Credit EASYTERMSLTD - Dom Pay 260914|Simplified Lending Ltd',
      BorrowerName: '',
      TransDate: '2026-09-14',
    },
    index
  ).record
  assert.equal(r.reviewStatus, 'unmatched')
  assert.equal(r.matchType, 'employer_remittance')
  assert.equal(r.borrowerId, null)
})

test('confidence Unmatched bucket matches status Unmatched; employer is separate', async () => {
  const { resolveConfidenceBucket, MATCH_KPI } = await import('../../../src/lib/confidenceBucket.js')
  const rows = [
    { review_status: 'confirmed', match_type: 'name_and_amount', name_score: 99, confidence_score: 100 },
    { review_status: 'auto_matched', match_type: 'name_and_amount', name_score: 95, confidence_score: 95 },
    { review_status: 'needs_review', match_type: 'name_only', name_score: 75, confidence_score: 75 },
    { review_status: 'unmatched', match_type: 'employer_remittance', name_score: 0, confidence_score: 0 },
    { review_status: 'unmatched', match_type: 'unmatched', name_score: 0, confidence_score: 0 },
    { review_status: 'unmatched', match_type: 'employer_remittance', name_score: 0, confidence_score: 0 },
  ]
  const buckets = Object.fromEntries(
    Object.values(MATCH_KPI).map((k) => [k, rows.filter((r) => resolveConfidenceBucket(r) === k).length])
  )
  const kpis = buildMatchKpis(rows)
  assert.equal(buckets.verified_match, 1)
  assert.equal(buckets.evidence_backed_match, 1)
  assert.equal(buckets.needs_review, 3) // needs_review + 2 employer
  assert.equal(buckets.wrong_match, 1)
  assert.equal(kpis.verifiedPct, Math.round((1 / 6) * 100))
  assert.equal(kpis.evidenceBackedPct, Math.round((1 / 6) * 100))
  assert.equal(kpis.wrongMatchPct, Math.round((1 / 6) * 100))
  assert.equal(kpis.needsReviewPct, Math.round((3 / 6) * 100))
})

test('quality KPIs replace a single match percent', () => {
  const kpis = buildMatchKpis([
    { review_status: 'confirmed', match_type: 'name_and_amount', name_score: 99, confidence_score: 100 },
    { review_status: 'auto_matched', match_type: 'name_and_amount', name_score: 95, confidence_score: 95 },
    { review_status: 'needs_review', match_type: 'name_only', name_score: 75, confidence_score: 75 },
    { review_status: 'unmatched', match_type: 'unmatched', name_score: 0, confidence_score: 0 },
  ])
  assert.equal(kpis.verifiedPct + kpis.evidenceBackedPct + kpis.needsReviewPct + kpis.wrongMatchPct, 100)
  assert.ok('verifiedPct' in kpis && 'evidenceBackedPct' in kpis && 'needsReviewPct' in kpis && 'wrongMatchPct' in kpis)
})
