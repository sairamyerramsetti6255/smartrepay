import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { ArrowRight, Landmark, Loader2, Search, Upload, User, X } from 'lucide-react'
import * as api from '@/lib/api'
import { confidenceVariant, confidenceLabel } from '@/lib/matcher'
import { writeAuditLog } from '@/lib/audit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/Badge'
import { Drawer } from '@/components/Drawer'
import { formatCurrency, formatDate, cn } from '@/lib/utils'

export const STATUS_META = {
  pending: { label: 'Pending', variant: 'pending' },
  matched: { label: 'Matched', variant: 'matched' },
  exception: { label: 'Unmatched', variant: 'exception' },
}

function ReadOnlyField({ label, value, mono }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)]/40 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>
      <p className={cn('text-[13px] font-medium text-[var(--text-primary)] mt-0.5', mono && 'mono')}>
        {value ?? '—'}
      </p>
    </div>
  )
}

/**
 * SQL-backed review drawer for a single staged bank credit. Reads/writes the
 * match purely through CRIF_Operations (api.sqlMatch.*) — no SQLite.
 */
export function MatchReviewDrawer({ tx, user, onClose, onResolved }) {
  const [nameSearch, setNameSearch] = useState('')
  const [borrowerResults, setBorrowerResults] = useState([])
  const [searchingBorrowers, setSearchingBorrowers] = useState(false)
  const [selectedBorrower, setSelectedBorrower] = useState(null)
  const [loans, setLoans] = useState([])
  const [selectedLoan, setSelectedLoan] = useState(null)
  const [loadingLoans, setLoadingLoans] = useState(false)
  const [saving, setSaving] = useState(false)

  const isUnmatched = tx?.status === 'exception'
  const score = tx?.confidence_score ?? 0

  const selected = useMemo(
    () => loans.find((l) => l.loanNumber === selectedLoan) || null,
    [loans, selectedLoan]
  )

  const proposedName = selectedBorrower?.borrowerName || selected?.borrowerName || tx?.matched_borrower_name || null
  const proposedId = selectedBorrower?.borrowerId || selected?.borrowerId || tx?.borrower_loandisk_id || null
  const proposedLoan = selected?.loanNumber || tx?.loan_number || null

  const loadLoansForBorrower = useCallback(async (borrower, preselectLoanNumber = null) => {
    if (!borrower?.borrowerId) return
    setSelectedBorrower(borrower)
    setLoadingLoans(true)
    setLoans([])
    setSelectedLoan(null)
    try {
      const { loans: rows } = await api.receipts.loans(borrower.borrowerId)
      const list = Array.isArray(rows) ? rows : []
      setLoans(list)
      if (!list.length) {
        toast.error('No active loans found for this borrower')
        return
      }
      const pick =
        preselectLoanNumber && list.some((l) => l.loanNumber === preselectLoanNumber)
          ? preselectLoanNumber
          : list.length === 1
            ? list[0].loanNumber
            : null
      if (pick) setSelectedLoan(pick)
    } catch {
      setLoans([])
      toast.error('Could not load loans for this borrower')
    } finally {
      setLoadingLoans(false)
    }
  }, [])

  useEffect(() => {
    setNameSearch('')
    setBorrowerResults([])
    setSelectedBorrower(null)
    setLoans([])
    setSelectedLoan(null)

    if (!tx) return

    const bid = tx.borrower_loandisk_id || tx.matched_borrower_id
    if (bid) {
      loadLoansForBorrower(
        {
          borrowerId: String(bid),
          borrowerName: tx.matched_borrower_name || `Borrower ${bid}`,
          branchName: null,
        },
        tx.loan_number || null
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx?.bank_transaction_id])

  useEffect(() => {
    const q = nameSearch.trim()
    if (q.length < 2) {
      setBorrowerResults([])
      setSearchingBorrowers(false)
      return
    }

    setSearchingBorrowers(true)
    const timer = setTimeout(async () => {
      try {
        const { borrowers } = await api.receipts.searchBorrowers(q)
        setBorrowerResults(Array.isArray(borrowers) ? borrowers : [])
      } catch {
        setBorrowerResults([])
      } finally {
        setSearchingBorrowers(false)
      }
    }, 350)

    return () => clearTimeout(timer)
  }, [nameSearch])

  function clearBorrowerSelection() {
    setSelectedBorrower(null)
    setLoans([])
    setSelectedLoan(null)
  }

  async function confirm() {
    if (!tx) return
    if (!proposedId || !proposedName) return toast.error('Search and select a borrower')
    if (loans.length > 1 && !selectedLoan) return toast.error('Select a loan for this borrower')

    setSaving(true)
    try {
      await api.sqlMatch.updateReview(tx.bank_transaction_id, {
        reviewStatus: 'auto_matched',
        borrowerId: proposedId,
        borrowerName: proposedName,
        loanNumber: proposedLoan,
        confidence: selectedBorrower || selected ? 100 : Math.max(score, 100),
      })
      await writeAuditLog({
        entity: 'bank_transaction',
        entityId: String(tx.bank_transaction_id),
        action: 'confirm_match',
        actor: user?.email,
        priorValue: null,
        newValue: { borrower: proposedName, loan: proposedLoan, manual: true },
      }).catch(() => {})
      toast.success(isUnmatched ? 'Manual match saved' : 'Match confirmed')
      onResolved?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function reject() {
    if (!tx) return
    setSaving(true)
    try {
      await api.sqlMatch.updateReview(tx.bank_transaction_id, { reviewStatus: 'unmatched' })
      toast.success('Kept as unmatched')
      onResolved?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (!tx) return null

  const canConfirm =
    !!selectedBorrower &&
    !!proposedId &&
    !!proposedName &&
    (loans.length === 0 || loans.length === 1 || !!selectedLoan)

  return (
    <Drawer
      open={!!tx}
      onClose={onClose}
      title={tx.status === 'matched' ? 'Review Matched' : 'Review Unmatched'}
      subtitle={tx.reference || `Txn #${tx.bank_transaction_id}`}
      width={580}
      footer={
        <div className="flex gap-2 w-full">
          <Button className="flex-1" disabled={saving || !canConfirm} onClick={confirm}>
            {isUnmatched ? 'Confirm manual match' : 'Confirm match'}
          </Button>
          <Button className="flex-1" variant="secondary" disabled={saving} onClick={reject}>
            {isUnmatched ? 'Keep unmatched' : 'Reject'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap gap-2">
          <Badge variant={STATUS_META[tx.status]?.variant || 'pending'}>{STATUS_META[tx.status]?.label || tx.status}</Badge>
          {score > 0 && <Badge variant={confidenceVariant(score)}>{Math.round(score)}% confidence</Badge>}
          {tx.match_method && <Badge variant="posted">{tx.match_method}</Badge>}
        </div>

        {/* Bank transaction */}
        <section className="rounded-[var(--radius-lg)] border border-[var(--border-light)] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]">
            <Upload className="h-4 w-4 text-[var(--accent)]" />
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Bank payment</h3>
          </div>
          <div className="divide-y divide-[var(--border-light)]">
            {[
              ['Date', formatDate(tx.date)],
              ['Payer', tx.payer],
              ['Description', tx.description],
              ['Reference', tx.reference],
              ['Document', tx.source_filename],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3 px-4 py-2.5 text-[13px]">
                <span className="text-[var(--text-secondary)] shrink-0">{label}</span>
                <span className={cn('font-medium text-right truncate', label === 'Reference' && 'mono')}>{value || '—'}</span>
              </div>
            ))}
            <div className="flex justify-between gap-3 px-4 py-3 bg-[var(--accent-subtle)]/30">
              <span className="text-[var(--text-secondary)] text-[13px]">Amount</span>
              <span className="mono text-[18px] font-bold text-[var(--text-primary)]">{formatCurrency(tx.amount)}</span>
            </div>
          </div>
        </section>

        <div className="flex items-center justify-center text-[var(--text-tertiary)]">
          <ArrowRight className="h-4 w-4" />
        </div>

        {/* Manual borrower match */}
        <section className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-xs)]">
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)] mb-1 flex items-center gap-2">
            <Search className="h-4 w-4 text-[var(--accent)]" />
            {isUnmatched ? 'Assign borrower (manual match)' : 'Matched borrower'}
          </h3>
          <p className="text-[11px] text-[var(--text-tertiary)] mb-4">
            {isUnmatched
              ? 'Search by name, pick the borrower, then select their loan to match this payment.'
              : 'Review or change the borrower linked to this payment.'}
          </p>

          <Input
            placeholder="Search by borrower name or ID…"
            value={nameSearch}
            onChange={(e) => {
              setNameSearch(e.target.value)
              if (selectedBorrower) clearBorrowerSelection()
            }}
            autoComplete="off"
          />
          <p className="text-[11px] text-[var(--text-tertiary)] mt-1.5">Type at least 2 characters</p>

          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
              {selectedBorrower ? 'Selected borrower' : `Borrowers (${borrowerResults.length})`}
            </p>

            {selectedBorrower ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--accent-border)] bg-[var(--accent-subtle)]/50 px-3 py-2.5">
                <User className="h-4 w-4 text-[var(--accent)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{selectedBorrower.borrowerName}</p>
                  <p className="text-[11px] text-[var(--text-tertiary)] mono">
                    ID {selectedBorrower.borrowerId}
                    {selectedBorrower.branchName ? ` · ${selectedBorrower.branchName}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="p-1 rounded hover:bg-[var(--bg-card)] text-[var(--text-tertiary)]"
                  onClick={clearBorrowerSelection}
                  aria-label="Clear borrower"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div
                className="max-h-[180px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]"
                role="listbox"
                aria-label="Borrower search results"
              >
                {nameSearch.trim().length < 2 ? (
                  <p className="text-[12px] text-[var(--text-tertiary)] px-3 py-6 text-center">
                    {tx.matched_borrower_name
                      ? `Suggested: ${tx.matched_borrower_name}${tx.borrower_loandisk_id ? ` (ID ${tx.borrower_loandisk_id})` : ''}`
                      : 'Start typing a borrower name'}
                  </p>
                ) : searchingBorrowers ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
                  </div>
                ) : borrowerResults.length === 0 ? (
                  <p className="text-[12px] text-[var(--text-tertiary)] px-3 py-6 text-center">No borrowers found</p>
                ) : (
                  borrowerResults.map((b) => (
                    <button
                      key={b.borrowerId}
                      type="button"
                      role="option"
                      onClick={() => loadLoansForBorrower(b)}
                      className="w-full text-left px-3 py-2.5 hover:bg-[var(--bg-subtle)] transition-colors flex items-start gap-2.5"
                    >
                      <User className="h-4 w-4 text-[var(--text-tertiary)] shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">{b.borrowerName}</p>
                        <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                          <span className="mono">ID {b.borrowerId}</span>
                          {b.branchName ? ` · ${b.branchName}` : ''}
                          {b.loanCount ? ` · ${b.loanCount} loan${b.loanCount === 1 ? '' : 's'}` : ''}
                        </p>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {selectedBorrower && (
            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
                Select loan ({loans.length})
              </p>
              <div
                className="max-h-[160px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]"
                role="listbox"
                aria-label="Borrower loans"
              >
                {loadingLoans ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
                  </div>
                ) : loans.length === 0 ? (
                  <p className="text-[12px] text-[var(--text-tertiary)] px-3 py-6 text-center">No loans for this borrower</p>
                ) : (
                  loans.map((loan) => {
                    const active = selectedLoan === loan.loanNumber
                    return (
                      <button
                        key={loan.loanNumber}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => setSelectedLoan(loan.loanNumber)}
                        className={cn(
                          'w-full text-left px-3 py-2.5 transition-colors',
                          active ? 'bg-[var(--accent-subtle)]' : 'hover:bg-[var(--bg-subtle)]'
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="mono text-[13px] font-semibold text-[var(--text-primary)]">Loan {loan.loanNumber}</span>
                          {loan.loanStatus && <Badge variant="posted">{loan.loanStatus}</Badge>}
                        </div>
                        <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 truncate">
                          {loan.emiAmount != null ? `EMI ${formatCurrency(loan.emiAmount)}` : '—'}
                          {loan.loanBalance != null ? ` · Bal ${formatCurrency(loan.loanBalance)}` : ''}
                        </p>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )}
        </section>

        {selected && (
          <section className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-xs)]">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
              <Landmark className="h-4 w-4 text-[var(--accent)]" />
              Borrower & loan details
            </h3>

            <div className="rounded-[var(--radius-md)] border border-[var(--accent-border)] bg-[var(--accent-subtle)]/40 px-3 py-2.5 mb-3">
              <p className="text-[14px] font-semibold text-[var(--text-primary)]">{selected.borrowerName || proposedName}</p>
              <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 mono">
                ID {selected.borrowerId}
                {selected.branchName ? ` · ${selected.branchName}` : ''}
              </p>
            </div>

            {tx.amount != null && selected.emiAmount != null && (
              <div className="mb-3 flex items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-light)] px-3 py-2 text-[12px]">
                <span className="text-[var(--text-secondary)]">Payment vs EMI</span>
                <span className="mono font-semibold">
                  {formatCurrency(tx.amount)}
                  <span className="text-[var(--text-tertiary)] font-normal mx-1">/</span>
                  {formatCurrency(selected.emiAmount)}
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <ReadOnlyField label="Loan ID" value={selected.loanNumber} mono />
              <ReadOnlyField label="Branch" value={selected.branchName} />
              <ReadOnlyField label="Principal" value={formatCurrency(selected.principalAmount)} mono />
              <ReadOnlyField label="Disbursed amount" value={formatCurrency(selected.disbursedAmount)} mono />
              <ReadOnlyField
                label="Disbursed date"
                value={selected.disbursedDate ? formatDate(selected.disbursedDate) : '—'}
              />
              <ReadOnlyField label="EMI amount" value={formatCurrency(selected.emiAmount)} mono />
              <ReadOnlyField label="Total due" value={formatCurrency(selected.totalDue)} mono />
              <ReadOnlyField label="Installments paid" value={selected.installmentsPaid} mono />
              <ReadOnlyField
                label="Last EMI paid"
                value={selected.lastEmiPaidDate ? formatDate(selected.lastEmiPaidDate) : '—'}
              />
              <ReadOnlyField label="Balance" value={formatCurrency(selected.loanBalance)} mono />
            </div>
          </section>
        )}

        {(tx.reasoning || score > 0 || tx.match_type) && (
          <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] p-4">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">
              Engine notes
            </h3>
            {score > 0 && (
              <div className="mb-4">
                <div className="flex justify-between text-[11px] text-[var(--text-tertiary)] mb-1">
                  <span>{confidenceLabel(score)}</span>
                  <span className="mono font-semibold">{Math.round(score)}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      score >= 80 ? 'bg-[var(--success)]' : score >= 50 ? 'bg-[var(--warning)]' : 'bg-[var(--danger)]'
                    )}
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
                ['Expected EMI (sum)', tx.summed_expected_emi != null ? formatCurrency(tx.summed_expected_emi) : null],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <dt className="text-[var(--text-tertiary)]">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
            </dl>
            {tx.reasoning && <p className="text-[12px] text-[var(--text-secondary)] mt-3 leading-relaxed">{tx.reasoning}</p>}
          </section>
        )}
      </div>
    </Drawer>
  )
}
