const cents = v => Math.round(Number(v) * 100)
const day = v => String(v || '').slice(0,10)
/** History supplements borrower identity; it must never select a different person. */
export function assessPayment(tx, loan, history = {}) {
  const date = day(tx.TransDate), month = date.slice(0,7)
  const seen = new Set()
  const rows = (history.rows || []).filter(r => {
    if (String(r.loanNumber) !== String(loan.loanNumber)) return false
    if (r.branchName && loan.branch && r.branchName.toLowerCase() !== loan.branch.toLowerCase()) return false
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day(r.date)) || day(r.date) > date || !Number.isFinite(Number(r.amount)) || Number(r.amount) <= 0) return false
    // Only deduplicate by immutable receipt ID; equal amounts can be legitimate.
    const key = r.entryId ? `${r.source}:${r.entryId}` : null
    if (key && seen.has(key)) return false
    if (key) seen.add(key)
    return true
  })
  const monthly = rows.filter(r=>day(r.date).startsWith(month))
  const paid = cents(tx.EmiPaidAmount), base = cents(loan.expectedEMI)
  const paidBefore = monthly.reduce((s,r)=>s+cents(r.amount),0)
  const reference = String(tx.ReferenceNo || '').trim()
  const duplicate = rows.some(r=>reference && String(r.reference || '').trim()===reference && cents(r.amount)===paid)
  const possibleDuplicate = monthly.some(r=>day(r.date)===date && cents(r.amount)===paid)
  const dates = [...new Set(rows.map(r=>day(r.date)))].sort().slice(-6)
  const gaps = dates.slice(1).map((d,i)=>(Date.parse(d)-Date.parse(dates[i]))/86400000)
  const cadence = gaps.length>=2 && gaps.every(g=>g>=5&&g<=9) ? 'weekly' : gaps.length>=2 && gaps.every(g=>g>=12&&g<=16) ? 'biweekly' : gaps.length>=2 && gaps.every(g=>g>=26&&g<=35) ? 'monthly' : 'irregular / insufficient history'
  let kind = !Number.isFinite(base) || base<=0 ? 'unknown_schedule' : paid<base ? 'partial_installment' : paid===base ? 'base_installment' : 'possible_arrears_or_advance'
  if (duplicate) kind='possible_existing_receipt'
  // A monthly expectation is valid only when the loan master explicitly says monthly.
  const monthlySchedule = /^(monthly|month)$/i.test(loan.frequency || '')
  const expectedMonthly = monthlySchedule && base>0 ? base : null
  const combined = paidBefore + (duplicate ? 0 : paid)
  if (expectedMonthly && paidBefore>0 && combined===expectedMonthly && !duplicate) kind='month_completed_by_installments'
  const syncAge = Date.now() - Date.parse(loan.syncedAt || '')
  const masterFresh = Number.isFinite(syncAge) && syncAge >= 0 && syncAge <= 36*60*60*1000
  return { masterFresh, kind, month, currentPayment: paid/100, recordedMonthPaid: paidBefore/100,
    monthIncludingPayment: combined/100, priorReceiptCount: monthly.length,
    expectedMonthly: expectedMonthly == null ? null : expectedMonthly/100,
    observedCadence: cadence, configuredFrequency: loan.frequency || null,
    duplicate, possibleDuplicate, historyComplete: history.complete === true,
    requiresReview: !masterFresh || duplicate || possibleDuplicate || history.complete !== true || kind !== 'base_installment',
    explanation: `${month}: ${monthly.length} recorded receipts total ${(paidBefore/100).toFixed(2)}; current payment ${(paid/100).toFixed(2)}; ${kind}; observed cadence ${cadence}. ${history.complete === true ? '' : 'Cached history is not proven complete/current; verify LoanDisk.'} ${monthlySchedule ? '' : 'Monthly obligation not inferred from base EMI.'} ${masterFresh ? '' : 'Loan master freshness requires verification.'}`.trim() }
}
