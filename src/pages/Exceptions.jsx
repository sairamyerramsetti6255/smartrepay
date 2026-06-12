import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { confidenceVariant } from '@/lib/matcher'
import { PageHeader } from '@/components/PageHeader'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/Badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card } from '@/components/Card'
import { PageLoader } from '@/components/PageLoader'
import { WorkflowStepper } from '@/components/WorkflowStepper'
import { MatchReviewDrawer, STATUS_META } from '@/components/MatchReviewDrawer'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { exportUnmatchedTransactions } from '@/lib/transactionExport'

const FILTERS = [
  { value: 'open', label: 'Needs action' },
  { value: 'exception', label: 'Unmatched' },
  { value: 'pending', label: 'Needs review' },
  { value: 'all', label: 'All' },
]

export function Exceptions() {
  const { user } = useAuth()
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState('open')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)

  async function load({ silent } = {}) {
    if (silent) setRefreshing(true)
    else setLoading(true)
    try {
      const { transactions: rows } = await api.sqlMatch.results()
      setTransactions(Array.isArray(rows) ? rows : [])
    } catch (e) {
      toast.error(e.message)
      setTransactions([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  // Everything that is not a confirmed match is part of the unmatched queue.
  const queue = useMemo(
    () => transactions.filter((t) => t.status === 'exception' || t.status === 'pending'),
    [transactions]
  )

  const filtered = useMemo(() => {
    let list = queue
    if (filter === 'exception') list = list.filter((t) => t.status === 'exception')
    else if (filter === 'pending') list = list.filter((t) => t.status === 'pending')
    // 'open' and 'all' both show the full unmatched queue here
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter((t) =>
        [t.payer, t.matched_borrower_name, t.reference, t.source_filename]
          .some((v) => String(v ?? '').toLowerCase().includes(q))
      )
    }
    const order = { pending: 0, exception: 1 }
    return [...list].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
  }, [queue, filter, search])

  const counts = useMemo(
    () => ({
      open: queue.length,
      exception: queue.filter((t) => t.status === 'exception').length,
      pending: queue.filter((t) => t.status === 'pending').length,
      all: queue.length,
    }),
    [queue]
  )

  const columns = [
    { key: 'date', label: 'Date', render: (t) => <span className="text-[var(--text-secondary)]">{formatDate(t.date)}</span> },
    { key: 'payer', label: 'Payer', render: (t) => <span className="font-medium">{t.payer || '—'}</span> },
    { key: 'amount', label: 'Amount', align: 'right', render: (t) => formatCurrency(t.amount) },
    {
      key: 'status',
      label: 'Status',
      render: (t) => <Badge variant={STATUS_META[t.status]?.variant || 'exception'}>{STATUS_META[t.status]?.label || t.status}</Badge>,
    },
    {
      key: 'confidence_score',
      label: 'Score',
      align: 'right',
      render: (t) =>
        t.confidence_score == null ? (
          <span className="text-[var(--text-tertiary)]">—</span>
        ) : (
          <Badge variant={confidenceVariant(t.confidence_score)} className="mono">
            {Math.round(t.confidence_score)}%
          </Badge>
        ),
    },
    {
      key: 'matched_borrower_name',
      label: 'Suggested borrower',
      render: (t) =>
        t.matched_borrower_name ? (
          <span className="text-[var(--text-secondary)]">{t.matched_borrower_name}</span>
        ) : (
          <span className="text-[var(--text-tertiary)]">—</span>
        ),
    },
    {
      key: 'actions',
      label: '',
      render: (t) => (
        <button
          type="button"
          className="text-[13px] font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]"
          onClick={(e) => {
            e.stopPropagation()
            setSelected(t)
          }}
        >
          Review →
        </button>
      ),
    },
  ]

  function exportExcel() {
    const ok = exportUnmatchedTransactions(filtered)
    if (!ok) toast.error('No unmatched transactions to export')
    else toast.success(`Exported ${filtered.length} unmatched rows`)
  }

  async function onResolved() {
    setSelected(null)
    await load({ silent: true })
  }

  if (loading) return <PageLoader label="Loading unmatched queue from SQL…" />

  return (
    <div className="space-y-6">
      <WorkflowStepper current="review" />

      <PageHeader
        eyebrow="Step 3 of 4"
        title="Unmatched Queue"
        subtitle="Resolve payments that could not be matched automatically — read directly from SQL Server."
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {refreshing && <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />}
            <Button variant="secondary" size="sm" onClick={() => load({ silent: true })} disabled={refreshing}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="secondary" size="sm" onClick={exportExcel} disabled={!filtered.length}>
              <FileSpreadsheet className="h-4 w-4" />
              Export Unmatched
            </Button>
          </div>
        }
      />

      <Card className="flex h-[72px] items-stretch overflow-hidden">
        <QueueMetric label="In queue" value={counts.open} color="var(--text-primary)" />
        <div className="w-px bg-[var(--border-light)]" />
        <QueueMetric label="Unmatched" value={counts.exception} color="var(--danger)" />
        <div className="w-px bg-[var(--border-light)]" />
        <QueueMetric label="Needs review" value={counts.pending} color="var(--warning)" />
      </Card>

      <div className="flex flex-wrap items-center gap-2 justify-between">
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
              <span className="ml-1.5 opacity-70">{counts[f.value] ?? counts.all}</span>
            </button>
          ))}
        </div>
        <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-48" />
      </div>

      <DataTable
        data={filtered}
        columns={columns}
        pageSize={25}
        sortable
        filterable
        onRowClick={(t) => setSelected(t)}
        emptyMessage={queue.length === 0 ? 'No unmatched transactions in SQL' : 'Nothing in this filter'}
        emptyDescription={
          queue.length === 0 ? 'Everything staged has been matched, or no documents are staged yet.' : 'Try another filter'
        }
      />

      <MatchReviewDrawer tx={selected} user={user} onClose={() => setSelected(null)} onResolved={onResolved} />
    </div>
  )
}

function QueueMetric({ label, value, color }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6">
      <p className="text-2xl font-bold mono" style={{ color }}>
        {value}
      </p>
      <p className="text-xs text-[var(--text-tertiary)] mt-1">{label}</p>
    </div>
  )
}
