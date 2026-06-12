import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { ArrowRight, Search, Upload, User } from 'lucide-react'
import * as api from '@/lib/api'
import { confidenceVariant, confidenceLabel } from '@/lib/matcher'
import { writeAuditLog } from '@/lib/audit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/Badge'
import { Drawer } from '@/components/Drawer'
import { formatCurrency, cn } from '@/lib/utils'

export const STATUS_META = {
  pending: { label: 'Pending', variant: 'pending' },
  matched: { label: 'Matched', variant: 'matched' },
  exception: { label: 'Unmatched', variant: 'exception' },
}

/**
 * SQL-backed review drawer for a single staged bank credit. Reads/writes the
 * match purely through CRIF_Operations (api.sqlMatch.*) — no SQLite.
 */
export function MatchReviewDrawer({ tx, user, onClose, onResolved }) {
  const [changing, setChanging] = useState(false)
  const [search, setSearch] = useState('')
  const [loans, setLoans] = useState([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setChanging(false)
    setSearch('')
    setLoans([])
    setPicked(null)
  }, [tx?.id])

  async function runSearch(q) {
    setSearch(q)
    if (!q.trim()) {
      setLoans([])
      return
    }
    setSearching(true)
    try {
      const { rows } = await api.activeLoans.list(q.trim())
      setLoans(Array.isArray(rows) ? rows.slice(0, 40) : [])
    } catch {
      setLoans([])
    } finally {
      setSearching(false)
    }
  }

  if (!tx) return null

  const proposedName = picked?.BorrowerFullName || tx.matched_borrower_name || null
  const proposedId = picked?.BorrowerId || tx.borrower_loandisk_id || null
  const proposedLoan = picked?.LoanNumber || tx.loan_number || null
  const score = tx.confidence_score ?? 0

  async function confirm() {
    setSaving(true)
    try {
      await api.sqlMatch.updateReview(tx.bank_transaction_id, {
        reviewStatus: 'auto_matched',
        borrowerId: proposedId,
        borrowerName: proposedName,
        loanNumber: proposedLoan,
        confidence: picked ? 100 : Math.max(score, 100),
      })
      await writeAuditLog({
        entity: 'bank_transaction',
        entityId: String(tx.bank_transaction_id),
        action: 'confirm_match',
        actor: user?.email,
        priorValue: null,
        newValue: { borrower: proposedName, loan: proposedLoan },
      }).catch(() => {})
      toast.success('Match confirmed')
      onResolved?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function reject() {
    setSaving(true)
    try {
      await api.sqlMatch.updateReview(tx.bank_transaction_id, { reviewStatus: 'unmatched' })
      toast.success('Moved to Unmatched')
      onResolved?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Drawer
      open={!!tx}
      onClose={onClose}
      title={tx.status === 'matched' ? 'Review Matched' : 'Review Unmatched'}
      subtitle={tx.reference || tx.id}
      width={520}
      footer={
        <div className="flex gap-2 w-full">
          <Button className="flex-1" disabled={saving || !proposedName} onClick={confirm}>
            Confirm match
          </Button>
          <Button className="flex-1" variant="secondary" disabled={saving} onClick={reject}>
            Reject
          </Button>
        </div>
      }
    >
      <div className="space-y-6 p-6">
        <div className="flex flex-wrap gap-2">
          <Badge variant={STATUS_META[tx.status]?.variant || 'pending'}>{STATUS_META[tx.status]?.label || tx.status}</Badge>
          {score > 0 && <Badge variant={confidenceVariant(score)}>{Math.round(score)}% confidence</Badge>}
          {tx.match_method && <Badge variant="posted">{tx.match_method}</Badge>}
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
            empty={!proposedName}
            emptyText="No proposed borrower"
            rows={[
              { label: 'Name', value: proposedName, highlight: true },
              { label: 'LoanDisk ID', value: proposedId, mono: true },
              { label: 'Loan #', value: proposedLoan, mono: true },
              { label: 'Loans covered', value: tx.loan_count ? String(tx.loan_count) : null },
              { label: 'Expected EMI', value: tx.summed_expected_emi != null ? formatCurrency(tx.summed_expected_emi) : null },
            ]}
          />
        </div>

        <section>
          <button type="button" onClick={() => setChanging((v) => !v)} className="text-[12px] font-medium text-[var(--accent)] hover:underline">
            {changing ? 'Hide search' : 'Change borrower'}
          </button>
          {changing && (
            <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] p-4 space-y-3">
              <div>
                <Label className="mb-1.5 block text-[12px]">Search active loans</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" />
                  <Input className="pl-9" placeholder="Type name, loan no, or LoanDisk ID…" value={search} onChange={(e) => runSearch(e.target.value)} />
                </div>
              </div>
              <div className="max-h-[220px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]">
                {searching ? (
                  <p className="px-3 py-6 text-center text-[12px] text-[var(--text-tertiary)]">Searching…</p>
                ) : loans.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[12px] text-[var(--text-tertiary)]">{search ? 'No active loans found' : 'Type to search'}</p>
                ) : (
                  loans.map((l) => (
                    <button
                      key={l.Id}
                      type="button"
                      onClick={() => {
                        setPicked(l)
                        setChanging(false)
                      }}
                      className={cn(
                        'w-full text-left px-3 py-2.5 text-[12px] transition-colors hover:bg-[var(--bg-hover)]',
                        picked?.Id === l.Id && 'bg-[var(--accent-subtle)]'
                      )}
                    >
                      <p className="font-semibold text-[var(--text-primary)]">{l.BorrowerFullName || '—'}</p>
                      <p className="text-[var(--text-tertiary)] mt-0.5 truncate">
                        {[l.LoanNumber ? `Loan ${l.LoanNumber}` : null, l.BranchName, l.BorrowerId ? `ID ${l.BorrowerId}` : null].filter(Boolean).join(' · ') || '—'}
                      </p>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </section>

        <div className="flex items-center justify-center text-[var(--text-tertiary)]">
          <ArrowRight className="h-4 w-4" />
        </div>

        <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] p-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">Match details</h3>
          {score > 0 && (
            <div className="mb-4">
              <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-1">
                <span>{confidenceLabel(score)}</span>
                <span className="mono font-semibold">{Math.round(score)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                <div
                  className={cn('h-full rounded-full', score >= 80 ? 'bg-[var(--success)]' : score >= 50 ? 'bg-[var(--warning)]' : 'bg-[var(--danger)]')}
                  style={{ width: `${Math.min(100, score)}%` }}
                />
              </div>
            </div>
          )}
          <dl className="space-y-1.5 text-[12px]">
            {[
              ['Match type', tx.match_type],
              ['Amount match', tx.amount_match_kind],
              ['Name score', tx.name_score != null ? `${tx.name_score}` : null],
              ['Matched loans', tx.matched_loan_numbers],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="text-[var(--text-tertiary)]">{k}</dt>
                  <dd className="text-right font-medium">{v}</dd>
                </div>
              ))}
          </dl>
          {tx.reasoning && <p className="text-[12px] text-[var(--text-secondary)] mt-3">{tx.reasoning}</p>}
        </section>
      </div>
    </Drawer>
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
          {rows
            .filter((r) => r.value)
            .map((r) => (
              <div key={r.label} className="flex justify-between gap-2 text-[11px]">
                <dt className="text-[var(--text-tertiary)]">{r.label}</dt>
                <dd className={cn('text-right truncate font-medium', r.highlight && 'font-semibold', r.mono && 'mono')}>{r.value || '—'}</dd>
              </div>
            ))}
        </dl>
      )}
    </div>
  )
}
