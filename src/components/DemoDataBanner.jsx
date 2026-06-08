import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Database, Loader2 } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { getDataCounts, loadDemoData } from '@/lib/demoData'
import { Button } from '@/components/ui/button'

export function DemoDataBanner() {
  const { user } = useAuth()
  const [counts, setCounts] = useState(null)
  const [loading, setLoading] = useState(false)

  async function refresh() {
    setCounts(await getDataCounts())
  }

  useEffect(() => {
    refresh()
    const onLoaded = () => refresh()
    window.addEventListener('smartrepay:demo-loaded', onLoaded)
    return () => window.removeEventListener('smartrepay:demo-loaded', onLoaded)
  }, [])

  async function handleLoad() {
    setLoading(true)
    try {
      const result = await loadDemoData(user?.email || 'demo')
      toast.success(`Loaded ${result.transactionsAdded} transactions`)
      window.dispatchEvent(new Event('smartrepay:demo-loaded'))
      await refresh()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  if (!counts || counts.error) {
    return (
      <div className="mb-6 rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] p-4 text-[13px] text-[var(--danger)]">
        Database: {counts?.error || 'unreachable'} — run migration in Supabase SQL Editor.
      </div>
    )
  }

  if (counts.borrowers > 0 && counts.transactions > 0) return null

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 card px-6 py-5">
      <div>
        <p className="text-[13px] font-medium text-[var(--text-primary)]">Load sample data</p>
        <p className="text-[13px] text-[var(--text-tertiary)] mt-1">
          Populate borrowers, loans, and pending transactions to explore the workflow.
        </p>
      </div>
      <Button variant="secondary" onClick={handleLoad} disabled={loading}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" strokeWidth={1.75} />}
        Load demo data
      </Button>
    </div>
  )
}
