import { useEffect, useState, useMemo } from 'react'
import { Search, RefreshCw, FileText, Plus, Edit2, Trash2, Eye } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { DataTable } from '@/components/DataTable'
import { QBRecordDrawer } from './QBRecordDrawer'
import { QBTransactionForm } from './QBTransactionForm'
import toast from 'react-hot-toast'
import { cn } from '@/lib/utils'

const STATUS_FILTERS = [
  { label: 'All', value: '' },
  { label: 'Valid', value: 'valid' },
  { label: 'Needs Review', value: 'needs_review' },
  { label: 'Invalid', value: 'invalid' },
  { label: 'Duplicate', value: 'duplicate' },
]

const TEMPLATE_FILTERS = [
  { label: 'All Types', value: '' },
  { label: 'EMI Receipt', value: 'emi_receipt' },
  { label: 'Payment Disbursed', value: 'payment_disbursed' },
  { label: 'Account to Create', value: 'account_to_create' },
]

function StatusBadge({ status }) {
  const styles = {
    valid: 'bg-[var(--success-bg)] text-[var(--success)]',
    invalid: 'bg-[var(--danger-bg)] text-[var(--danger)]',
    needs_review: 'bg-[var(--warning-bg)] text-[var(--warning)]',
    duplicate: 'bg-[var(--bg-subtle)] text-[var(--text-secondary)]',
    pending: 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]',
  }
  return (
    <span className={cn('inline-flex h-[22px] items-center rounded-full px-2.5 text-[11px] font-medium capitalize', styles[status] || styles.pending)}>
      {status?.replace(/_/g, ' ') || '—'}
    </span>
  )
}

export function QBLibrary() {
  const [transactions, setTransactions] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [validationStatus, setValidationStatus] = useState('')
  const [templateType, setTemplateType] = useState('')
  const [selectedTxn, setSelectedTxn] = useState(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [formInitialData, setFormInitialData] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const params = { pageSize: 1000 }
      if (search) params.search = search
      if (validationStatus) params.validationStatus = validationStatus
      if (templateType) params.templateType = templateType
      const res = await quickbooks.transactions(params)
      setTransactions(res.rows || [])
      setTotal(res.total || 0)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [search, validationStatus, templateType])

  const handleDelete = async (e, id) => {
    e?.stopPropagation?.()
    if (!window.confirm('Are you sure you want to delete this transaction record?')) return
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
      key: 'template_type',
      label: 'Type',
      render: (r) => (
        <span className="text-[12px] font-medium capitalize text-[var(--text-primary)]">
          {r.template_type?.replace(/_/g, ' ') || '—'}
        </span>
      ),
    },
    {
      key: 'source_type',
      label: 'Source / File Name',
      render: (r) => (
        <div className="flex items-center gap-1.5 max-w-[220px] truncate" title={r.original_filename || r.source_type}>
          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">
            {r.original_filename || r.source_type?.replace(/_/g, ' ') || 'SmartRepay'}
          </span>
        </div>
      ),
    },
    {
      key: 'customer_name',
      label: 'Customer / Vendor',
      render: (r) => <span className="font-semibold text-[13px] text-[var(--text-primary)]">{r.customer_name || '—'}</span>,
    },
    {
      key: 'borrower_id',
      label: 'LoanDisk ID',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-mono text-[12px] font-semibold text-[var(--accent)]">{r.borrower_id || '—'}</span>
          {r.loan_id && <span className="text-[11px] text-[var(--text-tertiary)] mono">Loan #{r.loan_id}</span>}
        </div>
      ),
    },
    {
      key: 'transaction_date',
      label: 'Date',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.transaction_date || '—'}</span>,
    },
    {
      key: 'reference_number',
      label: 'Reference',
      render: (r) => <span className="font-mono text-[12px] text-[var(--text-secondary)]">{r.reference_number || '—'}</span>,
    },
    {
      key: 'amount',
      label: 'Amount',
      render: (r) => (
        <span className="font-mono font-medium text-[var(--text-primary)]">
          {r.amount != null ? `$${Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
        </span>
      ),
      align: 'right',
    },
    {
      key: 'validation_status',
      label: 'Validation',
      render: (r) => <StatusBadge status={r.validation_status} />,
    },
    {
      key: 'approval_status',
      label: 'Approval',
      render: (r) => (
        <span className="text-[12px] capitalize text-[var(--text-tertiary)]">
          {r.approval_status?.replace(/_/g, ' ') || 'pending'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => {
              setFormInitialData(r)
              setIsFormOpen(true)
            }}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors rounded hover:bg-[var(--bg-hover)]"
            title="Edit record"
          >
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => handleDelete(e, r.id)}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors rounded hover:bg-[var(--danger-bg)]"
            title="Delete record"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setSelectedTxn(r)}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--accent)] transition-colors rounded hover:bg-[var(--bg-hover)]"
            title="Inspect full details"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ], [])

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
        backLabel="Back to Transaction Library"
      />
    )
  }

  if (selectedTxn) {
    return (
      <QBRecordDrawer
        transactionId={selectedTxn.id}
        onClose={() => setSelectedTxn(null)}
        onRefresh={load}
        backLabel="Back to Transaction Library"
      />
    )
  }

  return (
    <div>
      {/* Top action bar & filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer, LoanDisk ID, reference…"
            className="w-full h-9 pl-9 pr-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
        </div>

        {/* Status filter pills */}
        <div className="flex gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setValidationStatus(f.value)}
              className={cn(
                'h-8 px-3 rounded-full text-[12px] font-medium border transition-colors',
                validationStatus === f.value
                  ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                  : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <select
          value={templateType}
          onChange={(e) => setTemplateType(e.target.value)}
          className="h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        >
          {TEMPLATE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>{f.label}</option>
          ))}
        </select>

        <button
          onClick={() => {
            setFormInitialData(null)
            setIsFormOpen(true)
          }}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[12px] font-semibold hover:opacity-90 transition-colors shadow-xs"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
          Add Record
        </button>

        <button onClick={load} disabled={loading} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] p-2">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>

        <span className="text-[12px] text-[var(--text-tertiary)] ml-auto">{total.toLocaleString()} records</span>
      </div>

      {/* Table */}
      <DataTable
        data={transactions}
        columns={columns}
        pageSize={25}
        sortable
        filterable
        onRowClick={(row) => setSelectedTxn(row)}
        emptyMessage="No transactions found"
        emptyDescription="Import data from SmartRepay or add records manually to get started"
      />
    </div>
  )
}
