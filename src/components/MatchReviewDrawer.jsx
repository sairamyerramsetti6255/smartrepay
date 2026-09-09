import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Link } from 'react-router-dom'
import { Check, DollarSign, Landmark, Loader2, RotateCcw, Search, Upload, User, UserCheck, X } from 'lucide-react'
import * as api from '@/lib/api'
import { confidenceVariant } from '@/lib/matcher'
import { bucketVariant, CONFIDENCE_BUCKET_LABELS, resolveConfidenceBucket } from '@/lib/confidenceBucket'
import { analyzeNameMatch, kindLabel } from '@/lib/nameMatchInfo'
import { writeAuditLog } from '@/lib/audit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/Badge'
import { Drawer } from '@/components/Drawer'
import { LoanStatementHeader } from '@/components/loan/LoanStatementHeader'
import { formatRepaymentSource } from '@/lib/loanStatementExport'
import { formatCurrency, formatDate, cn } from '@/lib/utils'

export const STATUS_META = {
  pending: { label: 'Pending', variant: 'pending' },
  matched: { label: 'Matched', variant: 'matched' },
  exception: { label: 'Unmatched', variant: 'exception' },
}

function MatchRow({ label, left, right, match, detail, capitalize }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px]">
      <span className="text-[var(--text-tertiary)] shrink-0 w-[52px]">{label}</span>
      <div className="min-w-0 flex-1 flex items-center justify-end gap-1 text-right">
        <span className={cn('font-medium text-[var(--text-primary)] truncate', capitalize && 'capitalize')}>{left || '—'}</span>
        {right != null && (
          <>
            <span className="text-[var(--text-tertiary)]">vs</span>
            <span className={cn('font-medium text-[var(--text-secondary)] truncate', capitalize && 'capitalize')}>{right}</span>
          </>
        )}
      </div>
      <span
        className={cn(
          'inline-flex items-center gap-0.5 shrink-0 rounded-[var(--radius-full)] px-1.5 py-0.5 text-[10px] font-semibold',
          match ? 'bg-[var(--success-bg)] text-[var(--success)]' : 'bg-[var(--danger-bg)] text-[var(--danger)]'
        )}
      >
        {match ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
        {detail}
      </span>
    </div>
  )
}

function parseAmountInput(raw) {
  const s = String(raw ?? '').replace(/,/g, '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

function amountMatchHint(paid, emi) {
  if (paid == null || emi == null) return null
  const diff = Math.round((paid - emi) * 100) / 100
  if (Math.abs(diff) < 0.01) return { label: 'Matches EMI', variant: 'matched' }
  if (diff < 0) return { label: `Short by ${formatCurrency(Math.abs(diff))}`, variant: 'warning' }
  return { label: `Over by ${formatCurrency(diff)}`, variant: 'posted' }
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
  const [editedAmount, setEditedAmount] = useState('')
  const [amountTouched, setAmountTouched] = useState(false)
  const [loanBook, setLoanBook] = useState(null)
  const [repayRows, setRepayRows] = useState([])
  const [repaySummary, setRepaySummary] = useState(null)
  const [loadingLoanBook, setLoadingLoanBook] = useState(false)

  const isUnmatched = tx?.status === 'exception'
  const score = tx?.confidence_score ?? 0
  const importedAmount = tx?.amount ?? null
  const parsedAmount = parseAmountInput(editedAmount)

  const selected = useMemo(
    () => loans.find((l) => l.loanNumber === selectedLoan) || null,
    [loans, selectedLoan]
  )

  const paymentAmount = isUnmatched ? parsedAmount : importedAmount
  const expectedEmi =
    loanBook?.ExpectedEMIAmount ?? selected?.emiAmount ?? tx?.summed_expected_emi ?? null
  const emiInfo = useMemo(() => {
    if (paymentAmount == null && expectedEmi == null) return { available: false }
    const diff =
      paymentAmount != null && expectedEmi != null
        ? Math.round((paymentAmount - expectedEmi) * 100) / 100
        : null
    const matches = diff != null && Math.abs(diff) < 0.01
    return {
      available: true,
      paymentAmount,
      expectedEmi,
      diff,
      matches,
      hint: amountMatchHint(paymentAmount, expectedEmi),
    }
  }, [paymentAmount, expectedEmi])
  const amountChanged =
    parsedAmount != null && importedAmount != null && Math.abs(parsedAmount - importedAmount) > 0.01

  const proposedName = selectedBorrower?.borrowerName || selected?.borrowerName || tx?.matched_borrower_name || null
  const proposedId = selectedBorrower?.borrowerId || selected?.borrowerId || tx?.borrower_loandisk_id || null
  const proposedLoan = selected?.loanNumber || tx?.loan_number || null

  const bankName = tx?.payer || tx?.transaction_description || ''
  const borrowerNameForMatch = selectedBorrower?.borrowerName || selected?.borrowerName || tx?.matched_borrower_name || ''
  const nameInfo = useMemo(
    () => analyzeNameMatch(bankName, borrowerNameForMatch),
    [bankName, borrowerNameForMatch]
  )
  const nameScore = tx?.name_score != null ? Math.round(Number(tx.name_score)) : null

  useEffect(() => {
    const ln = proposedLoan
    if (!ln || !tx) {
      setLoanBook(null)
      setRepayRows([])
      setRepaySummary(null)
      return
    }
    let cancelled = false
    setLoadingLoanBook(true)
    Promise.all([
      api.activeLoans.get(ln).catch(() => ({ loan: null })),
      api.loans.repayments(ln).catch(() => ({ rows: [], summary: null })),
    ])
      .then(([loanRes, repayRes]) => {
        if (cancelled) return
        setLoanBook(loanRes.loan || null)
        setRepayRows(Array.isArray(repayRes.rows) ? repayRes.rows : [])
        setRepaySummary(repayRes.summary || null)
      })
      .finally(() => {
        if (!cancelled) setLoadingLoanBook(false)
      })
    return () => {
      cancelled = true
    }
  }, [proposedLoan, tx?.bank_transaction_id])

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
    setAmountTouched(false)
    setEditedAmount(tx?.amount != null ? String(tx.amount) : '')

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

    const amount = isUnmatched ? parsedAmount : importedAmount
    if (isUnmatched && !amount) return toast.error('Enter a valid payment amount')

    setSaving(true)
    try {
      await api.sqlMatch.updateReview(tx.bank_transaction_id, {
        reviewStatus: 'auto_matched',
        borrowerId: proposedId,
        borrowerName: proposedName,
        loanNumber: proposedLoan,
        confidence: selectedBorrower || selected ? 100 : Math.max(score, 100),
        emiPaidAmount: amount ?? undefined,
        expectedEmiAmount: selected?.emiAmount ?? undefined,
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

  async function saveAmount() {
    if (!tx || !isUnmatched) return
    const amount = parsedAmount
    if (!amount) return toast.error('Enter a valid payment amount')
    if (!amountChanged) return toast.success('Amount unchanged')

    setSaving(true)
    try {
      await api.sqlMatch.updateReview(tx.bank_transaction_id, {
        reviewStatus: 'unmatched',
        emiPaidAmount: amount,
        expectedEmiAmount: selected?.emiAmount ?? undefined,
      })
      await writeAuditLog({
        entity: 'bank_transaction',
        entityId: String(tx.bank_transaction_id),
        action: 'correct_amount',
        actor: user?.email,
        priorValue: { amount: importedAmount },
        newValue: { amount },
      }).catch(() => {})
      toast.success('Payment amount updated')
      onResolved?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  function resetAmount() {
    setEditedAmount(importedAmount != null ? String(importedAmount) : '')
    setAmountTouched(false)
  }

  if (!tx) return null

  const canConfirm =
    !!selectedBorrower &&
    !!proposedId &&
    !!proposedName &&
    (loans.length === 0 || loans.length === 1 || !!selectedLoan) &&
    (!isUnmatched || !!parsedAmount)

  const canSaveAmount = isUnmatched && !!parsedAmount && amountChanged

  return (
    <Drawer
      open={!!tx}
      onClose={onClose}
      title={tx.status === 'matched' ? 'Review Matched' : 'Review Unmatched'}
      subtitle={tx.reference || `Txn #${tx.bank_transaction_id}`}
      width={520}
      footer={
        <div className="flex flex-col gap-2 w-full">
          {isUnmatched && (
            <Button className="w-full" variant="secondary" disabled={saving || !canSaveAmount} onClick={saveAmount}>
              Save corrected amount
            </Button>
          )}
          <div className="flex gap-2 w-full">
            <Button className="flex-1" disabled={saving || !canConfirm} onClick={confirm}>
              {isUnmatched ? 'Confirm manual match' : 'Confirm match'}
            </Button>
            <Button className="flex-1" variant="secondary" disabled={saving} onClick={reject}>
              {isUnmatched ? 'Keep unmatched' : 'Reject'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={STATUS_META[tx.status]?.variant || 'pending'}>{STATUS_META[tx.status]?.label || tx.status}</Badge>
          {score > 0 && <Badge variant={confidenceVariant(score)}>{Math.round(score)}% confidence</Badge>}
          {tx.match_method && <Badge variant="posted">{tx.match_method}</Badge>}
        </div>

        {/* Match summary: name + EMI */}
        {(nameInfo.available || emiInfo.available) && (
          <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]">
              <div className="flex items-center gap-1.5">
                <UserCheck className="h-3.5 w-3.5 text-[var(--accent)]" />
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Match summary
                </h3>
              </div>
              {nameScore != null && (
                <span
                  className={cn(
                    'mono text-[13px] font-bold',
                    nameScore >= 90
                      ? 'text-[var(--success)]'
                      : nameScore >= 70
                        ? 'text-[var(--warning)]'
                        : 'text-[var(--danger)]'
                  )}
                >
                  Name {nameScore}%
                </span>
              )}
            </div>
            <div className="divide-y divide-[var(--border-light)]">
              {nameInfo.available && (
                <>
                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[var(--bg-subtle)]/30">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Name</span>
                    <Badge variant={nameInfo.bothMatch ? 'matched' : 'breached'}>
                      {nameInfo.bothMatch ? (nameInfo.fullName ? 'Full match' : 'First + last') : 'Mismatch'}
                    </Badge>
                  </div>
                  <MatchRow
                    label="First"
                    left={nameInfo.first.bank}
                    right={nameInfo.first.borrower}
                    match={nameInfo.first.match}
                    detail={kindLabel(nameInfo.first.kind)}
                    capitalize
                  />
                  <MatchRow
                    label="Last"
                    left={nameInfo.last.bank}
                    right={nameInfo.last.borrower}
                    match={nameInfo.last.match}
                    detail={kindLabel(nameInfo.last.kind)}
                    capitalize
                  />
                  {nameInfo.reversed && (
                    <p className="px-3 py-1 text-[10px] text-[var(--text-tertiary)]">Compared as Last First.</p>
                  )}
                </>
              )}
              {emiInfo.available && (
                <>
                  <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[var(--bg-subtle)]/30">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">EMI</span>
                    <Badge variant={emiInfo.matches ? 'matched' : expectedEmi != null ? 'breached' : 'pending'}>
                      {emiInfo.matches ? 'Match' : expectedEmi != null && paymentAmount != null ? 'Mismatch' : 'Pending'}
                    </Badge>
                  </div>
                  <MatchRow
                    label="Amount"
                    left={paymentAmount != null ? formatCurrency(paymentAmount) : '—'}
                    right={expectedEmi != null ? formatCurrency(expectedEmi) : '—'}
                    match={emiInfo.matches}
                    detail={
                      emiInfo.matches
                        ? 'Match'
                        : emiInfo.hint?.label?.replace(/^Matches EMI$/, 'Match') || (expectedEmi == null ? 'No EMI' : 'Mismatch')
                    }
                  />
                </>
              )}
            </div>
          </section>
        )}

        {/* Bank transaction */}
        <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] overflow-hidden">
          <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]">
            <Upload className="h-3.5 w-3.5 text-[var(--accent)]" />
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Bank payment</h3>
          </div>
          <div className="divide-y divide-[var(--border-light)]">
            {[
              ['Date', formatDate(tx.date)],
              ['Name', tx.payer || tx.transaction_description],
              ['Reference', tx.reference],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2 px-3 py-1.5 text-[12px]">
                <span className="text-[var(--text-secondary)] shrink-0">{label}</span>
                <span className={cn('font-medium text-right truncate', label === 'Reference' && 'mono')}>{value || '—'}</span>
              </div>
            ))}
            <div className={cn('px-3 py-2', isUnmatched ? 'bg-[var(--bg-card)]' : 'bg-[var(--accent-subtle)]/30')}>
              {isUnmatched ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[12px] font-medium text-[var(--text-primary)]">Payment amount</p>
                    <span className="text-[10px] text-[var(--text-tertiary)] mono">
                      Import {formatCurrency(importedAmount)}
                    </span>
                  </div>
                  <div className="relative">
                    <DollarSign className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-tertiary)]" />
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="Corrected amount"
                      value={editedAmount}
                      onChange={(e) => {
                        setEditedAmount(e.target.value)
                        setAmountTouched(true)
                      }}
                      error={amountTouched && !parsedAmount}
                      className="pl-8 mono text-[14px] font-semibold h-9"
                      aria-label="Corrected payment amount"
                    />
                  </div>
                  {amountTouched && !parsedAmount && (
                    <p className="text-[10px] text-[var(--danger)]">Enter a positive number</p>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!amountChanged}
                    onClick={resetAmount}
                    className="h-7 text-[11px]"
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Reset
                  </Button>
                </div>
              ) : (
                <div className="flex justify-between gap-2">
                  <span className="text-[var(--text-secondary)] text-[12px]">Amount</span>
                  <span className="mono text-[16px] font-bold text-[var(--text-primary)]">{formatCurrency(tx.amount)}</span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Manual borrower match */}
        <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] p-3">
          <h3 className="text-[12px] font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5 text-[var(--accent)]" />
            {isUnmatched ? 'Assign borrower' : 'Matched borrower'}
          </h3>

          <Input
            placeholder="Search borrower name or ID…"
            value={nameSearch}
            onChange={(e) => {
              setNameSearch(e.target.value)
              if (selectedBorrower) clearBorrowerSelection()
            }}
            autoComplete="off"
            className="h-9 text-[13px]"
          />
          <p className="text-[10px] text-[var(--text-tertiary)] mt-1">Type 2+ characters</p>

          <div className="mt-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">
              {selectedBorrower ? 'Selected borrower' : `Borrowers (${borrowerResults.length})`}
            </p>

            {selectedBorrower ? (
              <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--accent-border)] bg-[var(--accent-subtle)]/50 px-2.5 py-2">
                <User className="h-3.5 w-3.5 text-[var(--accent)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-semibold text-[var(--text-primary)] truncate">{selectedBorrower.borrowerName}</p>
                  <p className="text-[10px] text-[var(--text-tertiary)] mono">
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
                className="max-h-[100px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]"
                role="listbox"
                aria-label="Borrower search results"
              >
                {nameSearch.trim().length < 2 ? (
                  <p className="text-[11px] text-[var(--text-tertiary)] px-2.5 py-4 text-center">
                    {tx.matched_borrower_name
                      ? `Suggested: ${tx.matched_borrower_name}${tx.borrower_loandisk_id ? ` (ID ${tx.borrower_loandisk_id})` : ''}`
                      : 'Start typing a borrower name'}
                  </p>
                ) : searchingBorrowers ? (
                  <div className="flex justify-center py-5">
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />
                  </div>
                ) : borrowerResults.length === 0 ? (
                  <p className="text-[11px] text-[var(--text-tertiary)] px-2.5 py-4 text-center">No borrowers found</p>
                ) : (
                  borrowerResults.map((b) => (
                    <button
                      key={b.borrowerId}
                      type="button"
                      role="option"
                      onClick={() => loadLoansForBorrower(b)}
                      className="w-full text-left px-2.5 py-2 hover:bg-[var(--bg-subtle)] transition-colors flex items-start gap-2"
                    >
                      <User className="h-3.5 w-3.5 text-[var(--text-tertiary)] shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-[var(--text-primary)] truncate">{b.borrowerName}</p>
                        <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
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
            <div className="mt-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">
                Select loan ({loans.length})
              </p>
              <div
                className="max-h-[88px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]"
                role="listbox"
                aria-label="Borrower loans"
              >
                {loadingLoans ? (
                  <div className="flex justify-center py-5">
                    <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />
                  </div>
                ) : loans.length === 0 ? (
                  <p className="text-[11px] text-[var(--text-tertiary)] px-2.5 py-4 text-center">No loans for this borrower</p>
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
                          'w-full text-left px-2.5 py-1.5 transition-colors',
                          active ? 'bg-[var(--accent-subtle)]' : 'hover:bg-[var(--bg-subtle)]'
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="mono text-[12px] font-semibold text-[var(--text-primary)]">Loan {loan.loanNumber}</span>
                          {loan.loanStatus && <Badge variant="posted">{loan.loanStatus}</Badge>}
                        </div>
                        <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5 truncate">
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

        {proposedLoan && (
          <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Landmark className="h-3.5 w-3.5 text-[var(--accent)]" />
                Loan statement
              </h3>
              <Link
                to={`/loans/${proposedLoan}/statement`}
                className="text-[11px] text-[var(--accent)] hover:underline shrink-0"
              >
                Full statement →
              </Link>
            </div>

            {loadingLoanBook ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
              </div>
            ) : loanBook ? (
              <>
                <LoanStatementHeader loan={loanBook} summary={repaySummary} compact showStatementLink={false} />
                {repayRows.length > 0 && (
                  <div className="mt-3 border-t border-[var(--border-light)] pt-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">
                      Recent payments ({repayRows.length})
                    </p>
                    <div className="divide-y divide-[var(--border-light)] rounded-[var(--radius-md)] border border-[var(--border-light)] overflow-hidden">
                      {repayRows.slice(0, 5).map((r, i) => (
                        <div key={r.entryId || i} className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-medium">{r.date ? formatDate(r.date) : '—'}</span>
                            <Badge variant={r.source === 'manual' ? 'pending' : 'posted'}>
                              {formatRepaymentSource(r)}
                            </Badge>
                          </div>
                          <span className="mono font-semibold shrink-0">{formatCurrency(r.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="text-[12px] text-[var(--text-tertiary)] space-y-1">
                <p>Loan <span className="mono font-medium">{proposedLoan}</span></p>
                {selected && (
                  <p>
                    EMI {formatCurrency(selected.emiAmount)} · Balance {formatCurrency(selected.loanBalance)}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {(tx.reasoning || score > 0 || tx.match_type) && (
          <section className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] p-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
              Engine notes
            </h3>
            {score > 0 && (
              <div className="mb-2">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <Badge variant={bucketVariant(resolveConfidenceBucket(tx))}>
                    {CONFIDENCE_BUCKET_LABELS[resolveConfidenceBucket(tx)]}
                  </Badge>
                  <span className="mono text-[11px] font-semibold">{Math.round(score)}%</span>
                </div>
                <div className="h-1 rounded-full bg-[var(--bg-hover)] overflow-hidden">
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
            <dl className="space-y-1 text-[11px]">
              {[
                ['Match type', tx.match_type],
                ['Amount match', tx.amount_match_kind],
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
            {tx.reasoning && <p className="text-[11px] text-[var(--text-secondary)] mt-2 leading-snug line-clamp-3">{tx.reasoning}</p>}
          </section>
        )}
      </div>
    </Drawer>
  )
}
