import { useEffect, useState } from 'react'
import { Download, RefreshCw, FileText, X, Copy, Check, Calendar, User, Database } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { DataTable } from '@/components/DataTable'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'

export function QBExportHistory() {
  const [exportsList, setExportsList] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedExport, setSelectedExport] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const loadExports = async () => {
    try {
      setLoading(true)
      const res = await quickbooks.exports()
      setExportsList(res.rows || res || [])
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadExports()
  }, [])

  const handleView = async (row) => {
    try {
      setDetailLoading(true)
      setSelectedExport(row)
      const full = await quickbooks.exportById(row.id)
      setSelectedExport(full)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleDownload = (e, row) => {
    e.stopPropagation()
    const content = typeof row.payload_json === 'string'
      ? row.payload_json
      : JSON.stringify(row.payload_json || {}, null, 2)

    const format = row.export_format || 'json'
    const mimeMap = {
      json: 'application/json',
      csv: 'text/csv',
      iif: 'text/plain',
    }
    const extMap = {
      json: 'json',
      csv: 'csv',
      iif: 'iif',
    }

    const blob = new Blob([content], { type: mimeMap[format] || 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `qb_export_${row.created_at?.slice(0, 10) || 'batch'}_${row.id.slice(0, 8)}.${extMap[format] || 'txt'}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success('Download started')
  }

  const handleCopy = () => {
    if (!selectedExport?.payload_json) return
    const text = typeof selectedExport.payload_json === 'string'
      ? selectedExport.payload_json
      : JSON.stringify(selectedExport.payload_json, null, 2)
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success('Copied to clipboard')
  }

  const columns = [
    {
      key: 'id',
      label: 'Batch ID',
      render: (r) => <span className="font-mono text-[12px] font-medium text-[var(--accent)]">{r.id?.slice(0, 8)}…</span>,
    },
    {
      key: 'created_at',
      label: 'Exported Date',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.created_at ? new Date(r.created_at).toLocaleString() : '—'}</span>,
    },
    {
      key: 'export_format',
      label: 'Format',
      render: (r) => (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase bg-[var(--bg-subtle)] text-[var(--text-primary)] border border-[var(--border-light)]">
          {r.export_format || 'JSON'}
        </span>
      ),
    },
    {
      key: 'record_count',
      label: 'Records',
      render: (r) => <span className="font-semibold text-[var(--text-primary)]">{r.record_count ?? 0}</span>,
      align: 'right',
    },
    {
      key: 'total_amount',
      label: 'Total Value',
      render: (r) => (
        <span className="font-mono font-medium text-[var(--text-primary)]">
          {r.total_amount != null ? `$${Number(r.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
        </span>
      ),
      align: 'right',
    },
    {
      key: 'created_by',
      label: 'Exported By',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)]">{r.created_by || 'system'}</span>,
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={(e) => handleDownload(e, r)}
            title="Download export file"
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
          >
            <Download className="h-3 w-3" />
            Download
          </button>
          <button
            onClick={() => handleView(r)}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-md)] bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 text-[11px] font-medium transition-colors"
          >
            <FileText className="h-3 w-3" />
            View
          </button>
        </div>
      ),
    },
  ]

  return (
    <div>
      {/* Header Bar */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">Export Batch History</h3>
          <p className="text-[13px] text-[var(--text-secondary)]">Audit trail of all QuickBooks Desktop batch export runs</p>
        </div>
        <button
          onClick={loadExports}
          disabled={loading}
          className="p-2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      {/* History Table */}
      <DataTable
        data={exportsList}
        columns={columns}
        pageSize={20}
        sortable
        onRowClick={(row) => handleView(row)}
        emptyMessage="No export batches found"
        emptyDescription="Exports generated from the QB Preview tab will be logged here"
      />

      {/* View Modal */}
      {selectedExport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]">
              <div className="flex items-center gap-3">
                <FileText className="h-5 w-5 text-[var(--accent)]" />
                <div>
                  <h4 className="text-[14px] font-semibold text-[var(--text-primary)]">
                    Export Batch {selectedExport.id?.slice(0, 8)}
                  </h4>
                  <p className="text-[11px] text-[var(--text-tertiary)]">
                    Format: <span className="uppercase font-semibold">{selectedExport.export_format || 'JSON'}</span> | Records: {selectedExport.record_count}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedExport(null)}
                className="p-1.5 rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-4">
              <div className="grid grid-cols-3 gap-3 p-3 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] text-[12px]">
                <div>
                  <span className="text-[var(--text-tertiary)] block text-[10px] uppercase font-semibold">Date</span>
                  <span className="font-medium text-[var(--text-primary)]">{selectedExport.created_at?.slice(0, 19)}</span>
                </div>
                <div>
                  <span className="text-[var(--text-tertiary)] block text-[10px] uppercase font-semibold">Exported By</span>
                  <span className="font-medium text-[var(--text-primary)]">{selectedExport.created_by || 'system'}</span>
                </div>
                <div>
                  <span className="text-[var(--text-tertiary)] block text-[10px] uppercase font-semibold">Total Value</span>
                  <span className="font-medium text-[var(--accent)] font-mono">
                    ${Number(selectedExport.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[12px] font-semibold text-[var(--text-primary)]">Export Payload</span>
                  <button
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? 'Copied' : 'Copy Payload'}
                  </button>
                </div>
                {detailLoading ? (
                  <div className="py-12 flex justify-center">
                    <RefreshCw className="h-5 w-5 animate-spin text-[var(--accent)]" />
                  </div>
                ) : (
                  <pre className="p-3 bg-[var(--bg-subtle)] rounded-[var(--radius-md)] border border-[var(--border-light)] text-[11px] font-mono text-[var(--text-primary)] overflow-x-auto max-h-72">
                    {typeof selectedExport.payload_json === 'string'
                      ? selectedExport.payload_json
                      : JSON.stringify(selectedExport.payload_json || {}, null, 2)}
                  </pre>
                )}
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-6 py-3 border-t border-[var(--border-light)] bg-[var(--bg-subtle)]">
              <button
                onClick={() => setSelectedExport(null)}
                className="px-3.5 py-1.5 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                Close
              </button>
              <button
                onClick={(e) => handleDownload(e, selectedExport)}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-hover)] transition-colors"
              >
                <Download className="h-3.5 w-3.5" />
                Download Payload File
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
