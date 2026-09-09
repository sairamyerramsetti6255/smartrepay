import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2, Receipt, Search, Upload, User, X } from 'lucide-react'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/Badge'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { formatCurrency, cn } from '@/lib/utils'

export const SOURCE_OPTIONS = [
  { value: 'walkin', label: 'Walk-in' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
]

export function ReceiptFormDialog({ open, onClose, mode = 'create', receipt, onSaved }) {
  const isEdit = mode === 'edit'

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

  const selected = useMemo(
    () => loans.find((l) => l.loanNumber === selectedLoan) || null,
    [loans, selectedLoan]
  )

  const loadLoansForBorrower = useCallback(async (borrower, preselectLoan = null) => {
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
      else if (preselectLoan && list.some((l) => l.loanNumber === preselectLoan)) setSelectedLoan(preselectLoan)
      else if (list.length === 1) setSelectedLoan(list[0].loanNumber)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoadingLoans(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setNameSearch('')
    setBorrowerResults([])
    setReceiptFile(null)
    setSubmitting(false)

    if (isEdit && receipt) {
      setAmountReceived(receipt.amountReceived != null ? String(receipt.amountReceived) : '')
      setParticulars(receipt.particulars || '')
      setSourceChannel(receipt.sourceChannel || 'walkin')
      setCollectedDate(receipt.collectedDate?.slice?.(0, 10) || receipt.collectedDate || new Date().toISOString().slice(0, 10))
      loadLoansForBorrower(
        {
          borrowerId: receipt.borrowerId,
          borrowerName: receipt.borrowerName || `Borrower ${receipt.borrowerId}`,
          branchName: null,
        },
        receipt.loanNumber
      )
      return
    }

    setSelectedBorrower(null)
    setLoans([])
    setSelectedLoan(null)
    setAmountReceived('')
    setParticulars('')
    setSourceChannel('walkin')
    setCollectedDate(new Date().toISOString().slice(0, 10))
  }, [open, isEdit, receipt, loadLoansForBorrower])

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

  async function handleSubmit(e) {
    e.preventDefault()
    if (!selected) return toast.error('Select a loan')
    const amount = Number(String(amountReceived).replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(amount) || amount <= 0) return toast.error('Enter a valid amount received')

    const payload = {
      borrowerId: selectedBorrower.borrowerId,
      loanNumber: selected.loanNumber,
      branchId: selected.branchId,
      borrowerName: selected.borrowerName || selectedBorrower.borrowerName,
      amountReceived: amount,
      particulars,
      sourceChannel,
      collectedDate,
    }

    if (isEdit && receipt) {
      payload.receiptDocumentId = receipt.receiptDocumentId || ''
      payload.receiptFileName = receipt.receiptFileName || ''
    }

    setSubmitting(true)
    try {
      if (isEdit && receipt?.id) {
        await api.receipts.update(receipt.id, payload, receiptFile)
        toast.success('Receipt updated')
      } else {
        await api.receipts.create(payload, receiptFile)
        toast.success('Receipt saved')
      }
      onSaved?.()
      onClose?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose?.()}>
      <DialogContent title={isEdit ? 'Edit receipt' : 'Add receipt'} className="max-w-xl">
        <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-4">
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                <Search className="h-4 w-4 text-[var(--accent)]" />
                Borrower & loan
              </h3>
              <Input
                placeholder="Search borrower name or ID…"
                value={nameSearch}
                onChange={(e) => {
                  setNameSearch(e.target.value)
                  if (selectedBorrower) clearBorrowerSelection()
                }}
                autoComplete="off"
              />
              <p className="text-[11px] text-[var(--text-tertiary)] mt-1">Type 2+ characters</p>

              <div className="mt-3">
                {selectedBorrower ? (
                  <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--accent-border)] bg-[var(--accent-subtle)]/50 px-3 py-2">
                    <User className="h-4 w-4 text-[var(--accent)] shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold truncate">{selectedBorrower.borrowerName}</p>
                      <p className="text-[11px] text-[var(--text-tertiary)] mono">ID {selectedBorrower.borrowerId}</p>
                    </div>
                    <button type="button" className="p-1 rounded hover:bg-[var(--bg-card)]" onClick={clearBorrowerSelection}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="max-h-[120px] overflow-y-auto rounded-[var(--radius-md)] border divide-y">
                    {nameSearch.trim().length < 2 ? (
                      <p className="text-[12px] text-[var(--text-tertiary)] px-3 py-4 text-center">Search for a borrower</p>
                    ) : searchingBorrowers ? (
                      <div className="flex justify-center py-6">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                    ) : borrowerResults.length === 0 ? (
                      <p className="text-[12px] text-[var(--text-tertiary)] px-3 py-4 text-center">No borrowers found</p>
                    ) : (
                      borrowerResults.map((b) => (
                        <button
                          key={b.borrowerId}
                          type="button"
                          onClick={() => loadLoansForBorrower(b)}
                          className="w-full text-left px-3 py-2 hover:bg-[var(--bg-subtle)] flex gap-2"
                        >
                          <User className="h-4 w-4 shrink-0 mt-0.5 text-[var(--text-tertiary)]" />
                          <div className="min-w-0">
                            <p className="text-[13px] font-medium truncate">{b.borrowerName}</p>
                            <p className="text-[11px] text-[var(--text-tertiary)] mono">ID {b.borrowerId}</p>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>

              {selectedBorrower && (
                <div className="mt-3 max-h-[100px] overflow-y-auto rounded-[var(--radius-md)] border divide-y">
                  {loadingLoans ? (
                    <div className="flex justify-center py-6">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : loans.length === 0 ? (
                    <p className="text-[12px] text-[var(--text-tertiary)] px-3 py-4 text-center">No loans</p>
                  ) : (
                    loans.map((loan) => {
                      const active = selectedLoan === loan.loanNumber
                      return (
                        <button
                          key={loan.loanNumber}
                          type="button"
                          onClick={() => setSelectedLoan(loan.loanNumber)}
                          className={cn('w-full text-left px-3 py-2', active ? 'bg-[var(--accent-subtle)]' : 'hover:bg-[var(--bg-subtle)]')}
                        >
                          <span className="mono text-[12px] font-semibold">Loan {loan.loanNumber}</span>
                          <span className="text-[11px] text-[var(--text-tertiary)] ml-2">
                            {loan.emiAmount != null ? formatCurrency(loan.emiAmount) : ''}
                          </span>
                          {loan.loanStatus && (
                            <Badge variant="posted" className="ml-2">
                              {loan.loanStatus}
                            </Badge>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              )}
            </div>

            <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-4">
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
                <Receipt className="h-4 w-4 text-[var(--accent)]" />
                Payment details
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-[12px] font-medium text-[var(--text-secondary)]">Amount *</label>
                  <Input
                    type="text"
                    inputMode="decimal"
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
                  <label className="text-[12px] font-medium text-[var(--text-secondary)]">Source *</label>
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
                    className="mt-1 w-full min-h-[72px] rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2 text-[13px] resize-y"
                    value={particulars}
                    onChange={(e) => setParticulars(e.target.value)}
                    disabled={!selected}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-[12px] font-medium text-[var(--text-secondary)]">Attachment</label>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <label
                      className={cn(
                        'inline-flex items-center gap-2 h-9 px-3 rounded-[var(--radius-md)] border border-dashed text-[13px] cursor-pointer hover:bg-[var(--bg-subtle)]',
                        !selected && 'opacity-50 pointer-events-none'
                      )}
                    >
                      <Upload className="h-4 w-4" />
                      {receiptFile ? receiptFile.name : isEdit && receipt?.receiptFileName ? receipt.receiptFileName : 'Choose file…'}
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
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t px-6 py-4">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !selected}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {isEdit ? 'Update receipt' : 'Save receipt'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
