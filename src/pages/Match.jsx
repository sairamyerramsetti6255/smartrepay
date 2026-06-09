import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowRight, Download, FileText, Loader2, RefreshCw, Upload, User } from 'lucide-react'
import * as api from '@/lib/api'
import { explainMatch, confidenceVariant, confidenceLabel } from '@/lib/matcher'
import { writeAuditLog } from '@/lib/audit'
import { useAuth } from '@/context/AuthContext'
import { useTransactions } from '@/hooks/useTransactions'
import { useBorrowers } from '@/hooks/useBorrowers'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { Drawer } from '@/components/Drawer'
import { PageLoader } from '@/components/PageLoader'
import { formatCurrency, formatDate, cn, toUuidOrNull } from '@/lib/utils'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'matched', label: 'Matched' },
  { value: 'exception', label: 'Unmatched' },
]

const STATUS_META = {
  pending: { label: 'Pending', variant: 'pending' },
  matched: { label: 'Matched', variant: 'matched' },
  exception: { label: 'Unmatched', variant: 'exception' },
  posted: { label: 'Posted', variant: 'posted' },
}

export function Match() {
  const { user } = useAuth()
  const { transactions, loading: txLoading, refreshing: txRefreshing, error: txError, refetch } = useTransactions()
  const { borrowers, loans, loading: brLoading, refreshing: brRefreshing, error: brError, refetch: refetchBorrowers, syncFromLoanDisk } = useBorrowers()
  const [detailTx, setDetailTx] = useState(null)
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

  const borrowerById = useMemo(() => Object.fromEntries(borrowers.map((b) => [b.id, b])), [borrowers])

  const filtered = useMemo(() => {
    let list = filter === 'all' ? transactions : transactions.filter((t) => t.status === filter)
    if (documentFilter) list = list.filter((t) => t.source_document_id === documentFilter)
    const order = { pending: 0, matched: 1, exception: 2, posted: 3 }
    return [...list].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
  }, [transactions, filter, documentFilter])

  const counts = useMemo(
    () => ({
      all: transactions.length,
      pending: transactions.filter((t) => t.status === 'pending').length,
      matched: transactions.filter((t) => t.status === 'matched').length,
      exception: transactions.filter((t) => t.status === 'exception').length,
    }),
    [transactions]
  )

  const detailMatch = useMemo(() => {
    if (!detailTx || !borrowers.length) {
      return { borrower: null, loan: null, score: 0, method: 'none', reasons: [] }
    }
    if (detailTx.matched_borrower_id) {
      const borrower = borrowerById[detailTx.matched_borrower_id] || null
      const loan = borrower ? loans.find((l) => l.borrower_id === borrower.id) : null
      const explained = borrower ? explainMatch(detailTx, [borrower]) : { reasons: [], method: 'exact' }
      return {
        borrower,
        loan,
        score: detailTx.confidence_score || explained.score || 0,
        method: explained.method,
        reasons: explained.reasons,
      }
    }
    const explained = explainMatch(detailTx, borrowers)
    const loan = explained.borrower ? loans.find((l) => l.borrower_id === explained.borrower.id) : null
    return { ...explained, loan }
  }, [detailTx, borrowers, loans, borrowerById])

  const tableColumns = useMemo(
    () => [
      {
        key: 'date',
        label: 'Date',
        render: (row) => <span className="text-[var(--text-secondary)]">{formatDate(row.date)}</span>,
      },
      {
        key: 'source_filename',
        label: 'Document',
        render: (row) => (
          <span className="truncate max-w-[160px] block text-[var(--text-secondary)]" title={row.source_filename}>
            {row.source_filename || '—'}
          </span>
        ),
      },
      {
        key: 'payer',
        label: 'Payer',
        render: (row) => <span className="font-medium">{row.payer || '—'}</span>,
      },
      {
        key: 'amount',
        label: 'Amount',
        align: 'right',
        render: (row) => formatCurrency(row.amount),
      },
      {
        key: 'status',
        label: 'Status',
        render: (row) => (
          <Badge variant={STATUS_META[row.status]?.variant || 'pending'}>
            {STATUS_META[row.status]?.label || row.status}
          </Badge>
        ),
      },
      {
        key: 'confidence_score',
        label: 'Score',
        align: 'right',
        render: (row) => {
          const score = row.confidence_score
          if (score == null) return <span className="text-[var(--text-tertiary)]">—</span>
          return (
            <Badge variant={confidenceVariant(score)} className="mono">
              {Math.round(score)}%
            </Badge>
          )
        },
      },
      {
        key: 'matched_borrower',
        label: 'Matched to',
        render: (row) => {
          const name = row.matched_borrower_id ? borrowerById[row.matched_borrower_id]?.full_name : null
          return <span className="text-[var(--text-secondary)]">{name || '—'}</span>
        },
      },
    ],
    [borrowerById]
  )

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
      setDetailTx(null)
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
    if (!detailMatch.borrower || !detailTx) return toast.error('No borrower match')
    await api.transactions.update(detailTx.id, {
      status: 'matched',
      confidence_score: detailMatch.score,
      matched_borrower_id: toUuidOrNull(detailMatch.borrower.id),
      loan_id: toUuidOrNull(detailMatch.loan?.id),
      action: 'confirm_match',
    })
    await writeAuditLog({
      entity: 'transaction',
      entityId: detailTx.id,
      action: 'confirm_match',
      actor: user.email,
      priorValue: null,
      newValue: { borrower: detailMatch.borrower.id },
    })
    toast.success('Match confirmed')
    setDetailTx(null)
    refetch()
    loadDocuments()
  }

  async function sendToExceptions() {
    if (!detailTx) return
    await api.transactions.update(detailTx.id, { status: 'exception', action: 'send_to_queue' })
    await api.exceptions.create({ transaction_id: detailTx.id, type: 'unmatched', assigned_to: user.email })
    toast.success('Sent to unmatched queue')
    setDetailTx(null)
    refetch()
    loadDocuments()
  }

  if (initialLoading) return <PageLoader label="Loading transactions and borrowers…" />

  return (
    <div className="space-y-5">
      <PageHeader
        title="Match Transactions"
        subtitle="Review matches in the table — click a row to see full details."
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total" value={counts.all} />
        <StatCard label="Pending" value={counts.pending} accent />
        <StatCard label="Matched" value={counts.matched} success />
        <StatCard label="Unmatched" value={counts.exception} warn sub={ldStatus?.ok ? 'LoanDisk connected' : 'Sync LoanDisk'} />
      </div>

      {/* Documents table */}
      {documents.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Uploaded documents</h2>
            {documentFilter && (
              <button type="button" onClick={() => setDocumentFilter(null)} className="text-[12px] text-[var(--accent)] hover:underline">
                Clear filter
              </button>
            )}
          </div>
          <div className="card overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border-light)] bg-[var(--bg-subtle)] text-left text-[11px] uppercase tracking-wider text-[var(--text-tertiary)]">
                  <th className="px-5 py-3 font-semibold">Document</th>
                  <th className="px-3 py-3 font-semibold">Dates</th>
                  <th className="px-3 py-3 font-semibold text-right">Matched</th>
                  <th className="px-3 py-3 font-semibold text-right">Unmatched</th>
                  <th className="px-3 py-3 font-semibold text-right">Total</th>
                  <th className="px-5 py-3 font-semibold text-right">Download</th>
                </tr>
              </thead>
              <tbody>
                {docsLoading ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-8 text-center">
                      <Loader2 className="h-5 w-5 animate-spin mx-auto text-[var(--text-tertiary)]" />
                    </td>
                  </tr>
                ) : (
                  documents.map((doc) => (
                    <tr
                      key={doc.id}
                      onClick={() => setDocumentFilter(doc.id === documentFilter ? null : doc.id)}
                      className={cn(
                        'border-b border-[var(--border-light)] last:border-0 cursor-pointer hover:bg-[var(--bg-hover)]',
                        documentFilter === doc.id && 'bg-[var(--accent-subtle)]'
                      )}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-[var(--accent)] shrink-0" />
                          <span className="font-medium truncate max-w-[220px]">{doc.filename}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-[var(--text-secondary)] whitespace-nowrap">
                        {doc.date_from ? (
                          <>
                            {formatDate(doc.date_from)}
                            {doc.date_to && doc.date_to !== doc.date_from ? ` – ${formatDate(doc.date_to)}` : ''}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-3 text-right mono font-medium text-[var(--success)]">{doc.matched_count ?? 0}</td>
                      <td className="px-3 py-3 text-right mono font-medium text-[var(--danger)]">{doc.unmatched_count ?? 0}</td>
                      <td className="px-3 py-3 text-right mono text-[var(--text-secondary)]">{doc.total_rows ?? 0}</td>
                      <td className="px-5 py-3 text-right">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            downloadDoc(doc)
                          }}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
            <span className="ml-1.5 opacity-70">{counts[f.value] ?? counts.all}</span>
          </button>
        ))}
      </div>

      {/* Transactions table */}
      <DataTable
        data={filtered}
        columns={tableColumns}
        pageSize={25}
        onRowClick={(row) => setDetailTx(row)}
        emptyMessage={counts.all === 0 ? 'No transactions yet' : 'No transactions in this filter'}
        emptyDescription={counts.all === 0 ? 'Upload a statement first' : 'Try another filter'}
        emptyAction={
          counts.all === 0 ? (
            <Link to="/ingest">
              <Button variant="secondary" size="sm">Upload Documents</Button>
            </Link>
          ) : null
        }
      />

      {/* Detail drawer */}
      <Drawer
        open={!!detailTx}
        onClose={() => setDetailTx(null)}
        title={detailTx?.payer || 'Match details'}
        subtitle={detailTx ? `${formatDate(detailTx.date)} · ${formatCurrency(detailTx.amount)}` : ''}
        width={520}
        footer={
          detailTx?.status === 'pending' ? (
            <div className="flex gap-2 w-full">
              <Button className="flex-1" onClick={confirmOne} disabled={!detailMatch.borrower}>
                Confirm match
              </Button>
              <Button className="flex-1" variant="secondary" onClick={sendToExceptions}>
                Unmatched
              </Button>
            </div>
          ) : null
        }
      >
        {detailTx && (
          <MatchDetailContent tx={detailTx} match={detailMatch} />
        )}
      </Drawer>
    </div>
  )
}

function MatchDetailContent({ tx, match }) {
  const status = STATUS_META[tx.status] || STATUS_META.pending

  return (
    <div className="space-y-5 p-6">
      <div className="flex flex-wrap gap-2">
        <Badge variant={status.variant}>{status.label}</Badge>
        {match.score > 0 && (
          <Badge variant={confidenceVariant(match.score)}>{Math.round(match.score)}% confidence</Badge>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <CompareCard
          title="Payment"
          icon={Upload}
          rows={[
            { label: 'Payer', value: tx.payer, highlight: true },
            { label: 'Description', value: tx.description },
            { label: 'Reference', value: tx.reference, mono: true },
            { label: 'Document', value: tx.source_filename },
          ]}
        />
        <CompareCard
          title="Borrower"
          icon={User}
          empty={!match.borrower}
          emptyText="No match"
          rows={
            match.borrower
              ? [
                  { label: 'Name', value: match.borrower.full_name, highlight: true },
                  { label: 'Employer', value: match.borrower.employer },
                  { label: 'Branch', value: match.borrower.branch_name },
                  { label: 'LoanDisk ID', value: match.borrower.loandisk_id, mono: true },
                  { label: 'Loan #', value: match.loan?.loan_number, mono: true },
                ]
              : []
          }
        />
      </div>

      <div className="flex items-center justify-center text-[var(--text-tertiary)]">
        <ArrowRight className="h-4 w-4" />
      </div>

      <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] p-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">
          Why {tx.status === 'matched' || match.score >= 80 ? 'matched' : match.borrower ? 'suggested' : 'unmatched'}
        </h3>

        {match.score > 0 && (
          <div className="mb-4">
            <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-1">
              <span>{confidenceLabel(match.score)}</span>
              <span className="mono font-semibold">{Math.round(match.score)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full',
                  match.score >= 80 ? 'bg-[var(--success)]' : match.score >= 50 ? 'bg-[var(--warning)]' : 'bg-[var(--danger)]'
                )}
                style={{ width: `${Math.min(100, match.score)}%` }}
              />
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)] mt-2">
              {match.method === 'exact' && 'Exact name match'}
              {match.method === 'fuzzy' && 'Fuzzy match via BorrowerSerch'}
              {match.method === 'partial' && 'Partial name match'}
              {match.method === 'none' && 'No borrower found in LoanDisk'}
            </p>
          </div>
        )}

        <ul className="space-y-2">
          {(match.reasons?.length
            ? match.reasons
            : [{ label: 'No match run yet', detail: 'Click Run Matching to search LoanDisk BorrowerSerch', weight: 'medium' }]
          ).map((r, i) => (
            <li key={i} className="flex gap-2.5 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-light)] px-3 py-2">
              <span
                className={cn(
                  'shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full',
                  r.weight === 'high' ? 'bg-[var(--success)]' : r.weight === 'medium' ? 'bg-[var(--warning)]' : 'bg-[var(--text-tertiary)]'
                )}
              />
              <div>
                <p className="text-[12px] font-semibold text-[var(--text-primary)]">{r.label}</p>
                <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{r.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
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
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className="h-3.5 w-3.5 text-[var(--accent)]" />
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{title}</h4>
      </div>
      {empty ? (
        <p className="text-[12px] text-[var(--text-secondary)] py-4 text-center">{emptyText}</p>
      ) : (
        <dl className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.label} className="flex justify-between gap-2 text-[11px]">
              <dt className="text-[var(--text-tertiary)]">{r.label}</dt>
              <dd className={cn('text-right truncate font-medium', r.highlight && 'font-semibold', r.mono && 'mono')}>
                {r.value || '—'}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
