import { useMemo } from 'react'
import { X, Copy, Download } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const REQUIRED = ['loan_number', 'borrower', 'amount', 'date', 'reference']

export function LoanDiskPreviewModal({ open, onClose, rows }) {
  const payload = useMemo(
    () =>
      rows.map((t) => ({
        loan_number: t.loans?.loan_number || '',
        borrower: t.borrowers?.full_name || '',
        amount: t.amount,
        date: t.date,
        reference: t.reference || '',
      })),
    [rows]
  )

  if (!open) return null

  function buildCsv() {
    const headers = REQUIRED
    return [headers.join(','), ...payload.map((r) => headers.map((h) => escapeCsv(r[h])).join(','))].join('\n')
  }

  function copyJson() {
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
    toast.success('Copied JSON')
  }

  function download() {
    const blob = new Blob([buildCsv()], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `loandisk-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Downloaded')
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-[rgba(26,25,22,0.24)]" onClick={onClose} />
      <div
        className="fixed inset-x-4 top-[10%] mx-auto z-50 max-w-3xl bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-xl)] max-h-[80vh] flex flex-col"
        style={{ boxShadow: 'var(--shadow-lg)' }}
      >
        <header className="flex justify-between items-center px-6 h-14 border-b border-[var(--border-light)]">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">LoanDisk Payload</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </header>
        <div className="flex-1 overflow-auto p-6">
          {payload.length === 0 ? (
            <p className="text-[13px] text-[var(--text-tertiary)]">No rows to export.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-[#FAFAF8] border-b border-[var(--border-light)]">
                  {REQUIRED.map((h) => (
                    <th key={h} className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                      {h.replace('_', ' ')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payload.map((r, i) => {
                  const bad = REQUIRED.some((k) => !r[k] && r[k] !== 0)
                  return (
                    <tr key={i} className={cn('border-b border-[var(--border-light)] h-14', bad && 'bg-[var(--danger-bg)]')}>
                      {REQUIRED.map((h) => (
                        <td key={h} className="px-5 mono font-medium">
                          {r[h] || '—'}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <footer className="flex justify-end gap-2 px-6 py-4 border-t border-[var(--border-light)]">
          <Button variant="secondary" onClick={copyJson}>
            <Copy className="h-4 w-4" /> Copy JSON
          </Button>
          <Button onClick={download}>
            <Download className="h-4 w-4" /> Download CSV
          </Button>
        </footer>
      </div>
    </>
  )
}

function escapeCsv(val) {
  const s = String(val ?? '')
  return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s
}
