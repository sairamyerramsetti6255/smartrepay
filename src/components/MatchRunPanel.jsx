import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { CheckCircle2, Loader2, Search, FileSpreadsheet } from 'lucide-react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/Badge'
import { Drawer } from '@/components/Drawer'
import { DataTable } from '@/components/DataTable'
import { confidenceVariant } from '@/lib/matcher'
import { exportAllTransactions } from '@/lib/transactionExport'
import { formatCurrency, formatDate, cn, toUuidOrNull } from '@/lib/utils'

function ProgressBar({ value, className }) {
  const pct = Math.min(100, Math.max(0, value))
  return (
    <div className={cn('h-2 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden', className)}>
      <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-500" style={{ width: `${pct}%` }} />
    </div>
  )
}

function LiveResultList({ title, count, rows, variant, emptyLabel }) {
  const isMatched = variant === 'matched'
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] overflow-hidden">
      <div
        className={cn(
          'px-4 py-2.5 flex items-center justify-between border-b border-[var(--border-light)]',
          isMatched ? 'bg-[var(--success-bg)]' : 'bg-[var(--bg-subtle)]'
        )}
      >
        <span className="text-[13px] font-semibold text-[var(--text-primary)]">{title}</span>
        <span className={cn('text-[13px] font-bold mono', isMatched ? 'text-[var(--success)]' : 'text-[var(--text-secondary)]')}>
          {count}
        </span>
      </div>
      <div className="max-h-[280px] overflow-y-auto">
        {rows.length ? (
          <table className="w-full text-[12px]">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[var(--border-light)]">
                  <td className="px-3 py-2 text-[var(--text-secondary)] whitespace-nowrap">{formatDate(r.date)}</td>
                  <td className="px-3 py-2 font-medium truncate max-w-[140px]">{r.payer || '—'}</td>
                  <td className="px-3 py-2 mono text-right">{formatCurrency(r.amount)}</td>
                  {isMatched && (
                    <td className="px-3 py-2 text-[var(--accent)] truncate max-w-[140px]">{r.borrowerName || '—'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">{emptyLabel}</p>
        )}
      </div>
    </div>
  )
}

export function MatchRunPanel({ running, progress, result, borrowers, loans, onComplete, onAssign }) {
  const { user } = useAuth()
  const [preview, setPreview] = useState(null)
  const [activeLoanCount, setActiveLoanCount] = useState(null)
  const [reviewMode, setReviewMode] = useState(null)
  const [reviewRows, setReviewRows] = useState([])
  const [reviewLoading, setReviewLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Single-transaction review popup state
  const [reviewTx, setReviewTx] = useState(null)
  const [changing, setChanging] = useState(false)
  const [borrowerSearch, setBorrowerSearch] = useState('')
  const [selectedBorrowerId, setSelectedBorrowerId] = useState('')
  const [saving, setSaving] = useState(false)

  const overallPercent = useMemo(() => {
    if (progress?.percent != null) return progress.percent
    if (progress?.total) return Math.round(((progress.processed ?? 0) / progress.total) * 100)
    if (result) return 100
    return 0
  }, [progress, result])

  const recentMatched = progress?.recentMatched || result?.recentMatched || []
  const recentUnmatched = progress?.recentUnmatched || result?.recentUnmatched || []
  const liveMatched = progress?.matched ?? result?.matched ?? 0
  const liveUnmatched = progress?.excepted ?? result?.excepted ?? 0
  const totalToMatch = liveMatched + liveUnmatched || preview?.pendingCount || 0
  const matchedPct = totalToMatch ? Math.round((liveMatched / totalToMatch) * 100) : 0
  const unmatchedPct = totalToMatch ? Math.round((liveUnmatched / totalToMatch) * 100) : 0
  const activeLoans = activeLoanCount != null ? activeLoanCount : borrowers.length

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await api.matching.preview())
    } catch {
      /* optional */
    }
  }, [])

  useEffect(() => {
    loadPreview()
    api.staging
      .summary()
      .then((s) => setActiveLoanCount(s?.activeLoans ?? null))
      .catch(() => setActiveLoanCount(null))
  }, [loadPreview])

  async function openReview(status) {
    setReviewMode(status)
    setReviewLoading(true)
    try {
      const rows = await api.transactions.list({ status: status === 'matched' ? 'matched' : 'exception' })
      setReviewRows(rows)
    } catch (e) {
      toast.error(e.message)
      setReviewRows([])
    } finally {
      setReviewLoading(false)
    }
  }

  function openTxReview(tx) {
    setReviewTx(tx)
    setSelectedBorrowerId(tx.matched_borrower_id || '')
    setChanging(false)
    setBorrowerSearch('')
  }

  const selectedBorrower = useMemo(
    () => borrowers.find((b) => b.id === selectedBorrowerId) || null,
    [borrowers, selectedBorrowerId]
  )

  const filteredBorrowers = useMemo(() => {
    const q = borrowerSearch.trim().toLowerCase()
    if (!q) return borrowers.slice(0, 40)
    return borrowers
      .filter(
        (b) =>
          b.full_name?.toLowerCase().includes(q) ||
          b.loandisk_id?.toString().includes(q) ||
          b.first_name?.toLowerCase().includes(q) ||
          b.last_name?.toLowerCase().includes(q)
      )
      .slice(0, 40)
  }, [borrowers, borrowerSearch])

  async function confirmReview() {
    if (!reviewTx) return
    const bid = toUuidOrNull(selectedBorrowerId)
    if (!bid) return toast.error('No borrower selected')
    setSaving(true)
    try {
      const loan = loans.find((l) => l.borrower_id === selectedBorrowerId)
      await api.transactions.update(reviewTx.id, {
        status: 'matched',
        confidence_score: Math.max(reviewTx.confidence_score || 0, 100),
        matched_borrower_id: bid,
        loan_id: toUuidOrNull(loan?.id),
        action: 'confirm_match',
      })
      await api.audit
        .write({ entity: 'transaction', entityId: reviewTx.id, action: 'confirm_match', actor: user.email, newValue: { borrower: bid } })
        .catch(() => {})
      toast.success('Match confirmed')
      setReviewTx(null)
      onAssign?.()
      if (reviewMode) openReview(reviewMode)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function rejectReview() {
    if (!reviewTx) return
    setSaving(true)
    try {
      await api.transactions.update(reviewTx.id, {
        status: 'exception',
        matched_borrower_id: null,
        loan_id: null,
        action: 'reject_match',
      })
      await api.exceptions.create({ transaction_id: reviewTx.id, type: 'unmatched', assigned_to: user.email }).catch(() => {})
      toast.success('Moved to Unmatched')
      setReviewTx(null)
      onAssign?.()
      if (reviewMode) openReview(reviewMode)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function exportAll() {
    setExporting(true)
    try {
      const [matched, unmatched] = await Promise.all([
        api.transactions.list({ status: 'matched' }),
        api.transactions.list({ status: 'exception' }),
      ])
      const rows = [...(matched || []), ...(unmatched || [])]
      const borrowerById = Object.fromEntries(borrowers.map((b) => [b.id, b]))
      const ok = exportAllTransactions(rows, borrowerById)
      if (ok) toast.success(`Exported ${rows.length} rows (matched + unmatched)`)
      else toast.error('Nothing to export')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setExporting(false)
    }
  }

  const reviewColumns = [
    { key: 'date', label: 'Date', render: (r) => formatDate(r.date) },
    { key: 'payer', label: 'Payer', render: (r) => <span className="font-medium">{r.payer || '—'}</span> },
    { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span className="mono">{formatCurrency(r.amount)}</span> },
    { key: 'matched_borrower_name', label: 'Borrower', render: (r) => r.matched_borrower_name || '—' },
    { key: 'borrower_loandisk_id', label: 'LoanDisk ID', render: (r) => <span className="mono text-[12px]">{r.borrower_loandisk_id || '—'}</span> },
    {
      key: 'confidence_score',
      label: 'Score',
      align: 'right',
      render: (r) =>
        r.confidence_score != null ? (
          <Badge variant={confidenceVariant(r.confidence_score)} className="mono">
            {Math.round(r.confidence_score)}%
          </Badge>
        ) : (
          '—'
        ),
    },
  ]

  const reviewScore = reviewTx?.confidence_score ?? 0
  const proposedName = selectedBorrower?.full_name || reviewTx?.matched_borrower_name || null

  return (
    <section className="card p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Name matching</h2>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Matches payers against {activeLoans.toLocaleString()} active loans by first + last name
          </p>
        </div>
        {running ? (
          <span className="flex items-center gap-2 text-[12px] text-[var(--accent)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {progress?.processed != null
              ? `${progress.processed}/${progress.total} · ${liveMatched} matched · ${liveUnmatched} unmatched`
              : 'Starting…'}
          </span>
        ) : result ? (
          <span className="flex items-center gap-2 text-[12px] text-[var(--success)]">
            <CheckCircle2 className="h-4 w-4" />
            Complete — {result.matched} matched, {result.excepted} unmatched
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard label="Active loans" value={activeLoans.toLocaleString()} />
        <SummaryCard label="Total to match" value={totalToMatch.toLocaleString()} />
        <SummaryCard label="Matched" value={liveMatched} sub={`${matchedPct}%`} success />
        <SummaryCard label="Unmatched" value={liveUnmatched} sub={`${unmatchedPct}%`} warn />
      </div>

      <div>
        <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-1.5">
          <span>Progress</span>
          <span>{Math.round(overallPercent)}%</span>
        </div>
        <ProgressBar value={overallPercent} />
      </div>

      {(running || result) && (
        <div className="grid md:grid-cols-2 gap-4">
          <LiveResultList
            title="Matched"
            count={liveMatched}
            rows={recentMatched}
            variant="matched"
            emptyLabel={running ? 'Matching in progress…' : 'No matches'}
          />
          <LiveResultList
            title="Unmatched"
            count={liveUnmatched}
            rows={recentUnmatched}
            variant="unmatched"
            emptyLabel={running ? 'Waiting for results…' : 'All matched'}
          />
        </div>
      )}

      {preview && !running && !result && (
        <p className="text-[12px] text-[var(--text-secondary)]">
          {preview.pendingCount} transactions ready · sync borrowers first if count is 0
        </p>
      )}

      {reviewMode && (
        <div className="border-t border-[var(--border-light)] pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold">
              {reviewMode === 'matched' ? 'All matched' : 'All unmatched'} ({reviewRows.length}) — click a row to review
            </h3>
            <Button variant="secondary" size="sm" onClick={() => setReviewMode(null)}>
              Close
            </Button>
          </div>
          {reviewLoading ? (
            <div className="py-8 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--text-tertiary)]" />
            </div>
          ) : (
            <DataTable
              columns={reviewColumns}
              data={reviewRows}
              pageSize={25}
              sortable
              filterable
              onRowClick={openTxReview}
              emptyMessage="No rows"
            />
          )}
        </div>
      )}

      {result && !running && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => openReview('matched')}>
            View all matched ({result.matched})
          </Button>
          <Button variant="secondary" size="sm" onClick={() => openReview('unmatched')}>
            View all unmatched ({result.excepted})
          </Button>
          <Button variant="secondary" size="sm" onClick={exportAll} disabled={exporting}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
            Export all (with status)
          </Button>
          <Button variant="secondary" size="sm" onClick={onComplete}>
            Done
          </Button>
        </div>
      )}

      {/* Single-transaction review popup */}
      <Drawer
        open={!!reviewTx}
        onClose={() => setReviewTx(null)}
        title={reviewMode === 'matched' ? 'Review Matched' : 'Review Unmatched'}
        subtitle={reviewTx?.reference || reviewTx?.id?.slice?.(0, 8)}
        width={520}
        footer={
          reviewTx ? (
            <div className="flex gap-2 w-full">
              <Button className="flex-1" disabled={saving || !selectedBorrowerId} onClick={confirmReview}>
                Confirm match
              </Button>
              <Button className="flex-1" variant="secondary" disabled={saving} onClick={rejectReview}>
                Reject
              </Button>
            </div>
          ) : null
        }
      >
        {reviewTx && (
          <div className="space-y-6 p-6">
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">Bank record</h3>
              <div className="rounded-[var(--radius-md)] overflow-hidden border border-[var(--border-light)]">
                {[
                  ['Date', formatDate(reviewTx.date)],
                  ['Payer', reviewTx.payer],
                  ['Description', reviewTx.description],
                  ['Reference', reviewTx.reference],
                ].map(([k, v], i) => (
                  <div key={k} className={cn('flex justify-between h-9 px-4 items-center text-[13px]', i % 2 === 0 && 'bg-[var(--bg-subtle)]')}>
                    <span className="text-[var(--text-secondary)]">{k}</span>
                    <span className="font-medium text-right truncate max-w-[60%]">{v || '—'}</span>
                  </div>
                ))}
                <div className="flex justify-between h-10 px-4 items-center bg-[var(--bg-subtle)]">
                  <span className="text-[var(--text-secondary)]">Amount</span>
                  <span className="mono text-[17px] font-semibold">{formatCurrency(reviewTx.amount)}</span>
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">Proposed borrower</h3>
              {proposedName ? (
                <div className="flex items-start gap-4 rounded-[var(--radius-md)] border border-[var(--border-light)] p-4">
                  <ConfidenceRing score={Math.round(reviewScore)} />
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold truncate">{proposedName}</p>
                    <p className="text-[13px] text-[var(--text-secondary)] mt-0.5">
                      {[selectedBorrower?.employer, selectedBorrower?.branch_name].filter(Boolean).join(' · ') || '—'}
                    </p>
                    {(selectedBorrower?.loandisk_id || reviewTx.borrower_loandisk_id) && (
                      <p className="mono text-[12px] text-[var(--text-secondary)] mt-1">
                        ID {selectedBorrower?.loandisk_id || reviewTx.borrower_loandisk_id}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--border-light)] px-4 py-5 text-center text-[13px] text-[var(--text-tertiary)]">
                  No proposed borrower — use “Change borrower” to assign one.
                </p>
              )}

              <button
                type="button"
                onClick={() => setChanging((v) => !v)}
                className="mt-3 text-[12px] font-medium text-[var(--accent)] hover:underline"
              >
                {changing ? 'Hide search' : 'Change borrower'}
              </button>
            </section>

            {changing && (
              <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] p-4 space-y-3">
                <div>
                  <Label className="mb-1.5 block text-[12px]">Search borrower</Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" />
                    <Input
                      className="pl-9"
                      placeholder="Type name or LoanDisk ID…"
                      value={borrowerSearch}
                      onChange={(e) => setBorrowerSearch(e.target.value)}
                    />
                  </div>
                </div>
                <div className="max-h-[200px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]">
                  {filteredBorrowers.length === 0 ? (
                    <p className="px-3 py-6 text-center text-[12px] text-[var(--text-tertiary)]">No borrowers found</p>
                  ) : (
                    filteredBorrowers.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => {
                          setSelectedBorrowerId(b.id)
                          setChanging(false)
                        }}
                        className={cn(
                          'w-full text-left px-3 py-2.5 text-[12px] transition-colors hover:bg-[var(--bg-hover)]',
                          selectedBorrowerId === b.id && 'bg-[var(--accent-subtle)]'
                        )}
                      >
                        <p className="font-semibold text-[var(--text-primary)]">{b.full_name}</p>
                        <p className="text-[var(--text-tertiary)] mt-0.5 truncate">
                          {[b.employer, b.branch_name, b.loandisk_id ? `ID ${b.loandisk_id}` : null].filter(Boolean).join(' · ') || '—'}
                        </p>
                      </button>
                    ))
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </Drawer>
    </section>
  )
}

function SummaryCard({ label, value, sub, success, warn }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] px-4 py-3">
      <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wide">{label}</p>
      <div className="flex items-baseline gap-2 mt-1">
        <p className={cn('text-[20px] font-semibold mono', success && 'text-[var(--success)]', warn && 'text-[var(--warning)]')}>{value}</p>
        {sub != null && <span className="text-[12px] font-medium text-[var(--text-tertiary)]">{sub}</span>}
      </div>
    </div>
  )
}

function ConfidenceRing({ score }) {
  const r = 20
  const c = 2 * Math.PI * r
  const offset = c - (Math.min(100, Math.max(0, score)) / 100) * c
  return (
    <div className="relative h-12 w-12 shrink-0">
      <svg width="48" height="48" className="-rotate-90">
        <circle cx="24" cy="24" r={r} fill="none" stroke="var(--bg-subtle)" strokeWidth="4" />
        <circle cx="24" cy="24" r={r} fill="none" stroke="var(--accent)" strokeWidth="4" strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[15px] font-bold">{score}</span>
    </div>
  )
}
