import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import {
  ArrowRight,
  CheckCircle2,
  Download,
  FileText,
  HelpCircle,
  Loader2,
  RefreshCw,
  Upload,
  User,
  XCircle,
} from 'lucide-react'
import * as api from '@/lib/api'
import { explainMatch, confidenceVariant, confidenceLabel } from '@/lib/matcher'
import { writeAuditLog } from '@/lib/audit'
import { useAuth } from '@/context/AuthContext'
import { useTransactions } from '@/hooks/useTransactions'
import { useBorrowers } from '@/hooks/useBorrowers'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/Badge'
import { EmptyState } from '@/components/EmptyState'
import { PageLoader } from '@/components/PageLoader'
import { formatCurrency, formatDate, cn, toUuidOrNull } from '@/lib/utils'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'matched', label: 'Matched' },
  { value: 'exception', label: 'Unmatched' },
]

const STATUS_META = {
  pending: { label: 'Pending', variant: 'pending', icon: HelpCircle },
  matched: { label: 'Matched', variant: 'matched', icon: CheckCircle2 },
  exception: { label: 'Unmatched', variant: 'exception', icon: XCircle },
  posted: { label: 'Posted', variant: 'posted', icon: CheckCircle2 },
}

export function Match() {
  const { user } = useAuth()
  const { transactions, loading: txLoading, refreshing: txRefreshing, error: txError, refetch } = useTransactions()
  const { borrowers, loans, loading: brLoading, refreshing: brRefreshing, error: brError, refetch: refetchBorrowers, syncFromLoanDisk } = useBorrowers()
  const [selectedId, setSelectedId] = useState(null)
  const [filter, setFilter] = useState('all')
  const [running, setRunning] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [ldStatus, setLdStatus] = useState(null)
  const [documents, setDocuments] = useState([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [documentFilter, setDocumentFilter] = useState(null)

  const initialLoading = txLoading || brLoading
  const refreshing = txRefreshing || brRefreshing
  const error = txError || brError

  const filtered = useMemo(() => {
    let list = filter === 'all' ? transactions : transactions.filter((t) => t.status === filter)
    if (documentFilter) list = list.filter((t) => t.source_document_id === documentFilter)
    const order = { pending: 0, matched: 1, exception: 2, posted: 3 }
    return [...list].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
  }, [transactions, filter, documentFilter])

  const visibleList = useMemo(() => filtered.slice(0, 150), [filtered])

  const counts = useMemo(
    () => ({
      all: transactions.length,
      pending: transactions.filter((t) => t.status === 'pending').length,
      matched: transactions.filter((t) => t.status === 'matched').length,
      exception: transactions.filter((t) => t.status === 'exception').length,
    }),
    [transactions]
  )

  const selected = filtered.find((t) => t.id === selectedId) || filtered[0]

  const selectedMatch = useMemo(() => {
    if (!selected || !borrowers.length) {
      return { borrower: null, loan: null, score: 0, method: 'none', reasons: [], exactReason: null }
    }
    if (selected.matched_borrower_id) {
      const borrower = borrowers.find((b) => b.id === selected.matched_borrower_id) || null
      const loan = borrower ? loans.find((l) => l.borrower_id === borrower.id) : null
      const explained = borrower ? explainMatch(selected, [borrower]) : { reasons: [], method: 'exact' }
      return {
        borrower,
        loan,
        score: selected.confidence_score || explained.score || 0,
        method: explained.method,
        reasons: explained.reasons,
        exactReason: explained.exactReason,
      }
    }
    const explained = explainMatch(selected, borrowers)
    const loan = explained.borrower ? loans.find((l) => l.borrower_id === explained.borrower.id) : null
    return { ...explained, loan }
  }, [selected, borrowers, loans])

  useEffect(() => {
    if (filtered[0] && !selectedId) setSelectedId(filtered[0].id)
  }, [filtered, selectedId])

  useEffect(() => {
    const onLoaded = () => {
      refetch()
      refetchBorrowers()
      loadDocuments()
    }
    window.addEventListener('smartrepay:demo-loaded', onLoaded)
    return () => window.removeEventListener('smartrepay:demo-loaded', onLoaded)
  }, [refetch, refetchBorrowers])

  useEffect(() => {
    api.loandisk.status().then(setLdStatus).catch(() => setLdStatus({ ok: false }))
  }, [])

  useEffect(() => {
    loadDocuments()
  }, [])

  async function loadDocuments() {
    setDocsLoading(true)
    try {
      const docs = await api.documents.list()
      setDocuments(Array.isArray(docs) ? docs : [])
    } catch {
      setDocuments([])
    } finally {
      setDocsLoading(false)
    }
  }

  async function downloadDoc(doc) {
    try {
      await api.documents.download(doc.id, doc.filename)
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function resetData() {
    if (!window.confirm('Clear all transactions, borrowers, loans, and unmatched items?')) return
    try {
      await api.data.reset()
      toast.success('All data cleared')
      setSelectedId(null)
      refetch()
      refetchBorrowers()
      loadDocuments()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function syncLoanDisk() {
    setSyncing(true)
    try {
      const result = await syncFromLoanDisk()
      toast.success(`Synced ${result.synced} borrowers`)
      refetchBorrowers()
      setLdStatus(await api.loandisk.status())
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSyncing(false)
    }
  }

  async function runMatching() {
    setRunning(true)
    try {
      const result = await api.matching.run()
      if (result.message && result.matched === 0 && result.excepted === 0) {
        toast.error(result.message)
      } else {
        const via = result.searchSource === 'BorrowerSerch' ? ' via LoanDisk search' : ''
        toast.success(`${result.matched} matched, ${result.excepted} unmatched${via}`)
      }
      refetch()
      refetchBorrowers()
      loadDocuments()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }

  async function confirmOne() {
    if (!selectedMatch.borrower) return toast.error('No borrower match')
    await api.transactions.update(selected.id, {
      status: 'matched',
      confidence_score: selectedMatch.score,
      matched_borrower_id: toUuidOrNull(selectedMatch.borrower.id),
      loan_id: toUuidOrNull(selectedMatch.loan?.id),
      action: 'confirm_match',
    })
    await writeAuditLog({
      entity: 'transaction',
      entityId: selected.id,
      action: 'confirm_match',
      actor: user.email,
      priorValue: null,
      newValue: { borrower: selectedMatch.borrower.id },
    })
    toast.success('Match confirmed')
    refetch()
    loadDocuments()
  }

  async function sendToExceptions() {
    await api.transactions.update(selected.id, { status: 'exception', action: 'send_to_queue' })
    await api.exceptions.create({ transaction_id: selected.id, type: 'unmatched', assigned_to: user.email })
    toast.success('Sent to unmatched queue')
    refetch()
    loadDocuments()
  }

  function listScore(tx) {
    if (tx.confidence_score) return tx.confidence_score
    if (tx.id === selected?.id) return selectedMatch.score
    return null
  }

  if (initialLoading) return <PageLoader label="Loading transactions and borrowers…" />

  return (
    <div className="space-y-5">
      <PageHeader
        title="Match Transactions"
        subtitle="LoanDisk BorrowerSerch matches payer names to borrowers — review why each payment matched or didn't."
        actions={
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {refreshing && <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />}
            <Button variant="secondary" size="sm" onClick={resetData} disabled={syncing || running}>
              Reset
            </Button>
            <Button variant="secondary" size="sm" onClick={syncLoanDisk} disabled={syncing || running}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync
            </Button>
            <Button size="sm" onClick={runMatching} disabled={running || syncing}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Run Matching
            </Button>
          </div>
        }
      />

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total" value={counts.all} />
        <StatCard label="Pending" value={counts.pending} accent />
        <StatCard label="Matched" value={counts.matched} success />
        <StatCard label="Unmatched" value={counts.exception} warn sub={ldStatus?.ok ? 'LoanDisk connected' : 'Sync LoanDisk'} />
      </div>

      {/* Documents */}
      {documents.length > 0 && (
        <section className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Uploaded documents</h2>
            {documentFilter && (
              <button type="button" onClick={() => setDocumentFilter(null)} className="text-[12px] text-[var(--accent)] hover:underline">
                Clear filter
              </button>
            )}
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {docsLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
            ) : (
              documents.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => setDocumentFilter(doc.id === documentFilter ? null : doc.id)}
                  className={cn(
                    'shrink-0 w-[240px] rounded-[var(--radius-md)] border p-3 text-left transition-colors',
                    documentFilter === doc.id
                      ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
                      : 'border-[var(--border-light)] bg-[var(--bg-subtle)] hover:border-[var(--border-medium)]'
                  )}
                >
                  <div className="flex items-start gap-2">
                    <FileText className="h-4 w-4 mt-0.5 shrink-0 text-[var(--accent)]" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] font-medium text-[var(--text-primary)] truncate">{doc.filename}</p>
                      <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                        {doc.date_from ? formatDate(doc.date_from) : '—'}
                      </p>
                      <div className="flex gap-3 mt-2 text-[11px]">
                        <span className="text-[var(--success)] font-medium">{doc.matched_count ?? 0} matched</span>
                        <span className="text-[var(--danger)] font-medium">{doc.unmatched_count ?? 0} unmatched</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        downloadDoc(doc)
                      }}
                      className="p-1 rounded hover:bg-[var(--bg-hover)]"
                    >
                      <Download className="h-3.5 w-3.5 text-[var(--text-tertiary)]" />
                    </button>
                  </div>
                </button>
              ))
            )}
          </div>
        </section>
      )}

      {/* Filters */}
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

      {/* Main panel */}
      <div className="card overflow-hidden min-h-[560px] flex flex-col lg:flex-row">
        {/* Transaction list */}
        <div className="lg:w-[340px] shrink-0 border-b lg:border-b-0 lg:border-r border-[var(--border-light)] max-h-[320px] lg:max-h-none overflow-y-auto">
          {filtered.length === 0 ? (
            <EmptyState
              icon={Upload}
              title={counts.all === 0 ? 'No transactions' : 'Nothing in this filter'}
              description={counts.all === 0 ? 'Import a statement first' : 'Try another tab'}
              action={
                counts.all === 0 ? (
                  <Link to="/ingest">
                    <Button variant="secondary" size="sm">Go to Ingest</Button>
                  </Link>
                ) : null
              }
            />
          ) : (
            visibleList.map((tx) => {
              const score = listScore(tx)
              const meta = STATUS_META[tx.status] || STATUS_META.pending
              const Icon = meta.icon
              return (
                <button
                  key={tx.id}
                  type="button"
                  onClick={() => setSelectedId(tx.id)}
                  className={cn(
                    'w-full text-left px-4 py-3 border-b border-[var(--border-light)] transition-colors',
                    selected?.id === tx.id && 'bg-[var(--accent-subtle)] border-l-[3px] border-l-[var(--accent)] pl-[13px]'
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', tx.status === 'matched' ? 'text-[var(--success)]' : tx.status === 'exception' ? 'text-[var(--warning)]' : 'text-[var(--text-tertiary)]')} />
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2">
                        <p className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{tx.payer || '—'}</p>
                        <p className="mono text-[13px] font-semibold shrink-0">{formatCurrency(tx.amount)}</p>
                      </div>
                      <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 truncate">
                        {formatDate(tx.date)}
                        {tx.source_filename ? ` · ${tx.source_filename}` : ''}
                      </p>
                    </div>
                    {score != null && (
                      <Badge variant={confidenceVariant(score)} className="shrink-0 text-[10px] h-5">
                        {Math.round(score)}%
                      </Badge>
                    )}
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Detail panel */}
        <div className="flex-1 overflow-y-auto">
          {selected ? (
            <div className="p-6 lg:p-8 space-y-6">
              {/* Header */}
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant={STATUS_META[selected.status]?.variant || 'pending'}>
                      {STATUS_META[selected.status]?.label || selected.status}
                    </Badge>
                    {selectedMatch.score > 0 && (
                      <Badge variant={confidenceVariant(selectedMatch.score)}>
                        {Math.round(selectedMatch.score)}% confidence
                      </Badge>
                    )}
                  </div>
                  <h2 className="text-xl font-bold text-[var(--text-primary)]">{selected.payer || 'Unknown payer'}</h2>
                  <p className="mono text-2xl font-bold text-[var(--accent)] mt-1">{formatCurrency(selected.amount)}</p>
                </div>
                <div className="text-right text-[12px] text-[var(--text-tertiary)]">
                  <p>{formatDate(selected.date)}</p>
                  {selected.source_filename && <p className="mt-0.5 truncate max-w-[200px]">{selected.source_filename}</p>}
                </div>
              </div>

              {/* Side-by-side comparison */}
              <div className="grid md:grid-cols-[1fr_auto_1fr] gap-4 items-stretch">
                <CompareCard
                  title="Imported payment"
                  icon={Upload}
                  rows={[
                    { label: 'Payer', value: selected.payer, highlight: true },
                    { label: 'Description', value: selected.description },
                    { label: 'Reference', value: selected.reference, mono: true },
                    { label: 'Amount', value: formatCurrency(selected.amount), mono: true },
                  ]}
                />
                <div className="hidden md:flex items-center justify-center">
                  <div className="flex flex-col items-center gap-1 text-[var(--text-tertiary)]">
                    <ArrowRight className="h-5 w-5" />
                    <span className="text-[10px] uppercase tracking-wider font-semibold">match</span>
                  </div>
                </div>
                <CompareCard
                  title="LoanDisk borrower"
                  icon={User}
                  empty={!selectedMatch.borrower}
                  emptyText="No borrower found"
                  rows={
                    selectedMatch.borrower
                      ? [
                          { label: 'Name', value: selectedMatch.borrower.full_name, highlight: true },
                          {
                            label: 'First / Last',
                            value: [selectedMatch.borrower.first_name, selectedMatch.borrower.last_name].filter(Boolean).join(' ') || '—',
                          },
                          { label: 'Employer', value: selectedMatch.borrower.employer },
                          { label: 'Branch', value: selectedMatch.borrower.branch_name },
                          { label: 'LoanDisk ID', value: selectedMatch.borrower.loandisk_id, mono: true },
                          { label: 'Loan #', value: selectedMatch.loan?.loan_number, mono: true },
                        ]
                      : []
                  }
                />
              </div>

              {/* Why matched */}
              <section className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-subtle)] p-5">
                <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-4">
                  Why {selected.status === 'matched' || selectedMatch.score >= 80 ? 'it matched' : selectedMatch.borrower ? 'it was suggested' : "it didn't match"}
                </h3>

                {selectedMatch.score > 0 && (
                  <div className="mb-4">
                    <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-1.5">
                      <span>{confidenceLabel(selectedMatch.score)}</span>
                      <span className="mono font-semibold">{Math.round(selectedMatch.score)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          selectedMatch.score >= 80 ? 'bg-[var(--success)]' : selectedMatch.score >= 50 ? 'bg-[var(--warning)]' : 'bg-[var(--danger)]'
                        )}
                        style={{ width: `${Math.min(100, selectedMatch.score)}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-2">
                      Method:{' '}
                      <span className="font-medium text-[var(--text-secondary)]">
                        {selectedMatch.method === 'exact'
                          ? 'Exact name match'
                          : selectedMatch.method === 'fuzzy'
                            ? 'Fuzzy search (BorrowerSerch + name similarity)'
                            : selectedMatch.method === 'partial'
                              ? 'Partial name match'
                              : 'No match'}
                      </span>
                      {selected.status === 'matched' && ' · Auto-approved (score ≥ threshold)'}
                    </p>
                  </div>
                )}

                <ul className="space-y-2">
                  {(selectedMatch.reasons?.length ? selectedMatch.reasons : [{ label: 'No details', detail: 'Run matching to search LoanDisk BorrowerSerch API', weight: 'medium' }]).map((r, i) => (
                    <li
                      key={i}
                      className="flex gap-3 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-light)] px-3 py-2.5"
                    >
                      <span
                        className={cn(
                          'shrink-0 mt-0.5 h-2 w-2 rounded-full',
                          r.weight === 'high' ? 'bg-[var(--success)]' : r.weight === 'medium' ? 'bg-[var(--warning)]' : 'bg-[var(--text-tertiary)]'
                        )}
                      />
                      <div className="min-w-0">
                        <p className="text-[12px] font-semibold text-[var(--text-primary)]">{r.label}</p>
                        <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{r.detail}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Actions */}
              {selected.status === 'pending' && (
                <div className="flex gap-2 pt-2 border-t border-[var(--border-light)]">
                  <Button onClick={confirmOne} disabled={!selectedMatch.borrower}>
                    Confirm match
                  </Button>
                  <Button variant="secondary" onClick={sendToExceptions}>
                    Send to unmatched
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <EmptyState icon={User} title="Select a transaction" description="Pick a payment from the list to see match details" />
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, accent, success, warn }) {
  return (
    <div className="card px-4 py-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>
      <p
        className={cn(
          'mono text-[24px] font-bold mt-0.5',
          accent && 'text-[var(--accent)]',
          success && 'text-[var(--success)]',
          warn && 'text-[var(--warning)]',
          !accent && !success && !warn && 'text-[var(--text-primary)]'
        )}
      >
        {value}
      </p>
      {sub && <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5">{sub}</p>}
    </div>
  )
}

function CompareCard({ title, icon: Icon, rows, empty, emptyText }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-4 h-full">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-[var(--accent)]" />
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{title}</h4>
      </div>
      {empty ? (
        <p className="text-[13px] text-[var(--text-secondary)] py-6 text-center">{emptyText}</p>
      ) : (
        <dl className="space-y-2">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-3 text-[12px]">
              <dt className="text-[var(--text-tertiary)] shrink-0">{r.label}</dt>
              <dd
                className={cn(
                  'text-right font-medium truncate',
                  r.highlight ? 'text-[var(--text-primary)] font-semibold' : 'text-[var(--text-secondary)]',
                  r.mono && 'mono text-[11px]'
                )}
              >
                {r.value || '—'}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
