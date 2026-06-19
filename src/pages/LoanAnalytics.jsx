import { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import {
  RefreshCw, Layers, Users, Wallet, CreditCard, TrendingUp, Percent, Banknote, AlertTriangle,
} from 'lucide-react'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/Card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/Badge'
import { PageLoader } from '@/components/PageLoader'
import { formatCurrency, cn } from '@/lib/utils'

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const PIE_COLORS = ['#6f42c1', '#0d9488', '#f59e0b', '#dc3545', '#3b82f6', '#8b5cf6', '#10b981', '#64748b']

function compactCurrency(v) {
  const n = num(v)
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function statusBucket(status) {
  const s = (status || '').toLowerCase()
  if (s.includes('arrear') || s.includes('default') || s.includes('overdue') || s.includes('past') || s.includes('due')) return 'At risk'
  if (s.includes('current') || s.includes('active') || s.includes('on track') || s.includes('open')) return 'Current'
  if (s.includes('close') || s.includes('paid') || s.includes('settle')) return 'Closed'
  return status || 'Other'
}

function KpiCard({ icon: Icon, label, value, sub, accent }) {
  return (
    <Card className="px-4 py-3.5 flex items-center gap-3">
      <div className={cn('h-10 w-10 rounded-[var(--radius-md)] flex items-center justify-center shrink-0', accent || 'bg-[var(--accent-subtle)]')}>
        <Icon className="h-5 w-5 text-[var(--accent)]" strokeWidth={1.75} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-tertiary)]">{label}</p>
        <p className="text-[18px] font-semibold text-[var(--text-primary)] mono leading-tight mt-0.5 truncate">{value}</p>
        {sub && <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 truncate">{sub}</p>}
      </div>
    </Card>
  )
}

function ChartTooltip({ active, payload, label, currency }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2 shadow-[var(--shadow-sm)] text-[12px]">
      <p className="font-semibold text-[var(--text-primary)] mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-[var(--text-secondary)] flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color || p.fill }} />
          {p.name}: <span className="mono font-medium text-[var(--text-primary)]">{currency ? formatCurrency(p.value) : p.value.toLocaleString()}</span>
        </p>
      ))}
    </div>
  )
}

export function LoanAnalytics() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

  const kpis = useMemo(() => {
    const borrowers = new Set(rows.map((r) => r.BorrowerId || r.BorrowerFullName)).size
    const totalEmi = rows.reduce((s, r) => s + num(r.ExpectedEMIAmount), 0)
    const totalBalance = rows.reduce((s, r) => s + num(r.LoanBalanceAmount), 0)
    const totalPrincipal = rows.reduce((s, r) => s + num(r.PrincipalAmount), 0)
    const totalLoan = rows.reduce((s, r) => s + num(r.TotalLoanAmount), 0)
    const totalPaid = rows.reduce((s, r) => s + num(r.TotalPaid), 0)
    const totalDue = rows.reduce((s, r) => s + num(r.TotalDue), 0)
    const rateRows = rows.filter((r) => num(r.InterestRate) > 0)
    const avgRate = rateRows.length ? rateRows.reduce((s, r) => s + num(r.InterestRate), 0) / rateRows.length : 0
    const avgLoan = rows.length ? totalLoan / rows.length : 0
    const collectionRate = totalPaid + totalBalance > 0 ? (totalPaid / (totalPaid + totalBalance)) * 100 : 0
    return { count: rows.length, borrowers, totalEmi, totalBalance, totalPrincipal, totalLoan, totalPaid, totalDue, avgRate, avgLoan, collectionRate }
  }, [rows])

  const byBranch = useMemo(() => {
    const map = new Map()
    for (const r of rows) {
      const key = r.BranchName || 'Unknown'
      const cur = map.get(key) || { branch: key, loans: 0, balance: 0, emi: 0, principal: 0, paid: 0 }
      cur.loans += 1
      cur.balance += num(r.LoanBalanceAmount)
      cur.emi += num(r.ExpectedEMIAmount)
      cur.principal += num(r.PrincipalAmount)
      cur.paid += num(r.TotalPaid)
      map.set(key, cur)
    }
    return [...map.values()]
      .map((b) => ({ ...b, collection: b.paid + b.balance > 0 ? Math.round((b.paid / (b.paid + b.balance)) * 100) : 0 }))
      .sort((a, b) => b.balance - a.balance)
  }, [rows])

  const byStatus = useMemo(() => {
    const map = new Map()
    for (const r of rows) {
      const key = statusBucket(r.LoanStatus)
      map.set(key, (map.get(key) || 0) + 1)
    }
    return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }, [rows])

  const emiBuckets = useMemo(() => {
    const buckets = [
      { name: '0–100', min: 0, max: 100, count: 0 },
      { name: '100–250', min: 100, max: 250, count: 0 },
      { name: '250–500', min: 250, max: 500, count: 0 },
      { name: '500–1K', min: 500, max: 1000, count: 0 },
      { name: '1K+', min: 1000, max: Infinity, count: 0 },
    ]
    for (const r of rows) {
      const emi = num(r.ExpectedEMIAmount)
      const b = buckets.find((x) => emi >= x.min && emi < x.max)
      if (b) b.count += 1
    }
    return buckets
  }, [rows])

  const topBorrowers = useMemo(
    () =>
      [...rows]
        .sort((a, b) => num(b.LoanBalanceAmount) - num(a.LoanBalanceAmount))
        .slice(0, 10),
    [rows]
  )

  if (loading) return <PageLoader label="Crunching loan analytics…" />

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Detailed analysis of the active loan book (Staging_LoandiskDueRecords)."
        actions={
          <Button variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-5 py-3.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {/* KPI grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Layers} label="Active loans" value={kpis.count.toLocaleString()} sub={`${kpis.borrowers.toLocaleString()} borrowers`} />
        <KpiCard icon={Wallet} label="Outstanding" value={formatCurrency(kpis.totalBalance)} accent="bg-[var(--warning-bg)]" />
        <KpiCard icon={CreditCard} label="Monthly EMI" value={formatCurrency(kpis.totalEmi)} />
        <KpiCard icon={Banknote} label="Principal disbursed" value={formatCurrency(kpis.totalPrincipal)} accent="bg-[var(--success-bg)]" />
        <KpiCard icon={TrendingUp} label="Total collected" value={formatCurrency(kpis.totalPaid)} accent="bg-[var(--success-bg)]" />
        <KpiCard icon={Percent} label="Collection rate" value={`${kpis.collectionRate.toFixed(1)}%`} />
        <KpiCard icon={Percent} label="Avg interest" value={`${kpis.avgRate.toFixed(2)}%`} />
        <KpiCard icon={Users} label="Avg loan size" value={formatCurrency(kpis.avgLoan)} />
      </div>

      {/* Charts row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader title="Outstanding balance by branch" subtitle="Where the exposure sits" />
          <CardBody className="pt-2">
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byBranch} margin={{ top: 8, right: 8, left: -8, bottom: 4 }}>
                  <CartesianGrid stroke="var(--border-light)" vertical={false} strokeDasharray="4 4" />
                  <XAxis dataKey="branch" tick={{ fontSize: 11, fill: 'var(--text-tertiary)', fontWeight: 500 }} axisLine={false} tickLine={false} interval={0} angle={-12} textAnchor="end" height={50} />
                  <YAxis tickFormatter={compactCurrency} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} width={52} />
                  <Tooltip content={<ChartTooltip currency />} cursor={{ fill: 'var(--bg-subtle)' }} />
                  <Bar dataKey="balance" name="Outstanding" fill="#6f42c1" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Loans by status" />
          <CardBody className="pt-2">
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={byStatus} dataKey="value" nameKey="name" cx="50%" cy="45%" innerRadius={55} outerRadius={90} paddingAngle={2}>
                    {byStatus.map((entry, i) => (
                      <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Charts row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader title="Loan count by EMI size" subtitle="Distribution of monthly instalments" />
          <CardBody className="pt-2">
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={emiBuckets} margin={{ top: 8, right: 8, left: -16, bottom: 4 }}>
                  <CartesianGrid stroke="var(--border-light)" vertical={false} strokeDasharray="4 4" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--text-tertiary)', fontWeight: 500 }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--bg-subtle)' }} />
                  <Bar dataKey="count" name="Loans" fill="#0d9488" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Branch performance" subtitle="Portfolio breakdown & collection rate" />
          <CardBody className="pt-2 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[var(--text-tertiary)] border-b border-[var(--border-light)]">
                  <th className="py-2 pr-3 font-medium">Branch</th>
                  <th className="py-2 px-3 font-medium text-right">Loans</th>
                  <th className="py-2 px-3 font-medium text-right">Principal</th>
                  <th className="py-2 px-3 font-medium text-right">Outstanding</th>
                  <th className="py-2 px-3 font-medium text-right">EMI</th>
                  <th className="py-2 pl-3 font-medium text-right">Collection</th>
                </tr>
              </thead>
              <tbody>
                {byBranch.map((b) => (
                  <tr key={b.branch} className="border-b border-[var(--border-light)] last:border-0">
                    <td className="py-2 pr-3 font-medium text-[var(--text-primary)]">{b.branch}</td>
                    <td className="py-2 px-3 text-right mono">{b.loans.toLocaleString()}</td>
                    <td className="py-2 px-3 text-right mono">{formatCurrency(b.principal)}</td>
                    <td className="py-2 px-3 text-right mono">{formatCurrency(b.balance)}</td>
                    <td className="py-2 px-3 text-right mono">{formatCurrency(b.emi)}</td>
                    <td className="py-2 pl-3 text-right">
                      <Badge variant={b.collection >= 70 ? 'on_track' : b.collection >= 40 ? 'posted' : 'pending'}>{b.collection}%</Badge>
                    </td>
                  </tr>
                ))}
                {byBranch.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-[var(--text-tertiary)]">No data</td></tr>
                )}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </div>

      {/* Top borrowers by exposure */}
      <Card>
        <CardHeader
          title="Top borrowers by outstanding"
          subtitle="Largest exposures in the book"
          action={<AlertTriangle className="h-4 w-4 text-[var(--warning)]" />}
        />
        <CardBody className="pt-2 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[var(--text-tertiary)] border-b border-[var(--border-light)]">
                <th className="py-2 pr-3 font-medium">Borrower</th>
                <th className="py-2 px-3 font-medium">Loan #</th>
                <th className="py-2 px-3 font-medium">Branch</th>
                <th className="py-2 px-3 font-medium text-right">EMI</th>
                <th className="py-2 px-3 font-medium text-right">Outstanding</th>
                <th className="py-2 pl-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {topBorrowers.map((r) => (
                <tr key={r.Id || `${r.LoanNumber}-${r.BorrowerId}`} className="border-b border-[var(--border-light)] last:border-0">
                  <td className="py-2 pr-3">
                    <p className="font-medium text-[var(--text-primary)]">{r.BorrowerFullName || '—'}</p>
                    {r.BorrowerId && <p className="text-[11px] text-[var(--text-tertiary)] mono">ID {r.BorrowerId}</p>}
                  </td>
                  <td className="py-2 px-3 mono text-[12px]">{r.LoanNumber || '—'}</td>
                  <td className="py-2 px-3">{r.BranchName || '—'}</td>
                  <td className="py-2 px-3 text-right mono">{formatCurrency(r.ExpectedEMIAmount)}</td>
                  <td className="py-2 px-3 text-right mono font-semibold">{formatCurrency(r.LoanBalanceAmount)}</td>
                  <td className="py-2 pl-3">
                    <Badge variant="posted">{statusBucket(r.LoanStatus)}</Badge>
                  </td>
                </tr>
              ))}
              {topBorrowers.length === 0 && (
                <tr><td colSpan={6} className="py-6 text-center text-[var(--text-tertiary)]">No active loans found</td></tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  )
}
