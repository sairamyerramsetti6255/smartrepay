import { useEffect, useState, useMemo } from 'react'
import { RefreshCw, Plus, Edit2, Trash2, Eye, FileText } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { DataTable } from '@/components/DataTable'
import { QBRecordDrawer } from './QBRecordDrawer'
import { QBTransactionForm } from './QBTransactionForm'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'

export function QBPaymentsDisbursed() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedTxn, setSelectedTxn] = useState(null)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [formInitialData, setFormInitialData] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await quickbooks.paymentsDisbursed()
      setRows(res.rows || [])
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleDelete = async (e, id) => {
    e?.stopPropagation?.()
    if (!window.confirm('Are you sure you want to delete this payment disbursement record?')) return
    try {
      await quickbooks.deleteTransaction(id)
      toast.success('Disbursement deleted successfully')
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
      label: 'Payee / Vendor',
      render: (r) => (
        <span className="font-semibold text-[13px] text-[var(--text-primary)]">
          {r.customer_name || r.vendor_name || '—'}
        </span>
      ),
      sortable: true,
    },
    {
      key: 'reference_number',
      label: 'Reference / Check #',
      render: (r) => <span className="font-mono text-[12px] text-[var(--text-secondary)]">{r.reference_number || '—'}</span>,
      sortable: true,
    },
    {
      key: 'bank_account',
      label: 'Bank Account',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.bank_account || 'Operating Bank Account'}</span>,
    },
    {
      key: 'amount',
      label: 'Disbursed Amount',
      render: (r) => (
        <span className="font-mono font-bold text-[var(--text-primary)]">
          {r.amount != null ? `$${Number(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
        </span>
      ),
      align: 'right',
      sortable: true,
    },
    {
      key: 'validation_status',
      label: 'Status',
      render: (r) => (
        <span className={cn(
          'inline-flex h-[22px] items-center rounded-full px-2.5 text-[11px] font-medium capitalize',
          r.validation_status === 'valid' ? 'bg-[var(--success-bg)] text-[var(--success)]' : 'bg-[var(--warning-bg)] text-[var(--warning)]'
        )}>
          {r.validation_status?.replace(/_/g, ' ') || '—'}
        </span>
      ),
      sortable: true,
    },
    {
      key: 'approval_status',
      label: 'Approval',
      render: (r) => (
        <span className="text-[12px] capitalize text-[var(--text-tertiary)]">
          {r.approval_status?.replace(/_/g, ' ') || 'pending'}
        </span>
      ),
      sortable: true,
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
            title="Edit disbursement"
          >
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => handleDelete(e, r.id)}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors rounded hover:bg-[var(--danger-bg)]"
            title="Delete disbursement"
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
        defaultType="payment_disbursed"
        onClose={() => {
          setIsFormOpen(false)
          setFormInitialData(null)
        }}
        onSuccess={() => {
          setIsFormOpen(false)
          setFormInitialData(null)
          load()
        }}
        backLabel="Back to Payments"
      />
    )
  }

  if (selectedTxn) {
    return (
      <QBRecordDrawer
        transactionId={selectedTxn.id}
        onClose={() => setSelectedTxn(null)}
        onRefresh={load}
        backLabel="Back to Payments"
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Top Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div>
          <h3 className="text-[14px] font-bold text-[var(--text-primary)]">
            Payment Disbursements ({rows.length})
          </h3>
          <p className="text-[12px] text-[var(--text-secondary)]">
            QuickBooks Check / Bill Payment records
          </p>
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
            Add Disbursement
          </button>

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

      {/* DataTable */}
      <DataTable
        data={rows}
        columns={columns}
        pageSize={25}
        sortable
        onRowClick={(row) => setSelectedTxn(row)}
        emptyMessage="No payment disbursements yet"
        emptyDescription="Add a disbursement or import files to populate this ledger"
      />
    </div>
  )
}
