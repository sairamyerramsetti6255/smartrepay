import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Search } from 'lucide-react'
import * as api from '@/lib/api'
import { getSlaBucket } from '@/lib/sla'
import { formatCurrency, formatDate, cn, toUuidOrNull } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/Badge'
import { Drawer } from '@/components/Drawer'

export function ExceptionDrawer({ exception, open, onClose, borrowers, loans, onResolved }) {
  const [borrowerId, setBorrowerId] = useState('')
  const [borrowerSearch, setBorrowerSearch] = useState('')
  const [saving, setSaving] = useState(false)

  const tx = exception?.transactions
  const sla = exception ? getSlaBucket(exception.created_at, exception.sla_hours) : null
  const selectedBorrower = borrowers.find((b) => b.id === borrowerId)
  const selectedLoan = loans.find((l) => l.borrower_id === borrowerId)
  const score = tx?.confidence_score ?? 0

  useEffect(() => {
    if (exception) {
      setBorrowerId(tx?.matched_borrower_id || '')
      setBorrowerSearch('')
    }
  }, [exception, tx?.matched_borrower_id])

  const filteredBorrowers = useMemo(() => {
    const q = borrowerSearch.toLowerCase().trim()
    const list = !q
      ? borrowers
      : borrowers.filter((b) => {
          const hay = [
            b.full_name,
            b.first_name,
            b.last_name,
            b.employer,
            b.loandisk_id,
            ...(Array.isArray(b.aliases) ? b.aliases : []),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()
          return hay.includes(q)
        })
    return list.slice(0, 40)
  }, [borrowers, borrowerSearch])

  if (!exception) return null

  async function confirmMatch() {
    const resolvedBorrower = toUuidOrNull(borrowerId)
    if (!resolvedBorrower) return toast.error('Search and select a borrower')

    setSaving(true)
    try {
      await api.transactions.update(tx.id, {
        status: 'matched',
        matched_borrower_id: resolvedBorrower,
        loan_id: toUuidOrNull(selectedLoan?.id),
        confidence_score: Math.max(score, 100),
        action: 'confirm_match',
      })
      await api.exceptions.update(exception.id, {
        status: 'resolved',
        resolved_at: new Date().toISOString(),
      })
      toast.success('Match confirmed')
      onResolved?.()
      onClose()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function rejectMatch() {
    setSaving(true)
    try {
      await api.transactions.update(tx.id, {
        status: 'exception',
        matched_borrower_id: null,
        loan_id: null,
        action: 'reject_match',
      })
      await api.exceptions.update(exception.id, {
        status: 'resolved',
        resolution_note: 'Rejected',
        resolved_at: new Date().toISOString(),
      })
      toast.success('Rejected')
      onResolved?.()
      onClose()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const slaVariant = sla?.bucket === 'breached' ? 'breached' : sla?.bucket === 'at_risk' ? 'at_risk' : 'on_track'
  const isOpen = exception.status === 'open'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Review Unmatched"
      subtitle={tx?.reference || exception.id?.slice(0, 8)}
      width={520}
      footer={
        isOpen ? (
          <div className="flex gap-2 w-full">
            <Button className="flex-1" disabled={saving || !borrowerId} onClick={confirmMatch}>
              Confirm match
            </Button>
            <Button className="flex-1" variant="secondary" disabled={saving} onClick={rejectMatch}>
              Reject
            </Button>
          </div>
        ) : null
      }
    >
      <div className="space-y-6 p-6">
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

        {isOpen && (
          <>
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">
                Proposed borrower
              </h3>
              <div className="flex items-start gap-4 mb-4">
                <ConfidenceRing score={score} />
                <div>
                  <p className="text-[15px] font-semibold">
                    {selectedBorrower?.full_name || tx?.borrowers?.full_name || '—'}
                  </p>
                  <p className="text-[13px] text-[var(--text-secondary)] mt-0.5">
                    {selectedBorrower?.employer || '—'}
                  </p>
                  {selectedLoan?.loan_number && (
                    <p className="mono text-[13px] text-[var(--text-secondary)] mt-2">{selectedLoan.loan_number}</p>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] p-4 space-y-3">
              <div>
                <Label className="mb-1.5 block text-[12px]">Search borrower</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" />
                  <Input
                    className="pl-9"
                    placeholder="Type name, employer, or LoanDisk ID…"
                    value={borrowerSearch}
                    onChange={(e) => setBorrowerSearch(e.target.value)}
                  />
                </div>
              </div>
              <div className="max-h-[220px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]">
                {filteredBorrowers.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[12px] text-[var(--text-tertiary)]">No borrowers found</p>
                ) : (
                  filteredBorrowers.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => setBorrowerId(b.id)}
                      className={cn(
                        'w-full text-left px-3 py-2.5 text-[12px] transition-colors hover:bg-[var(--bg-hover)]',
                        borrowerId === b.id && 'bg-[var(--accent-subtle)]'
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
          </>
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
