import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { FileSpreadsheet, Loader2, RefreshCw, FileText, Play, RotateCcw, Sparkles, X } from 'lucide-react'
import * as api from '@/lib/api'
import { confidenceVariant } from '@/lib/matcher'
import { useAuth } from '@/context/AuthContext'
import { useMatchingProgress } from '@/context/MatchingProgressContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { PageLoader } from '@/components/PageLoader'
import { WorkflowStepper } from '@/components/WorkflowStepper'
import { MatchReviewDrawer, STATUS_META } from '@/components/MatchReviewDrawer'
import { MatchScopePanel } from '@/components/MatchScopePanel'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { exportAllTransactions } from '@/lib/transactionExport'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'matched', label: 'Matched' },
  { value: 'exception', label: 'Unmatched' },
]

export function Match() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const focusFile = searchParams.get('file')?.trim() || null
  const [transactions, setTransactions] = useState([])
  const [summary, setSummary] = useState({ activeLoans: 0, bankTransactions: 0, matched: 0, needsReview: 0, unmatched: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('all')
  const [detailTx, setDetailTx] = useState(null)
  const [useAi, setUseAi] = useState(true)
  const [scopeTab, setScopeTab] = useState('todo')
  const [viewScope, setViewScope] = useState({ tab: 'todo', fileNames: null })
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

  useEffect(() => {
    if (wasRunning.current && !running) {
      loadMatches({ silent: true })
      if (runError) {
        toast.error(`Matching failed: ${runError}`)
      } else if (runSummary) {
        toast.success(
          `Matching complete — ${runSummary.autoMatched ?? 0} matched, ${runSummary.unmatched ?? 0} unmatched`
        )
      }
    }
    wasRunning.current = running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => loadMatches({ silent: true }), 4000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  async function runMatching(fileNames = null) {
    if (running) return
    if (!summary.bankTransactions) {
      toast.error('No staged transactions — upload documents first')
      return
    }
    if (!Array.isArray(fileNames) || !fileNames.length) {
      toast.error('Select at least one file to match')
      return
    }
    try {
      await startMatching(useAi, fileNames)
      toast.success(`${useAi ? 'AI matching' : 'Matching'} started for ${fileNames.length} file(s)`)
    } catch (e) {
      toast.error(e.message)
    }
  }

  const scopedTransactions = useMemo(() => {
    if (focusFile) {
      return transactions.filter((t) => (t.source_filename || '—') === focusFile)
    }
    if (viewScope.tab === 'all' || !viewScope.fileNames?.length) return transactions
    const names = new Set(viewScope.fileNames)
    return transactions.filter((t) => names.has(t.source_filename || '—'))
  }, [transactions, viewScope, focusFile])

  const counts = useMemo(() => {
    const total = scopedTransactions.length
    const matched = scopedTransactions.filter((t) => t.status === 'matched').length
    const unmatched = scopedTransactions.filter((t) => t.status === 'exception').length
    return {
      total,
      matched,
      unmatched,
      matchedPct: total ? Math.round((matched / total) * 100) : 0,
      unmatchedPct: total ? Math.round((unmatched / total) * 100) : 0,
    }
  }, [scopedTransactions])

  const fileGroups = useMemo(() => {
    const map = new Map()
    for (const t of transactions) {
      const name = t.source_filename || '—'
      let g = map.get(name)
      if (!g) {
        g = { fileName: name, total: 0, matched: 0, exception: 0, pending: 0, dateFrom: null }
        map.set(name, g)
      }
      g.total += 1
      if (t.status === 'matched') g.matched += 1
      else if (t.status === 'exception') g.exception += 1
      else g.pending += 1
      const d = t.date ? String(t.date).slice(0, 10) : null
      if (d && (!g.dateFrom || d < g.dateFrom)) g.dateFrom = d
    }
    return [...map.values()].sort((a, b) => {
      const ac = a.pending === 0 ? 1 : 0
      const bc = b.pending === 0 ? 1 : 0
      if (ac !== bc) return ac - bc
      return a.fileName.localeCompare(b.fileName)
    })
  }, [transactions])

  const isFileScoped = !!focusFile || (viewScope.tab !== 'all' && viewScope.fileNames?.length > 0)

  const focusedFileStats = useMemo(() => {
    if (!focusFile) return null
    return fileGroups.find((f) => f.fileName === focusFile) || {
      fileName: focusFile,
      total: scopedTransactions.length,
      matched: scopedTransactions.filter((t) => t.status === 'matched').length,
      exception: scopedTransactions.filter((t) => t.status === 'exception').length,
      pending: scopedTransactions.filter((t) => t.status === 'pending').length,
      dateFrom: null,
    }
  }, [focusFile, fileGroups, scopedTransactions])

  function clearFileFocus() {
    setSearchParams({})
    setScopeTab('all')
    setViewScope({ tab: 'all', fileNames: null })
  }

  const liveCounts = useMemo(() => {
    if (!progress || progress.matched == null) return null
    return { matched: progress.matched, unmatched: progress.unmatched ?? 0 }
  }, [progress])

  const filtered = useMemo(() => {
    let list = scopedTransactions
    if (filter !== 'all') list = list.filter((t) => t.status === filter)
    const order = { pending: 0, exception: 1, matched: 2 }
    return [...list].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
  }, [scopedTransactions, filter])

  const pillCounts = useMemo(
    () => ({
      all: scopedTransactions.length,
      matched: scopedTransactions.filter((t) => t.status === 'matched').length,
      pending: scopedTransactions.filter((t) => t.status === 'pending').length,
      exception: scopedTransactions.filter((t) => t.status === 'exception').length,
    }),
    [scopedTransactions]
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
    const ok = exportAllTransactions(scopedTransactions)
    if (!ok) toast.error('No transactions to export')
    else toast.success(`Exported ${scopedTransactions.length} rows`)
  }

  async function onResolved() {
    setDetailTx(null)
    await loadMatches({ silent: true })
  }

  if (loading) return <PageLoader label="Loading reconciliation data…" />

  const activeLoans = summary.activeLoans ?? 0
  const displayMatched = running && liveCounts ? liveCounts.matched : counts.matched
  const displayUnmatched = running && liveCounts ? liveCounts.unmatched : counts.unmatched

  return (
    <div className="-mt-2 space-y-4 pb-6">
      <WorkflowStepper current="match" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-[-0.02em]">Match Transactions</h1>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => loadMatches({ silent: true })} disabled={refreshing}>
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={exportAllExcel} disabled={scopedTransactions.length === 0}>
            <FileSpreadsheet className="h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      {!focusFile ? (
        <MatchScopePanel
          files={fileGroups}
          running={running}
          useAi={useAi}
          onUseAiChange={setUseAi}
          onRun={runMatching}
          tab={scopeTab}
          onTabChange={setScopeTab}
          onViewScopeChange={setViewScope}
        />
      ) : focusedFileStats ? (
        <FileFocusBanner
          file={focusedFileStats}
          counts={counts}
          running={running}
          useAi={useAi}
          onUseAiChange={setUseAi}
          onRun={() => runMatching([focusFile])}
          onClear={clearFileFocus}
        />
      ) : null}

      {(running || runError) && <MatchProgress progress={progress} running={running} error={runError} />}

      {isFileScoped && !focusFile && (
        <p className="text-[12px] text-[var(--text-secondary)] -mt-1">
          Showing {counts.total.toLocaleString()} transaction{counts.total === 1 ? '' : 's'} from{' '}
          {viewScope.fileNames.length === 1 ? (
            <span className="font-medium text-[var(--text-primary)]">{viewScope.fileNames[0]}</span>
          ) : (
            <span className="font-medium text-[var(--text-primary)]">{viewScope.fileNames.length} files</span>
          )}
          {' · '}
          <button
            type="button"
            className="text-[var(--accent)] font-medium hover:underline"
            onClick={() => setScopeTab('all')}
          >
            Show all files
          </button>
        </p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <CompactStat label="Loans" value={typeof activeLoans === 'number' ? activeLoans.toLocaleString() : activeLoans} />
        <CompactStat label="Transactions" value={counts.total} />
        <CompactStat label="Matched" value={displayMatched} sub={`${counts.matchedPct}%`} tone="success" live={running && !!liveCounts} />
        <CompactStat label="Unmatched" value={displayUnmatched} sub={`${counts.unmatchedPct}%`} tone="warn" live={running && !!liveCounts} />
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-[var(--shadow-xs)] overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]/30">
          <span className="text-[12px] font-semibold text-[var(--text-secondary)] mr-1">Results</span>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[var(--radius-md)] text-[12px] font-medium transition-colors',
                filter === f.value
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-card)]'
              )}
            >
              {f.label}
              <span className={cn('mono text-[10px] font-semibold', filter === f.value ? 'opacity-80' : 'text-[var(--text-tertiary)]')}>
                {pillCounts[f.value] ?? pillCounts.all}
              </span>
            </button>
          ))}
          {pillCounts.pending > 0 && (
            <span className="ml-auto text-[11px] text-[var(--warning)] font-medium">{pillCounts.pending} pending</span>
          )}
        </div>

        <DataTable
          data={filtered}
          columns={tableColumns}
          pageSize={25}
          sortable
          filterable
          onRowClick={(row) => setDetailTx(row)}
          emptyMessage={scopedTransactions.length === 0 ? 'No transactions yet' : 'Nothing in this filter'}
          emptyDescription={
            scopedTransactions.length === 0
              ? 'Upload statements, then run matching above.'
              : 'Try another filter.'
          }
          emptyAction={
            scopedTransactions.length === 0 ? (
              <Link to="/ingest">
                <Button variant="secondary" size="sm">Upload</Button>
              </Link>
            ) : null
          }
        />
      </div>

      <MatchReviewDrawer tx={detailTx} user={user} onClose={() => setDetailTx(null)} onResolved={onResolved} />
    </div>
  )
}

/* ── File focus banner (from Upload page) ───────────────────────────── */

function FileFocusBanner({ file, counts, running, useAi, onUseAiChange, onRun, onClear }) {
  const pct = file.total > 0 ? Math.round((file.matched / file.total) * 100) : 0
  const completed = file.total > 0 && file.pending === 0
  const ext = file.fileName?.split('.').pop()?.toLowerCase() || ''
  const isSheet = ['csv', 'xlsx', 'xls', 'xlsm'].includes(ext)
  const Icon = isSheet ? FileSpreadsheet : FileText

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--accent-border)] bg-[var(--accent-subtle)]/50 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="h-11 w-11 shrink-0 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-light)] flex items-center justify-center">
            <Icon className={cn('h-5 w-5', isSheet ? 'text-[var(--success)]' : 'text-[var(--accent)]')} strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">Matching this file</p>
            <p className="text-[15px] font-semibold text-[var(--text-primary)] mt-0.5 truncate" title={file.fileName}>
              {file.fileName}
            </p>
            <p className="text-[12px] text-[var(--text-secondary)] mt-1">
              {counts.total.toLocaleString()} transactions · {counts.matched.toLocaleString()} matched · {counts.unmatched.toLocaleString()} unmatched
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--text-secondary)] cursor-pointer select-none bg-[var(--bg-card)] border border-[var(--border-light)]">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(e) => onUseAiChange?.(e.target.checked)}
              disabled={running}
              className="h-3 w-3 accent-[var(--accent)]"
            />
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
            AI
          </label>
          <Button size="sm" onClick={onRun} disabled={running} variant={completed ? 'secondary' : 'default'}>
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : completed ? (
              <RotateCcw className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {running ? 'Running…' : completed ? 'Re-match file' : 'Run match'}
          </Button>
          <Button variant="ghost" size="icon" onClick={onClear} aria-label="Show all files">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {file.total > 0 && (
        <div className="px-5 pb-4">
          <div className="flex justify-between text-[11px] mb-1.5">
            <span className="text-[var(--text-tertiary)]">Match progress</span>
            <span className="mono font-semibold text-[var(--text-primary)]">{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-[var(--bg-card)] overflow-hidden flex">
            <div className="h-full bg-[var(--success)] transition-all duration-300" style={{ width: `${pct}%` }} />
            {pct < 100 && file.exception > 0 && (
              <div className="h-full bg-[var(--warning)]" style={{ width: `${100 - pct}%` }} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Compact stats ─────────────────────────────────────────────────── */

function CompactStat({ label, value, sub, tone, live }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-4 py-3 flex items-center justify-between gap-2">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>
        <p
          className={cn(
            'mono text-[20px] font-bold leading-tight mt-0.5',
            tone === 'success' && 'text-[var(--success)]',
            tone === 'warn' && 'text-[var(--warning)]',
            !tone && 'text-[var(--text-primary)]'
          )}
        >
          {value}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {live && <Loader2 className="h-3 w-3 animate-spin text-[var(--accent)]" />}
        {sub && <span className="text-[11px] font-medium text-[var(--text-tertiary)]">{sub}</span>}
      </div>
    </div>
  )
}

/* ── Live progress banner ──────────────────────────────────────────── */

function MatchProgress({ progress, running, error }) {
  const p = progress || {}
  const isAi = p.phase === 'ai'
  const pct = isAi && p.total ? Math.round((p.done / p.total) * 100) : null
  const hasTally = p.matched != null
  const phaseLabel = error
    ? 'Matching failed'
    : p.phase === 'starting'
      ? 'Starting engine…'
      : p.phase === 'loaded'
        ? `Loaded ${p.bankTx ?? 0} transactions · ${p.loans ?? 0} loans`
      : p.phase === 'classified'
        ? `Classified ${p.bankTx ?? 0} rows${p.total ? ` · AI refining ${p.total}` : ''}`
      : p.phase === 'ai'
        ? `AI step ${p.done ?? 0} / ${p.total ?? 0}`
      : p.phase === 'done'
        ? 'Saving results…'
      : 'Matching in progress…'

  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border px-5 py-4',
        error
          ? 'border-[var(--danger-border)] bg-[var(--danger-bg)]'
          : 'border-[var(--accent-border)] bg-[var(--accent-subtle)]'
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-[14px] font-medium text-[var(--text-primary)]">
          {running && !error && <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)] shrink-0" />}
          {error ? error : phaseLabel}
        </div>
        {pct != null && <span className="mono text-[13px] font-bold text-[var(--accent)]">{pct}%</span>}
      </div>

      {hasTally && !error && (
        <div className="mt-3 flex items-center gap-3">
          <LiveCount label="Matched" value={p.matched} tone="success" />
          <LiveCount label="Unmatched" value={p.unmatched ?? 0} tone="warn" />
        </div>
      )}

      {pct != null && (
        <div className="mt-3 h-2 rounded-full bg-[var(--bg-card)]/80 overflow-hidden">
          <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}

function LiveCount({ label, value, tone }) {
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-light)] px-3 py-1.5">
      <span
        className={cn(
          'mono text-[15px] font-bold',
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
