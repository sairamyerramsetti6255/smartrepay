import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/Badge'
import { PageLoader } from '@/components/PageLoader'
import { ReceiptFormDialog, SOURCE_OPTIONS } from '@/components/ReceiptFormDialog'
import { formatCurrency, formatDate } from '@/lib/utils'

const SOURCE_LABELS = Object.fromEntries(SOURCE_OPTIONS.map((o) => [o.value, o.label]))

export function ReceiptsUpload() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState('create')
  const [editingReceipt, setEditingReceipt] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  const loadRows = useCallback(async () => {
    setLoading(true)
    try {
      const { rows: data } = await api.receipts.list()
      setRows(Array.isArray(data) ? data : [])
    } catch (e) {
      toast.error(e.message)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  function openCreate() {
    setDialogMode('create')
    setEditingReceipt(null)
    setDialogOpen(true)
  }

  function openEdit(row) {
    setDialogMode('edit')
    setEditingReceipt(row)
    setDialogOpen(true)
  }

  async function handleDelete(row) {
    if (!row?.id) return
    if (!window.confirm(`Delete receipt #${row.id} for ${row.borrowerName || row.borrowerId}?`)) return
    setDeletingId(row.id)
    try {
      await api.receipts.remove(row.id)
      toast.success('Receipt deleted')
      await loadRows()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setDeletingId(null)
    }
  }

  const columns = useMemo(
    () => [
      {
        key: 'collectedDate',
        label: 'Date',
        sortAccessor: (r) => r.collectedDate || '',
        filterAccessor: (r) => formatDate(r.collectedDate),
        render: (r) => <span className="text-[var(--text-secondary)]">{formatDate(r.collectedDate)}</span>,
      },
      {
        key: 'borrowerName',
        label: 'Borrower',
        sortAccessor: (r) => r.borrowerName || '',
        render: (r) => <span className="font-medium">{r.borrowerName || '—'}</span>,
      },
      {
        key: 'borrowerId',
        label: 'Borrower ID',
        sortAccessor: (r) => r.borrowerId || '',
        render: (r) => <span className="mono text-[12px]">{r.borrowerId || '—'}</span>,
      },
      {
        key: 'loanNumber',
        label: 'Loan',
        sortAccessor: (r) => r.loanNumber || '',
        render: (r) => <span className="mono text-[12px]">{r.loanNumber || '—'}</span>,
      },
      {
        key: 'amountReceived',
        label: 'Amount',
        align: 'right',
        sortAccessor: (r) => Number(r.amountReceived) || 0,
        filterAccessor: (r) => String(r.amountReceived ?? ''),
        render: (r) => formatCurrency(r.amountReceived),
      },
      {
        key: 'sourceChannel',
        label: 'Source',
        sortAccessor: (r) => SOURCE_LABELS[r.sourceChannel] || r.sourceChannel || '',
        filterAccessor: (r) => SOURCE_LABELS[r.sourceChannel] || r.sourceChannel || '',
        render: (r) => <Badge variant="posted">{SOURCE_LABELS[r.sourceChannel] || r.sourceChannel || '—'}</Badge>,
      },
      {
        key: 'particulars',
        label: 'Particulars',
        sortAccessor: (r) => r.particulars || '',
        render: (r) => (
          <span className="truncate max-w-[180px] inline-block text-[var(--text-secondary)]" title={r.particulars}>
            {r.particulars || '—'}
          </span>
        ),
      },
      {
        key: 'receiptFileName',
        label: 'Attachment',
        sortAccessor: (r) => r.receiptFileName || '',
        render: (r) =>
          r.receiptDocumentId ? (
            <button
              type="button"
              className="text-[12px] text-[var(--accent)] hover:underline truncate max-w-[120px]"
              onClick={(e) => {
                e.stopPropagation()
                api.documents.download(r.receiptDocumentId, r.receiptFileName).catch((err) => toast.error(err.message))
              }}
            >
              {r.receiptFileName || 'Download'}
            </button>
          ) : (
            '—'
          ),
      },
      {
        key: 'enteredBy',
        label: 'Entered by',
        sortAccessor: (r) => r.enteredBy || '',
        render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.enteredBy || '—'}</span>,
      },
      {
        key: 'createdAt',
        label: 'Created',
        sortAccessor: (r) => r.createdAt || '',
        filterAccessor: (r) => (r.createdAt ? formatDate(r.createdAt) : ''),
        render: (r) => <span className="text-[12px] text-[var(--text-tertiary)]">{r.createdAt ? formatDate(r.createdAt) : '—'}</span>,
      },
      {
        key: 'actions',
        label: 'Actions',
        sortable: false,
        filterable: false,
        render: (r) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              title="Edit"
              onClick={(e) => {
                e.stopPropagation()
                openEdit(r)
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-[var(--danger)] hover:text-[var(--danger)]"
              title="Delete"
              disabled={deletingId === r.id}
              onClick={(e) => {
                e.stopPropagation()
                handleDelete(r)
              }}
            >
              {deletingId === r.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        ),
      },
    ],
    [deletingId]
  )

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Manual Receipts"
        subtitle="Manage walk-in, WhatsApp, email, and phone repayments — filter, sort, add, edit, or delete."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={loadRows} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> Add receipt
            </Button>
          </div>
        }
      />

      {loading ? (
        <PageLoader label="Loading receipts…" />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          pageSize={15}
          sortable
          filterable
          emptyMessage="No manual receipts yet"
          emptyDescription="Click Add receipt to record a payment."
          emptyAction={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" /> Add receipt
            </Button>
          }
        />
      )}

      <ReceiptFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        mode={dialogMode}
        receipt={editingReceipt}
        onSaved={loadRows}
      />
    </div>
  )
}
