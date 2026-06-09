import { exportToExcel } from '@/lib/exportExcel'
import { formatDate } from '@/lib/utils'
import { getSlaBucket } from '@/lib/sla'

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

export function exportUnmatchedTransactions(rows, { exceptionByTxId = {}, borrowerById = {} } = {}) {
  return exportToExcel(
    rows,
    [
      { key: 'date', label: 'Date', value: (r) => formatDate(r.date) },
      { key: 'source_filename', label: 'Document', value: (r) => r.source_filename || '' },
      { key: 'payer', label: 'Payer', value: (r) => r.payer || '' },
      { key: 'amount', label: 'Amount', value: (r) => r.amount ?? '' },
      {
        key: 'type',
        label: 'Type',
        value: (r) => exceptionByTxId[r.id]?.type || 'unmatched',
      },
      {
        key: 'queue_status',
        label: 'Queue Status',
        value: (r) => exceptionByTxId[r.id]?.status || '',
      },
      {
        key: 'assigned_to',
        label: 'Assigned',
        value: (r) => exceptionByTxId[r.id]?.assigned_to || '',
      },
      {
        key: 'sla',
        label: 'SLA Status',
        value: (r) => {
          const ex = exceptionByTxId[r.id]
          return ex ? getSlaBucket(ex.created_at, ex.sla_hours).label : ''
        },
      },
      {
        key: 'confidence_score',
        label: 'Score',
        value: (r) => (r.confidence_score != null ? Math.round(r.confidence_score) : ''),
      },
      {
        key: 'suggested_borrower',
        label: 'Suggested borrower',
        value: (r) => (r.matched_borrower_id ? borrowerById[r.matched_borrower_id]?.full_name : '') || '',
      },
      { key: 'reference', label: 'Reference', value: (r) => r.reference || '' },
      { key: 'description', label: 'Description', value: (r) => r.description || '' },
    ],
    `unmatched-transactions-${today()}.xlsx`
  )
}
