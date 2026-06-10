import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DataTable } from '@/components/DataTable'
import { formatCurrency, formatDate, cn, toUuidOrNull } from '@/lib/utils'

function ProgressBar({ value, className }) {
  const pct = Math.min(100, Math.max(0, value))
  return (
    <div className={cn('h-2 w-full rounded-full bg-[var(--bg-subtle)] overflow-hidden', className)}>
      <div
        className="h-full rounded-full bg-[var(--accent)] transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
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
  const [reviewMode, setReviewMode] = useState(null)
  const [reviewRows, setReviewRows] = useState([])
  const [reviewLoading, setReviewLoading] = useState(false)
  const [assignTxId, setAssignTxId] = useState(null)
  const [borrowerSearch, setBorrowerSearch] = useState('')
  const [selectedBorrowerId, setSelectedBorrowerId] = useState('')

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
  const borrowerCount = progress?.borrowerCount ?? result?.borrowers ?? preview?.borrowerCount ?? borrowers.length

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await api.matching.preview())
    } catch {
      /* optional */
    }
  }, [])

  useEffect(() => {
    loadPreview()
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

  async function confirmAssign(tx) {
    if (!selectedBorrowerId) return toast.error('Select a borrower')
    const loan = loans.find((l) => l.borrower_id === selectedBorrowerId)
    try {
      await api.transactions.update(tx.id, {
        status: 'matched',
        confidence_score: 100,
        matched_borrower_id: toUuidOrNull(selectedBorrowerId),
        loan_id: toUuidOrNull(loan?.id),
        action: 'manual_assign',
      })
      await api.audit.write({
        entity: 'transaction',
        entityId: tx.id,
        action: 'manual_assign',
        actor: user.email,
        newValue: { borrower: selectedBorrowerId },
      })
      toast.success('Borrower assigned')
      setAssignTxId(null)
      setSelectedBorrowerId('')
      setBorrowerSearch('')
      onAssign?.()
      if (reviewMode) openReview(reviewMode)
    } catch (e) {
      toast.error(e.message)
    }
  }

  const reviewColumns = [
    { key: 'date', label: 'Date', render: (r) => formatDate(r.date) },
    { key: 'payer', label: 'Payer', render: (r) => r.payer || '—' },
    { key: 'amount', label: 'Amount', render: (r) => <span className="mono">{formatCurrency(r.amount)}</span> },
    {
      key: 'borrower',
      label: 'Borrower',
      render: (r) => r.matched_borrower_name || '—',
    },
    {
      key: 'loandisk_id',
      label: 'LoanDisk ID',
      render: (r) => r.borrower_loandisk_id || '—',
    },
    {
      key: 'actions',
      label: '',
      render: (r) => (
        <Button
          size="sm"
          variant="secondary"
          onClick={(e) => {
            e.stopPropagation()
            setAssignTxId(r.id)
            setSelectedBorrowerId(r.matched_borrower_id || '')
          }}
        >
          {r.status === 'matched' || r.status === 'posted' ? 'Reassign' : 'Assign'}
        </Button>
      ),
    },
  ]

  return (
    <section className="card p-5 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Name matching</h2>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            Matches payers against {borrowerCount.toLocaleString()} synced borrowers by first + last name
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

      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Borrowers loaded" value={borrowerCount} />
        <SummaryCard label="Matched" value={liveMatched} success />
        <SummaryCard label="Unmatched" value={liveUnmatched} />
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
              {reviewMode === 'matched' ? 'All matched' : 'All unmatched'} ({reviewRows.length})
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
            <DataTable columns={reviewColumns} data={reviewRows} emptyMessage="No rows" />
          )}
        </div>
      )}

      {assignTxId && (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-[13px] font-semibold">Assign borrower</h4>
            <button type="button" onClick={() => setAssignTxId(null)} className="text-[var(--text-tertiary)]">
              <XCircle className="h-4 w-4" />
            </button>
          </div>
          <Input
            placeholder="Search borrower name…"
            value={borrowerSearch}
            onChange={(e) => setBorrowerSearch(e.target.value)}
          />
          <div className="max-h-40 overflow-y-auto space-y-1">
            {filteredBorrowers.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedBorrowerId(b.id)}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-[var(--radius-sm)] text-[12px]',
                  selectedBorrowerId === b.id ? 'bg-[var(--accent-subtle)]' : 'hover:bg-[var(--bg-hover)]'
                )}
              >
                <span className="font-medium">{b.full_name}</span>
                {b.loandisk_id && (
                  <span className="text-[var(--text-tertiary)]"> · {b.loandisk_id}</span>
                )}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            disabled={!selectedBorrowerId}
            onClick={() => confirmAssign(reviewRows.find((r) => r.id === assignTxId) || { id: assignTxId })}
          >
            Confirm assignment
          </Button>
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
          <Button variant="secondary" size="sm" onClick={onComplete}>
            Done
          </Button>
        </div>
      )}
    </section>
  )
}

function SummaryCard({ label, value, success }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] px-4 py-3">
      <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wide">{label}</p>
      <p className={cn('text-[20px] font-semibold mono mt-1', success && 'text-[var(--success)]')}>{value}</p>
    </div>
  )
}
