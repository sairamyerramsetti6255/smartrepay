import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Ban,
  FileText,
  RefreshCw,
  Calendar,
  User,
  CreditCard,
  Landmark,
  Hash,
  Edit2,
  Trash2,
} from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { canApproveQB } from '@/lib/roles'
import { QBTransactionForm } from './QBTransactionForm'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'

function StatusBadge({ status }) {
  const styles = {
    valid: 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/20',
    invalid: 'bg-[var(--danger-bg)] text-[var(--danger)] border-[var(--danger)]/20',
    needs_review: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/20',
    duplicate: 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] border-[var(--border-light)]',
    pending: 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)] border-[var(--border-light)]',
  }
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-[12px] font-semibold border capitalize', styles[status] || styles.pending)}>
      {status?.replace(/_/g, ' ') || 'pending'}
    </span>
  )
}

function ApprovalBadge({ status }) {
  const styles = {
    approved: 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/20',
    rejected: 'bg-[var(--danger-bg)] text-[var(--danger)] border-[var(--danger)]/20',
    exported: 'bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent)]/20',
    pending_review: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/20',
  }
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-[12px] font-semibold border capitalize', styles[status] || 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]')}>
      {status?.replace(/_/g, ' ') || 'Pending Review'}
    </span>
  )
}

export function QBRecordDrawer({ transactionId, onClose, onRefresh, backLabel = 'Back to List' }) {
  const { profile } = useAuth()
  const canApprove = canApproveQB(profile?.role)
  const [txn, setTxn] = useState(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [showRejectModal, setShowRejectModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)

  const loadData = async () => {
    if (!transactionId) return
    try {
      setLoading(true)
      const data = await quickbooks.transaction(transactionId)
      setTxn(data)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [transactionId])

  const handleApprove = async () => {
    try {
      setActionLoading(true)
      await quickbooks.approve(transactionId)
      toast.success('Transaction approved for QuickBooks export')
      await loadData()
      onRefresh?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleReject = async () => {
    try {
      setActionLoading(true)
      await quickbooks.reject(transactionId, rejectReason)
      toast.success('Transaction rejected')
      setShowRejectModal(false)
      setRejectReason('')
      await loadData()
      onRefresh?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setActionLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this transaction record?')) return
    try {
      setActionLoading(true)
      await quickbooks.deleteTransaction(transactionId)
      toast.success('Transaction record deleted')
      onRefresh?.()
      onClose()
    } catch (e) {
      toast.error(e.message || 'Failed to delete transaction')
      setActionLoading(false)
    }
  }

  if (!transactionId) return null

  if (loading) {
    return (
      <div className="py-24 flex flex-col items-center justify-center gap-3">
        <RefreshCw className="h-6 w-6 animate-spin text-[var(--accent)]" />
        <p className="text-[14px] text-[var(--text-tertiary)]">Loading transaction details...</p>
      </div>
    )
  }

  if (!txn) {
    return (
      <div className="p-8 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] text-center">
        <p className="text-[14px] text-[var(--text-secondary)] mb-4">Transaction record not found.</p>
        <button
          onClick={onClose}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-medium"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </button>
      </div>
    )
  }

  if (showEditModal && txn) {
    return (
      <QBTransactionForm
        initialData={txn}
        defaultType={txn.template_type || 'emi_receipt'}
        onClose={() => setShowEditModal(false)}
        onSuccess={() => {
          setShowEditModal(false)
          loadData()
          onRefresh?.()
        }}
        backLabel={`Back to ${txn.template_type === 'payment_disbursed' ? 'Payment' : 'Receipt'} Details`}
      />
    )
  }

  return (
    <div className="w-full space-y-6 animate-in fade-in duration-200">
      {/* Top Navigation & Action Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <button
          onClick={onClose}
          className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shadow-xs"
        >
          <ArrowLeft className="h-4 w-4 text-[var(--accent)]" />
          {backLabel}
        </button>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowEditModal(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shadow-xs"
          >
            <Edit2 className="h-3.5 w-3.5 text-[var(--accent)]" />
            Edit Record
          </button>

          <button
            onClick={handleDelete}
            disabled={actionLoading}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-md)] border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger-bg)] text-[13px] font-medium transition-colors disabled:opacity-50 shadow-xs"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>

          {canApprove && txn.approval_status !== 'rejected' && (
            <button
              onClick={() => setShowRejectModal(true)}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-md)] border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger-bg)] text-[13px] font-medium transition-colors disabled:opacity-50"
            >
              <Ban className="h-3.5 w-3.5" />
              Reject
            </button>
          )}

          {canApprove && txn.approval_status !== 'approved' && (
            <button
              onClick={handleApprove}
              disabled={actionLoading || txn.validation_status === 'invalid'}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-[var(--radius-md)] bg-[var(--success)] text-white hover:opacity-90 text-[13px] font-semibold transition-colors disabled:opacity-50 shadow-xs"
            >
              <Check className="h-4 w-4" strokeWidth={2.5} />
              Approve for QuickBooks
            </button>
          )}
        </div>
      </div>

      {/* Top Executive Card with Prominent EMI Amount */}
      <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="p-3.5 rounded-[var(--radius-md)] bg-[var(--accent-subtle)] text-[var(--accent)] shrink-0">
              <FileText className="h-7 w-7" />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-[20px] font-bold text-[var(--text-primary)] capitalize">
                  {txn.template_type?.replace(/_/g, ' ') || 'EMI Receipt'}
                </h1>
                <StatusBadge status={txn.validation_status} />
                <ApprovalBadge status={txn.approval_status} />
              </div>
              <p className="text-[12px] font-mono text-[var(--text-tertiary)] mt-1">
                ID: {txn.id}
              </p>
            </div>
          </div>

          <div className="sm:text-right p-3 sm:p-0 rounded-[var(--radius-md)] sm:rounded-none bg-[var(--bg-subtle)] sm:bg-transparent">
            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-tertiary)]">
              {txn.template_type === 'payment_disbursed' ? 'Payment Amount' : 'EMI Amount'}
            </p>
            <p className="text-[30px] font-extrabold text-[var(--accent)] leading-tight mt-0.5">
              ${Number(txn.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      </div>

      {/* Responsive 2-Column Grid (Left Details + Right Action Summary Panel) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left Details (2 Cols) */}
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-6 shadow-xs">
            <h3 className="text-[14px] font-semibold text-[var(--text-primary)] border-b border-[var(--border-light)] pb-3 mb-5">
              Transaction Details
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Customer / Payee
                </p>
                <p className="text-[15px] font-semibold text-[var(--text-primary)] mt-1">
                  {txn.customer_name || '—'}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Transaction Date
                </p>
                <p className="text-[15px] font-medium text-[var(--text-primary)] mt-1">
                  {txn.transaction_date || '—'}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Reference Number
                </p>
                <p className="text-[14px] font-mono font-medium text-[var(--text-secondary)] mt-1">
                  {txn.reference_number || '—'}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  LoanDisk Borrower ID
                </p>
                <p className="text-[15px] font-mono font-bold text-[var(--accent)] mt-1">
                  {txn.borrower_id || '—'}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Loan Number
                </p>
                <p className="text-[14px] font-mono font-semibold text-[var(--text-primary)] mt-1">
                  {txn.loan_id ? `Loan #${txn.loan_id}` : '—'}
                </p>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Payment Method
                </p>
                <p className="text-[14px] font-medium text-[var(--text-primary)] mt-1">
                  {txn.payment_method || 'ACH'}
                </p>
              </div>

              <div className="sm:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Deposit Account
                </p>
                <p className="text-[14px] text-[var(--text-primary)] mt-1">
                  {txn.deposit_to || txn.bank_account || 'General Bank Account'}
                </p>
              </div>

              <div className="sm:col-span-2 pt-3 border-t border-[var(--border-light)]">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Source File
                </p>
                <div className="flex items-center gap-2 mt-1.5">
                  <FileText className="h-4 w-4 text-[var(--accent)] shrink-0" />
                  <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                    {txn.input?.original_filename || txn.original_filename || txn.source_type?.replace(/_/g, ' ') || 'SmartRepay Match'}
                  </span>
                </div>
              </div>
            </div>

            {txn.rejection_reason && (
              <div className="mt-6 p-4 rounded-[var(--radius-md)] bg-[var(--danger-bg)]/30 border border-[var(--danger)]/30 text-[13px] text-[var(--danger)]">
                <p className="font-semibold text-[11px] uppercase tracking-wider">Rejection Reason</p>
                <p className="mt-1">{txn.rejection_reason}</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Sidebar (1 Col) */}
        <div className="lg:col-span-1 space-y-6 lg:sticky lg:top-6">
          <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-xs space-y-4">
            <h4 className="text-[14px] font-bold text-[var(--text-primary)]">
              Quick Actions
            </h4>

            <div className="space-y-2.5">
              {canApprove && txn.approval_status !== 'approved' && (
                <button
                  onClick={handleApprove}
                  disabled={actionLoading || txn.validation_status === 'invalid'}
                  className="w-full inline-flex items-center justify-center gap-2 h-10 px-4 rounded-[var(--radius-md)] bg-[var(--success)] text-white hover:opacity-90 text-[13px] font-semibold transition-colors disabled:opacity-50 shadow-xs"
                >
                  <Check className="h-4 w-4" strokeWidth={2.5} />
                  Approve for Export
                </button>
              )}

              <button
                onClick={() => setShowEditModal(true)}
                className="w-full inline-flex items-center justify-center gap-2 h-10 px-4 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors shadow-xs"
              >
                <Edit2 className="h-3.5 w-3.5 text-[var(--accent)]" />
                Modify Record
              </button>

              <button
                onClick={handleDelete}
                disabled={actionLoading}
                className="w-full inline-flex items-center justify-center gap-2 h-10 px-4 rounded-[var(--radius-md)] border border-[var(--danger)]/30 text-[var(--danger)] hover:bg-[var(--danger-bg)] text-[13px] font-medium transition-colors disabled:opacity-50 shadow-xs"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Record
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Rejection Modal Dialog */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in">
          <div className="bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95">
            <h4 className="text-[16px] font-semibold text-[var(--text-primary)] mb-1">Reject Transaction</h4>
            <p className="text-[13px] text-[var(--text-secondary)] mb-4">
              Specify the reason for rejecting this record from the QuickBooks Desktop export batch.
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="E.g., Borrower loan account requires manual adjustment..."
              rows={3}
              className="w-full p-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] mb-4 resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowRejectModal(false)}
                className="px-4 py-2 rounded-[var(--radius-md)] text-[13px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={actionLoading}
                className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--danger)] text-white text-[13px] font-medium hover:opacity-90 disabled:opacity-50"
              >
                Confirm Rejection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}



