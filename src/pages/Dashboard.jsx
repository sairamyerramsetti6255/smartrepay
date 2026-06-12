import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts'
import { format, subDays, startOfDay, isToday, formatDistanceToNow } from 'date-fns'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { NextStepHero } from '@/components/NextStepHero'
import { WorkflowTracker } from '@/components/WorkflowTracker'
import { KPICard } from '@/components/KPICard'
import { Badge } from '@/components/Badge'
import { CardSkeleton } from '@/components/Skeleton'
import { aggregateSlaBuckets } from '@/lib/sla'
import { formatCurrency, greeting, firstName, cn } from '@/lib/utils'

const KPI_KEYS = [
  { key: 'today', label: 'Transactions Today', icon: '↗' },
  { key: 'matched', label: 'Matched', icon: '✓' },
  { key: 'exc', label: 'Unmatched', icon: '!' },
  { key: 'posted', label: 'Posted', icon: '→' },
]

const EXCEPTION_COLORS = {
  'Duplicate': '#0d6e6e',
  'Mismatch': '#c41e3a',
  'Missing': '#b45309',
  'Unknown': '#8a8a85',
}

export function Dashboard() {
  const { user } = useAuth()
  const [transactions, setTransactions] = useState([])
  const [exceptions, setExceptions] = useState([])
  const [openExceptions, setOpenExceptions] = useState([])
  const [audit, setAudit] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const since = format(subDays(new Date(), 7), 'yyyy-MM-dd')
        const [txList, exList, auditList] = await Promise.all([
          api.transactions.list({ since }),
          api.exceptions.list(),
          api.audit.list(8),
        ])
        setTransactions(txList)
        setExceptions(exList)
        setOpenExceptions(exList.filter((e) => e.status === 'open').slice(0, 5))
        setAudit(auditList)
      } catch (e) {
        setError(e.message)
        setTransactions([])
        setExceptions([])
        setOpenExceptions([])
        setAudit([])
      } finally {
        setLoading(false)
      }
    }
    load()
    window.addEventListener('smartrepay:demo-loaded', load)
    return () => window.removeEventListener('smartrepay:demo-loaded', load)
  }, [])

  const todayTx = transactions.filter((t) => isToday(new Date(t.date + 'T00:00:00')))
  const kpis = useMemo(
    () => ({
      today: todayTx.length,
      matched: todayTx.filter((t) => t.status === 'matched').length,
      exc: todayTx.filter((t) => t.status === 'exception').length,
      posted: todayTx.filter((t) => t.status === 'posted').length,
    }),
    [todayTx]
  )

  const chartData = useMemo(() => {
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = startOfDay(subDays(new Date(), i))
      const key = format(d, 'yyyy-MM-dd')
      const dayTx = transactions.filter((t) => t.date === key)
      days.push({
        date: format(d, 'MMM d'),
        matched: dayTx.filter((t) => t.status === 'matched').length,
        exceptions: dayTx.filter((t) => t.status === 'exception').length,
        spark: dayTx.length,
      })
    }
    return days
  }, [transactions])

  const slaCounts = aggregateSlaBuckets(exceptions)
  const slaTotal = slaCounts.on_track + slaCounts.at_risk + slaCounts.breached || 1
  const avgMatch = todayTx.length
    ? `${Math.round(todayTx.reduce((s, t) => s + (t.confidence_score || 0), 0) / todayTx.length)}%`
    : '—'
  const slaPct = slaTotal ? `${Math.round((slaCounts.on_track / slaTotal) * 100)}%` : '—'

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </div>
    )
  }

  const name = firstName(user?.email)

  return (
    <div className="space-y-8">
      {/* Header */}
      <header className="animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[26px] font-bold text-[var(--text-primary)] tracking-[-0.03em]">
              {greeting()}, {name}
              <span className="text-gradient ml-1">.</span>
            </h1>
            <p className="text-[14px] text-[var(--text-tertiary)] mt-1">
              Follow the steps below to reconcile today&apos;s payments.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-[var(--text-tertiary)] mono">
              {format(new Date(), 'EEEE, MMMM d')}
            </span>
            <span className="w-px h-6 bg-[var(--border-light)]" />
            <span className="text-[13px] font-medium text-[var(--accent)]">
              {todayTx.length} today
            </span>
          </div>
        </div>
      </header>

      {/* Guided next step */}
      <div className="animate-fade-in" style={{ animationDelay: '0.03s' }}>
        <NextStepHero />
      </div>

      {/* Workflow tracker */}
      <div className="space-y-4 animate-fade-in" style={{ animationDelay: '0.05s' }}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Reconciliation workflow</h2>
            <p className="text-[13px] text-[var(--text-tertiary)] mt-0.5">
              Four steps from statement to posted payment.
            </p>
          </div>
        </div>
        <WorkflowTracker />
      </div>

      {/* KPI Cards */}
      <div className="grid gap-5 grid-cols-2 lg:grid-cols-4 animate-fade-in" style={{ animationDelay: '0.08s' }}>
        {KPI_KEYS.map(({ key, label }) => (
          <KPICard
            key={key}
            label={label}
            value={kpis[key]}
            trend={kpis[key] > 0 ? `${kpis[key]}` : '0'}
            trendUp={kpis[key] > 0}
            sparkData={chartData.map((d) => ({ v: d.spark }))}
          />
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-6 lg:grid-cols-12 animate-fade-in" style={{ animationDelay: '0.1s' }}>
        {/* Chart Section */}
        <Card className="lg:col-span-7">
          <CardHeader title="Reconciliation Activity" subtitle="7-day matched vs unmatched trend" />
          <CardBody className="pt-0">
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barGap={6} margin={{ top: 8, right: 8, left: -16, bottom: 4 }}>
                  <defs>
                    <linearGradient id="matchedGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6f42c1" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#6f42c1" stopOpacity={0.15} />
                    </linearGradient>
                    <linearGradient id="exceptionsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#dc3545" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#dc3545" stopOpacity={0.08} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--border-light)" vertical={false} strokeDasharray="4 4" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 12, fill: 'var(--text-tertiary)', fontWeight: 500 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: 'var(--text-tertiary)' }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                    width={32}
                  />
                  <Bar
                    dataKey="matched"
                    fill="url(#matchedGrad)"
                    stroke="#6f42c1"
                    strokeWidth={1}
                    radius={[6, 6, 0, 0]}
                    name="Matched"
                  />
                  <Bar
                    dataKey="exceptions"
                    fill="url(#exceptionsGrad)"
                    stroke="#dc3545"
                    strokeWidth={1}
                    radius={[6, 6, 0, 0]}
                    name="Unmatched"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-6 justify-center mt-4 text-[13px] text-[var(--text-secondary)]">
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm" style={{ background: '#6f42c180' }} />
                Matched
              </span>
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm" style={{ background: '#dc354580' }} />
                Unmatched
              </span>
            </div>
          </CardBody>
        </Card>

        {/* Right Column */}
        <div className="lg:col-span-5 space-y-6">
          {/* SLA Status */}
          <Card>
            <CardHeader title="Unmatched SLA Status" subtitle={`${slaTotal} total unmatched`} />
            <CardBody className="pt-0 space-y-5">
              {[
                { key: 'on_track', label: 'On Track', color: 'var(--success)', icon: '✓' },
                { key: 'at_risk', label: 'At Risk', color: 'var(--warning)', icon: '!' },
                { key: 'breached', label: 'Breached', color: 'var(--danger)', icon: '✕' },
              ].map((row, i, arr) => {
                const count = slaCounts[row.key]
                const pct = (count / slaTotal) * 100
                const isLast = i === arr.length - 1
                return (
                  <div key={row.key}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ background: row.color }}
                        />
                        <span className="text-[13px] font-medium text-[var(--text-primary)]">
                          {row.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[13px] font-medium text-[var(--text-tertiary)] mono">
                          {Math.round(pct)}%
                        </span>
                        <span className="text-[16px] font-bold text-[var(--text-primary)] mono w-6 text-right">
                          {count}
                        </span>
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--bg-subtle)] overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500 ease-out"
                        style={{
                          width: `${pct}%`,
                          background: row.color,
                          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.2)`,
                        }}
                      />
                    </div>
                    {!isLast && <div className="mt-5 border-t border-[var(--border-light)]" />}
                  </div>
                )
              })}
            </CardBody>
          </Card>

          {/* Quick Stats */}
          <Card>
            <CardHeader title="Performance Metrics" subtitle="Key indicators at a glance" />
            <CardBody className="pt-0">
              <div className="grid grid-cols-2 gap-5">
                {[
                  { v: avgMatch, l: 'Avg match confidence', icon: '◆', color: '#6f42c1' },
                  { v: slaPct, l: 'SLA compliance', icon: '●', color: '#28a745' },
                  { v: String(exceptions.filter((e) => e.status === 'resolved').length), l: 'Manual overrides', icon: '■', color: '#ffc107' },
                  { v: String(kpis.matched), l: 'Auto-approved', icon: '▲', color: '#6f42c1' },
                ].map((s) => (
                  <div
                    key={s.l}
                    className="p-4 rounded-xl border border-[var(--border-light)] bg-[var(--bg-subtle)]/50 transition-all duration-200 hover:bg-[var(--bg-hover)]"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="text-[10px] w-5 h-5 flex items-center justify-center rounded-md font-bold"
                        style={{ color: s.color, background: `${s.color}15` }}
                      >
                        {s.icon}
                      </span>
                      <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-[0.04em] font-semibold">
                        {s.l}
                      </p>
                    </div>
                    <p className="text-[22px] font-bold text-[var(--text-primary)] tracking-[-0.03em] mono">
                      {s.v}
                    </p>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>

      {/* Bottom Grid */}
      <div className="grid gap-6 lg:grid-cols-2 animate-fade-in" style={{ animationDelay: '0.15s' }}>
        {/* Recent Activity */}
        <Card>
          <CardHeader
            title="Recent Activity"
            subtitle="Latest system events"
            action={
              <Link
                to="/audit"
                className="text-[12px] font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)] uppercase tracking-[0.04em]"
              >
                View all →
              </Link>
            }
          />
          <CardBody className="p-0">
            {audit.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-[13px] text-[var(--text-tertiary)]">No activity yet.</p>
              </div>
            ) : (
              <ul>
                {audit.map((entry, i) => (
                  <li
                    key={entry.id}
                    className={cn(
                      'flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-[var(--bg-hover)]',
                      i > 0 && 'border-t border-[var(--border-light)]'
                    )}
                  >
                    <div className="w-8 h-8 rounded-full bg-[var(--accent-subtle)] flex items-center justify-center shrink-0">
                      <span className="text-[12px] font-bold text-[var(--accent)]">
                        {(entry.actor || 'S')[0].toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-[var(--text-primary)]">
                        <span className="font-semibold">{entry.actor || 'System'}</span>{' '}
                        {entry.action} <span className="font-medium text-[var(--accent)]">{entry.entity}</span>
                      </p>
                      <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                        {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Unresolved Exceptions */}
        <Card>
          <CardHeader
            title="Unresolved Unmatched"
            subtitle={`${openExceptions.length} items requiring attention`}
            action={
              <Link
                to="/exceptions"
                className="text-[12px] font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)] uppercase tracking-[0.04em]"
              >
                View queue →
              </Link>
            }
          />
          <CardBody className="p-0">
            {openExceptions.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-[13px] text-[var(--text-tertiary)]">No unmatched items. All clear!</p>
              </div>
            ) : (
              <ul>
                {openExceptions.map((ex, i) => {
                  const tx = ex.transactions
                  return (
                    <li
                      key={ex.id}
                      className={cn(
                        'flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-[var(--bg-hover)]',
                        i > 0 && 'border-t border-[var(--border-light)]'
                      )}
                    >
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold"
                        style={{
                          background: `${EXCEPTION_COLORS[ex.type] || '#6c757d'}15`,
                          color: EXCEPTION_COLORS[ex.type] || '#6c757d',
                        }}
                      >
                        {(ex.type || '?')[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                          {tx?.payer || 'Unknown payer'}
                        </p>
                        <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5 mono">
                          {formatCurrency(tx?.amount)}
                        </p>
                      </div>
                      <Badge variant="exception">{ex.type}</Badge>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}