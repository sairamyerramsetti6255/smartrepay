import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Search, Loader2, Receipt, Upload, Landmark, User, X } from 'lucide-react'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/Badge'
import { formatCurrency, formatDate, cn } from '@/lib/utils'

const SOURCE_OPTIONS = [
  { value: 'walkin', label: 'Walk-in' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
]

const SOURCE_LABELS = Object.fromEntries(SOURCE_OPTIONS.map((o) => [o.value, o.label]))

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

export function ReceiptsUpload() {
  const [nameSearch, setNameSearch] = useState('')
  const [borrowerResults, setBorrowerResults] = useState([])
  const [searchingBorrowers, setSearchingBorrowers] = useState(false)
  const [selectedBorrower, setSelectedBorrower] = useState(null)
  const [loans, setLoans] = useState([])
  const [selectedLoan, setSelectedLoan] = useState(null)
  const [loadingLoans, setLoadingLoans] = useState(false)
  const [amountReceived, setAmountReceived] = useState('')
  const [particulars, setParticulars] = useState('')
  const [sourceChannel, setSourceChannel] = useState('walkin')
  const [collectedDate, setCollectedDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [receiptFile, setReceiptFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [history, setHistory] = useState([])
  const [historyLoading, setHistoryLoading] = useState(true)

  const selected = useMemo(
    () => loans.find((l) => l.loanNumber === selectedLoan) || null,
    [loans, selectedLoan]
  )

  async function loadHistory() {
    setHistoryLoading(true)
    try {
      const { rows } = await api.receipts.list()
      setHistory(Array.isArray(rows) ? rows : [])
    } catch {
      setHistory([])
    } finally {
      setHistoryLoading(false)
    }
  }

  useEffect(() => {
    loadHistory()
  }, [])

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

  const loadLoansForBorrower = useCallback(async (borrower) => {
    if (!borrower?.borrowerId) return
    setSelectedBorrower(borrower)
    setLoadingLoans(true)
    setLoans([])
    setSelectedLoan(null)
    try {
      const { loans: rows } = await api.receipts.loans(borrower.borrowerId)
      const list = Array.isArray(rows) ? rows : []
      setLoans(list)
      if (!list.length) toast.error('No active loans found for this borrower')
      else if (list.length === 1) setSelectedLoan(list[0].loanNumber)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoadingLoans(false)
    }
  }, [])

  function clearBorrowerSelection() {
    setSelectedBorrower(null)
    setLoans([])
    setSelectedLoan(null)
  }

  function resetForm() {
    setAmountReceived('')
    setParticulars('')
    setSourceChannel('walkin')
    setCollectedDate(new Date().toISOString().slice(0, 10))
    setReceiptFile(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!selected) return toast.error('Select a loan')
    const amount = Number(String(amountReceived).replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Enter a valid amount received')

    setSubmitting(true)
    try {
      await api.receipts.create(
        {
          borrowerId: selectedBorrower.borrowerId,
          loanNumber: selected.loanNumber,
          branchId: selected.branchId,
          borrowerName: selected.borrowerName || selectedBorrower.borrowerName,
          amountReceived: amount,
          particulars,
          sourceChannel,
          collectedDate,
        },
        receiptFile
      )
      toast.success('Receipt saved to loan repayments')
      resetForm()
      await loadHistory()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const historyColumns = [
    { key: 'collectedDate', label: 'Date', render: (r) => formatDate(r.collectedDate) },
    { key: 'borrowerId', label: 'Borrower ID', render: (r) => <span className="mono text-[12px]">{r.borrowerId}</span> },
    { key: 'loanNumber', label: 'Loan', render: (r) => <span className="mono text-[12px]">{r.loanNumber}</span> },
    {
      key: 'amountReceived',
      label: 'Amount',
      align: 'right',
      render: (r) => formatCurrency(r.amountReceived),
    },
    {
      key: 'sourceChannel',
      label: 'Source',
      render: (r) => <Badge variant="posted">{SOURCE_LABELS[r.sourceChannel] || r.sourceChannel}</Badge>,
    },
    { key: 'particulars', label: 'Particulars', render: (r) => r.particulars || '—' },
    {
      key: 'receiptFileName',
      label: 'Attachment',
      render: (r) =>
        r.receiptDocumentId ? (
          <button
            type="button"
            className="text-[12px] text-[var(--accent)] hover:underline truncate max-w-[140px]"
            onClick={() =>
              api.documents.download(r.receiptDocumentId, r.receiptFileName).catch((e) => toast.error(e.message))
            }
          >
            {r.receiptFileName || 'Download'}
          </button>
        ) : (
          '—'
        ),
    },
  ]

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Receipts Upload"
        description="Record manual repayments with receipt attachments — saved as type manual into SIL loan repayments."
      />

      <form onSubmit={handleSubmit} className="grid gap-6 lg:grid-cols-12">
        {/* Left — borrower & loan picker */}
        <div className="lg:col-span-5 space-y-4">
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-5 shadow-[var(--shadow-xs)]">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
              <Search className="h-4 w-4 text-[var(--accent)]" />
              Find borrower loans
            </h2>
            <div>
              <Input
                placeholder="Search by borrower name…"
                value={nameSearch}
                onChange={(e) => {
                  setNameSearch(e.target.value)
                  if (selectedBorrower) clearBorrowerSelection()
                }}
                autoComplete="off"
              />
              <p className="text-[11px] text-[var(--text-tertiary)] mt-1.5">Type at least 2 characters</p>
            </div>

            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
                {selectedBorrower ? 'Selected borrower' : `Borrowers (${borrowerResults.length})`}
              </p>

              {selectedBorrower ? (
                <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--accent-border)] bg-[var(--accent-subtle)]/50 px-3 py-2.5">
                  <User className="h-4 w-4 text-[var(--accent)] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                      {selectedBorrower.borrowerName}
                    </p>
                    <p className="text-[11px] text-[var(--text-tertiary)] mono">ID {selectedBorrower.borrowerId}</p>
                  </div>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-[var(--bg-card)] text-[var(--text-tertiary)]"
                    onClick={() => {
                      clearBorrowerSelection()
                    }}
                    aria-label="Clear borrower"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div
                  className="max-h-[200px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]"
                  role="listbox"
                  aria-label="Borrower search results"
                >
                  {nameSearch.trim().length < 2 ? (
                    <p className="text-[12px] text-[var(--text-tertiary)] px-3 py-6 text-center">
                      Start typing a borrower name
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
                className="max-h-[220px] overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]"
                role="listbox"
                aria-label="Borrower loans"
              >
                {loadingLoans ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
                  </div>
                ) : loans.length === 0 ? (
                  <p className="text-[12px] text-[var(--text-tertiary)] px-3 py-6 text-center">
                    No loans for this borrower
                  </p>
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
                          <span className="mono text-[13px] font-semibold text-[var(--text-primary)]">
                            Loan {loan.loanNumber}
                          </span>
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
          </div>

          {selected && (
            <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-5 shadow-[var(--shadow-xs)]">
              <h2 className="text-[14px] font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                <Landmark className="h-4 w-4 text-[var(--accent)]" />
                Loan details (read-only)
              </h2>
              <div className="grid grid-cols-2 gap-2">
                <ReadOnlyField label="Loan ID" value={selected.loanNumber} mono />
                <ReadOnlyField label="Branch" value={selected.branchName} />
                <ReadOnlyField label="Principal" value={formatCurrency(selected.principalAmount)} mono />
                <ReadOnlyField label="Disbursed amount" value={formatCurrency(selected.disbursedAmount)} mono />
                <ReadOnlyField label="Disbursed date" value={selected.disbursedDate ? formatDate(selected.disbursedDate) : '—'} />
                <ReadOnlyField label="EMI amount" value={formatCurrency(selected.emiAmount)} mono />
                <ReadOnlyField label="Total due" value={formatCurrency(selected.totalDue)} mono />
                <ReadOnlyField label="Installments paid" value={selected.installmentsPaid} mono />
                <ReadOnlyField
                  label="Last EMI paid"
                  value={selected.lastEmiPaidDate ? formatDate(selected.lastEmiPaidDate) : '—'}
                />
                <ReadOnlyField label="Balance" value={formatCurrency(selected.loanBalance)} mono />
              </div>
            </div>
          )}
        </div>

        {/* Right — receipt entry */}
        <div className="lg:col-span-7">
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-5 shadow-[var(--shadow-xs)]">
            <h2 className="text-[14px] font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
              <Receipt className="h-4 w-4 text-[var(--accent)]" />
              Payment receipt
            </h2>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-[12px] font-medium text-[var(--text-secondary)]">Amount received *</label>
                <Input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  className="mt-1 mono"
                  value={amountReceived}
                  onChange={(e) => setAmountReceived(e.target.value.replace(/[^0-9.]/g, ''))}
                  required
                  disabled={!selected}
                />
              </div>
              <div>
                <label className="text-[12px] font-medium text-[var(--text-secondary)]">Collection date</label>
                <Input
                  type="date"
                  className="mt-1"
                  value={collectedDate}
                  onChange={(e) => setCollectedDate(e.target.value)}
                  disabled={!selected}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[12px] font-medium text-[var(--text-secondary)]">Source channel *</label>
                <select
                  className="mt-1 w-full h-9 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 text-[13px]"
                  value={sourceChannel}
                  onChange={(e) => setSourceChannel(e.target.value)}
                  disabled={!selected}
                >
                  {SOURCE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="text-[12px] font-medium text-[var(--text-secondary)]">Particulars</label>
                <textarea
                  className="mt-1 w-full min-h-[80px] rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2 text-[13px] resize-y"
                  placeholder="Payment notes, reference, payer name…"
                  value={particulars}
                  onChange={(e) => setParticulars(e.target.value)}
                  disabled={!selected}
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-[12px] font-medium text-[var(--text-secondary)]">Receipt attachment</label>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <label
                    className={cn(
                      'inline-flex items-center gap-2 h-9 px-3 rounded-[var(--radius-md)] border border-dashed border-[var(--border-light)] text-[13px] cursor-pointer hover:bg-[var(--bg-subtle)]',
                      !selected && 'opacity-50 pointer-events-none'
                    )}
                  >
                    <Upload className="h-4 w-4" />
                    {receiptFile ? receiptFile.name : 'Choose file…'}
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*,.pdf,.png,.jpg,.jpeg,.webp"
                      onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                      disabled={!selected}
                    />
                  </label>
                  {receiptFile && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setReceiptFile(null)}>
                      Remove
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-[var(--text-tertiary)] mt-1">PDF or image — optional</p>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2 border-t border-[var(--border-light)] pt-4">
              <Button type="button" variant="secondary" onClick={resetForm} disabled={submitting}>
                Clear
              </Button>
              <Button type="submit" disabled={submitting || !selected}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save receipt
              </Button>
            </div>
          </div>
        </div>
      </form>

      <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-[var(--shadow-xs)] overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]/40">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Recent manual receipts</h2>
        </div>
        {historyLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
          </div>
        ) : (
          <DataTable data={history} columns={historyColumns} pageSize={10} emptyMessage="No receipts uploaded yet" />
        )}
      </div>
    </div>
  )
}
