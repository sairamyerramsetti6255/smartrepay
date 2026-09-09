import { exportToExcel } from '@/lib/exportExcel'
import { formatDate } from '@/lib/utils'

export function formatRepaymentSource(r) {
  return r?.source === 'manual' ? 'Manual' : 'LoanDisk'
}

export function exportLoanStatement(repayments, loanNumber) {
  const ln = String(loanNumber || 'loan').replace(/[^\w-]+/g, '_')
  return exportToExcel(
    repayments,
    [
      { key: 'date', label: 'Date', value: (r) => (r.date ? formatDate(r.date) : '') },
      { key: 'amount', label: 'Amount', value: (r) => r.amount ?? '' },
      { key: 'principalAmount', label: 'Principal', value: (r) => r.principalAmount ?? '' },
      { key: 'interestAmount', label: 'Interest', value: (r) => r.interestAmount ?? '' },
      { key: 'source', label: 'Source', value: (r) => formatRepaymentSource(r) },
      { key: 'method', label: 'Method', value: (r) => r.method ?? '' },
      { key: 'particulars', label: 'Particulars', value: (r) => r.particulars || r.description || '' },
      { key: 'enteredBy', label: 'Entered by', value: (r) => r.enteredBy ?? '' },
    ],
    `loan-statement-${ln}.xlsx`
  )
}
