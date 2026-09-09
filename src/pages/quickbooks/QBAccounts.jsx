import { useEffect, useState, useMemo } from 'react'
import { RefreshCw, Plus, Edit2, Trash2, Landmark } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { DataTable } from '@/components/DataTable'
import { QBAccountForm } from './QBAccountForm'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'

function StatusBadge({ status }) {
  const styles = {
    unknown: 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]',
    existing: 'bg-[var(--success-bg)] text-[var(--success)]',
    new_required: 'bg-[var(--warning-bg)] text-[var(--warning)]',
    created: 'bg-[var(--accent-subtle)] text-[var(--accent)]',
    inactive: 'bg-[var(--danger-bg)] text-[var(--danger)]',
  }
  return (
    <span className={cn('inline-flex h-[22px] items-center rounded-full px-2.5 text-[11px] font-medium capitalize', styles[status] || styles.unknown)}>
      {status?.replace(/_/g, ' ') || 'Unknown'}
    </span>
  )
}

export function QBAccounts() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [formInitialData, setFormInitialData] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await quickbooks.accounts()
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
    if (!window.confirm('Are you sure you want to delete this account?')) return
    try {
      await quickbooks.deleteAccount(id)
      toast.success('Account deleted successfully')
      load()
    } catch (err) {
      toast.error(err.message || 'Failed to delete account')
    }
  }

  const columns = useMemo(() => [
    {
      key: 'account_name',
      label: 'Account Name',
      render: (r) => <span className="font-semibold text-[13px] text-[var(--text-primary)]">{r.account_name || '—'}</span>,
      sortable: true,
    },
    {
      key: 'account_type',
      label: 'Account Type',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.account_type || '—'}</span>,
      sortable: true,
    },
    {
      key: 'account_number',
      label: 'Account Number',
      render: (r) => <span className="font-mono text-[12px] text-[var(--text-secondary)]">{r.account_number || '—'}</span>,
      sortable: true,
    },
    {
      key: 'sub_account_of',
      label: 'Sub-Account Of',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.sub_account_of || '—'}</span>,
    },
    {
      key: 'description',
      label: 'Description',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.description || '—'}</span>,
    },
    {
      key: 'existence_status',
      label: 'QuickBooks Status',
      render: (r) => <StatusBadge status={r.existence_status} />,
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
            title="Edit account"
          >
            <Edit2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => handleDelete(e, r.id)}
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors rounded hover:bg-[var(--danger-bg)]"
            title="Delete account"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ], [])

  if (isFormOpen) {
    return (
      <QBAccountForm
        initialData={formInitialData}
        onClose={() => {
          setIsFormOpen(false)
          setFormInitialData(null)
        }}
        onSuccess={() => {
          setIsFormOpen(false)
          setFormInitialData(null)
          load()
        }}
        backLabel="Back to Accounts"
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Top Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div>
          <h3 className="text-[14px] font-bold text-[var(--text-primary)]">
            QuickBooks Accounts ({rows.length})
          </h3>
          <p className="text-[12px] text-[var(--text-secondary)]">
            Chart of Accounts proposals and mappings for export
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
            Add Account
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
        emptyMessage="No account proposals"
        emptyDescription="Add an account or import loan disbursement documents to populate this ledger"
      />
    </div>
  )
}
