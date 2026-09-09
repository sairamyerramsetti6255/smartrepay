import { useState, useEffect } from 'react'
import { X, Save, RefreshCw, FileText, CheckCircle } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import toast from 'react-hot-toast'

const PAYMENT_METHODS = [
  'ACH',
  'Check',
  'Cash',
  'Wire Transfer',
  'Credit Card',
  'Debit Card',
  'Bank Transfer',
]

const DEPOSIT_ACCOUNTS = [
  'General Bank Account',
  'Operating Bank Account',
  'Undeposited Funds',
  'Checking - 1000',
  'Payroll Account - 1020',
  'Business Savings - 1050',
]

const DISBURSEMENT_ACCOUNTS = [
  'Loan Disbursements',
  'Loans Receivable',
  'Operating Expenses',
  'Legal & Professional Fees',
  'Office Expenses',
  'Bank Service Charges',
]

export function QBTransactionModal({
  isOpen,
  onClose,
  initialData = null,
  defaultType = 'emi_receipt',
  onSuccess,
}) {
  const isEdit = Boolean(initialData?.id)

  const [formData, setFormData] = useState({
    template_type: defaultType,
    transaction_date: new Date().toISOString().slice(0, 10),
    customer_name: '',
    amount: '',
    payment_method: 'ACH',
    reference_number: '',
    deposit_to: 'General Bank Account',
    bank_account: 'Operating Bank Account',
    account_name: defaultType === 'payment_disbursed' ? 'Loan Disbursements' : 'Loans Receivable',
    borrower_id: '',
    loan_id: '',
    memo: '',
    principal_amount: '',
    interest_amount: '',
    use_split: false,
  })

  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (initialData) {
      const isDisbursed = initialData.template_type === 'payment_disbursed'
      const lines = initialData.lines || []
      const principalLine = lines.find((l) => /principal|receivable/i.test(l.account_name || l.memo))
      const interestLine = lines.find((l) => /interest/i.test(l.account_name || l.memo))

      setFormData({
        template_type: initialData.template_type || defaultType,
        transaction_date: initialData.transaction_date ? String(initialData.transaction_date).slice(0, 10) : new Date().toISOString().slice(0, 10),
        customer_name: initialData.customer_name || initialData.vendor_name || '',
        amount: initialData.amount != null ? String(initialData.amount) : '',
        payment_method: initialData.payment_method || 'ACH',
        reference_number: initialData.reference_number || '',
        deposit_to: initialData.deposit_to || 'General Bank Account',
        bank_account: initialData.bank_account || 'Operating Bank Account',
        account_name: lines[0]?.account_name || (isDisbursed ? 'Loan Disbursements' : 'Loans Receivable'),
        borrower_id: initialData.borrower_id || '',
        loan_id: initialData.loan_id || '',
        memo: lines[0]?.memo || '',
        principal_amount: principalLine ? String(principalLine.amount) : '',
        interest_amount: interestLine ? String(interestLine.amount) : '',
        use_split: Boolean(principalLine && interestLine),
      })
    } else {
      setFormData({
        template_type: defaultType,
        transaction_date: new Date().toISOString().slice(0, 10),
        customer_name: '',
        amount: '',
        payment_method: 'ACH',
        reference_number: '',
        deposit_to: 'General Bank Account',
        bank_account: 'Operating Bank Account',
        account_name: defaultType === 'payment_disbursed' ? 'Loan Disbursements' : 'Loans Receivable',
        borrower_id: '',
        loan_id: '',
        memo: defaultType === 'payment_disbursed' ? 'Disbursement Payment' : 'Customer EMI Payment',
        principal_amount: '',
        interest_amount: '',
        use_split: false,
      })
    }
  }, [initialData, defaultType, isOpen])

  if (!isOpen) return null

  const isReceipt = formData.template_type === 'emi_receipt'

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!formData.customer_name.trim()) {
      toast.error(isReceipt ? 'Customer name is required' : 'Payee / Vendor name is required')
      return
    }
    const numAmount = parseFloat(formData.amount)
    if (isNaN(numAmount) || numAmount <= 0) {
      toast.error('Please enter a valid amount greater than 0')
      return
    }

    try {
      setSaving(true)
      const payload = {
        template_type: formData.template_type,
        transaction_date: formData.transaction_date,
        customer_name: formData.customer_name.trim(),
        vendor_name: formData.customer_name.trim(),
        amount: numAmount,
        payment_method: formData.payment_method,
        reference_number: formData.reference_number.trim(),
        deposit_to: isReceipt ? formData.deposit_to : null,
        bank_account: !isReceipt ? formData.bank_account : null,
        borrower_id: isReceipt ? (formData.borrower_id.trim() || null) : null,
        loan_id: isReceipt ? (formData.loan_id.trim() || null) : null,
        memo: formData.memo.trim(),
        currency: 'BSD',
      }

      if (isReceipt && formData.use_split) {
        const pAmt = parseFloat(formData.principal_amount) || 0
        const iAmt = parseFloat(formData.interest_amount) || 0
        payload.principal_amount = pAmt
        payload.interest_amount = iAmt
      } else {
        payload.account_name = formData.account_name
      }

      let res
      if (isEdit) {
        res = await quickbooks.updateTransaction(initialData.id, payload)
        toast.success('Transaction updated successfully')
      } else {
        res = await quickbooks.createTransaction(payload)
        toast.success(isReceipt ? 'EMI Receipt created successfully' : 'Payment Disbursement created successfully')
      }

      onSuccess?.(res)
      onClose()
    } catch (err) {
      toast.error(err.message || 'Failed to save transaction')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in">
      <div className="bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden animate-in zoom-in-95">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-[var(--border-light)] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[var(--radius-md)] bg-[var(--accent-subtle)] text-[var(--accent)]">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-[16px] font-bold text-[var(--text-primary)]">
                {isEdit ? 'Modify Transaction' : isReceipt ? 'Add EMI Receipt' : 'Add Payment Disbursement'}
              </h3>
              <p className="text-[12px] text-[var(--text-secondary)]">
                QuickBooks Template: {isReceipt ? 'Receive Payment / Sales Receipt' : 'Check / Bill Payment'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body / Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Template Type Selector (for new entries) */}
          {!isEdit && (
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">
                Transaction Template Type
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, template_type: 'emi_receipt', account_name: 'Loans Receivable' })}
                  className={`p-3 rounded-[var(--radius-md)] border text-left flex items-center justify-between transition-colors ${
                    isReceipt
                      ? 'border-[var(--accent)] bg-[var(--accent-subtle)]/50 text-[var(--text-primary)] font-semibold'
                      : 'border-[var(--border-light)] bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <div>
                    <p className="text-[13px] font-medium">EMI Receipt</p>
                    <p className="text-[11px] text-[var(--text-tertiary)]">Customer loan payment received</p>
                  </div>
                  {isReceipt && <CheckCircle className="h-4 w-4 text-[var(--accent)] shrink-0" />}
                </button>

                <button
                  type="button"
                  onClick={() => setFormData({ ...formData, template_type: 'payment_disbursed', account_name: 'Loan Disbursements' })}
                  className={`p-3 rounded-[var(--radius-md)] border text-left flex items-center justify-between transition-colors ${
                    !isReceipt
                      ? 'border-[var(--accent)] bg-[var(--accent-subtle)]/50 text-[var(--text-primary)] font-semibold'
                      : 'border-[var(--border-light)] bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <div>
                    <p className="text-[13px] font-medium">Payment Disbursed</p>
                    <p className="text-[11px] text-[var(--text-tertiary)]">Disbursement to borrower / vendor</p>
                  </div>
                  {!isReceipt && <CheckCircle className="h-4 w-4 text-[var(--accent)] shrink-0" />}
                </button>
              </div>
            </div>
          )}

          {/* Core Info Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Customer / Payee Name */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                {isReceipt ? 'Customer / Borrower Name *' : 'Payee / Vendor Name *'}
              </label>
              <input
                type="text"
                required
                value={formData.customer_name}
                onChange={(e) => setFormData({ ...formData, customer_name: e.target.value })}
                placeholder={isReceipt ? 'e.g. John Doe' : 'e.g. Acme Corp / Borrower'}
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </div>

            {/* Transaction Date */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                Transaction Date *
              </label>
              <input
                type="date"
                required
                value={formData.transaction_date}
                onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </div>

            {/* Total Amount */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                {isReceipt ? 'EMI Amount ($) *' : 'Disbursement Amount ($) *'}
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                placeholder="0.00"
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-semibold text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </div>

            {/* Reference Number */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                Reference / Check #
              </label>
              <input
                type="text"
                value={formData.reference_number}
                onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                placeholder="e.g. REF-88219 or CHK-1044"
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-mono text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </div>

            {/* Payment Method */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                Payment Method
              </label>
              <select
                value={formData.payment_method}
                onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            {/* Deposit Account or Bank Account */}
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                {isReceipt ? 'Deposit To Account' : 'Bank Account'}
              </label>
              <input
                type="text"
                list={isReceipt ? 'deposit-accounts-list' : 'disb-accounts-list'}
                value={isReceipt ? formData.deposit_to : formData.bank_account}
                onChange={(e) => setFormData({
                  ...formData,
                  ...(isReceipt ? { deposit_to: e.target.value } : { bank_account: e.target.value })
                })}
                placeholder={isReceipt ? 'General Bank Account' : 'Operating Bank Account'}
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
              <datalist id="deposit-accounts-list">
                {DEPOSIT_ACCOUNTS.map((a) => <option key={a} value={a} />)}
              </datalist>
              <datalist id="disb-accounts-list">
                {DEPOSIT_ACCOUNTS.map((a) => <option key={a} value={a} />)}
              </datalist>
            </div>
          </div>

          {/* EMI Specific Fields (LoanDisk Borrower ID, Loan #) */}
          {isReceipt && (
            <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)]/40 space-y-3">
              <p className="text-[12px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
                LoanDisk Association
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                    LoanDisk Borrower ID
                  </label>
                  <input
                    type="text"
                    value={formData.borrower_id}
                    onChange={(e) => setFormData({ ...formData, borrower_id: e.target.value })}
                    placeholder="e.g. BOR-1002"
                    className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-mono text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                    Loan Number
                  </label>
                  <input
                    type="text"
                    value={formData.loan_id}
                    onChange={(e) => setFormData({ ...formData, loan_id: e.target.value })}
                    placeholder="e.g. 5092"
                    className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-mono text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Payment Disbursed Specific Account */}
          {!isReceipt && (
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                Disbursement Account / Expense Category
              </label>
              <input
                type="text"
                list="expense-categories"
                value={formData.account_name}
                onChange={(e) => setFormData({ ...formData, account_name: e.target.value })}
                placeholder="Loan Disbursements"
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
              <datalist id="expense-categories">
                {DISBURSEMENT_ACCOUNTS.map((a) => <option key={a} value={a} />)}
              </datalist>
            </div>
          )}

          {/* Memo / Notes */}
          <div>
            <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
              Memo / Description
            </label>
            <input
              type="text"
              value={formData.memo}
              onChange={(e) => setFormData({ ...formData, memo: e.target.value })}
              placeholder="e.g. Monthly installment payment"
              className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          {/* Modal Footer */}
          <div className="pt-4 border-t border-[var(--border-light)] flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-colors shadow-xs"
            >
              {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Record'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
