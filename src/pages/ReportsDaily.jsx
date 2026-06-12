import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { format, isToday } from 'date-fns'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/Card'
import { PageLoader } from '@/components/PageLoader'

export function ReportsDaily() {
  const [stats, setStats] = useState({ processed: 0, posted: 0, pending: 0, exceptions: 0, slaPct: 100 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const today = format(new Date(), 'yyyy-MM-dd')
        const [txList, exList] = await Promise.all([api.transactions.list(), api.exceptions.list()])
        const todayTx = txList.filter((t) => t.date === today || isToday(new Date(t.created_at)))
        const openEx = exList.filter((e) => e.status === 'open')
        const resolved = exList.filter((e) => e.status === 'resolved')
        const total = openEx.length + resolved.length || 1
        setStats({
          processed: todayTx.length,
          posted: todayTx.filter((t) => t.status === 'posted').length,
          pending: todayTx.filter((t) => t.status === 'pending').length,
          exceptions: todayTx.filter((t) => t.status === 'exception').length,
          slaPct: Math.round((resolved.length / total) * 100) || 100,
        })
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  function send() {
    toast.success(
      `Today: ${stats.processed} processed, ${stats.posted} posted, ${stats.exceptions} exceptions`,
      { duration: 5000 }
    )
  }

  if (loading) return <PageLoader label="Loading daily report…" />

  return (
    <div className="space-y-6">
      <PageHeader
        title="Daily Report"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => window.print()}>Print</Button>
            <Button onClick={send}>Send Report</Button>
          </div>
        }
      />

      <Card className="p-10 max-w-2xl mx-auto print:shadow-none">
        <div className="text-center border-b border-[var(--border-light)] pb-8 mb-8">
          <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">SmartRepay AI</p>
          <h2 className="text-xl font-semibold text-[var(--text-primary)] tracking-[-0.025em] mt-2">
            Daily Reconciliation Summary
          </h2>
          <p className="text-[13px] text-[var(--text-tertiary)] mt-1">{format(new Date(), 'EEEE, MMMM d, yyyy')}</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: 'Processed', value: stats.processed },
            { label: 'Posted', value: stats.posted },
            { label: 'Pending', value: stats.pending },
            { label: 'Unmatched', value: stats.exceptions },
          ].map((s) => (
            <div key={s.label} className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-5 text-center">
              <p className="text-xs text-[var(--text-tertiary)]">{s.label}</p>
              <p className="text-2xl font-bold mono mt-2 text-[var(--text-primary)]">{s.value}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center rounded-[var(--radius-md)] bg-[var(--success-bg)] border border-[var(--success-border)] p-6">
          <p className="text-[13px] text-[var(--text-secondary)]">SLA compliance</p>
          <p className="text-3xl font-bold mono text-[var(--success)] mt-2">{stats.slaPct}%</p>
        </div>
      </Card>
    </div>
  )
}
