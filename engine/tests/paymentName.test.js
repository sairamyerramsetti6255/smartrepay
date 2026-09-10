import test from 'node:test'
import assert from 'node:assert/strict'
import { stripPaymentNote } from '../src/bankName.js'
import { scoreNameMatch } from '../src/nameMatch.js'
import { groupLoansByBorrower, buildBorrowerIndex, classify } from '../src/matchingEngine.js'
const name = 'Wellington Antonio Johnson'
const index = buildBorrowerIndex(groupLoansByBorrower([{BorrowerId:'test',BorrowerFullName:name,LoanNumber:'TEST-1',ExpectedEMIAmount:350,LoanStatus:'active'}]))


test('first and last name match despite omitted middle name and payoff narration', () => {
  for (const input of ['Wellington Johnson', 'Wellington Johnson - paid off', 'Wellington Johnson – Paid Off', 'Wellington Johnson (paid off)', 'Wellington Johnson paid off', 'Wellington Johnson - paid in full']) {
    assert.equal(stripPaymentNote(input), 'Wellington Johnson')
    assert.ok(scoreNameMatch(input,name).score > 70)
    for (const row of [{BorrowerName:input,Particulars:`Direct Credit Employer - Salary | ${input}`}, {Particulars:input}]) {
      const r=classify({Id:1,EmiPaidAmount:350,...row},index).record
      assert.equal(r.borrowerId,'test'); assert.equal(r.reviewStatus,'auto_matched')
    }
  }
})
test('payment-note cleanup preserves hyphenated surnames and identity distinctions', () => {
  assert.equal(stripPaymentNote('Latoya Mason-Cash - paid off'),'Latoya Mason-Cash')
  assert.equal(stripPaymentNote('Wellington Johnson - Michael Smith'),'Wellington Johnson - Michael Smith')
})

