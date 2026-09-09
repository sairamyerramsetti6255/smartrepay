import { useState, useEffect } from 'react'
import {
  ArrowLeft,
  Save,
  RefreshCw,
  FileText,
  CheckCircle2,
  DollarSign,
  Calendar,
  CreditCard,
  Landmark,
  User,
  Hash,
  FileCheck,
  Layers,
  ShieldCheck,
  HelpCircle,
} from 'lucide-react'
import { quickbooks } from '@/lib/api'
import toast from 'react-hot-toast'
import { cn } from '@/lib/utils'

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

export function QBTransactionForm({
  initialData = null,
  defaultType = 'emi_receipt',
  onClose,
  onSuccess,
  backLabel = 'Back',
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
  }, [initialData, defaultType])

  const isReceipt = formData.template_type === 'emi_receipt'
  const displayAmount = parseFloat(formData.amount) || 0
  const isFormValid = Boolean(formData.customer_name.trim() && displayAmount > 0)

  const handleSubmit = async (e) => {
    e?.preventDefault?.()
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
    } catch (err) {
      toast.error(err.message || 'Failed to save transaction')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="w-full space-y-6 animate-in fade-in duration-200">
      {/* Top Header & Actions Bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shadow-xs"
        >
          <ArrowLeft className="h-4 w-4 text-[var(--accent)]" />
          {backLabel}
        </button>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-5 py-2 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-colors shadow-xs"
          >
            {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Record'}
          </button>
        </div>
      </div>

      {/* Top Executive Summary Card (Full Width) */}
      <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="p-3.5 rounded-[var(--radius-md)] bg-[var(--accent-subtle)] text-[var(--accent)] shrink-0">
              <FileText className="h-7 w-7" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-[22px] font-bold text-[var(--text-primary)]">
                  {isEdit ? 'Modify Record' : isReceipt ? 'New EMI Receipt' : 'New Payment Disbursement'}
                </h1>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent)]/20">
                  {isReceipt ? 'Receive Payment' : 'Check / Bill Payment'}
                </span>
              </div>
              <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                QuickBooks Desktop Template: {isReceipt ? 'Customer EMI Payment (Receive Payment / Sales Receipt)' : 'Disbursement Payment (Check / Bill Payment)'}
              </p>
            </div>
          </div>

          <div className="sm:text-right p-3.5 sm:p-0 rounded-[var(--radius-md)] sm:rounded-none bg-[var(--bg-subtle)] sm:bg-transparent">
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
              {isReceipt ? 'EMI Amount' : 'Disbursed Amount'}
            </p>
            <p className="text-[34px] font-extrabold text-[var(--accent)] leading-tight mt-0.5">
              ${displayAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      </div>

      {/* Responsive 2-Column Grid (Left Form Area + Right Summary Panel) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Form Area (2 Cols) */}
        <div className="lg:col-span-2 space-y-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Template Type Selector (Only on New Record) */}
            {!isEdit && (
              <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs">
                <label className="block text-[11px] font-bold uppercase tracking-wider text-[var(--text-tertiary)] mb-3">
                  Transaction Template Type
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, template_type: 'emi_receipt', account_name: 'Loans Receivable' })}
                    className={`p-4 rounded-[var(--radius-md)] border text-left flex items-center justify-between transition-colors ${
                      isReceipt
                        ? 'border-[var(--accent)] bg-[var(--accent-subtle)]/50 text-[var(--text-primary)] font-semibold shadow-xs'
                        : 'border-[var(--border-light)] bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <div>
                      <p className="text-[14px] font-bold text-[var(--text-primary)]">EMI Receipt</p>
                      <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">Customer loan payment received</p>
                    </div>
                    {isReceipt && <CheckCircle2 className="h-5 w-5 text-[var(--accent)] shrink-0" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, template_type: 'payment_disbursed', account_name: 'Loan Disbursements' })}
                    className={`p-4 rounded-[var(--radius-md)] border text-left flex items-center justify-between transition-colors ${
                      !isReceipt
                        ? 'border-[var(--accent)] bg-[var(--accent-subtle)]/50 text-[var(--text-primary)] font-semibold shadow-xs'
                        : 'border-[var(--border-light)] bg-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <div>
                      <p className="text-[14px] font-bold text-[var(--text-primary)]">Payment Disbursed</p>
                      <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">Disbursement payment to borrower / vendor</p>
                    </div>
                    {!isReceipt && <CheckCircle2 className="h-5 w-5 text-[var(--accent)] shrink-0" />}
                  </button>
                </div>
              </div>
            )}

            {/* Primary Transaction Details Card */}
            <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs space-y-5">
              <h3 className="text-[15px] font-bold text-[var(--text-primary)] border-b border-[var(--border-light)] pb-3">
                Transaction Details
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                {/* Customer / Payee */}
                <div className="sm:col-span-2">
                  <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                    {isReceipt ? 'Customer / Borrower Name *' : 'Payee / Vendor Name *'}
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.customer_name}
                    onChange={(e) => setFormData({ ...formData, customer_name: e.target.value })}
                    placeholder={isReceipt ? 'e.g. Jane Doe' : 'e.g. Acme Borrowers Ltd.'}
                    className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-medium text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                </div>

                {/* Transaction Date */}
                <div>
                  <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                    Transaction Date *
                  </label>
                  <input
                    type="date"
                    required
                    value={formData.transaction_date}
                    onChange={(e) => setFormData({ ...formData, transaction_date: e.target.value })}
                    className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                </div>

                {/* Total Amount */}
                <div>
                  <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                    {isReceipt ? 'Total EMI Amount ($) *' : 'Total Payment Amount ($) *'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={formData.amount}
                    onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                    placeholder="0.00"
                    className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[14px] font-bold text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                </div>

                {/* Reference Number */}
                <div>
                  <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                    Reference / Check #
                  </label>
                  <input
                    type="text"
                    value={formData.reference_number}
                    onChange={(e) => setFormData({ ...formData, reference_number: e.target.value })}
                    placeholder="e.g. REF-10928 or CHK-4421"
                    className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-mono text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                </div>

                {/* Payment Method */}
                <div>
                  <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                    Payment Method
                  </label>
                  <select
                    value={formData.payment_method}
                    onChange={(e) => setFormData({ ...formData, payment_method: e.target.value })}
                    className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  >
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                {/* Deposit Account or Bank Account */}
                <div className="sm:col-span-2">
                  <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                    {isReceipt ? 'Deposit To Account' : 'Bank Account'}
                  </label>
                  <input
                    type="text"
                    list={isReceipt ? 'deposit-accounts-list-w' : 'disb-accounts-list-w'}
                    value={isReceipt ? formData.deposit_to : formData.bank_account}
                    onChange={(e) => setFormData({
                      ...formData,
                      ...(isReceipt ? { deposit_to: e.target.value } : { bank_account: e.target.value })
                    })}
                    placeholder={isReceipt ? 'General Bank Account' : 'Operating Bank Account'}
                    className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                  <datalist id="deposit-accounts-list-w">
                    {DEPOSIT_ACCOUNTS.map((a) => <option key={a} value={a} />)}
                  </datalist>
                  <datalist id="disb-accounts-list-w">
                    {DEPOSIT_ACCOUNTS.map((a) => <option key={a} value={a} />)}
                  </datalist>
                </div>
              </div>
            </div>

            {/* LoanDisk Association Card (For EMI Receipts) */}
            {isReceipt && (
              <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs space-y-5">
                <h3 className="text-[15px] font-bold text-[var(--text-primary)] border-b border-[var(--border-light)] pb-3">
                  LoanDisk Linkage
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                      LoanDisk Borrower ID
                    </label>
                    <input
                      type="text"
                      value={formData.borrower_id}
                      onChange={(e) => setFormData({ ...formData, borrower_id: e.target.value })}
                      placeholder="e.g. BOR-1002"
                      className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-mono font-bold text-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                  </div>

                  <div>
                    <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                      Loan Number
                    </label>
                    <input
                      type="text"
                      value={formData.loan_id}
                      onChange={(e) => setFormData({ ...formData, loan_id: e.target.value })}
                      placeholder="e.g. 5092"
                      className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-mono text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Accounting & Category Card */}
            <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs space-y-5">
              <h3 className="text-[15px] font-bold text-[var(--text-primary)] border-b border-[var(--border-light)] pb-3">
                Accounting Classification & Memo
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                    {isReceipt ? 'Ledger Account' : 'Disbursement Category / Account'}
                  </label>
                  <input
                    type="text"
                    list="expense-categories-w"
                    value={formData.account_name}
                    onChange={(e) => setFormData({ ...formData, account_name: e.target.value })}
                    placeholder={isReceipt ? 'Loans Receivable' : 'Loan Disbursements'}
                    className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                  <datalist id="expense-categories-w">
                    {DISBURSEMENT_ACCOUNTS.map((a) => <option key={a} value={a} />)}
                  </datalist>
                </div>

                <div>
                  <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                    Memo / Particulars
                  </label>
                  <input
                    type="text"
                    value={formData.memo}
                    onChange={(e) => setFormData({ ...formData, memo: e.target.value })}
                    placeholder="e.g. Monthly installment payment"
                    className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                </div>
              </div>
            </div>

            {/* Bottom Actions Bar */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="px-5 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 px-6 py-2.5 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-colors shadow-xs"
              >
                {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Record'}
              </button>
            </div>
          </form>
        </div>

        {/* Right Sidebar / Summary Panel (1 Col) */}
        <div className="lg:col-span-1 space-y-6 lg:sticky lg:top-6">
          {/* Live QuickBooks Preview Summary Card */}
          <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-[14px] font-bold text-[var(--text-primary)]">
                QuickBooks Preview
              </h4>
              <span className={cn(
                'text-[11px] font-semibold px-2 py-0.5 rounded-full border',
                isFormValid
                  ? 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/20'
                  : 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/20'
              )}>
                {isFormValid ? 'Ready' : 'Draft'}
              </span>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] space-y-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
                  {isReceipt ? 'EMI Payment Amount' : 'Disbursement Amount'}
                </p>
                <p className="text-[26px] font-extrabold text-[var(--accent)] leading-tight mt-0.5">
                  ${displayAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>

              <div className="pt-3 border-t border-[var(--border-light)] space-y-2 text-[12px]">
                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Customer / Payee:</span>
                  <span className="font-semibold text-[var(--text-primary)] truncate max-w-[150px]">
                    {formData.customer_name || '—'}
                  </span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Date:</span>
                  <span className="text-[var(--text-primary)] font-medium">
                    {formData.transaction_date || '—'}
                  </span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Method:</span>
                  <span className="text-[var(--text-primary)] font-medium">
                    {formData.payment_method}
                  </span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Reference #:</span>
                  <span className="font-mono text-[var(--text-primary)] font-medium">
                    {formData.reference_number || '—'}
                  </span>
                </div>

                {isReceipt && (
                  <div className="flex justify-between items-center">
                    <span className="text-[var(--text-tertiary)]">LoanDisk ID:</span>
                    <span className="font-mono text-[var(--accent)] font-bold">
                      {formData.borrower_id || '—'}
                    </span>
                  </div>
                )}

                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">
                    {isReceipt ? 'Deposit To:' : 'Bank Account:'}
                  </span>
                  <span className="text-[var(--text-primary)] truncate max-w-[150px]">
                    {isReceipt ? formData.deposit_to : formData.bank_account}
                  </span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Category / Account:</span>
                  <span className="text-[var(--text-primary)] font-medium truncate max-w-[150px]">
                    {formData.account_name}
                  </span>
                </div>
              </div>
            </div>

            <div className="pt-2 flex flex-col gap-2">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving}
                className="w-full inline-flex items-center justify-center gap-2 h-10 px-4 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-50 transition-colors shadow-xs"
              >
                {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Record'}
              </button>
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="w-full h-9 px-4 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>

          {/* QuickBooks Template Information Card */}
          <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs space-y-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[var(--success)]" />
              <h4 className="text-[13px] font-bold text-[var(--text-primary)]">
                QuickBooks Desktop Integration
              </h4>
            </div>
            <ul className="text-[12px] text-[var(--text-secondary)] space-y-2 list-disc pl-4">
              <li>Automatic deduplication hash check prevents duplicate entries.</li>
              <li>Values format directly to standard QuickBooks IIF and JSON export specifications.</li>
              <li>Approved records will be batch-exported via the <strong>QB Preview</strong> tab.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
