/**
 * Server-side posting gates. Name comparison uses a lightweight token check
 * (same rules as the client drawer) without importing Vite UI modules.
 */

function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && t.length > 1)
}

function firstLastAgree(bankName, borrowerName) {
  const a = tokenize(bankName)
  const b = tokenize(borrowerName)
  if (a.length < 2 || b.length < 2) return false
  const fa = a[0]
  const la = a[a.length - 1]
  const fb = b[0]
  const lb = b[b.length - 1]
  if ((fa === fb && la === lb) || (fa === lb && la === fb)) return true
  // Bank omitted given name: middle(+…) + last still agree with the selected borrower
  if (a.length >= 2 && b.length > a.length) {
    for (let i = 1; i <= b.length - a.length; i++) {
      const window = b.slice(i, i + a.length)
      if (a.every((t, j) => t === window[j])) return true
    }
  }
  return false
}

export function evaluateBeneficiaryGate({ bankName, selectedBorrowerName, overrideReason = '' }) {
  const bank = String(bankName || '').trim()
  if (!bank) return { ok: true, conflict: false, bankName: '', reason: null }
  const conflict = !firstLastAgree(bank, selectedBorrowerName || '')
  if (!conflict) return { ok: true, conflict: false, bankName: bank, reason: null }
  const reason = String(overrideReason || '').trim()
  if (reason.length >= 8) {
    return { ok: true, conflict: true, overridden: true, bankName: bank, reason }
  }
  return {
    ok: false,
    conflict: true,
    overridden: false,
    bankName: bank,
    reason: null,
    message: `Bank name "${bank}" does not match selected borrower "${selectedBorrowerName || ''}". Enter an override reason (8+ chars) to confirm anyway.`,
  }
}

export function evaluateLoanPostGate({
  loanBook = null,
  borrowerId = null,
  loanNumber = null,
  amount = null,
  postedDate = null,
  reference = null,
  existingReceipts = [],
} = {}) {
  const issues = []
  if (!loanNumber) issues.push('No loan selected')
  if (!borrowerId) issues.push('No borrower selected')

  if (loanBook) {
    const loanBorrower = String(loanBook.BorrowerId || loanBook.borrowerId || '').trim()
    if (borrowerId && loanBorrower && loanBorrower !== String(borrowerId)) {
      issues.push('Loan does not belong to the selected borrower')
    }
    const status = String(loanBook.LoanStatus || loanBook.status || '').toLowerCase()
    if (status && !/^(active|current|open|arrears|overdue|past due|delinquent)$/i.test(status)) {
      issues.push(`Loan status is "${loanBook.LoanStatus || loanBook.status}", not active`)
    }
  } else if (loanNumber) {
    issues.push('Loan could not be loaded from master — verify LoanDisk sync')
  }

  const paid = Number(amount)
  const day = String(postedDate || '').slice(0, 10)
  const ref = String(reference || '').trim()
  if (Number.isFinite(paid) && paid > 0 && day) {
    const dup = (existingReceipts || []).some((r) => {
      const sameLoan = String(r.loanNumber || r.LoanId || '') === String(loanNumber)
      const sameAmt = Math.abs(Number(r.amount) - paid) < 0.01
      const sameDay = String(r.date || '').slice(0, 10) === day
      const sameRef = ref && String(r.reference || '').trim() === ref
      return sameLoan && sameAmt && sameDay && (sameRef || !ref)
    })
    if (dup) issues.push('Possible duplicate receipt for same loan, amount, and posted date')
  }

  return {
    ok: issues.length === 0,
    issues,
    message: issues.length ? issues.join('; ') : null,
    readyToPost: issues.length === 0,
  }
}
