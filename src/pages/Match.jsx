import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  FileText,
  Play,
  RotateCcw,
  Sparkles,
  Search,
  X,
  Filter,
  AlertCircle,
  HelpCircle,
  Layers,
  Building2,
  Tag,
} from 'lucide-react'
import * as api from '@/lib/api'
import { confidenceVariant } from '@/lib/matcher'
import { bucketVariant, CONFIDENCE_BUCKET_LABELS, resolveConfidenceBucket } from '@/lib/confidenceBucket'
import { useAuth } from '@/context/AuthContext'
import { useMatchingProgress } from '@/context/MatchingProgressContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { PageLoader } from '@/components/PageLoader'
import { WorkflowStepper } from '@/components/WorkflowStepper'
import { MatchReviewDrawer, STATUS_META } from '@/components/MatchReviewDrawer'
import { MatchScopePanel } from '@/components/MatchScopePanel'
import { formatCurrency, formatDate, toDateKey, cn } from '@/lib/utils'
import { exportAllTransactions } from '@/lib/transactionExport'
import {
  buildNarrationBuckets,
  rowMatchesNarrationBucket,
} from '@/lib/narrationBucket'

const BUCKET_DEFINITIONS = [
  {
    key: 'all',
    label: 'All Buckets',
    desc: 'All categorized transactions',
    color: 'text-[var(--text-primary)]',
    dotColor: 'bg-[var(--text-tertiary)]',
    activeBg: 'bg-[var(--accent)] text-white shadow-sm',
    badgeVariant: 'default',
  },
  {
    key: 'same_person',
    label: 'Same Person',
    desc: '≥ 95% confidence — full match',
    color: 'text-emerald-700 dark:text-emerald-400',
    dotColor: 'bg-emerald-500',
    activeBg: 'bg-emerald-700 text-white shadow-sm',
    badgeVariant: 'on_track',
  },
  {
    key: 'very_likely_match',
    label: 'Very Likely',
    desc: '85% – 94% confidence',
    color: 'text-sky-700 dark:text-sky-400',
    dotColor: 'bg-sky-500',
    activeBg: 'bg-sky-700 text-white shadow-sm',
    badgeVariant: 'posted',
  },
  {
    key: 'possible_review',
    label: 'Needs Review',
    desc: '70% – 84% confidence',
    color: 'text-amber-700 dark:text-amber-400',
    dotColor: 'bg-amber-500',
    activeBg: 'bg-amber-700 text-white shadow-sm',
    badgeVariant: 'pending',
  },
  {
    key: 'different_person',
    label: 'Different Person',
    desc: '< 70% confidence — unmatched',
    color: 'text-rose-700 dark:text-rose-400',
    dotColor: 'bg-rose-500',
    activeBg: 'bg-rose-700 text-white shadow-sm',
    badgeVariant: 'exception',
  },
]

const STATUS_FILTERS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'matched', label: 'Matched' },
  { value: 'exception', label: 'Unmatched' },
  { value: 'pending', label: 'Pending' },
]

function rowSource(t) {
  return (
    t.employer_name ||
    t.employerOrBank ||
    t.employer_or_bank ||
    (t.source_filename ? String(t.source_filename).replace(/\.pdf$/i, '') : null)
  )
}

function rowStatus(t) {
  const s = String(t.status || t.review_status || '').toLowerCase()
  if (s === 'matched' || s === 'posted' || s === 'confirmed' || s === 'auto_matched') return 'matched'
  if (s === 'exception' || s === 'unmatched') return 'exception'
  if (s === 'pending' || s === 'needs_review') return 'pending'
  return s || 'pending'
}

/** Stack filters so confidence → narration → status → source all AND together. */
function applyStackedFilters(rows, { bucket = 'all', narration = 'all', status = 'all', source = 'all' } = {}) {
  let list = rows
  if (bucket !== 'all') {
    list = list.filter((t) => resolveConfidenceBucket(t) === bucket)
  }
  if (narration !== 'all') {
    list = list.filter((t) => rowMatchesNarrationBucket(t, narration))
  }
  if (status !== 'all') {
    list = list.filter((t) => rowStatus(t) === status)
  }
  if (source !== 'all') {
    list = list.filter((t) => rowSource(t) === source)
  }
  return list
}

export function Match() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const focusFile = searchParams.get('file')?.trim() || null
  const [transactions, setTransactions] = useState([])
  const [summary, setSummary] = useState({ activeLoans: 0, bankTransactions: 0, matched: 0, needsReview: 0, unmatched: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [bucketFilter, setBucketFilter] = useState('all')
  const [narrationFilter, setNarrationFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
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

  // Narration buckets are file-scoped — clear selection when the file set changes
  useEffect(() => {
    setNarrationFilter('all')
  }, [focusFile, viewScope.tab, viewScope.fileNames])

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

  const bucketCounts = useMemo(() => {
    const res = {
      all: scopedTransactions.length,
      same_person: 0,
      very_likely_match: 0,
      possible_review: 0,
      different_person: 0,
    }
    for (const t of scopedTransactions) {
      const b = resolveConfidenceBucket(t)
      if (res[b] !== undefined) res[b] += 1
    }
    return res
  }, [scopedTransactions])

  // Narration chips are scoped to the selected confidence bucket
  const afterConfidence = useMemo(
    () => applyStackedFilters(scopedTransactions, { bucket: bucketFilter }),
    [scopedTransactions, bucketFilter]
  )

  const afterConfidenceAndNarration = useMemo(
    () => applyStackedFilters(afterConfidence, { narration: narrationFilter }),
    [afterConfidence, narrationFilter]
  )

  const narrationBuckets = useMemo(
    () =>
      buildNarrationBuckets(afterConfidence, {
        minCount: bucketFilter === 'all' ? 2 : 1,
        maxBuckets: 14,
      }),
    [afterConfidence, bucketFilter]
  )

  // Status counts follow confidence + narration (the filters above)
  const statusCounts = useMemo(() => {
    const base = applyStackedFilters(afterConfidenceAndNarration, { source: sourceFilter })
    return {
      all: base.length,
      matched: base.filter((t) => rowStatus(t) === 'matched').length,
      pending: base.filter((t) => rowStatus(t) === 'pending').length,
      exception: base.filter((t) => rowStatus(t) === 'exception').length,
    }
  }, [afterConfidenceAndNarration, sourceFilter])

  const sourceCounts = useMemo(() => {
    const map = new Map()
    for (const t of afterConfidenceAndNarration) {
      const src = rowSource(t)
      if (src && src !== '—') map.set(src, (map.get(src) || 0) + 1)
    }
    return map
  }, [afterConfidenceAndNarration])

  const availableSources = useMemo(() => [...sourceCounts.keys()].sort(), [sourceCounts])

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

  // Drop a narration chip that no longer exists inside the selected confidence bucket
  useEffect(() => {
    if (narrationFilter === 'all') return
    const stillValid = afterConfidence.some((t) => rowMatchesNarrationBucket(t, narrationFilter))
    if (!stillValid) setNarrationFilter('all')
  }, [afterConfidence, narrationFilter])

  useEffect(() => {
    if (sourceFilter === 'all') return
    if (!availableSources.includes(sourceFilter)) setSourceFilter('all')
  }, [availableSources, sourceFilter])

  useEffect(() => {
    if (statusFilter === 'all') return
    if ((statusCounts[statusFilter] ?? 0) === 0) setStatusFilter('all')
  }, [statusCounts, statusFilter])

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
    let list = applyStackedFilters(scopedTransactions, {
      bucket: bucketFilter,
      narration: narrationFilter,
      status: statusFilter,
      source: sourceFilter,
    })

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      list = list.filter((t) => {
        const searchTarget = [
          t.payer,
          t.transaction_description,
          t.description,
          t.matched_borrower_name,
          t.reference,
          t.borrower_loandisk_id,
          t.amount ? String(t.amount) : '',
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return searchTarget.includes(q)
      })
    }

    const order = { pending: 0, exception: 1, matched: 2 }
    return [...list].sort((a, b) => (order[rowStatus(a)] ?? 9) - (order[rowStatus(b)] ?? 9))
  }, [scopedTransactions, bucketFilter, narrationFilter, statusFilter, sourceFilter, searchQuery])

  const isAnyFilterActive =
    bucketFilter !== 'all' ||
    narrationFilter !== 'all' ||
    statusFilter !== 'all' ||
    sourceFilter !== 'all' ||
    !!searchQuery.trim()

  const activeNarrationLabel = useMemo(() => {
    if (narrationFilter === 'all') return null
    return narrationBuckets.find((b) => b.key === narrationFilter)?.label || narrationFilter
  }, [narrationFilter, narrationBuckets])

  const activeBucketLabel =
    bucketFilter === 'all' ? null : BUCKET_DEFINITIONS.find((b) => b.key === bucketFilter)?.label || bucketFilter

  const activeStatusLabel =
    statusFilter === 'all' ? null : STATUS_FILTERS.find((f) => f.value === statusFilter)?.label || statusFilter

  function selectBucket(key) {
    setBucketFilter((prev) => (key !== 'all' && prev === key ? 'all' : key))
    setStatusFilter('all')
  }

  function selectNarration(key) {
    setNarrationFilter(key)
    setStatusFilter('all')
  }

  function selectStatus(key) {
    setStatusFilter((prev) => (prev === key ? 'all' : key))
  }

  function resetAllFilters() {
    setBucketFilter('all')
    setNarrationFilter('all')
    setStatusFilter('all')
    setSourceFilter('all')
    setSearchQuery('')
  }

  const tableColumns = useMemo(
    () => [
      {
        key: 'date',
        label: 'Date',
        filterType: 'date',
        sortAccessor: (row) => toDateKey(row.date) || '',
        filterAccessor: (row) => row.date,
        render: (row) => <span className="text-[var(--text-secondary)]">{formatDate(row.date)}</span>,
      },
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
      {
        key: 'transaction_description',
        label: 'Description',
        filterAccessor: (row) =>
          [row.transaction_description, row.description].filter(Boolean).join(' '),
        render: (row) => (
          <span className="text-[var(--text-secondary)] truncate max-w-[220px] inline-block" title={row.transaction_description || row.description}>
            {row.transaction_description || '—'}
          </span>
        ),
      },
      {
        key: 'payer',
        label: 'Name',
        filterAccessor: (row) =>
          [row.payer, row.transaction_description, row.description, row.matched_borrower_name]
            .filter(Boolean)
            .join(' '),
        render: (row) => <span className="font-medium">{row.payer || row.transaction_description || '—'}</span>,
      },
      { key: 'amount', label: 'Amount', align: 'right', render: (row) => formatCurrency(row.amount) },
      {
        key: 'status',
        label: 'Status',
        filterAccessor: (row) =>
          [row.status, STATUS_META[row.status]?.label].filter(Boolean).join(' '),
        render: (row) => (
          <Badge variant={STATUS_META[row.status]?.variant || 'pending'}>{STATUS_META[row.status]?.label || row.status}</Badge>
        ),
      },
      {
        key: 'confidence_bucket',
        label: 'Bucket',
        filterAccessor: (row) => {
          const bucket = resolveConfidenceBucket(row)
          return [bucket, CONFIDENCE_BUCKET_LABELS[bucket]].filter(Boolean).join(' ')
        },
        render: (row) => {
          const bucket = resolveConfidenceBucket(row)
          return (
            <Badge variant={bucketVariant(bucket)} title={row.reasoning || undefined}>
              {CONFIDENCE_BUCKET_LABELS[bucket] || bucket}
            </Badge>
          )
        },
      },
      {
        key: 'confidence_score',
        label: 'Score',
        align: 'right',
        render: (row) =>
          row.confidence_score == null ? (
            <span className="text-[var(--text-tertiary)]">—</span>
          ) : (
            <Badge variant={confidenceVariant(row.confidence_score)} className="mono" title={row.reasoning || undefined}>
              {Math.round(row.confidence_score)}%
            </Badge>
          ),
      },
      {
        key: 'name_score',
        label: 'Name %',
        align: 'right',
        render: (row) =>
          row.name_score == null ? (
            <span className="text-[var(--text-tertiary)]">—</span>
          ) : (
            <span className="text-[12px] mono text-[var(--text-secondary)]" title={row.reasoning || ''}>
              {Math.round(row.name_score)}%
            </span>
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
    const ok = exportAllTransactions(filtered)
    if (!ok) toast.error('No transactions to export')
    else toast.success(`Exported ${filtered.length} rows`)
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
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)] tracking-tight">Match Transactions</h1>
          <p className="text-[13px] text-[var(--text-tertiary)] mt-0.5">
            Auto-reconcile bank credits & employer deductions with active borrower loans.
          </p>
        </div>
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

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <CompactStat label="Loans" value={typeof activeLoans === 'number' ? activeLoans.toLocaleString() : activeLoans} />
        <CompactStat label="Transactions" value={counts.total} />
        <CompactStat label="Matched" value={displayMatched} sub={`${counts.matchedPct}%`} tone="success" live={running && !!liveCounts} />
        <CompactStat label="Unmatched" value={displayUnmatched} sub={`${counts.unmatchedPct}%`} tone="warn" live={running && !!liveCounts} />
      </div>

      {/* ── TOP BUCKET & FILTER BAR ───────────────────────────────────────── */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-sm overflow-hidden space-y-0">
        {/* Bucket Selector Header */}
        <div className="border-b border-[var(--border-light)] bg-[var(--bg-subtle)]/40 p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-[var(--accent)]" />
              <h2 className="text-[13px] font-bold text-[var(--text-primary)] uppercase tracking-wider">
                Confidence Buckets
              </h2>
              <span className="hidden sm:inline text-[10px] font-medium text-[var(--text-tertiary)]">
                Confidence → Narration → Status
              </span>
            </div>
            {isAnyFilterActive && (
              <button
                type="button"
                onClick={resetAllFilters}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--accent)] hover:text-[var(--accent-hover)] hover:underline"
              >
                <RotateCcw className="h-3 w-3" />
                Reset all filters
              </button>
            )}
          </div>

          {/* Bucket Pills Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {BUCKET_DEFINITIONS.map((b) => {
              const active = bucketFilter === b.key
              const count = bucketCounts[b.key] ?? 0
              return (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => selectBucket(b.key)}
                  className={cn(
                    'flex flex-col items-start justify-between p-2.5 rounded-[var(--radius-md)] border text-left transition-all',
                    active
                      ? `${b.activeBg} border-transparent ring-2 ring-[var(--accent)]/30`
                      : 'bg-white border-[var(--border-light)] hover:border-[var(--border-medium)] hover:bg-[var(--bg-subtle)]/60 text-[var(--text-secondary)]'
                  )}
                >
                  <div className="flex items-center justify-between w-full gap-1 mb-1">
                    <span className="flex items-center gap-1.5 text-[12px] font-semibold truncate">
                      <span className={cn('h-2 w-2 rounded-full shrink-0', active ? 'bg-white' : b.dotColor)} />
                      {b.label}
                    </span>
                    <span
                      className={cn(
                        'mono text-[11px] font-bold px-1.5 py-0.5 rounded-full shrink-0',
                        active ? 'bg-white/20 text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-primary)]'
                      )}
                    >
                      {count.toLocaleString()}
                    </span>
                  </div>
                  <p className={cn('text-[10px] line-clamp-1 leading-tight', active ? 'text-white/80' : 'text-[var(--text-tertiary)]')}>
                    {b.desc}
                  </p>
                </button>
              )
            })}
          </div>

          {/* Dynamic narration buckets from uploaded file descriptions */}
          {narrationBuckets.length > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--border-light)]">
              <div className="flex items-center gap-2 mb-2">
                <Tag className="h-3.5 w-3.5 text-[var(--accent)]" />
                <h3 className="text-[11px] font-bold text-[var(--text-primary)] uppercase tracking-wider">
                  Narration Buckets
                </h3>
                <span className="relative group/nb inline-flex">
                  <button
                    type="button"
                    className="inline-flex text-[var(--text-tertiary)] hover:text-[var(--accent)] focus:outline-none focus-visible:text-[var(--accent)]"
                    aria-label="What are narration buckets?"
                  >
                    <HelpCircle className="h-3.5 w-3.5" />
                  </button>
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 w-72 rounded-[var(--radius-md)] border border-[var(--border-medium)] bg-[var(--text-primary)] px-2.5 py-2 text-[11px] font-medium leading-snug text-white opacity-0 shadow-[var(--shadow-md)] transition-opacity group-hover/nb:opacity-100 group-focus-within/nb:opacity-100"
                  >
                    Similar bank-statement descriptions are grouped together. They stay inside the selected confidence bucket. Click a chip to filter the grid; Matched / Unmatched counts update to that slice.
                  </span>
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)]">
                  {bucketFilter === 'all'
                    ? 'Built from this file’s descriptions — click to filter'
                    : `Inside ${activeBucketLabel} · ${afterConfidence.length.toLocaleString()} rows`}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => selectNarration('all')}
                  title="Show every transaction in the selected confidence bucket, with no narration filter"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all',
                    narrationFilter === 'all'
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-white shadow-sm'
                      : 'border-[var(--border-light)] bg-white text-[var(--text-secondary)] hover:border-[var(--border-medium)]'
                  )}
                >
                  All narrations
                  <span className={cn('mono text-[10px]', narrationFilter === 'all' ? 'text-white/90' : 'text-[var(--text-tertiary)]')}>
                    {afterConfidence.length.toLocaleString()}
                  </span>
                </button>
                {narrationBuckets.map((nb) => {
                  const active = narrationFilter === nb.key
                  return (
                    <button
                      key={nb.key}
                      type="button"
                      onClick={() => selectNarration(active ? 'all' : nb.key)}
                      title={`${nb.label} — ${nb.count.toLocaleString()} transaction${nb.count === 1 ? '' : 's'} with this narration. Click to filter; click again to clear.`}
                      className={cn(
                        'inline-flex max-w-[220px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all',
                        active
                          ? 'border-teal-700 bg-teal-700 text-white shadow-sm'
                          : 'border-[var(--border-light)] bg-white text-[var(--text-secondary)] hover:border-teal-400 hover:bg-teal-50'
                      )}
                    >
                      <span className="truncate">{nb.label}</span>
                      <span className={cn('mono shrink-0 text-[10px] font-bold', active ? 'text-white/90' : 'text-[var(--text-tertiary)]')}>
                        {nb.count.toLocaleString()}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Sub-Filters Strip (Status, Source, Search) */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-[var(--border-light)] bg-white">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mr-1 flex items-center gap-1">
              <Filter className="h-3 w-3" /> Status
            </span>
            <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)]/50 p-0.5">
              {STATUS_FILTERS.map((f) => {
                const active = statusFilter === f.value
                const count = statusCounts[f.value] ?? statusCounts.all
                const empty = f.value !== 'all' && count === 0
                return (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => selectStatus(f.value)}
                    disabled={empty}
                    title={
                      empty
                        ? `No ${f.label.toLowerCase()} rows in this confidence and narration slice`
                        : `${f.label}: ${count.toLocaleString()} in the current confidence and narration slice`
                    }
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] text-[11px] font-medium transition-all',
                      active
                        ? 'bg-white text-[var(--text-primary)] font-semibold shadow-xs'
                        : empty
                          ? 'text-[var(--text-tertiary)] opacity-45 cursor-not-allowed'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    )}
                  >
                    {f.label}
                    <span
                      className={cn(
                        'mono text-[10px]',
                        active ? 'text-[var(--accent)] font-bold' : 'text-[var(--text-tertiary)]'
                      )}
                    >
                      {count.toLocaleString()}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* Source / Entity Dropdown */}
            {availableSources.length > 1 && (
              <div className="flex items-center gap-1.5 ml-1">
                <Building2 className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
                <select
                  value={sourceFilter}
                  onChange={(e) => setSourceFilter(e.target.value)}
                  className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-app)] py-1 px-2 text-[11px] font-medium text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
                  aria-label="Filter by source or employer"
                >
                  <option value="all">All Sources ({availableSources.length})</option>
                  {availableSources.map((src) => (
                    <option key={src} value={src}>
                      {src} ({(sourceCounts.get(src) || 0).toLocaleString()})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Quick Search */}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, ref, amount…"
              className="w-full rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-app)] py-1.5 pl-8 pr-7 text-[12px] text-[var(--text-primary)] placeholder-[var(--text-tertiary)] transition-colors focus:border-[var(--accent)] focus:bg-white focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Results Counter & Table */}
        <div className="px-4 py-2 bg-[var(--bg-subtle)]/20 border-b border-[var(--border-light)] flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
          <span className="flex flex-wrap items-center gap-1.5 min-w-0">
            Showing <strong className="text-[var(--text-primary)]">{filtered.length.toLocaleString()}</strong> of{' '}
            {scopedTransactions.length.toLocaleString()} transactions
            {isAnyFilterActive && (
              <span className="inline-flex flex-wrap items-center gap-1 ml-1">
                {activeBucketLabel && (
                  <ActiveChip
                    label={activeBucketLabel}
                    onClear={() => selectBucket('all')}
                    className="bg-[var(--accent-subtle)] text-[var(--accent)]"
                  />
                )}
                {activeNarrationLabel && (
                  <ActiveChip
                    label={activeNarrationLabel}
                    onClear={() => selectNarration('all')}
                    className="bg-teal-50 text-teal-800"
                  />
                )}
                {activeStatusLabel && (
                  <ActiveChip
                    label={activeStatusLabel}
                    onClear={() => selectStatus('all')}
                    className="bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
                  />
                )}
                {sourceFilter !== 'all' && (
                  <ActiveChip
                    label={sourceFilter}
                    onClear={() => setSourceFilter('all')}
                    className="bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
                  />
                )}
                {searchQuery.trim() && (
                  <ActiveChip
                    label={`“${searchQuery.trim()}”`}
                    onClear={() => setSearchQuery('')}
                    className="bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
                  />
                )}
              </span>
            )}
          </span>
          {statusCounts.pending > 0 && (
            <span className="text-[var(--warning)] font-medium shrink-0">
              {statusCounts.pending.toLocaleString()} pending matching
            </span>
          )}
        </div>

        <DataTable
          key={`${bucketFilter}|${narrationFilter}|${statusFilter}|${sourceFilter}`}
          data={filtered}
          columns={tableColumns}
          pageSize={25}
          sortable
          filterable
          onRowClick={(row) => setDetailTx(row)}
          emptyMessage={scopedTransactions.length === 0 ? 'No transactions yet' : 'No matching records found'}
          emptyDescription={
            scopedTransactions.length === 0
              ? 'Upload statements, then run matching above.'
              : 'This slice has no rows. Clear a filter above, or reset all filters.'
          }
          emptyAction={
            scopedTransactions.length === 0 ? (
              <Link to="/ingest">
                <Button variant="secondary" size="sm">Upload</Button>
              </Link>
            ) : isAnyFilterActive ? (
              <Button variant="secondary" size="sm" onClick={resetAllFilters}>
                Clear filters
              </Button>
            ) : null
          }
        />
      </div>

      <MatchReviewDrawer tx={detailTx} user={user} onClose={() => setDetailTx(null)} onResolved={onResolved} />
    </div>
  )
}

function ActiveChip({ label, onClear, className }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title={`Clear ${label}`}
      className={cn(
        'inline-flex max-w-[180px] items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors hover:opacity-80',
        className
      )}
    >
      <span className="truncate">{label}</span>
      <X className="h-2.5 w-2.5 shrink-0 opacity-70" />
    </button>
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

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer select-none text-[12px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(e) => onUseAiChange(e.target.checked)}
              disabled={running}
              className="rounded border-[var(--border-medium)] text-[var(--accent)] focus:ring-[var(--accent)]"
            />
            <span className="flex items-center gap-1 font-medium">
              <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" /> AI assistance
            </span>
          </label>

          <Button
            variant="default"
            size="sm"
            onClick={onRun}
            disabled={running || file.total === 0}
            className="gap-1.5 shadow-sm"
          >
            {running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Matching…
              </>
            ) : (
              <>
                <Play className="h-4 w-4 fill-current" />
                {completed ? 'Re-run match' : 'Run matching'}
              </>
            )}
          </Button>

          <button
            type="button"
            onClick={onClear}
            className="h-8 w-8 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-white flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:border-[var(--border-medium)]"
            title="Show all files"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

function MatchProgress({ progress, running, error }) {
  if (error) {
    return (
      <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-[13px] text-[var(--danger)] flex items-center gap-2">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{error}</span>
      </div>
    )
  }
  if (!running || !progress) return null

  const pct = progress.total > 0 ? Math.round(((progress.processed || 0) / progress.total) * 100) : 0

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--accent-border)] bg-[var(--accent-subtle)] p-3 space-y-2">
      <div className="flex items-center justify-between text-[12px]">
        <span className="font-semibold text-[var(--accent)] flex items-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {progress.phase === 'indexing' ? 'Indexing borrowers…' : 'Running matching algorithm…'}
        </span>
        <span className="mono font-semibold text-[var(--text-primary)]">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white overflow-hidden">
        <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-[var(--text-secondary)]">
        <span>
          Processed {progress.processed ?? 0} of {progress.total ?? 0}
        </span>
        <span>
          Matched: <strong className="text-[var(--success)]">{progress.matched ?? 0}</strong> · Unmatched:{' '}
          <strong className="text-[var(--warning)]">{progress.unmatched ?? 0}</strong>
        </span>
      </div>
    </div>
  )
}

function CompactStat({ label, value, sub, tone, live }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3.5 py-2.5 shadow-xs">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</span>
        {live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-[18px] font-bold text-[var(--text-primary)] tracking-tight mono">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </span>
        {sub && (
          <span
            className={cn(
              'text-[11px] font-semibold mono',
              tone === 'success' && 'text-[var(--success)]',
              tone === 'warn' && 'text-[var(--warning)]'
            )}
          >
            {sub}
          </span>
        )}
      </div>
    </div>
  )
}
