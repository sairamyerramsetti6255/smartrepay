import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSmartRepayImportRows } from '../qbService.js'

const row = (over) => ({
  review_status: 'auto_matched',
  matched_borrower_id: '1',
  loan_number: 'LN1',
  amount: 301.29,
  posting_safety: { ok: false },
  ...over,
})

test('SmartRepay import keeps matched receipts and drops review-only rows', () => {
  const picked = selectSmartRepayImportRows([
    row({ review_status: 'auto_matched' }),
    row({ review_status: 'confirmed' }),
    row({ review_status: 'ready_to_post', posting_safety: { ok: true } }),
    row({ review_status: 'posted' }),
    row({ review_status: null, status: 'matched' }),
    row({ review_status: 'needs_review', status: 'ready' }),
    row({ review_status: 'needs_review' }),
    row({ review_status: 'unmatched' }),
    row({ matched_borrower_id: null }),
    row({ loan_number: null }),
    row({ amount: 0 }),
  ])
  assert.deepEqual(picked.map((t) => t.review_status), ['auto_matched', 'confirmed', 'ready_to_post', 'posted', null, 'auto_matched'])
})
