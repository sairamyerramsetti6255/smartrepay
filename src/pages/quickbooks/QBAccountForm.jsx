import { useState, useEffect } from 'react'
import { ArrowLeft, Save, RefreshCw, Landmark } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import toast from 'react-hot-toast'

const QB_ACCOUNT_TYPES = [
  'Bank',
  'Accounts Receivable',
  'Other Current Asset',
  'Loan Receivable',
  'Fixed Asset',
  'Other Asset',
  'Accounts Payable',
  'Credit Card',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
  'Income',
  'Cost of Goods Sold',
  'Expense',
  'Other Income',
  'Other Expense',
]

const QB_STATUS_OPTIONS = [
  { value: 'new_required', label: 'New Required' },
  { value: 'existing', label: 'Existing' },
  { value: 'created', label: 'Created' },
  { value: 'unknown', label: 'Unknown' },
  { value: 'inactive', label: 'Inactive' },
]

export function QBAccountForm({
  initialData = null,
  onClose,
  onSuccess,
  backLabel = 'Back to Accounts',
}) {
  const isEdit = Boolean(initialData?.id)

  const [formData, setFormData] = useState({
    account_name: '',
    account_type: 'Expense',
    account_number: '',
    sub_account_of: '',
    description: '',
    existence_status: 'new_required',
  })

  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (initialData) {
      setFormData({
        account_name: initialData.account_name || '',
        account_type: initialData.account_type || 'Expense',
        account_number: initialData.account_number || '',
        sub_account_of: initialData.sub_account_of || '',
        description: initialData.description || '',
        existence_status: initialData.existence_status || 'new_required',
      })
    } else {
      setFormData({
        account_name: '',
        account_type: 'Expense',
        account_number: '',
        sub_account_of: '',
        description: '',
        existence_status: 'new_required',
      })
    }
  }, [initialData])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!formData.account_name.trim()) {
      toast.error('Account Name is required')
      return
    }

    try {
      setSaving(true)
      const payload = {
        account_name: formData.account_name.trim(),
        account_type: formData.account_type,
        account_number: formData.account_number.trim() || null,
        sub_account_of: formData.sub_account_of.trim() || null,
        description: formData.description.trim() || null,
        existence_status: formData.existence_status,
      }

      let res
      if (isEdit) {
        res = await quickbooks.updateAccount(initialData.id, payload)
        toast.success('QuickBooks account updated')
      } else {
        res = await quickbooks.createAccount(payload)
        toast.success('QuickBooks account added')
      }

      onSuccess?.(res)
    } catch (err) {
      toast.error(err.message || 'Failed to save account')
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
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Account'}
          </button>
        </div>
      </div>

      {/* Top Executive Summary Card */}
      <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs">
        <div className="flex items-start gap-4">
          <div className="p-3.5 rounded-[var(--radius-md)] bg-[var(--accent-subtle)] text-[var(--accent)] shrink-0">
            <Landmark className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-[20px] font-bold text-[var(--text-primary)]">
              {isEdit ? 'Modify Account' : 'New QuickBooks Account'}
            </h1>
            <p className="text-[13px] text-[var(--text-secondary)] mt-0.5">
              Chart of Accounts Proposal & Mapping for QuickBooks Desktop Export
            </p>
          </div>
        </div>
      </div>

      {/* Responsive 2-Column Grid (Left Form Area + Right Summary Panel) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Form Area (2 Cols) */}
        <div className="lg:col-span-2">
          <form onSubmit={handleSubmit} className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs space-y-5">
            <h3 className="text-[15px] font-bold text-[var(--text-primary)] border-b border-[var(--border-light)] pb-3">
              Account Specifications
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                  Account Name *
                </label>
                <input
                  type="text"
                  required
                  value={formData.account_name}
                  onChange={(e) => setFormData({ ...formData, account_name: e.target.value })}
                  placeholder="e.g. Loan Disbursements - Commercial"
                  className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-medium text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                  Account Type *
                </label>
                <select
                  value={formData.account_type}
                  onChange={(e) => setFormData({ ...formData, account_type: e.target.value })}
                  className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                >
                  {QB_ACCOUNT_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                  Account Number
                </label>
                <input
                  type="text"
                  value={formData.account_number}
                  onChange={(e) => setFormData({ ...formData, account_number: e.target.value })}
                  placeholder="e.g. 1205"
                  className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-mono text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                  Sub-Account Of
                </label>
                <input
                  type="text"
                  value={formData.sub_account_of}
                  onChange={(e) => setFormData({ ...formData, sub_account_of: e.target.value })}
                  placeholder="e.g. Loans Receivable"
                  className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                  QuickBooks Existence Status
                </label>
                <select
                  value={formData.existence_status}
                  onChange={(e) => setFormData({ ...formData, existence_status: e.target.value })}
                  className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                >
                  {QB_STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1.5">
                  Description / Notes
                </label>
                <input
                  type="text"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="e.g. General ledger account for short term borrower disbursements"
                  className="w-full h-10 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
              </div>
            </div>

            {/* Bottom Actions */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border-light)]">
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
                {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Account'}
              </button>
            </div>
          </form>
        </div>

        {/* Right Sidebar / Summary Panel (1 Col) */}
        <div className="lg:col-span-1 space-y-6 lg:sticky lg:top-6">
          {/* Live Preview Card */}
          <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs space-y-4">
            <h4 className="text-[14px] font-bold text-[var(--text-primary)]">
              Account Overview
            </h4>

            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] space-y-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Account Title
                </p>
                <p className="text-[18px] font-bold text-[var(--text-primary)] leading-snug mt-0.5">
                  {formData.account_name || 'Account Name'}
                </p>
              </div>

              <div className="pt-3 border-t border-[var(--border-light)] space-y-2 text-[12px]">
                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Type:</span>
                  <span className="font-semibold text-[var(--text-primary)]">
                    {formData.account_type}
                  </span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Number:</span>
                  <span className="font-mono text-[var(--text-primary)]">
                    {formData.account_number || '—'}
                  </span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Sub-Account:</span>
                  <span className="text-[var(--text-primary)] font-medium">
                    {formData.sub_account_of || 'None (Top-level)'}
                  </span>
                </div>

                <div className="flex justify-between items-center">
                  <span className="text-[var(--text-tertiary)]">Status:</span>
                  <span className="capitalize font-medium text-[var(--accent)]">
                    {formData.existence_status?.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
