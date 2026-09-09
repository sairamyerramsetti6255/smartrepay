import { useEffect, useState, useMemo } from 'react'
import { CheckCircle2, RefreshCw, FileText, Search, Check, Ban, Eye, Layers, Plus, Edit2, Trash2 } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { canApproveQB } from '@/lib/roles'
import { DataTable } from '@/components/DataTable'
import { QBRecordDrawer } from './QBRecordDrawer'
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
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium border capitalize', styles[status] || styles.pending)}>
      {status?.replace(/_/g, ' ') || 'pending'}
    </span>
  )
}

function ApprovalBadge({ status }) {
  const styles = {
    approved: 'bg-[var(--success-bg)] text-[var(--success)]',
    rejected: 'bg-[var(--danger-bg)] text-[var(--danger)]',
    exported: 'bg-[var(--accent-subtle)] text-[var(--accent)]',
    pending_review: 'bg-[var(--bg-subtle)] text-[var(--text-secondary)]',
  }
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium capitalize', styles[status] || styles.pending_review)}>
      {status?.replace(/_/g, ' ') || 'Pending'}
    </span>
  )
}

export function QBEmiReceipts({ onNavigate }) {
  const { profile } = useAuth()
  const canApproveRole = canApproveQB(profile?.role)
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [approvalFilter, setApprovalFilter] = useState('')
  const [search, setSearch] = useState('')
  const [approvingAll, setApprovingAll] = useState(false)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [formInitialData, setFormInitialData] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const params = { pageSize: 1000 } // Load full records for responsive client DataTable filtering
      if (approvalFilter) params.approvalStatus = approvalFilter
      if (search) params.search = search
      const res = await quickbooks.emiReceipts(params)
      setRows(res.rows || [])
      setTotal(res.total || 0)
      if (res.summary) setSummary(res.summary)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [approvalFilter, search])

  const handleApprove = async (e, id) => {
    e?.stopPropagation?.()
    try {
      await quickbooks.approve(id)
      toast.success('Transaction approved for QuickBooks export')
      load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  const handleReject = async (e, id) => {
    e?.stopPropagation?.()
    const reason = window.prompt('Rejection reason (optional):')
    if (reason === null) return
    try {
      await quickbooks.reject(id, reason)
      toast.success('Transaction rejected')
      load()
    } catch (e) {
      toast.error(e.message)
    }
  }

  const handleApproveAll = async () => {
    if (!window.confirm('Are you sure you want to approve all valid pending EMI receipts for QuickBooks export?')) return
    try {
      setApprovingAll(true)
      const res = await quickbooks.approveAll('emi_receipt')
      toast.success(`Approved ${res.approved_count} valid EMI receipts`)
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setApprovingAll(false)
    }
  }

  const validCount = summary?.valid ?? rows.filter((r) => r.validation_status === 'valid').length
  const pendingCount = summary?.pending_review ?? rows.filter((r) => r.approval_status === 'pending_review').length
  const approvedCount = summary?.approved ?? rows.filter((r) => r.approval_status === 'approved').length
  const totalCount = summary?.total ?? total

  const handleDelete = async (e, id) => {
    e?.stopPropagation?.()
    if (!window.confirm('Are you sure you want to delete this EMI receipt record?')) return
    try {
      await quickbooks.deleteTransaction(id)
      toast.success('Record deleted successfully')
      load()
    } catch (err) {
      toast.error(err.message || 'Failed to delete record')
    }
  }

  const columns = useMemo(() => [
    {
      key: 'transaction_date',
      label: 'Date',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.transaction_date || '—'}</span>,
      sortable: true,
    },
    {
      key: 'customer_name',
      label: 'Customer',
      render: (r) => (
        <div className="min-w-0 max-w-[200px]">
          <p className="font-semibold text-[13px] text-[var(--text-primary)] truncate" title={r.customer_name}>
            {r.customer_name || '—'}
          </p>
        </div>
      ),
      sortable: true,
    },
    {
      key: 'borrower_id',
      label: 'LoanDisk ID',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-mono text-[12px] font-semibold text-[var(--accent)]">
            {r.borrower_id || '—'}
          </span>
          {r.loan_id && (
            <span className="text-[11px] text-[var(--text-tertiary)] mono">
              Loan #{r.loan_id}
            </span>
          )}
        </div>
      ),
      sortable: true,
    },
    {
      key: 'source_type',
      label: 'Source / File',
      render: (r) => (
        <div className="flex items-center gap-1.5 max-w-[180px] truncate" title={r.original_filename || r.source_type}>
          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          <span className="text-[12px] text-[var(--text-secondary)] truncate">
            {r.original_filename || r.source_type?.replace(/_/g, ' ') || 'SmartRepay'}
          </span>
        </div>
      ),
      sortable: true,
    },
    {
      key: 'reference_number',
      label: 'Reference',
      render: (r) => <span className="font-mono text-[12px] text-[var(--text-secondary)]">{r.reference_number || '—'}</span>,
      sortable: true,
    },
    {
      key: 'payment_method',
      label: 'Method',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.payment_method || 'ACH'}</span>,
    },
    {
      key: 'deposit_to',
      label: 'Deposit To',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)] truncate max-w-[140px]" title={r.deposit_to}>{r.deposit_to || 'General Bank Account'}</span>,
    },
    {
      key: 'amount',
      label: 'Total Amount',
      render: (r) => (
        <span className="font-mono font-semibold text-[var(--text-primary)]">
          {r.amount != null ? `$${Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
        </span>
      ),
      align: 'right',
      sortable: true,
    },
    {
      key: 'validation_status',
      label: 'Validation',
      render: (r) => <StatusBadge status={r.validation_status} />,
      sortable: true,
    },
    {
      key: 'approval_status',
      label: 'Approval',
      render: (r) => <ApprovalBadge status={r.approval_status} />,
      sortable: true,
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {canApproveRole && r.validation_status === 'valid' && r.approval_status === 'pending_review' && (
            <button
              onClick={(e) => handleApprove(e, r.id)}
              title="Approve for QuickBooks"
              className="h-7 px-2.5 text-[11px] font-medium rounded border border-[var(--success)] text-[var(--success)] hover:bg-[var(--success-bg)] transition-colors"
            >
              Approve
            </button>
          )}
          {canApproveRole && r.approval_status === 'pending_review' && (
            <button
              onClick={(e) => handleReject(e, r.id)}
              title="Reject transaction"
              className="h-7 px-2.5 text-[11px] font-medium rounded border border-[var(--border-light)] text-[var(--text-secondary)] hover:border-[var(--danger)] hover:text-[var(--danger)] transition-colors"
            >
              Reject
            </button>
          )}
          <button
            onClick={() => {
              setFormInitialData(r)
              setIsFormOpen(true)
            }}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors rounded hover:bg-[var(--bg-hover)]"
            title="Edit transaction"
          >
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => handleDelete(e, r.id)}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors rounded hover:bg-[var(--danger-bg)]"
            title="Delete transaction"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setSelected(r)}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors rounded hover:bg-[var(--bg-hover)]"
            title="Inspect full details"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ], [canApproveRole])

  if (isFormOpen) {
    return (
      <QBTransactionForm
        initialData={formInitialData}
        defaultType="emi_receipt"
        onClose={() => {
          setIsFormOpen(false)
          setFormInitialData(null)
        }}
        onSuccess={() => {
          setIsFormOpen(false)
          setFormInitialData(null)
          load()
        }}
        backLabel="Back to EMI Receipts"
      />
    )
  }

  if (selected) {
    return (
      <QBRecordDrawer
        transactionId={selected.id}
        onClose={() => setSelected(null)}
        onRefresh={load}
        backLabel="Back to EMI Receipts"
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Top Summary & Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-[var(--accent)]" />
            <span className="text-[14px] font-semibold text-[var(--text-primary)]">
              {totalCount.toLocaleString()} EMI Receipts
            </span>
          </div>
          <span className="text-[12px] px-2.5 py-0.5 rounded-full bg-[var(--success-bg)] text-[var(--success)] font-medium">
            {validCount.toLocaleString()} Valid
          </span>
          <span className="text-[12px] px-2.5 py-0.5 rounded-full bg-[var(--warning-bg)] text-[var(--warning)] font-medium">
            {pendingCount.toLocaleString()} Pending Review
          </span>
          {approvedCount > 0 && (
            <span className="text-[12px] px-2.5 py-0.5 rounded-full bg-[var(--accent-subtle)] text-[var(--accent)] font-medium">
              {approvedCount.toLocaleString()} Approved
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              setFormInitialData(null)
              setIsFormOpen(true)
            }}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[12px] font-semibold hover:opacity-90 transition-colors shadow-xs"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            Add Receipt
          </button>

          {canApproveRole && pendingCount > 0 && (
            <button
              onClick={handleApproveAll}
              disabled={approvingAll || loading}
              className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-[var(--radius-md)] bg-[var(--success)] text-white text-[12px] font-medium hover:opacity-90 disabled:opacity-50 transition-colors shadow-xs"
            >
              {approvingAll ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              {approvingAll ? 'Approving…' : `Approve All Valid (${validCount})`}
            </button>
          )}

          <div className="flex gap-1">
            {[
              { label: 'All', value: '' },
              { label: 'Pending Review', value: 'pending_review' },
              { label: 'Approved', value: 'approved' },
              { label: 'Rejected', value: 'rejected' },
              { label: 'Exported', value: 'exported' },
            ].map((f) => (
              <button
                key={f.value}
                onClick={() => setApprovalFilter(f.value)}
                className={cn(
                  'h-8 px-3 rounded-full text-[12px] font-medium border transition-colors',
                  approvalFilter === f.value
                    ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                    : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          <button
            onClick={load}
            disabled={loading}
            className="p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            title="Refresh list"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Filter / Search Row */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer, LoanDisk ID, loan #, file, reference…"
            className="w-full h-9 pl-9 pr-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
        </div>
      </div>

      {/* DataTable */}
      <DataTable
        data={rows}
        columns={columns}
        pageSize={25}
        sortable
        filterable
        onRowClick={(row) => setSelected(row)}
        emptyMessage="No EMI receipts found"
        emptyDescription="Import transactions from SmartRepay or upload receipts to populate this ledger"
      />
    </div>
  )
}


