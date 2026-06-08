import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { getSlaBucket } from '@/lib/sla'
import { formatCurrency, formatDate, cn, sanitizeTxUpdate, toUuidOrNull } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/Badge'
import { Drawer } from '@/components/Drawer'

export function ExceptionDrawer({ exception, open, onClose, borrowers, loans, onResolved }) {
  const { user } = useAuth()
  const [borrowerId, setBorrowerId] = useState('')
  const [loanId, setLoanId] = useState('')
  const [note, setNote] = useState('')
  const [assignee, setAssignee] = useState('')
  const [saving, setSaving] = useState(false)
  const [noteRequired, setNoteRequired] = useState(false)

  const tx = exception?.transactions
  const sla = exception ? getSlaBucket(exception.created_at, exception.sla_hours) : null
  const borrowerLoans = loans.filter((l) => l.borrower_id === borrowerId)
  const score = tx?.confidence_score ?? 0

  useEffect(() => {
    if (exception) {
      setBorrowerId(tx?.matched_borrower_id || '')
      setLoanId(tx?.loan_id || '')
      setAssignee(exception.assigned_to || '')
      setNote('')
      setNoteRequired(false)
    }
  }, [exception, tx])

  if (!exception) return null

  async function save(updates, txUpdates, action, requireNote = false) {
    if (requireNote && !note.trim()) {
      setNoteRequired(true)
      return toast.error('Resolution note required')
    }

    let sanitized = txUpdates ? sanitizeTxUpdate(txUpdates) : null
    if (sanitized?.status === 'matched') {
      const resolvedBorrower =
        toUuidOrNull(borrowerId) ?? toUuidOrNull(tx?.matched_borrower_id)
      if (!resolvedBorrower) {
        return toast.error('Select a borrower')
      }
      sanitized = { ...sanitized, matched_borrower_id: resolvedBorrower }
    }

    setSaving(true)
    try {
      if (sanitized && tx?.id) {
        await api.transactions.update(tx.id, { ...sanitized, action })
      }
      await api.exceptions.update(exception.id, {
        ...updates,
        resolution_note: note || updates.resolution_note,
        resolved_at: updates.status === 'resolved' ? new Date().toISOString() : null,
        action,
      })
      toast.success('Decision saved')
      onResolved?.()
      onClose()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const slaVariant = sla?.bucket === 'breached' ? 'breached' : sla?.bucket === 'at_risk' ? 'at_risk' : 'on_track'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Review Unmatched"
      subtitle={tx?.reference || exception.id?.slice(0, 8)}
    >
      <div className="space-y-6">
        <div className="flex gap-2">
          <Badge variant="exception">{exception.type}</Badge>
          <Badge variant={slaVariant}>{sla?.label}</Badge>
        </div>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">
            Bank Record
          </h3>
          <div className="rounded-[var(--radius-md)] overflow-hidden border border-[var(--border-light)]">
            {[
              ['Date', formatDate(tx?.date)],
              ['Payer', tx?.payer],
              ['Description', tx?.description],
              ['Reference', tx?.reference],
            ].map(([k, v], i) => (
              <div
                key={k}
                className={cn('flex justify-between h-9 px-4 items-center text-[13px]', i % 2 === 0 && 'bg-[var(--bg-subtle)]')}
              >
                <span className="text-[var(--text-secondary)]">{k}</span>
                <span className="font-medium">{v || '—'}</span>
              </div>
            ))}
            <div className="flex justify-between h-10 px-4 items-center bg-[var(--bg-subtle)]">
              <span className="text-[var(--text-secondary)]">Amount</span>
              <span className="mono text-[17px] font-semibold">{formatCurrency(tx?.amount)}</span>
            </div>
          </div>
        </section>

        <div className="relative py-2">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[var(--border-light)]" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-[var(--bg-card)] px-3 py-0.5 rounded-full text-[11px] font-medium text-[var(--text-tertiary)] border border-[var(--border-light)]">
              AI Proposed Match
            </span>
          </div>
        </div>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">
            Proposed Borrower
          </h3>
          <div className="flex items-start gap-4">
            <ConfidenceRing score={score} />
            <div>
              <p className="text-[15px] font-semibold">
                {borrowers.find((b) => b.id === borrowerId)?.full_name || tx?.borrowers?.full_name || '—'}
              </p>
              <p className="text-[13px] text-[var(--text-secondary)] mt-0.5">
                {borrowers.find((b) => b.id === borrowerId)?.employer}
              </p>
              <p className="mono text-[13px] text-[var(--text-secondary)] mt-2">
                {borrowerLoans.find((l) => l.id === loanId)?.loan_number || '—'}
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            <div>
              <Label className="mb-1.5 block">Reassign borrower</Label>
              <select
                className="w-full h-9 rounded-[var(--radius-md)] border border-[var(--border-medium)] px-3 text-sm bg-[var(--bg-card)]"
                value={borrowerId}
                onChange={(e) => {
                  setBorrowerId(e.target.value)
                  setLoanId('')
                }}
              >
                <option value="">Select…</option>
                {borrowers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.full_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="mb-1.5 block">Loan</Label>
              <select
                className="w-full h-9 rounded-[var(--radius-md)] border border-[var(--border-medium)] px-3 text-sm bg-[var(--bg-card)]"
                value={loanId}
                onChange={(e) => setLoanId(e.target.value)}
                disabled={!borrowerId}
              >
                <option value="">Select…</option>
                {borrowerLoans.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.loan_number}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {exception.status === 'open' && (
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">
              Decision
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="success" disabled={saving} onClick={() => save({ status: 'resolved' }, { status: 'matched', matched_borrower_id: borrowerId, loan_id: loanId || null, confidence_score: 100 }, 'confirm')}>
                ✓ Confirm Match
              </Button>
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => {
                  setNoteRequired(true)
                  save({ assigned_to: assignee }, { matched_borrower_id: borrowerId, loan_id: loanId }, 'reassign', true)
                }}
              >
                ↩ Reassign Borrower
              </Button>
              <Button variant="secondary" disabled={saving} onClick={() => save({ status: 'resolved', resolution_note: note || 'Split' }, { status: 'exception' }, 'split')}>
                ⊕ Split Across Loans
              </Button>
              <Button
                variant="danger"
                disabled={saving}
                onClick={() => {
                  setNoteRequired(true)
                  save({ status: 'resolved' }, { status: 'exception', matched_borrower_id: null, loan_id: null }, 'reject', true)
                }}
              >
                ✕ Reject
              </Button>
            </div>
            {noteRequired && (
              <div className="mt-4">
                <Label className="mb-1.5 block">Resolution note (required)</Label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="w-full min-h-[88px] rounded-[var(--radius-md)] border border-[var(--border-medium)] px-3 py-2 text-sm focus:border-[var(--border-strong)] focus:outline-none focus:shadow-[0_0_0_3px_rgba(29,78,216,0.08)]"
                  placeholder="Explain why this match was changed..."
                />
              </div>
            )}
            <Button className="w-full mt-4" disabled={saving} onClick={() => save({ status: 'resolved', resolution_note: note }, { status: 'matched', matched_borrower_id: borrowerId, loan_id: loanId }, 'save', noteRequired)}>
              Save Decision
            </Button>
          </section>
        )}
      </div>
    </Drawer>
  )
}

function ConfidenceRing({ score }) {
  const r = 20
  const c = 2 * Math.PI * r
  const offset = c - (score / 100) * c
  return (
    <div className="relative h-12 w-12 shrink-0">
      <svg width="48" height="48" className="-rotate-90">
        <circle cx="24" cy="24" r={r} fill="none" stroke="var(--bg-subtle)" strokeWidth="4" />
        <circle
          cx="24"
          cy="24"
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="4"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[15px] font-bold">{score}</span>
    </div>
  )
}
