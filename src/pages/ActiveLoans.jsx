import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { RefreshCw, Search, Landmark, CreditCard, User, Wallet, Layers } from 'lucide-react'
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

export function ActiveLoans() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState(null)

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
    const totalBalance = rows.reduce((s, r) => s + (Number(r.LoanBalanceAmount) || 0), 0)
    return { count: rows.length, borrowers, totalEmi, totalBalance }
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
      key: 'EMILastPaidDate',
      label: 'Last paid',
      render: (r) => (r.EMILastPaidDate ? formatDate(r.EMILastPaidDate) : '—'),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Active Loans"
        subtitle="Live loan book from LoanDisk (Staging_LoandiskDueRecords)."
        actions={
          <Button variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Layers} label="Active loans" value={stats.count.toLocaleString()} />
        <StatCard icon={User} label="Borrowers" value={stats.borrowers.toLocaleString()} accent="bg-[var(--success-bg)]" />
        <StatCard icon={CreditCard} label="Total EMI" value={formatCurrency(stats.totalEmi)} />
        <StatCard icon={Wallet} label="Outstanding" value={formatCurrency(stats.totalBalance)} accent="bg-[var(--warning-bg)]" />
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
        <PageLoader label="Loading active loans…" />
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          pageSize={25}
          onRowClick={setDetail}
          sortable
          filterable
          emptyMessage="No active loans found"
          emptyDescription="Run the LoanDisk sync to populate Staging_LoandiskDueRecords."
        />
      )}

      <Drawer open={!!detail} onClose={() => setDetail(null)} title="Loan Details">
        {detail && (
          <div className="space-y-6">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-full bg-[var(--accent-subtle)] flex items-center justify-center shrink-0">
                <Landmark className="h-5 w-5 text-[var(--accent)]" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">{detail.BorrowerFullName}</h3>
                <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                  {[detail.BranchName, detail.LoanNumber && `Loan ${detail.LoanNumber}`].filter(Boolean).join(' · ') || '—'}
                </p>
              </div>
              <Badge variant={statusVariant(detail.LoanStatus)}>{detail.LoanStatus || 'Active'}</Badge>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-3">
                <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wide">EMI</p>
                <p className="text-[18px] font-semibold mono mt-1">{formatCurrency(detail.ExpectedEMIAmount)}</p>
              </div>
              <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-3">
                <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wide">Balance</p>
                <p className="text-[18px] font-semibold mono mt-1">{formatCurrency(detail.LoanBalanceAmount)}</p>
              </div>
            </div>

            <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] px-4">
              <DetailRow label="Loan Number" value={detail.LoanNumber} mono />
              <DetailRow label="Borrower ID" value={detail.BorrowerId} mono />
              <DetailRow label="Principal" value={detail.PrincipalAmount != null ? formatCurrency(detail.PrincipalAmount) : null} mono />
              <DetailRow label="Total Loan Amount" value={detail.TotalLoanAmount != null ? formatCurrency(detail.TotalLoanAmount) : null} mono />
              <DetailRow label="Interest Rate" value={detail.InterestRate != null ? `${detail.InterestRate}%` : null} mono />
              <DetailRow label="Interest Amount" value={detail.InterestAmount != null ? formatCurrency(detail.InterestAmount) : null} mono />
              <DetailRow label="Total Due" value={detail.TotalDue != null ? formatCurrency(detail.TotalDue) : null} mono />
              <DetailRow label="Total Paid" value={detail.TotalPaid != null ? formatCurrency(detail.TotalPaid) : null} mono />
              <DetailRow label="Last EMI Paid" value={detail.EMILastPaidDate ? formatDate(detail.EMILastPaidDate) : null} />
              <DetailRow label="Email" value={detail.BorrowerEmail} />
              <DetailRow label="Phone" value={detail.BorrowerPhone} mono />
              <DetailRow label="Branch" value={detail.BranchName} />
              <DetailRow label="Synced" value={detail.SyncedAt ? formatDate(detail.SyncedAt) : null} />
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
