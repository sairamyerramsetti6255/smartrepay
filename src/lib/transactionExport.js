import { exportToExcel } from '@/lib/exportExcel'
import { formatDate } from '@/lib/utils'

const today = () => new Date().toISOString().slice(0, 10)

export function exportMatchedTransactions(rows, borrowerById = {}) {
  return exportToExcel(
    rows,
    [
      { key: 'date', label: 'Date', value: (r) => formatDate(r.date) },
      { key: 'source_filename', label: 'Document', value: (r) => r.source_filename || '' },
      { key: 'payer', label: 'Payer', value: (r) => r.payer || '' },
      { key: 'amount', label: 'Amount', value: (r) => r.amount ?? '' },
      { key: 'status', label: 'Status', value: (r) => r.status || '' },
      {
        key: 'confidence_score',
        label: 'Score',
        value: (r) => (r.confidence_score != null ? Math.round(r.confidence_score) : ''),
      },
      {
        key: 'matched_borrower',
        label: 'Matched to',
        value: (r) => (r.matched_borrower_id ? borrowerById[r.matched_borrower_id]?.full_name : '') || '',
      },
      { key: 'reference', label: 'Reference', value: (r) => r.reference || '' },
      { key: 'description', label: 'Description', value: (r) => r.description || '' },
    ],
    `matched-transactions-${today()}.xlsx`
  )
}

const STATUS_LABEL = {
  matched: 'Matched',
  posted: 'Posted',
  pending: 'Pending',
  exception: 'Unmatched',
}

/** All matched + unmatched rows in a single sheet, each tagged with its status. */
export function exportAllTransactions(rows, borrowerById = {}) {
  return exportToExcel(
    rows,
    [
      { key: 'date', label: 'Date', value: (r) => formatDate(r.date) },
      {
        key: 'status',
        label: 'Status',
        value: (r) => STATUS_LABEL[r.status] || r.status || '',
      },
      { key: 'payer', label: 'Payer', value: (r) => r.payer || '' },
      { key: 'amount', label: 'Amount', value: (r) => r.amount ?? '' },
      {
        key: 'matched_borrower',
        label: 'Matched / Suggested borrower',
        value: (r) =>
          r.matched_borrower_name ||
          (r.matched_borrower_id ? borrowerById[r.matched_borrower_id]?.full_name : '') ||
          '',
      },
      {
        key: 'loandisk_id',
        label: 'LoanDisk ID',
        value: (r) =>
          r.borrower_loandisk_id ||
          (r.matched_borrower_id ? borrowerById[r.matched_borrower_id]?.loandisk_id : '') ||
          '',
      },
      {
        key: 'confidence_score',
        label: 'Score',
        value: (r) => (r.confidence_score != null ? Math.round(r.confidence_score) : ''),
      },
      { key: 'source_filename', label: 'Document', value: (r) => r.source_filename || '' },
      { key: 'reference', label: 'Reference', value: (r) => r.reference || '' },
      { key: 'description', label: 'Description', value: (r) => r.description || '' },
    ],
    `all-transactions-${today()}.xlsx`
  )
}

/** Unmatched / needs-review rows straight from the SQL match results. */
export function exportUnmatchedTransactions(rows) {
  return exportToExcel(
    rows,
    [
      { key: 'date', label: 'Date', value: (r) => formatDate(r.date) },
      { key: 'source_filename', label: 'Document', value: (r) => r.source_filename || '' },
      { key: 'payer', label: 'Payer', value: (r) => r.payer || '' },
      { key: 'amount', label: 'Amount', value: (r) => r.amount ?? '' },
      {
        key: 'status',
        label: 'Status',
        value: (r) => STATUS_LABEL[r.status] || r.status || '',
      },
      {
        key: 'confidence_score',
        label: 'Score',
        value: (r) => (r.confidence_score != null ? Math.round(r.confidence_score) : ''),
      },
      {
        key: 'suggested_borrower',
        label: 'Suggested borrower',
        value: (r) => r.matched_borrower_name || '',
      },
      {
        key: 'loandisk_id',
        label: 'LoanDisk ID',
        value: (r) => r.borrower_loandisk_id || '',
      },
      { key: 'reference', label: 'Reference', value: (r) => r.reference || '' },
      { key: 'description', label: 'Description', value: (r) => r.description || '' },
    ],
    `unmatched-transactions-${today()}.xlsx`
  )
}
