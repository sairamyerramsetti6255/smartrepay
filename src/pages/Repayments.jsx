import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import {
  RefreshCw,
  Search,
  Landmark,
  CreditCard,
  Wallet,
  Layers,
  Receipt,
  Download,
  TrendingUp,
  CalendarClock,
  Hash,
} from 'lucide-react'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { DataTable } from '@/components/DataTable'
import { Drawer } from '@/components/Drawer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/Badge'
import { PageLoader } from '@/components/PageLoader'
import { formatCurrency, formatDate, cn } from '@/lib/utils'

function statusVariant(status) {
  const s = (status || '').toLowerCase()
  if (s.includes('current') || s.includes('active') || s.includes('on track')) return 'on_track'
  if (s.includes('arrear') || s.includes('default') || s.includes('overdue') || s.includes('past')) return 'pending'
  return 'posted'
}

function StatCard({ icon: Icon, label, value, accent }) {
  return (
    <div className="card px-4 py-3.5 flex items-center gap-3">
      <div
        className={cn(
          'h-10 w-10 rounded-[var(--radius-md)] flex items-center justify-center shrink-0',
          accent || 'bg-[var(--accent-subtle)]'
        )}
      >
        <Icon className="h-5 w-5 text-[var(--accent)]" strokeWidth={1.75} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-tertiary)]">{label}</p>
        <p className="text-[18px] font-semibold text-[var(--text-primary)] mono leading-tight mt-0.5 truncate">{value}</p>
      </div>
    </div>
  )
}

function AnalysisTile({ icon: Icon, label, value, sub, tone }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3.5 py-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="h-3.5 w-3.5 text-[var(--accent)]" strokeWidth={1.75} />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>
      </div>
      <p
        className={cn(
          'text-[17px] font-bold mono leading-tight',
          tone === 'success' && 'text-[var(--success)]',
          tone === 'warn' && 'text-[var(--warning)]',
          !tone && 'text-[var(--text-primary)]'
        )}
      >
        {value}
      </p>
      {sub && <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{sub}</p>}
    </div>
  )
}

function DetailRow({ label, value, mono }) {
  if (value == null || value === '') return null
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-[var(--border-light)] text-[13px] last:border-0">
      <span className="text-[var(--text-tertiary)] shrink-0">{label}</span>
      <span className={mono ? 'mono text-right text-[var(--text-primary)]' : 'text-right text-[var(--text-primary)]'}>
        {value}
      </span>
    </div>
  )
}

export function Repayments() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  const [detailLoan, setDetailLoan] = useState(null)
  const [repayments, setRepayments] = useState([])
  const [repaySummary, setRepaySummary] = useState(null)
  const [loadingRepay, setLoadingRepay] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const { rows } = await api.activeLoans.list()
      setRows(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setError(e.message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function openLoan(loan) {
    setDetailLoan(loan)
    setRepayments([])
    setRepaySummary(null)
    setLoadingRepay(true)
    try {
      const { rows, summary } = await api.loans.repayments(loan.LoanNumber)
      setRepayments(Array.isArray(rows) ? rows : [])
      setRepaySummary(summary || null)
    } catch (e) {
      toast.error(e.message)
      setRepayments([])
    } finally {
      setLoadingRepay(false)
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (r) =>
        r.BorrowerFullName?.toLowerCase().includes(q) ||
        r.LoanNumber?.toString().toLowerCase().includes(q) ||
        r.BorrowerId?.toString().toLowerCase().includes(q) ||
        r.BranchName?.toLowerCase().includes(q)
    )
  }, [rows, search])

  const stats = useMemo(() => {
    const borrowers = new Set(rows.map((r) => r.BorrowerId || r.BorrowerFullName)).size
    const totalEmi = rows.reduce((s, r) => s + (Number(r.ExpectedEMIAmount) || 0), 0)
    const totalPaid = rows.reduce((s, r) => s + (Number(r.TotalPaid) || 0), 0)
    return { count: rows.length, borrowers, totalEmi, totalPaid }
  }, [rows])

  const columns = [
    {
      key: 'LoanNumber',
      label: 'Loan #',
      render: (r) => <span className="mono text-[12px] font-medium">{r.LoanNumber || '—'}</span>,
    },
    {
      key: 'BorrowerFullName',
      label: 'Borrower',
      render: (r) => (
        <div className="min-w-0">
          <p className="font-medium text-[var(--text-primary)] truncate">{r.BorrowerFullName || '—'}</p>
          {r.BorrowerId && <p className="text-[11px] text-[var(--text-tertiary)] mono">ID {r.BorrowerId}</p>}
        </div>
      ),
    },
    { key: 'BranchName', label: 'Branch', render: (r) => r.BranchName || '—' },
    {
      key: 'ExpectedEMIAmount',
      label: 'EMI',
      align: 'right',
      render: (r) => (r.ExpectedEMIAmount != null ? formatCurrency(r.ExpectedEMIAmount) : '—'),
    },
    {
      key: 'TotalPaid',
      label: 'Total paid',
      align: 'right',
      render: (r) => (r.TotalPaid != null ? formatCurrency(r.TotalPaid) : '—'),
    },
    {
      key: 'LoanBalanceAmount',
      label: 'Balance',
      align: 'right',
      render: (r) => (r.LoanBalanceAmount != null ? formatCurrency(r.LoanBalanceAmount) : '—'),
    },
    {
      key: 'LoanStatus',
      label: 'Status',
      render: (r) => <Badge variant={statusVariant(r.LoanStatus)}>{r.LoanStatus || 'Active'}</Badge>,
    },
    {
      key: 'view',
      label: '',
      align: 'right',
      render: () => <span className="text-[12px] font-medium text-[var(--accent)]">View repayments →</span>,
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Repayments"
        subtitle="Pick a loan to see its full repayment ledger — synced LoanDisk payments plus manual receipts — with a detailed analysis."
        actions={
          <Button variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Layers} label="Loans" value={stats.count.toLocaleString()} />
        <StatCard icon={CreditCard} label="Total EMI" value={formatCurrency(stats.totalEmi)} accent="bg-[var(--success-bg)]" />
        <StatCard icon={Wallet} label="Total repaid" value={formatCurrency(stats.totalPaid)} />
        <StatCard icon={Receipt} label="Borrowers" value={stats.borrowers.toLocaleString()} accent="bg-[var(--warning-bg)]" />
      </div>

      <div className="relative max-w-[360px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" />
        <Input
          placeholder="Search borrower, loan #, branch…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-5 py-3.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader label="Loading loans…" />
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          pageSize={25}
          onRowClick={openLoan}
          sortable
          filterable
          emptyMessage="No loans found"
          emptyDescription="Run the LoanDisk sync to populate the loan book."
        />
      )}

      <Drawer
        open={!!detailLoan}
        onClose={() => setDetailLoan(null)}
        title="Loan Repayments"
        subtitle={detailLoan ? `Loan ${detailLoan.LoanNumber}` : undefined}
        width={680}
      >
        {detailLoan && (
          <div className="space-y-6">
            {/* Borrower header */}
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-full bg-[var(--accent-subtle)] flex items-center justify-center shrink-0">
                <Landmark className="h-5 w-5 text-[var(--accent)]" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">
                  {detailLoan.BorrowerFullName || '—'}
                </h3>
                <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                  {[detailLoan.BranchName, detailLoan.BorrowerId && `ID ${detailLoan.BorrowerId}`]
                    .filter(Boolean)
                    .join(' · ') || '—'}
                </p>
              </div>
              <Badge variant={statusVariant(detailLoan.LoanStatus)}>{detailLoan.LoanStatus || 'Active'}</Badge>
            </div>

            {/* Loan facts */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-3">
                <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wide">EMI</p>
                <p className="text-[18px] font-semibold mono mt-1">{formatCurrency(detailLoan.ExpectedEMIAmount)}</p>
              </div>
              <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-3">
                <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wide">Balance</p>
                <p className="text-[18px] font-semibold mono mt-1">{formatCurrency(detailLoan.LoanBalanceAmount)}</p>
              </div>
            </div>

            <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] px-4">
              <DetailRow label="Principal" value={detailLoan.PrincipalAmount != null ? formatCurrency(detailLoan.PrincipalAmount) : null} mono />
              <DetailRow label="Total loan amount" value={detailLoan.TotalLoanAmount != null ? formatCurrency(detailLoan.TotalLoanAmount) : null} mono />
              <DetailRow label="Total due" value={detailLoan.TotalDue != null ? formatCurrency(detailLoan.TotalDue) : null} mono />
              <DetailRow label="Total paid (LoanDisk)" value={detailLoan.TotalPaid != null ? formatCurrency(detailLoan.TotalPaid) : null} mono />
              <DetailRow label="Last EMI paid" value={detailLoan.EMILastPaidDate ? formatDate(detailLoan.EMILastPaidDate) : null} />
            </div>

            {/* Detailed analysis */}
            <section>
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">
                Repayment analysis
              </h4>
              {loadingRepay ? (
                <div className="py-6 flex justify-center">
                  <RefreshCw className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
                </div>
              ) : repaySummary ? (
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5">
                  <AnalysisTile
                    icon={Wallet}
                    label="Total repaid"
                    value={formatCurrency(repaySummary.totalPaid)}
                    sub={`${repaySummary.paymentCount} payment${repaySummary.paymentCount === 1 ? '' : 's'}`}
                    tone="success"
                  />
                  <AnalysisTile
                    icon={TrendingUp}
                    label="Avg payment"
                    value={formatCurrency(repaySummary.averagePayment)}
                  />
                  <AnalysisTile
                    icon={Receipt}
                    label="Manual receipts"
                    value={formatCurrency(repaySummary.manualTotal)}
                    sub={`${repaySummary.manualCount} entr${repaySummary.manualCount === 1 ? 'y' : 'ies'}`}
                    tone={repaySummary.manualCount ? 'warn' : undefined}
                  />
                  <AnalysisTile
                    icon={Hash}
                    label="Synced payments"
                    value={formatCurrency(repaySummary.syncedTotal)}
                    sub={`${repaySummary.syncedCount} from LoanDisk`}
                  />
                  <AnalysisTile
                    icon={CalendarClock}
                    label="First payment"
                    value={repaySummary.firstPaymentDate ? formatDate(repaySummary.firstPaymentDate) : '—'}
                  />
                  <AnalysisTile
                    icon={CalendarClock}
                    label="Last payment"
                    value={repaySummary.lastPaymentDate ? formatDate(repaySummary.lastPaymentDate) : '—'}
                  />
                </div>
              ) : (
                <p className="text-[13px] text-[var(--text-tertiary)]">No analysis available.</p>
              )}

              {repaySummary && (repaySummary.principalPaid > 0 || repaySummary.interestPaid > 0 || repaySummary.feesPaid > 0 || repaySummary.penaltyPaid > 0) && (
                <div className="mt-2.5 rounded-[var(--radius-md)] border border-[var(--border-light)] px-4">
                  <DetailRow label="Principal repaid" value={formatCurrency(repaySummary.principalPaid)} mono />
                  <DetailRow label="Interest repaid" value={formatCurrency(repaySummary.interestPaid)} mono />
                  <DetailRow label="Fees repaid" value={repaySummary.feesPaid ? formatCurrency(repaySummary.feesPaid) : null} mono />
                  <DetailRow label="Penalty repaid" value={repaySummary.penaltyPaid ? formatCurrency(repaySummary.penaltyPaid) : null} mono />
                </div>
              )}
            </section>

            {/* Repayment history */}
            <section>
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">
                Repayment history ({repayments.length})
              </h4>
              {loadingRepay ? (
                <div className="py-6 flex justify-center">
                  <RefreshCw className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
                </div>
              ) : repayments.length === 0 ? (
                <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--border-light)] px-4 py-6 text-center text-[13px] text-[var(--text-tertiary)]">
                  No repayments recorded for this loan yet.
                </p>
              ) : (
                <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] overflow-hidden divide-y divide-[var(--border-light)]">
                  {repayments.map((r, i) => {
                    const manual = r.source === 'manual'
                    return (
                      <div
                        key={r.entryId || i}
                        className={cn('px-4 py-3', manual && 'bg-[var(--warning-bg)]/40')}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[13px] font-medium text-[var(--text-primary)]">{formatDate(r.date)}</span>
                            {manual ? (
                              <Badge variant="pending">Manual</Badge>
                            ) : (
                              <Badge variant="posted">LoanDisk</Badge>
                            )}
                            {manual && r.sourceChannel && (
                              <span className="text-[11px] text-[var(--text-tertiary)] capitalize">{r.sourceChannel}</span>
                            )}
                          </div>
                          <span className="mono text-[15px] font-semibold text-[var(--text-primary)] shrink-0">
                            {formatCurrency(r.amount)}
                          </span>
                        </div>
                        {(r.description || r.particulars) && (
                          <p className="text-[12px] text-[var(--text-secondary)] mt-1 truncate">
                            {r.description || r.particulars}
                          </p>
                        )}
                        <div className="flex items-center gap-3 mt-1.5">
                          {r.method && (
                            <span className="text-[11px] text-[var(--text-tertiary)]">Method: {r.method}</span>
                          )}
                          {r.enteredBy && (
                            <span className="text-[11px] text-[var(--text-tertiary)]">By {r.enteredBy}</span>
                          )}
                          {r.receiptDocumentId && (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
                              onClick={() =>
                                api.documents
                                  .download(r.receiptDocumentId, r.receiptFileName)
                                  .catch((e) => toast.error(e.message))
                              }
                            >
                              <Download className="h-3 w-3" />
                              {r.receiptFileName || 'Receipt'}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </Drawer>
    </div>
  )
}
