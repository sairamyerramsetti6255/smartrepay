import { config } from './engine/src/config.js'
import { fetchLoanReceiptHistory } from './engine/src/loandiskClient.js'
import { crif } from './crifClient.js'
/** Read the actual receipt ledger, not matched bank credits (which may be unposted). */
async function cachedPaymentHistory(loanNumber) {
  try {
    const raw = await crif({ LoanNumber: String(loanNumber) }, 'Get_LoanRepayments')
    if (!Array.isArray(raw)) throw new Error('Invalid ledger response')
    return { complete: false, source: 'cached_ledger', rows: raw.filter(r=>r.EntryId!=null || r.Amount!=null).map(r=>({
      entryId: r.EntryId, source: r.Source || 'loandisk', loanNumber: String(r.LoanNumber || loanNumber),
      branchName: r.BranchName, date: r.RepaymentDate || r.RepaymentDateRaw,
      amount: r.Amount, reference: r.ReferenceNo || r.ReferenceNumber || null,
    })) }
  } catch { return { complete: false, source: 'unavailable', rows: [] } }
}

function receiptDate(value) {
  const text = String(value || '')
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0,10)
  const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}
export async function loadPaymentHistory(loan) {
  const cached = await cachedPaymentHistory(loan.loanNumber)
  const branch = config.loandisk.branches.find(b=>b.name.toLowerCase()===String(loan.branch || '').toLowerCase())
  if (!branch || !config.loandisk.publicKey || !config.loandisk.authToken) return cached
  try {
    const raw = await fetchLoanReceiptHistory(branch.id, loan.loanNumber)
    const rows = raw.map(r=>({entryId:String(r.repayment_id),source:'loandisk',loanNumber:loan.loanNumber,
      branchName:loan.branch,date:receiptDate(r.repayment_collected_date),amount:Number(r.repayment_amount),
      reference:r.repayment_reference || null}))
    if (rows.some(r=>!r.date || !Number.isFinite(r.amount))) throw new Error('Unknown repayment date/amount schema')
    // Manual receipts may already have been entered in LoanDisk. Do not sum both sources blindly.
    const pendingManual = cached.rows.some(r=>r.source==='manual')
    return { rows, complete: !pendingManual, source: 'live_loandisk', fetchedAt: new Date().toISOString(), manualReconciliationRequired: pendingManual }
  } catch { return cached }
}
