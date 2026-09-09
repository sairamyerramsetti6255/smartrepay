import { useState, useEffect } from 'react'
import { X, Save, RefreshCw, Landmark } from 'lucide-react'
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

export function QBAccountModal({
  isOpen,
  onClose,
  initialData = null,
  onSuccess,
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
  }, [initialData, isOpen])

  if (!isOpen) return null

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
      onClose()
    } catch (err) {
      toast.error(err.message || 'Failed to save account')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in">
      <div className="bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--border-light)] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[var(--radius-md)] bg-[var(--accent-subtle)] text-[var(--accent)]">
              <Landmark className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-[16px] font-bold text-[var(--text-primary)]">
                {isEdit ? 'Modify Account' : 'Add QuickBooks Account'}
              </h3>
              <p className="text-[12px] text-[var(--text-secondary)]">
                QuickBooks Chart of Accounts Proposal
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

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
              Account Name *
            </label>
            <input
              type="text"
              required
              value={formData.account_name}
              onChange={(e) => setFormData({ ...formData, account_name: e.target.value })}
              placeholder="e.g. Loan Disbursements - Commercial"
              className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-medium text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                Account Type *
              </label>
              <select
                value={formData.account_type}
                onChange={(e) => setFormData({ ...formData, account_type: e.target.value })}
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                {QB_ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                Account Number
              </label>
              <input
                type="text"
                value={formData.account_number}
                onChange={(e) => setFormData({ ...formData, account_number: e.target.value })}
                placeholder="e.g. 1205"
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-mono text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                Sub-Account Of
              </label>
              <input
                type="text"
                value={formData.sub_account_of}
                onChange={(e) => setFormData({ ...formData, sub_account_of: e.target.value })}
                placeholder="e.g. Loans Receivable"
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
                QuickBooks Status
              </label>
              <select
                value={formData.existence_status}
                onChange={(e) => setFormData({ ...formData, existence_status: e.target.value })}
                className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                {QB_STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-[var(--text-secondary)] mb-1">
              Description / Notes
            </label>
            <input
              type="text"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="e.g. General ledger account for short term borrower disbursements"
              className="w-full h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          {/* Footer */}
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
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Account'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
