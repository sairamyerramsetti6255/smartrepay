import { useEffect, useState } from 'react'
import { AlertCircle, AlertTriangle, Copy, RefreshCw, Search, Eye, CheckCircle, FileText } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { DataTable } from '@/components/DataTable'
import { QBRecordDrawer } from './QBRecordDrawer'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'

function StatusBadge({ status }) {
  const styles = {
    invalid: 'bg-[var(--danger-bg)] text-[var(--danger)] border-[var(--danger)]/20',
    needs_review: 'bg-[var(--warning-bg)] text-[var(--warning)] border-[var(--warning)]/20',
    duplicate: 'bg-[var(--bg-subtle)] text-[var(--text-secondary)] border-[var(--border-light)]',
    valid: 'bg-[var(--success-bg)] text-[var(--success)] border-[var(--success)]/20',
  }
  return (
    <span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium border capitalize', styles[status] || 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]')}>
      {status?.replace(/_/g, ' ') || '—'}
    </span>
  )
}

export function QBExceptions() {
  const [exceptions, setExceptions] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedTxn, setSelectedTxn] = useState(null)
  const [revalidatingId, setRevalidatingId] = useState(null)

  const loadData = async () => {
    try {
      setLoading(true)
      const params = {}
      if (search) params.search = search
      const res = await quickbooks.exceptions(params)
      let list = res.rows || []
      if (statusFilter) {
        list = list.filter((r) => r.validation_status === statusFilter)
      }
      setExceptions(list)
      setTotal(list.length)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [search, statusFilter])

  const handleRevalidate = async (e, id) => {
    e.stopPropagation()
    try {
      setRevalidatingId(id)
      const res = await quickbooks.validate(id)
      toast.success(`Validated: status is now ${res.validation_status}`)
      loadData()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRevalidatingId(null)
    }
  }

  const invalidCount = exceptions.filter((e) => e.validation_status === 'invalid').length
  const reviewCount = exceptions.filter((e) => e.validation_status === 'needs_review').length
  const dupCount = exceptions.filter((e) => e.validation_status === 'duplicate').length

  const columns = [
    {
      key: 'validation_status',
      label: 'Severity / Status',
      render: (r) => <StatusBadge status={r.validation_status} />,
    },
    {
      key: 'template_type',
      label: 'Type',
      render: (r) => <span className="text-[12px] font-medium capitalize text-[var(--text-primary)]">{r.template_type?.replace(/_/g, ' ') || '—'}</span>,
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
    },
    {
      key: 'customer_name',
      label: 'Customer / Vendor',
      render: (r) => <span className="font-medium text-[var(--text-primary)]">{r.customer_name || '—'}</span>,
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
      key: 'actions',
      label: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={(e) => handleRevalidate(e, r.id)}
            disabled={revalidatingId === r.id}
            title="Re-run validation engine"
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', revalidatingId === r.id && 'animate-spin')} />
            Re-validate
          </button>
          <button
            onClick={() => setSelectedTxn(r)}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-md)] bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 text-[11px] font-medium transition-colors"
          >
            <Eye className="h-3 w-3" />
            Inspect
          </button>
        </div>
      ),
    },
  ]

  if (selectedTxn) {
    return (
      <QBRecordDrawer
        transactionId={selectedTxn.id}
        onClose={() => setSelectedTxn(null)}
        onRefresh={loadData}
        backLabel="Back to Exceptions"
      />
    )
  }

  return (
    <div>
      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--danger)]/30 bg-[var(--danger-bg)]/20 flex items-center gap-3">
          <div className="p-2.5 rounded-full bg-[var(--danger)]/10 text-[var(--danger)]">
            <AlertCircle className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase text-[var(--danger)] tracking-wide">Invalid Transactions</p>
            <p className="text-[22px] font-bold text-[var(--danger)] mt-0.5">{invalidCount}</p>
          </div>
        </div>

        <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--warning)]/30 bg-[var(--warning-bg)]/20 flex items-center gap-3">
          <div className="p-2.5 rounded-full bg-[var(--warning)]/10 text-[var(--warning)]">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase text-[var(--warning)] tracking-wide">Needs Review</p>
            <p className="text-[22px] font-bold text-[var(--warning)] mt-0.5">{reviewCount}</p>
          </div>
        </div>

        <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] flex items-center gap-3">
          <div className="p-2.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-tertiary)]">
            <Copy className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase text-[var(--text-tertiary)] tracking-wide">Duplicates Flagged</p>
            <p className="text-[22px] font-bold text-[var(--text-primary)] mt-0.5">{dupCount}</p>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search exceptions by name, reference..."
            className="w-full h-9 pl-9 pr-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
        </div>

        <div className="flex items-center gap-1.5">
          {[
            { label: 'All Exceptions', value: '' },
            { label: 'Invalid Only', value: 'invalid' },
            { label: 'Needs Review', value: 'needs_review' },
            { label: 'Duplicates', value: 'duplicate' },
          ].map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={cn(
                'h-8 px-3 rounded-full text-[12px] font-medium border transition-colors',
                statusFilter === f.value
                  ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                  : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <button
          onClick={loadData}
          disabled={loading}
          className="p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors ml-auto"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Exception Table */}
      <DataTable
        data={exceptions}
        columns={columns}
        pageSize={20}
        sortable
        onRowClick={(row) => setSelectedTxn(row)}
        emptyMessage="No exceptions found"
        emptyDescription="All imported QuickBooks transactions passed validation rules"
      />
    </div>
  )
}
