import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip, Legend,
  PieChart, Pie, Cell,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import {
  RefreshCw, GitMerge, AlertCircle, Receipt, Upload,
  ArrowRight, Sparkles, Users, ShieldAlert,
} from 'lucide-react'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardHeader, CardBody } from '@/components/Card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/Badge'
import { PageLoader } from '@/components/PageLoader'
import { cn } from '@/lib/utils'
import { CONFIDENCE_BUCKET_LABELS, bucketVariant } from '@/lib/confidenceBucket'

const PIE_COLORS = ['#6f42c1', '#0d9488', '#f59e0b', '#dc3545', '#3b82f6', '#8b5cf6', '#64748b']
const CHANNEL_LABELS = { walkin: 'Walk-in', whatsapp: 'WhatsApp', email: 'Email', phone: 'Phone', unknown: 'Other' }
const SOURCE_LABELS = { bank: 'Bank', employer: 'Employer', spreadsheet: 'Spreadsheet', pdf: 'PDF', image: 'Image', unknown: 'Other' }
const NAME_TIER_LABELS = {
  full_match_amount: 'Name + amount (100)',
  full_name: 'Full name (90+)',
  first_last: 'First + last (70+)',
  no_match: 'Below threshold',
}
const AMOUNT_KIND_LABELS = {
  exact_single: 'Exact single EMI',
  sum_all: 'Sum all loans',
  subset: 'Subset match',
  partial: 'Partial payment',
  mismatch: 'Amount mismatch',
  none: 'No amount match',
}
const MISSING_PATTERN_LABELS = {
  name_mismatch: 'Name gate failed',
  amount_mismatch: 'Amount mismatch',
  partial_payment: 'Partial payment',
  review_band_failed: 'Review band (70–84)',
  low_name_confidence: 'Low name confidence',
  no_match_found: 'No match found',
  awaiting_match: 'Awaiting match run',
  other: 'Other',
}
const REPAYMENT_BUCKET_LABELS = {
  excellent: 'Excellent',
  on_track: 'On track',
  at_risk: 'At risk',
  overdue: 'Overdue',
  delinquent: 'Delinquent',
  no_payments: 'No payments',
}
const REPAYMENT_BUCKET_VARIANT = {
  excellent: 'on_track',
  on_track: 'posted',
  at_risk: 'pending',
  overdue: 'exception',
  delinquent: 'exception',
  no_payments: 'pending',
}

function KpiCard({ icon: Icon, label, value, sub, accent, to }) {
  const inner = (
    <Card className={cn('px-4 py-3.5 flex items-center gap-3 h-full', to && 'hover:border-[var(--accent-border)] transition-colors')}>
      <div className={cn('h-10 w-10 rounded-[var(--radius-md)] flex items-center justify-center shrink-0', accent || 'bg-[var(--accent-subtle)]')}>
        <Icon className="h-5 w-5 text-[var(--accent)]" strokeWidth={1.75} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-[0.06em] text-[var(--text-tertiary)]">{label}</p>
        <p className="text-[22px] font-bold text-[var(--text-primary)] mono leading-tight mt-0.5">{value}</p>
        {sub && <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{sub}</p>}
      </div>
    </Card>
  )
  if (to) return <Link to={to} className="block">{inner}</Link>
  return inner
}

function CountTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2 shadow-[var(--shadow-sm)] text-[12px]">
      <p className="font-semibold text-[var(--text-primary)] mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-[var(--text-secondary)]">
          {p.name}: <span className="mono font-medium text-[var(--text-primary)]">{p.value}</span>
        </p>
      ))}
    </div>
  )
}

function PipelineStep({ label, count, hint, active, tone }) {
  const countColor =
    tone === 'success'
      ? 'text-[var(--success)]'
      : tone === 'danger'
        ? 'text-[var(--danger)]'
        : 'text-[var(--text-primary)]'
  return (
    <div className={cn('flex-1 min-w-[100px] text-center px-2', active && 'opacity-100')}>
      <p className={cn('text-[28px] font-bold mono leading-none', countColor)}>{count}</p>
      <p className="text-[12px] font-semibold text-[var(--text-primary)] mt-2">{label}</p>
      {hint && <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5">{hint}</p>}
    </div>
  )
}

export function LoanAnalytics() {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await api.dashboard.stats()
      setStats(data)
    } catch (e) {
      setError(e.message)
      setStats(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    window.addEventListener('smartrepay:demo-loaded', load)
    window.addEventListener('smartrepay:matching-done', load)
    return () => {
      window.removeEventListener('smartrepay:demo-loaded', load)
      window.removeEventListener('smartrepay:matching-done', load)
    }
  }, [])

  const m = stats?.matching ?? {}
  const imp = stats?.imports ?? {}
  const rec = stats?.receipts ?? {}
  const pipe = stats?.pipeline ?? {}
  const algo = stats?.algorithm ?? {}
  const rep = stats?.repayments ?? {}

  const chartData = useMemo(
    () =>
      (stats?.activity?.daily ?? []).map((d) => ({
        date: format(parseISO(d.date), 'MMM d'),
        Matched: d.matched,
        Unmatched: d.unmatched,
        Receipts: d.receipts,
      })),
    [stats]
  )

  const matchStatusPie = useMemo(
    () => [
      { name: 'Matched', value: m.matched ?? 0 },
      { name: 'Unmatched', value: m.unmatched ?? 0 },
      { name: 'Pending', value: m.pending ?? 0 },
    ].filter((x) => x.value > 0),
    [m]
  )

  const importSourcePie = useMemo(
    () =>
      (imp.bySourceType ?? []).map((x) => ({
        name: SOURCE_LABELS[x.source] || x.source,
        value: x.count,
      })),
    [imp]
  )

  const receiptChannelPie = useMemo(
    () =>
      (rec.byChannel ?? []).map((x) => ({
        name: CHANNEL_LABELS[x.channel] || x.channel,
        value: x.count,
      })),
    [rec]
  )

  const matchMethodBars = useMemo(
    () =>
      (m.byMatchMethod ?? []).map((x) => ({
        method: x.method === 'ai' ? 'AI' : x.method === 'deterministic' ? 'Rules' : x.method || 'Other',
        count: x.count,
      })),
    [m]
  )

  const confidenceBucketPie = useMemo(
    () =>
      (algo.byConfidenceBucket ?? []).map((x) => ({
        name: CONFIDENCE_BUCKET_LABELS[x.bucket] || x.bucket,
        value: x.count,
        bucket: x.bucket,
      })),
    [algo]
  )

  const nameTierBars = useMemo(
    () =>
      (algo.byNameTier ?? []).map((x) => ({
        tier: NAME_TIER_LABELS[x.tier] || x.tier,
        count: x.count,
      })),
    [algo]
  )

  const amountKindBars = useMemo(
    () =>
      (algo.byAmountMatchKind ?? []).map((x) => ({
        kind: AMOUNT_KIND_LABELS[x.kind] || x.kind,
        count: x.count,
      })),
    [algo]
  )

  const missingPatternBars = useMemo(
    () =>
      (algo.missingPatterns ?? []).map((x) => ({
        pattern: MISSING_PATTERN_LABELS[x.pattern] || x.pattern,
        count: x.count,
      })),
    [algo]
  )

  const borrowerBucketPie = useMemo(
    () =>
      (rep.byBorrowerBucket ?? []).map((x) => ({
        name: REPAYMENT_BUCKET_LABELS[x.bucket] || x.bucket,
        value: x.count,
        bucket: x.bucket,
      })),
    [rep]
  )

  const loanBucketBars = useMemo(
    () =>
      (rep.byLoanBucket ?? []).map((x) => ({
        bucket: REPAYMENT_BUCKET_LABELS[x.bucket] || x.bucket,
        count: x.count,
      })),
    [rep]
  )

  if (loading) return <PageLoader label="Loading reconciliation dashboard…" />

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Matching algorithm analytics, import file breakdowns, and borrower repayment health."
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

      {/* Pipeline funnel */}
      <Card>
        <CardHeader title="Reconciliation pipeline" subtitle="Volume at each stage (counts only)" />
        <CardBody className="pt-2">
          <div className="flex flex-wrap items-center justify-between gap-4 py-2">
            <PipelineStep label="Files imported" count={pipe.importedFiles ?? 0} />
            <ArrowRight className="h-4 w-4 text-[var(--text-tertiary)] shrink-0 hidden sm:block" />
            <PipelineStep label="Transactions" count={pipe.stagedCredits ?? 0} />
            <ArrowRight className="h-4 w-4 text-[var(--text-tertiary)] shrink-0 hidden sm:block" />
            <PipelineStep label="Processed" count={pipe.processed ?? 0} hint="Matched + unmatched" />
            <ArrowRight className="h-4 w-4 text-[var(--text-tertiary)] shrink-0 hidden sm:block" />
            <PipelineStep label="Matched" count={pipe.matched ?? 0} tone="success" active />
            <ArrowRight className="h-4 w-4 text-[var(--text-tertiary)] shrink-0 hidden sm:block" />
            <PipelineStep label="Unmatched" count={pipe.unmatched ?? 0} tone="danger" hint="Need review" />
            <ArrowRight className="h-4 w-4 text-[var(--text-tertiary)] shrink-0 hidden sm:block" />
            <PipelineStep label="Manual receipts" count={pipe.manualReceipts ?? 0} hint="Walk-in / channels" />
          </div>
          <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-[var(--border-light)]">
            <Badge variant="posted">Auto-matched: {m.autoMatched ?? 0}</Badge>
            <Badge variant="matched">Confirmed: {m.confirmed ?? 0}</Badge>
            <Badge variant="pending">Needs review: {m.needsReview ?? 0}</Badge>
            <Link to="/match" className="ml-auto text-[12px] font-semibold text-[var(--accent)] hover:underline inline-flex items-center gap-1">
              Open match queue <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </CardBody>
      </Card>

      {/* Repayment health KPIs */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">Repayment health</p>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <KpiCard icon={Users} label="Active borrowers" value={(rep.borrowers ?? 0).toLocaleString()} sub={`${rep.activeLoans ?? 0} active loans`} to="/active-loans" />
          <KpiCard icon={ShieldAlert} label="At risk / overdue" value={(rep.overdueOrAtRiskLoans ?? 0).toLocaleString()} sub="Loans needing follow-up" accent="bg-[var(--danger-bg)]" />
          <KpiCard icon={Receipt} label="Manual receipts" value={`$${(rep.manualReceiptTotal ?? 0).toLocaleString()}`} sub={`${rep.manualReceiptCount ?? 0} entries`} to="/receipts" />
        </div>
      </div>

      {/* Hybrid matching algorithm */}
      <Card>
        <CardHeader
          title="Hybrid matching algorithm"
          subtitle={`Avg name score ${algo.avgNameScore ?? '—'} · avg confidence ${algo.avgConfidence ?? '—'}% · 70 / 90 / 100 name gates`}
        />
        <CardBody className="pt-2">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="h-[220px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-2">Confidence buckets</p>
              {confidenceBucketPie.length ? (
                <ResponsiveContainer width="100%" height="90%">
                  <PieChart>
                    <Pie data={confidenceBucketPie} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={40} outerRadius={70} paddingAngle={2}>
                      {confidenceBucketPie.map((entry, i) => (
                        <Cell key={entry.bucket} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CountTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[13px] text-[var(--text-tertiary)] py-8 text-center">Run matching to see buckets</p>
              )}
            </div>
            <div className="h-[220px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-2">Name score tiers</p>
              {nameTierBars.length ? (
                <ResponsiveContainer width="100%" height="90%">
                  <BarChart data={nameTierBars} layout="vertical" margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid stroke="var(--border-light)" horizontal={false} strokeDasharray="4 4" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="tier" width={110} tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
                    <Tooltip content={<CountTooltip />} cursor={{ fill: 'var(--bg-subtle)' }} />
                    <Bar dataKey="count" name="Lines" fill="#6f42c1" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[13px] text-[var(--text-tertiary)] py-8 text-center">No scored lines yet</p>
              )}
            </div>
            <div className="h-[220px]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-2">Amount match kinds</p>
              {amountKindBars.length ? (
                <ResponsiveContainer width="100%" height="90%">
                  <BarChart data={amountKindBars} layout="vertical" margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid stroke="var(--border-light)" horizontal={false} strokeDasharray="4 4" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="kind" width={100} tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
                    <Tooltip content={<CountTooltip />} cursor={{ fill: 'var(--bg-subtle)' }} />
                    <Bar dataKey="count" name="Lines" fill="#0d9488" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[13px] text-[var(--text-tertiary)] py-8 text-center">No amount matches yet</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-[var(--border-light)]">
            {(algo.byConfidenceBucket ?? []).map((x) => (
              <Badge key={x.bucket} variant={bucketVariant(x.bucket)}>
                {CONFIDENCE_BUCKET_LABELS[x.bucket] || x.bucket}: {x.count}
              </Badge>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* Missing patterns + borrower buckets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Missing / exception patterns" subtitle="Why credits did not auto-match" />
          <CardBody className="pt-2">
            <div className="h-[240px]">
              {missingPatternBars.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={missingPatternBars} margin={{ top: 8, right: 8, left: -8, bottom: 48 }}>
                    <CartesianGrid stroke="var(--border-light)" vertical={false} strokeDasharray="4 4" />
                    <XAxis dataKey="pattern" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} angle={-25} textAnchor="end" height={56} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} width={32} />
                    <Tooltip content={<CountTooltip />} cursor={{ fill: 'var(--bg-subtle)' }} />
                    <Bar dataKey="count" name="Lines" fill="#dc3545" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[13px] text-[var(--text-tertiary)] py-12 text-center">No exceptions recorded</p>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Borrower repayment ratings" subtitle="Worst loan per borrower drives the bucket" />
          <CardBody className="pt-2">
            <div className="h-[240px]">
              {borrowerBucketPie.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={borrowerBucketPie} dataKey="value" nameKey="name" cx="50%" cy="45%" innerRadius={45} outerRadius={80} paddingAngle={2}>
                      {borrowerBucketPie.map((entry, i) => (
                        <Cell key={entry.bucket} fill={PIE_COLORS[(i + 1) % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CountTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[13px] text-[var(--text-tertiary)] py-12 text-center">No active loan book synced</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2 mt-2 pt-3 border-t border-[var(--border-light)]">
              {loanBucketBars.map((x) => (
                <Badge key={x.bucket} variant="posted">{x.bucket}: {x.count} loans</Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* At-risk borrowers */}
      {(rep.atRiskBorrowers ?? []).length > 0 && (
        <Card>
          <CardHeader
            title="Borrowers needing attention"
            subtitle="Overdue, delinquent, at risk, or no payments recorded"
            action={
              <Link to="/active-loans" className="text-[12px] font-semibold text-[var(--accent)] hover:underline">
                Active loans →
              </Link>
            }
          />
          <CardBody className="pt-2 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[var(--text-tertiary)] border-b border-[var(--border-light)]">
                  <th className="py-2 pr-3 font-medium">Borrower</th>
                  <th className="py-2 px-3 font-medium">Rating</th>
                  <th className="py-2 px-3 font-medium text-right">Loans</th>
                  <th className="py-2 px-3 font-medium text-right">Paid</th>
                  <th className="py-2 px-3 font-medium text-right">Outstanding</th>
                  <th className="py-2 pl-3 font-medium text-right">Days since EMI</th>
                </tr>
              </thead>
              <tbody>
                {(rep.atRiskBorrowers ?? []).map((b) => (
                  <tr key={b.borrowerId} className="border-b border-[var(--border-light)] last:border-0">
                    <td className="py-2 pr-3 font-medium text-[var(--text-primary)]">{b.borrowerName}</td>
                    <td className="py-2 px-3">
                      <Badge variant={REPAYMENT_BUCKET_VARIANT[b.rating] || 'pending'}>
                        {REPAYMENT_BUCKET_LABELS[b.rating] || b.rating}
                      </Badge>
                    </td>
                    <td className="py-2 px-3 text-right mono">{b.loanCount}</td>
                    <td className="py-2 px-3 text-right mono">${(b.totalPaid ?? 0).toLocaleString()}</td>
                    <td className="py-2 px-3 text-right mono">${(b.outstanding ?? 0).toLocaleString()}</td>
                    <td className="py-2 pl-3 text-right mono text-[var(--danger)]">
                      {b.daysSinceLastPayment != null ? b.daysSinceLastPayment : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* Receipt + import KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">Imports</p>
          <div className="grid grid-cols-2 gap-4">
            <KpiCard icon={Upload} label="Imported files" value={(imp.totalFiles ?? 0).toLocaleString()} sub={`${imp.totalRows ?? 0} total rows`} to="/ingest" />
            <KpiCard icon={AlertCircle} label="Files w/ unmatched" value={(imp.filesWithUnmatched ?? 0).toLocaleString()} sub={`${imp.filesFullyMatched ?? 0} fully matched`} />
          </div>
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">Manual receipts</p>
          <div className="grid grid-cols-2 gap-4">
            <KpiCard icon={Receipt} label="Total receipts" value={(rec.total ?? 0).toLocaleString()} sub={`${rec.withAttachment ?? 0} with attachment`} to="/receipts" />
            <KpiCard icon={Receipt} label="This week" value={(rec.thisWeek ?? 0).toLocaleString()} sub={`${rec.today ?? 0} today`} accent="bg-[var(--success-bg)]" />
          </div>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Card className="lg:col-span-7">
          <CardHeader title="7-day activity" subtitle="Matched vs unmatched credits and receipts entered" />
          <CardBody className="pt-2">
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barGap={4} margin={{ top: 8, right: 8, left: -16, bottom: 4 }}>
                  <CartesianGrid stroke="var(--border-light)" vertical={false} strokeDasharray="4 4" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} width={32} />
                  <Tooltip content={<CountTooltip />} cursor={{ fill: 'var(--bg-subtle)' }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Matched" fill="#6f42c1" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Unmatched" fill="#dc3545" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Receipts" fill="#0d9488" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader title="Match status mix" subtitle="All transactions" />
          <CardBody className="pt-2">
            <div className="h-[280px]">
              {matchStatusPie.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={matchStatusPie} dataKey="value" nameKey="name" cx="50%" cy="45%" innerRadius={50} outerRadius={85} paddingAngle={2}>
                      {matchStatusPie.map((entry, i) => (
                        <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CountTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-[13px] text-[var(--text-tertiary)]">
                  No transactions yet — upload a statement to begin.
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Breakdown row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader title="Import source" subtitle="Files by type" />
          <CardBody className="pt-2">
            <div className="h-[220px]">
              {importSourcePie.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={importSourcePie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75}>
                      {importSourcePie.map((entry, i) => (
                        <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CountTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[13px] text-[var(--text-tertiary)] py-8 text-center">No imports</p>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Receipt channels" subtitle="How payments were collected" />
          <CardBody className="pt-2">
            <div className="h-[220px]">
              {receiptChannelPie.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={receiptChannelPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75}>
                      {receiptChannelPie.map((entry, i) => (
                        <Cell key={entry.name} fill={PIE_COLORS[(i + 2) % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={<CountTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-[13px] text-[var(--text-tertiary)] py-8 text-center">No manual receipts yet</p>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Match methods" subtitle="How matches were resolved" />
          <CardBody className="pt-2">
            <div className="h-[220px]">
              {matchMethodBars.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={matchMethodBars} layout="vertical" margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid stroke="var(--border-light)" horizontal={false} strokeDasharray="4 4" />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="method" width={56} tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} axisLine={false} tickLine={false} />
                    <Tooltip content={<CountTooltip />} cursor={{ fill: 'var(--bg-subtle)' }} />
                    <Bar dataKey="count" name="Matches" fill="#6f42c1" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-[13px] text-[var(--text-tertiary)]">
                  <Sparkles className="h-5 w-5 opacity-50" />
                  Run matching to see method breakdown
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Per-file algorithm analytics */}
      <Card>
        <CardHeader
          title="Imported files — algorithm analytics"
          subtitle="Match rate and confidence mix per file (all source types)"
          action={
            <Link to="/ingest" className="text-[12px] font-semibold text-[var(--accent)] hover:underline">
              Upload →
            </Link>
          }
        />
        <CardBody className="pt-2 overflow-x-auto">
          <table className="w-full text-[13px] min-w-[720px]">
            <thead>
              <tr className="text-left text-[var(--text-tertiary)] border-b border-[var(--border-light)]">
                <th className="py-2 pr-3 font-medium">File</th>
                <th className="py-2 px-3 font-medium">Type</th>
                <th className="py-2 px-3 font-medium text-right">Lines</th>
                <th className="py-2 px-3 font-medium text-right">Match %</th>
                <th className="py-2 px-3 font-medium text-right">Avg conf.</th>
                <th className="py-2 pl-3 font-medium">Top confidence bucket</th>
              </tr>
            </thead>
            <tbody>
              {(algo.fileAnalytics ?? []).map((f) => {
                const topBucket = f.byConfidenceBucket?.[0]
                return (
                  <tr key={f.filename} className="border-b border-[var(--border-light)] last:border-0">
                    <td className="py-2 pr-3 font-medium text-[var(--text-primary)] truncate max-w-[200px]" title={f.filename}>
                      {f.filename}
                    </td>
                    <td className="py-2 px-3">
                      <Badge variant="posted">{SOURCE_LABELS[f.sourceType] || f.sourceType}</Badge>
                    </td>
                    <td className="py-2 px-3 text-right mono">{f.total || f.totalRows}</td>
                    <td className="py-2 px-3 text-right mono">{f.matchRate ?? 0}%</td>
                    <td className="py-2 px-3 text-right mono">{f.avgConfidence ?? '—'}</td>
                    <td className="py-2 pl-3">
                      {topBucket ? (
                        <Badge variant={bucketVariant(topBucket.bucket)}>
                          {CONFIDENCE_BUCKET_LABELS[topBucket.bucket] || topBucket.bucket} ({topBucket.count})
                        </Badge>
                      ) : (
                        <span className="text-[var(--text-tertiary)]">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!(algo.fileAnalytics ?? []).length && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--text-tertiary)]">
                    No imported files — upload a statement to begin.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {/* Algorithm by file source type */}
      {(algo.bySourceType ?? []).length > 0 && (
        <Card>
          <CardHeader title="Confidence by import source" subtitle="Bucket distribution grouped by bank / employer / spreadsheet" />
          <CardBody className="pt-2 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[var(--text-tertiary)] border-b border-[var(--border-light)]">
                  <th className="py-2 pr-3 font-medium">Source</th>
                  <th className="py-2 px-3 font-medium text-right">Lines</th>
                  {(algo.byConfidenceBucket ?? []).map((b) => (
                    <th key={b.bucket} className="py-2 px-2 font-medium text-right text-[11px]">
                      {CONFIDENCE_BUCKET_LABELS[b.bucket] || b.bucket}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(algo.bySourceType ?? []).map((row) => {
                  const bucketMap = Object.fromEntries((row.buckets ?? []).map((b) => [b.bucket, b.count]))
                  return (
                    <tr key={row.source} className="border-b border-[var(--border-light)] last:border-0">
                      <td className="py-2 pr-3 font-medium">{SOURCE_LABELS[row.source] || row.source}</td>
                      <td className="py-2 px-3 text-right mono">{row.total}</td>
                      {(algo.byConfidenceBucket ?? []).map((b) => (
                        <td key={b.bucket} className="py-2 px-2 text-right mono text-[var(--text-secondary)]">
                          {bucketMap[b.bucket] ?? 0}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* Import files summary */}
      <Card>
        <CardHeader
          title="Import files summary"
          subtitle="Row counts per file"
          action={
            <Link to="/ingest" className="text-[12px] font-semibold text-[var(--accent)] hover:underline">
              Upload →
            </Link>
          }
        />
        <CardBody className="pt-2 overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[var(--text-tertiary)] border-b border-[var(--border-light)]">
                <th className="py-2 pr-3 font-medium">File</th>
                <th className="py-2 px-3 font-medium">Source</th>
                <th className="py-2 px-3 font-medium text-right">Rows</th>
                <th className="py-2 px-3 font-medium text-right">Matched</th>
                <th className="py-2 px-3 font-medium text-right">Unmatched</th>
                <th className="py-2 pl-3 font-medium text-right">Pending</th>
              </tr>
            </thead>
            <tbody>
              {(imp.recentFiles ?? []).map((f) => (
                <tr key={f.filename} className="border-b border-[var(--border-light)] last:border-0">
                  <td className="py-2 pr-3 font-medium text-[var(--text-primary)] truncate max-w-[220px]" title={f.filename}>
                    {f.filename}
                  </td>
                  <td className="py-2 px-3">
                    <Badge variant="posted">{SOURCE_LABELS[f.sourceType] || f.sourceType}</Badge>
                  </td>
                  <td className="py-2 px-3 text-right mono">{f.totalRows}</td>
                  <td className="py-2 px-3 text-right mono text-[var(--success)]">{f.matchedCount}</td>
                  <td className="py-2 px-3 text-right mono text-[var(--danger)]">{f.unmatchedCount}</td>
                  <td className="py-2 pl-3 text-right mono text-[var(--text-tertiary)]">{f.pendingCount}</td>
                </tr>
              ))}
              {!(imp.recentFiles ?? []).length && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-[var(--text-tertiary)]">
                    No imported files — start with Upload in the workflow.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>

      {/* Quick actions */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { to: '/ingest', icon: Upload, label: 'Upload statement', desc: 'Import bank or employer file' },
          { to: '/match', icon: GitMerge, label: 'Run matching', desc: `${m.pending ?? 0} transactions awaiting match` },
          { to: '/receipts', icon: Receipt, label: 'Enter receipt', desc: 'Walk-in / WhatsApp / phone' },
        ].map((a) => (
          <Link
            key={a.to}
            to={a.to}
            className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] px-4 py-3.5 hover:border-[var(--accent-border)] hover:bg-[var(--accent-subtle)]/30 transition-colors"
          >
            <a.icon className="h-5 w-5 text-[var(--accent)] shrink-0" strokeWidth={1.75} />
            <div>
              <p className="text-[14px] font-semibold text-[var(--text-primary)]">{a.label}</p>
              <p className="text-[12px] text-[var(--text-tertiary)]">{a.desc}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
