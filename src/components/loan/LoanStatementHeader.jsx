import { Link } from 'react-router-dom'
import {
  CalendarClock,
  Hash,
  Landmark,
  Receipt,
  TrendingUp,
  Wallet,
} from 'lucide-react'
import { Badge } from '@/components/Badge'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { formatRepaymentSource } from '@/lib/loanStatementExport'

function AnalysisTile({ icon: Icon, label, value, sub, tone }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>
      </div>
      <p
        className={cn(
          'text-[15px] font-bold mono leading-tight',
          tone === 'success' && 'text-[var(--success)]',
          !tone && 'text-[var(--text-primary)]'
        )}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5">{sub}</p>}
    </div>
  )
}

function statusVariant(status) {
  const s = (status || '').toLowerCase()
  if (s.includes('current') || s.includes('active')) return 'on_track'
  if (s.includes('arrear') || s.includes('default') || s.includes('overdue')) return 'pending'
  return 'posted'
}

/** Loan book summary header — same fields as Repayments drawer. */
export function LoanStatementHeader({ loan, summary, compact, showStatementLink = true }) {
  if (!loan) return null

  return (
    <div className={cn('space-y-3', compact && 'space-y-2')}>
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-full bg-[var(--accent-subtle)] flex items-center justify-center shrink-0">
          <Landmark className="h-4 w-4 text-[var(--accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className={cn('font-semibold text-[var(--text-primary)] truncate', compact ? 'text-[13px]' : 'text-[15px]')}>
            {loan.BorrowerFullName || '—'}
          </h3>
          <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
            Loan <span className="mono font-medium">{loan.LoanNumber}</span>
            {loan.BorrowerId ? ` · ID ${loan.BorrowerId}` : ''}
            {loan.BranchName ? ` · ${loan.BranchName}` : ''}
          </p>
        </div>
        <Badge variant={statusVariant(loan.LoanStatus)}>{loan.LoanStatus || 'Active'}</Badge>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-2.5">
          <p className="text-[10px] text-[var(--text-tertiary)] uppercase">EMI</p>
          <p className="text-[14px] font-semibold mono mt-0.5">{formatCurrency(loan.ExpectedEMIAmount)}</p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-2.5">
          <p className="text-[10px] text-[var(--text-tertiary)] uppercase">Balance</p>
          <p className="text-[14px] font-semibold mono mt-0.5">{formatCurrency(loan.LoanBalanceAmount)}</p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-2.5">
          <p className="text-[10px] text-[var(--text-tertiary)] uppercase">Total paid</p>
          <p className="text-[14px] font-semibold mono mt-0.5">{formatCurrency(loan.TotalPaid)}</p>
        </div>
        <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-2.5">
          <p className="text-[10px] text-[var(--text-tertiary)] uppercase">Last EMI paid</p>
          <p className="text-[13px] font-semibold mt-0.5">{loan.EMILastPaidDate ? formatDate(loan.EMILastPaidDate) : '—'}</p>
        </div>
      </div>

      {summary && (
        <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-3')}>
          <AnalysisTile
            icon={Wallet}
            label="Total repaid"
            value={formatCurrency(summary.totalPaid)}
            sub={`${summary.paymentCount} payment${summary.paymentCount === 1 ? '' : 's'}`}
            tone="success"
          />
          <AnalysisTile
            icon={TrendingUp}
            label="Avg payment"
            value={formatCurrency(summary.averagePayment)}
          />
          <AnalysisTile
            icon={Receipt}
            label="Manual receipts"
            value={formatCurrency(summary.manualTotal)}
            sub={`${summary.manualCount} entries`}
          />
          <AnalysisTile
            icon={Hash}
            label="Synced payments"
            value={formatCurrency(summary.syncedTotal)}
            sub={`${summary.syncedCount} from LoanDisk`}
          />
          <AnalysisTile
            icon={CalendarClock}
            label="First payment"
            value={summary.firstPaymentDate ? formatDate(summary.firstPaymentDate) : '—'}
          />
          <AnalysisTile
            icon={CalendarClock}
            label="Last payment"
            value={summary.lastPaymentDate ? formatDate(summary.lastPaymentDate) : '—'}
          />
        </div>
      )}

      {summary && (summary.principalPaid > 0 || summary.interestPaid > 0) && (
        <div className="flex flex-wrap gap-4 text-[12px] text-[var(--text-secondary)]">
          <span>Principal repaid: <span className="mono font-medium">{formatCurrency(summary.principalPaid)}</span></span>
          <span>Interest repaid: <span className="mono font-medium">{formatCurrency(summary.interestPaid)}</span></span>
        </div>
      )}

      {!compact && showStatementLink && loan.LoanNumber && (
        <Link to={`/loans/${loan.LoanNumber}/statement`} className="text-[12px] text-[var(--accent)] hover:underline">
          Open full loan statement →
        </Link>
      )}
    </div>
  )
}

export function buildRepaymentColumns({ onDownload } = {}) {
  return [
    {
      key: 'date',
      label: 'Date',
      sortAccessor: (r) => r.date || '',
      filterAccessor: (r) => (r.date ? formatDate(r.date) : ''),
      render: (r) => <span className="text-[var(--text-secondary)]">{r.date ? formatDate(r.date) : '—'}</span>,
    },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      sortAccessor: (r) => Number(r.amount) || 0,
      filterAccessor: (r) => String(r.amount ?? ''),
      render: (r) => formatCurrency(r.amount),
    },
    {
      key: 'principalAmount',
      label: 'Principal',
      align: 'right',
      sortAccessor: (r) => Number(r.principalAmount) || 0,
      filterAccessor: (r) => String(r.principalAmount ?? ''),
      render: (r) => (r.principalAmount != null ? formatCurrency(r.principalAmount) : '—'),
    },
    {
      key: 'interestAmount',
      label: 'Interest',
      align: 'right',
      sortAccessor: (r) => Number(r.interestAmount) || 0,
      filterAccessor: (r) => String(r.interestAmount ?? ''),
      render: (r) => (r.interestAmount != null ? formatCurrency(r.interestAmount) : '—'),
    },
    {
      key: 'source',
      label: 'Source',
      sortAccessor: (r) => formatRepaymentSource(r),
      filterAccessor: (r) => formatRepaymentSource(r),
      render: (r) => (
        <Badge variant={r.source === 'manual' ? 'pending' : 'posted'}>{formatRepaymentSource(r)}</Badge>
      ),
    },
    {
      key: 'method',
      label: 'Method',
      sortAccessor: (r) => r.method || '',
      render: (r) => r.method || '—',
    },
    {
      key: 'particulars',
      label: 'Particulars',
      sortAccessor: (r) => r.particulars || r.description || '',
      render: (r) => (
        <span className="truncate max-w-[200px] inline-block" title={r.particulars || r.description}>
          {r.particulars || r.description || '—'}
        </span>
      ),
    },
    {
      key: 'enteredBy',
      label: 'Entered by',
      sortAccessor: (r) => r.enteredBy || '',
      render: (r) => r.enteredBy || '—',
    },
    ...(onDownload
      ? [
          {
            key: 'attachment',
            label: 'Receipt',
            sortable: false,
            filterable: false,
            render: (r) =>
              r.receiptDocumentId ? (
                <button
                  type="button"
                  className="text-[12px] text-[var(--accent)] hover:underline"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDownload(r)
                  }}
                >
                  Download
                </button>
              ) : (
                '—'
              ),
          },
        ]
      : []),
  ]
}
