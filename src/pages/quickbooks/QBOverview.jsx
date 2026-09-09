import { useEffect, useState } from 'react'
import { BookOpen, Download, RefreshCw, ArrowRight, CheckCircle, AlertCircle, Clock, Copy } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAuth } from '@/context/AuthContext'
import { canApproveQB } from '@/lib/roles'
import toast from 'react-hot-toast'

function StatCard({ label, value, sub, accent }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-5">
      <p className="text-[12px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide mb-1">{label}</p>
      <p className={cn('text-[28px] font-bold leading-none', accent || 'text-[var(--text-primary)]')}>{value ?? '—'}</p>
      {sub && <p className="text-[12px] text-[var(--text-tertiary)] mt-1">{sub}</p>}
    </div>
  )
}

function BatchRow({ batch }) {
  const statusColor = {
    completed: 'text-[var(--success)]',
    processing: 'text-[var(--accent)]',
    failed: 'text-[var(--danger)]',
    completed_with_exceptions: 'text-[var(--warning)]',
  }
  return (
    <div className="flex items-center justify-between py-3 border-b border-[var(--border-light)] last:border-0">
      <div>
        <p className="text-[13px] font-medium text-[var(--text-primary)]">{batch.source_name || batch.source_type}</p>
        <p className="text-[12px] text-[var(--text-tertiary)]">{batch.created_at?.slice(0, 10)}</p>
      </div>
      <div className="flex items-center gap-6 text-right">
        <div>
          <p className="text-[12px] text-[var(--text-tertiary)]">Total</p>
          <p className="text-[13px] font-semibold text-[var(--text-primary)]">{batch.total_records}</p>
        </div>
        <div>
          <p className="text-[12px] text-[var(--text-tertiary)]">Valid</p>
          <p className="text-[13px] font-semibold text-[var(--success)]">{batch.valid_records}</p>
        </div>
        <div>
          <p className="text-[12px] text-[var(--text-tertiary)]">Invalid</p>
          <p className="text-[13px] font-semibold text-[var(--danger)]">{batch.invalid_records}</p>
        </div>
        <span className={cn('text-[12px] font-medium capitalize', statusColor[batch.status] || 'text-[var(--text-secondary)]')}>
          {batch.status?.replace(/_/g, ' ')}
        </span>
      </div>
    </div>
  )
}

export function QBOverview({ onNavigate }) {
  const { profile } = useAuth()
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)

  const fetchSummary = async () => {
    try {
      setLoading(true)
      const data = await quickbooks.summary()
      setSummary(data)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchSummary() }, [])

  const handleImportSmartRepay = async () => {
    setImporting(true)
    try {
      const result = await quickbooks.importSmartRepay(1000)
      toast.success(result.message || `Imported ${result.valid} EMI receipts from SmartRepay`)
      fetchSummary()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setImporting(false)
    }
  }

  const fmt = (n) => (n ?? 0).toLocaleString()
  const fmtAmt = (n) => `$${((n ?? 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  return (
    <div>
      {/* Action bar */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={handleImportSmartRepay}
            disabled={importing}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] disabled:opacity-60 transition-colors"
          >
            {importing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <BookOpen className="h-3.5 w-3.5" />}
            {importing ? 'Importing…' : 'Import from SmartRepay'}
          </button>
          <button
            onClick={() => onNavigate?.('import')}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[var(--text-primary)] text-[13px] font-medium hover:bg-[var(--bg-hover)] transition-colors"
          >
            <ArrowRight className="h-3.5 w-3.5" />
            Import Other Sources
          </button>
        </div>
        <button onClick={fetchSummary} disabled={loading} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Records" value={fmt(summary?.total_records)} />
        <StatCard label="Valid" value={fmt(summary?.valid_records)} accent="text-[var(--success)]" />
        <StatCard label="Needs Review" value={fmt(summary?.needs_review)} accent="text-[var(--warning)]" />
        <StatCard label="Invalid" value={fmt(summary?.invalid_records)} accent="text-[var(--danger)]" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="EMI Receipts" value={fmt(summary?.emi_receipts)} />
        <StatCard label="Payments Disbursed" value={fmt(summary?.payments_disbursed)} />
        <StatCard label="Accounts to Create" value={fmt(summary?.accounts_to_create)} />
        <StatCard label="Total Value" value={fmtAmt(summary?.total_value)} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Duplicates" value={fmt(summary?.duplicates)} />
        <StatCard label="Approved" value={fmt(summary?.approved)} accent="text-[var(--accent)]" />
        <StatCard label="Exported" value={fmt(summary?.exported)} />
        <StatCard label="Total Batches" value={fmt(summary?.total_batches)} />
      </div>

      {/* Status Legend */}
      <div className="flex items-center gap-6 mb-6 p-4 rounded-[var(--radius-lg)] bg-[var(--bg-subtle)] border border-[var(--border-light)]">
        <div className="flex items-center gap-1.5 text-[12px] text-[var(--success)]">
          <CheckCircle className="h-3.5 w-3.5" />
          Valid — ready for accounting review
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-[var(--warning)]">
          <Clock className="h-3.5 w-3.5" />
          Needs Review — missing or low-confidence fields
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-[var(--danger)]">
          <AlertCircle className="h-3.5 w-3.5" />
          Invalid — blocking rules failed
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]">
          <Copy className="h-3.5 w-3.5" />
          Duplicate — already in library
        </div>
      </div>

      {/* Recent Batches */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-light)]">
          <p className="text-[13px] font-semibold text-[var(--text-primary)]">Recent Import Batches</p>
          <button
            onClick={() => onNavigate?.('history')}
            className="text-[12px] text-[var(--accent)] hover:underline"
          >
            View all exports →
          </button>
        </div>
        <div className="px-5">
          {loading ? (
            <p className="py-6 text-center text-[13px] text-[var(--text-tertiary)]">Loading…</p>
          ) : !summary?.recent_batches?.length ? (
            <div className="py-10 text-center">
              <p className="text-[13px] text-[var(--text-tertiary)] mb-3">No import batches yet</p>
              <button
                onClick={handleImportSmartRepay}
                className="text-[13px] text-[var(--accent)] hover:underline"
              >
                Import from SmartRepay to get started →
              </button>
            </div>
          ) : (
            summary.recent_batches.map((b) => <BatchRow key={b.id} batch={b} />)
          )}
        </div>
      </div>
    </div>
  )
}
