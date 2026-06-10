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

export function MatchRunPanel({
  running,
  progress,
  result,
  borrowers,
  loans,
  onComplete,
  onAssign,
}) {
  const { user } = useAuth()
  const [preview, setPreview] = useState(null)
  const [drillDown, setDrillDown] = useState(null)
  const [drillRows, setDrillRows] = useState([])
  const [drillLoading, setDrillLoading] = useState(false)
  const [assignTxId, setAssignTxId] = useState(null)
  const [borrowerSearch, setBorrowerSearch] = useState('')
  const [selectedBorrowerId, setSelectedBorrowerId] = useState('')

  const branches = progress?.branches || result?.branches || preview?.branches || []

  const overallPercent = useMemo(() => {
    if (!branches.length) return 0
    if (progress?.phase === 'done' || result) return 100
    const done = branches.filter((b) => b.status === 'done').length
    const runningBr = branches.find((b) => b.status === 'running')
    const base = (done / branches.length) * 100
    if (runningBr && runningBr.processed > 0) {
      return base + (1 / branches.length) * Math.min(99, runningBr.percent || 50)
    }
    return base
  }, [branches, progress, result])

  const loadPreview = useCallback(async () => {
    try {
      const data = await api.matching.preview()
      setPreview(data)
    } catch {
      /* optional */
    }
  }, [])

  useEffect(() => {
    loadPreview()
  }, [loadPreview])

  useEffect(() => {
    if (result?.branches) setPreview((p) => ({ ...p, branches: result.branches }))
  }, [result])

  async function openDrillDown(branch, status) {
    setDrillDown({ branch, status })
    setDrillLoading(true)
    try {
      const rows = await api.matching.branchTransactions(branch.branchKey, status)
      setDrillRows(rows)
    } catch (e) {
      toast.error(e.message)
      setDrillRows([])
    } finally {
      setDrillLoading(false)
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
          b.branch_name?.toLowerCase().includes(q)
      )
      .slice(0, 40)
  }, [borrowers, borrowerSearch])

  async function confirmAssign(tx) {
    if (!selectedBorrowerId) return toast.error('Select a borrower')
    const borrower = borrowers.find((b) => b.id === selectedBorrowerId)
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
      if (drillDown) openDrillDown(drillDown.branch, drillDown.status)
    } catch (e) {
      toast.error(e.message)
    }
  }

  const drillColumns = [
    { key: 'date', label: 'Date', render: (r) => formatDate(r.date) },
    { key: 'payer', label: 'Payer', render: (r) => r.payer || '—' },
    { key: 'amount', label: 'EMI', render: (r) => <span className="mono">{formatCurrency(r.amount)}</span> },
    {
      key: 'borrower',
      label: 'Borrower',
      render: (r) => r.matched_borrower_name || r.borrower?.full_name || '—',
    },
    {
      key: 'loandisk_id',
      label: 'Borrower ID',
      render: (r) => r.borrower_loandisk_id || r.borrower?.loandisk_id || '—',
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
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Branch matching</h2>
          <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
            First name + last name match first · EMI disambiguates ties · multi-loan sum checked
          </p>
        </div>
        {running ? (
          <span className="flex items-center gap-2 text-[12px] text-[var(--accent)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            {progress?.currentBranch ? `Processing ${progress.currentBranch}…` : 'Starting…'}
          </span>
        ) : result ? (
          <span className="flex items-center gap-2 text-[12px] text-[var(--success)]">
            <CheckCircle2 className="h-4 w-4" />
            Complete — {result.matched} matched, {result.excepted} unmatched
          </span>
        ) : null}
      </div>

      <div>
        <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-1.5">
          <span>Overall progress</span>
          <span>{Math.round(overallPercent)}%</span>
        </div>
        <ProgressBar value={overallPercent} />
      </div>

      <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-light)]">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-[var(--bg-subtle)] text-left text-[11px] uppercase tracking-wider text-[var(--text-tertiary)]">
              <th className="px-4 py-2.5 font-semibold">Branch</th>
              <th className="px-3 py-2.5 font-semibold text-right">Borrowers</th>
              <th className="px-3 py-2.5 font-semibold text-right">Loan EMI total</th>
              <th className="px-3 py-2.5 font-semibold text-right">EMI received</th>
              <th className="px-3 py-2.5 font-semibold text-center">Matched</th>
              <th className="px-3 py-2.5 font-semibold text-center">Unmatched</th>
              <th className="px-4 py-2.5 font-semibold min-w-[140px]">Progress</th>
            </tr>
          </thead>
          <tbody>
            {branches.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[var(--text-tertiary)]">
                  Sync borrowers from LoanDisk to see branches
                </td>
              </tr>
            ) : (
              branches.map((br) => (
                <tr key={br.branchKey} className="border-t border-[var(--border-light)]">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      {br.status === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />}
                      {br.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5 text-[var(--success)]" />}
                      {br.status === 'pending' && !running && <span className="w-3.5" />}
                      {br.branchName}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right mono">{br.borrowerCount}</td>
                  <td className="px-3 py-3 text-right mono">{formatCurrency(br.totalLoanEmi)}</td>
                  <td className="px-3 py-3 text-right mono text-[var(--success)]">
                    {formatCurrency(br.totalEmiReceived || 0)}
                  </td>
                  <td className="px-3 py-3 text-center">
                    <button
                      type="button"
                      disabled={!br.matched}
                      onClick={() => openDrillDown(br, 'matched')}
                      className="text-[var(--accent)] hover:underline disabled:opacity-40 mono font-medium"
                    >
                      {br.matched ?? 0}
                    </button>
                  </td>
                  <td className="px-3 py-3 text-center">
                    <span className="mono text-[var(--text-secondary)]">{br.unmatched ?? 0}</span>
                  </td>
                  <td className="px-4 py-3">
                    <ProgressBar value={br.percent || (br.status === 'done' ? 100 : 0)} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {preview && !running && !result && (
        <p className="text-[12px] text-[var(--text-secondary)]">
          {preview.pendingCount} transactions pending · {formatCurrency(preview.totalPendingEmi)} total EMI to match
        </p>
      )}

      {drillDown && (
        <div className="border-t border-[var(--border-light)] pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold">
              {drillDown.branch.branchName} — {drillDown.status === 'matched' ? 'Matched' : 'Unmatched'} (
              {drillRows.length})
            </h3>
            <Button variant="secondary" size="sm" onClick={() => setDrillDown(null)}>
              Close
            </Button>
          </div>
          {drillLoading ? (
            <div className="py-8 flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--text-tertiary)]" />
            </div>
          ) : (
            <DataTable columns={drillColumns} data={drillRows} emptyMessage="No rows" />
          )}
        </div>
      )}

      {assignTxId && (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-[13px] font-semibold">Assign borrower ID</h4>
            <button type="button" onClick={() => setAssignTxId(null)} className="text-[var(--text-tertiary)]">
              <XCircle className="h-4 w-4" />
            </button>
          </div>
          <Input
            placeholder="Search name or LoanDisk ID…"
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
                <span className="text-[var(--text-tertiary)]">
                  {' '}
                  · {b.loandisk_id || '—'} · {b.branch_name || '—'}
                </span>
              </button>
            ))}
          </div>
          <Button
            size="sm"
            disabled={!selectedBorrowerId}
            onClick={() => confirmAssign(drillRows.find((r) => r.id === assignTxId) || { id: assignTxId })}
          >
            Confirm assignment
          </Button>
        </div>
      )}

      {result && !running && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              setDrillDown({ branch: { branchName: 'All unmatched' }, status: 'unmatched' })
              setDrillLoading(true)
              try {
                const rows = await api.transactions.list({ status: 'exception' })
                setDrillRows(rows)
              } catch (e) {
                toast.error(e.message)
              } finally {
                setDrillLoading(false)
              }
            }}
          >
            Review all unmatched ({result.excepted})
          </Button>
          <Button variant="secondary" size="sm" onClick={onComplete}>
            Done — refresh list
          </Button>
        </div>
      )}
    </section>
  )
}
