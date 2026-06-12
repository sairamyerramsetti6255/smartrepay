import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { FileSpreadsheet, Loader2, RefreshCw, Sparkles, Play } from 'lucide-react'
import * as api from '@/lib/api'
import { confidenceVariant } from '@/lib/matcher'
import { useAuth } from '@/context/AuthContext'
import { useMatchingProgress } from '@/context/MatchingProgressContext'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { PageLoader } from '@/components/PageLoader'
import { WorkflowStepper } from '@/components/WorkflowStepper'
import { MatchReviewDrawer, STATUS_META } from '@/components/MatchReviewDrawer'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { exportAllTransactions } from '@/lib/transactionExport'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'matched', label: 'Matched' },
  { value: 'exception', label: 'Unmatched' },
]

export function Match() {
  const { user } = useAuth()
  const [transactions, setTransactions] = useState([])
  // Tile counts come straight from SQL (CRIF_Operations / Get_MatchSummary).
  const [summary, setSummary] = useState({ activeLoans: 0, bankTransactions: 0, matched: 0, needsReview: 0, unmatched: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('all')
  const [detailTx, setDetailTx] = useState(null)
  const [useAi, setUseAi] = useState(true)
  const { running, progress, summary: runSummary, error: runError, startMatching } = useMatchingProgress()
  const wasRunning = useRef(false)

  async function loadMatches({ silent } = {}) {
    if (silent) setRefreshing(true)
    else setLoading(true)
    try {
      const [{ transactions: rows }, s] = await Promise.all([
        api.sqlMatch.results(),
        api.staging.summary().catch(() => null),
      ])
      setTransactions(Array.isArray(rows) ? rows : [])
      if (s) setSummary(s)
    } catch (e) {
      toast.error(e.message)
      setTransactions([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    loadMatches()
  }, [])

  // When a run finishes (running flips true -> false), refresh results + tiles.
  useEffect(() => {
    if (wasRunning.current && !running) {
      loadMatches({ silent: true })
      if (runError) {
        toast.error(`Matching failed: ${runError}`)
      } else if (runSummary) {
        toast.success(
          `Matching complete — ${runSummary.autoMatched ?? 0} matched, ${runSummary.needsReview ?? 0} to review, ${runSummary.unmatched ?? 0} unmatched`
        )
      }
    }
    wasRunning.current = running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  // While a run is in progress, refresh the grid so deterministic results (saved
  // first) and AI refinements appear without waiting for the whole run to finish.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => loadMatches({ silent: true }), 4000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  async function runMatching() {
    if (running) return
    if (!summary.bankTransactions) {
      toast.error('No staged transactions to match — upload documents first')
      return
    }
    try {
      await startMatching(useAi)
      toast.success(useAi ? 'AI matching started…' : 'Matching started…')
    } catch (e) {
      toast.error(e.message)
    }
  }

  const counts = useMemo(() => {
    const total = summary.bankTransactions ?? 0
    const matched = summary.matched ?? 0
    const unmatched = summary.unmatched ?? 0
    return {
      total,
      matched,
      unmatched,
      matchedPct: total ? Math.round((matched / total) * 100) : 0,
      unmatchedPct: total ? Math.round((unmatched / total) * 100) : 0,
    }
  }, [summary])

  // Live matched/unmatched tally streamed from the matching engine while it runs.
  const liveCounts = useMemo(() => {
    if (!progress || progress.matched == null) return null
    return { matched: progress.matched, unmatched: progress.unmatched ?? 0 }
  }, [progress])

  const filtered = useMemo(() => {
    let list = transactions
    if (filter !== 'all') list = list.filter((t) => t.status === filter)
    const order = { pending: 0, exception: 1, matched: 2 }
    return [...list].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
  }, [transactions, filter])

  const pillCounts = useMemo(
    () => ({
      all: transactions.length,
      matched: transactions.filter((t) => t.status === 'matched').length,
      pending: transactions.filter((t) => t.status === 'pending').length,
      exception: transactions.filter((t) => t.status === 'exception').length,
    }),
    [transactions]
  )

  const tableColumns = useMemo(
    () => [
      { key: 'date', label: 'Date', render: (row) => <span className="text-[var(--text-secondary)]">{formatDate(row.date)}</span> },
      {
        key: 'borrower_loandisk_id',
        label: 'LoanDisk ID',
        render: (row) =>
          row.borrower_loandisk_id ? (
            <span className="mono text-[12px] font-medium tabular-nums">{row.borrower_loandisk_id}</span>
          ) : (
            <span className="text-[var(--text-tertiary)]">—</span>
          ),
      },
      { key: 'payer', label: 'Payer', render: (row) => <span className="font-medium">{row.payer || '—'}</span> },
      { key: 'amount', label: 'Amount', align: 'right', render: (row) => formatCurrency(row.amount) },
      {
        key: 'status',
        label: 'Status',
        render: (row) => (
          <Badge variant={STATUS_META[row.status]?.variant || 'pending'}>{STATUS_META[row.status]?.label || row.status}</Badge>
        ),
      },
      {
        key: 'confidence_score',
        label: 'Score',
        align: 'right',
        render: (row) =>
          row.confidence_score == null ? (
            <span className="text-[var(--text-tertiary)]">—</span>
          ) : (
            <Badge variant={confidenceVariant(row.confidence_score)} className="mono">
              {Math.round(row.confidence_score)}%
            </Badge>
          ),
      },
      {
        key: 'matched_borrower_name',
        label: 'Matched to',
        render: (row) =>
          row.matched_borrower_name ? (
            <span className="text-[var(--text-secondary)]">{row.matched_borrower_name}</span>
          ) : (
            <span className="text-[var(--text-tertiary)]">—</span>
          ),
      },
    ],
    []
  )

  function exportAllExcel() {
    const ok = exportAllTransactions(transactions)
    if (!ok) toast.error('No transactions to export')
    else toast.success(`Exported ${transactions.length} rows (matched + unmatched)`)
  }

  async function onResolved() {
    setDetailTx(null)
    await loadMatches({ silent: true })
  }

  if (loading) return <PageLoader label="Loading match results from SQL…" />

  const activeLoans = summary.activeLoans ?? 0

  return (
    <div className="space-y-5">
      <WorkflowStepper current="match" />

      <PageHeader
        eyebrow="Step 2 of 4"
        title="Match Transactions"
        subtitle="Reading directly from SQL Server — Staging_BankTransactions joined with Staging_TransactionMatches."
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <label className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)] mr-1 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useAi}
                onChange={(e) => setUseAi(e.target.checked)}
                disabled={running}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
              AI matching
            </label>
            <Button size="sm" onClick={runMatching} disabled={running}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? 'Matching…' : 'Run Matching'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => loadMatches({ silent: true })} disabled={refreshing}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={exportAllExcel} disabled={transactions.length === 0}>
              <FileSpreadsheet className="h-4 w-4" />
              Export All
            </Button>
          </div>
        }
      />

      {(running || runError) && <MatchProgress progress={progress} running={running} error={runError} />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Active loans" value={typeof activeLoans === 'number' ? activeLoans.toLocaleString() : activeLoans} />
        <StatCard label="Total to match" value={counts.total} />
        <StatCard
          label="Matched"
          value={running && liveCounts ? liveCounts.matched : counts.matched}
          sub={running && liveCounts ? 'live' : `${counts.matchedPct ?? 0}%`}
          success
        />
        <StatCard
          label="Unmatched"
          value={running && liveCounts ? liveCounts.unmatched : counts.unmatched}
          sub={running && liveCounts ? 'live' : `${counts.unmatchedPct ?? 0}%`}
          warn
        />
      </div>

      {/* Filter pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setFilter(f.value)}
            className={cn(
              'h-8 px-3 rounded-[var(--radius-full)] text-[12px] font-medium transition-colors',
              filter === f.value
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
            )}
          >
            {f.label}
            <span className="ml-1.5 opacity-70">{pillCounts[f.value] ?? pillCounts.all}</span>
          </button>
        ))}
      </div>

      {/* Transactions table */}
      <DataTable
        data={filtered}
        columns={tableColumns}
        pageSize={25}
        sortable
        filterable
        onRowClick={(row) => setDetailTx(row)}
        emptyMessage={transactions.length === 0 ? 'No transactions in SQL' : 'No transactions in this filter'}
        emptyDescription={
          transactions.length === 0 ? 'Upload & stage documents, then run matching.' : 'Try another filter'
        }
        emptyAction={
          transactions.length === 0 ? (
            <Link to="/ingest">
              <Button variant="secondary" size="sm">Upload Documents</Button>
            </Link>
          ) : null
        }
      />

      <MatchReviewDrawer tx={detailTx} user={user} onClose={() => setDetailTx(null)} onResolved={onResolved} />
    </div>
  )
}

function MatchProgress({ progress, running, error }) {
  const p = progress || {}
  const isAi = p.phase === 'ai'
  const pct = isAi && p.total ? Math.round((p.done / p.total) * 100) : null
  const hasTally = p.matched != null
  const phaseLabel = error
    ? 'Matching failed'
    : p.phase === 'starting'
      ? 'Starting matching engine…'
      : p.phase === 'loaded'
        ? `Loaded ${p.bankTx ?? 0} transactions · ${p.loans ?? 0} loans — classifying…`
        : p.phase === 'classified'
          ? `Classified ${p.bankTx ?? 0} transactions${p.total ? ` · refining ${p.total} with AI…` : ''}`
          : p.phase === 'ai'
            ? `AI adjudication ${p.done ?? 0}/${p.total ?? 0}`
            : p.phase === 'done'
              ? 'Finishing up…'
              : 'Matching in progress…'

  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border px-4 py-3',
        error
          ? 'border-[var(--danger-border)] bg-[var(--danger-bg)]'
          : 'border-[var(--accent-border,var(--border-light))] bg-[var(--accent-subtle)]'
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
          {running && <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />}
          {error ? error : phaseLabel}
        </div>
        {pct != null && <span className="mono text-[12px] font-semibold text-[var(--accent)]">{pct}%</span>}
      </div>

      {hasTally && !error && (
        <div className="mt-2.5 flex items-center gap-2.5">
          <LiveCount label="Matched" value={p.matched} tone="success" />
          <LiveCount label="Unmatched" value={p.unmatched ?? 0} tone="warn" />
        </div>
      )}

      {pct != null && (
        <div className="mt-2 h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
          <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

function LiveCount({ label, value, tone }) {
  return (
    <div className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-light)] px-2.5 py-1">
      <span
        className={cn(
          'mono text-[14px] font-bold',
          tone === 'success' && 'text-[var(--success)]',
          tone === 'warn' && 'text-[var(--warning)]'
        )}
      >
        {Number(value).toLocaleString()}
      </span>
      <span className="text-[11px] font-medium text-[var(--text-tertiary)]">{label}</span>
    </div>
  )
}

function StatCard({ label, value, sub, accent, success, warn }) {
  return (
    <div className="card px-4 py-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>
      <div className="flex items-baseline gap-2 mt-0.5">
        <p
          className={cn(
            'mono text-[24px] font-bold',
            accent && 'text-[var(--accent)]',
            success && 'text-[var(--success)]',
            warn && 'text-[var(--warning)]',
            !accent && !success && !warn && 'text-[var(--text-primary)]'
          )}
        >
          {value}
        </p>
        {sub && <span className="text-[12px] font-medium text-[var(--text-tertiary)]">{sub}</span>}
      </div>
    </div>
  )
}
