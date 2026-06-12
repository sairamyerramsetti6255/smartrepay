import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { computeWorkflow } from '@/lib/workflow'
import { useBorrowerSync } from '@/context/BorrowerSyncContext'

const WorkflowContext = createContext(null)

const EMPTY_COUNTS = {
  transactions: 0,
  pending: 0,
  matched: 0,
  unmatched: 0,
  posted: 0,
  documents: 0,
  openExceptions: 0,
  borrowers: 0,
}

export function WorkflowProvider({ children }) {
  const { ready: borrowersReady, syncing: borrowersSyncing, borrowerCount } = useBorrowerSync()
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await api.transactions.counts()
      setCounts({ ...EMPTY_COUNTS, ...data })
    } catch {
      /* keep last known counts */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const events = [
      'smartrepay:demo-loaded',
      'smartrepay:borrowers-synced',
      'smartrepay:matching-done',
      'smartrepay:matching-progress',
    ]
    events.forEach((e) => window.addEventListener(e, refresh))
    return () => events.forEach((e) => window.removeEventListener(e, refresh))
  }, [refresh])

  const resolvedReady = borrowersReady || (borrowerCount ?? 0) > 0 || (counts.borrowers ?? 0) > 0

  const workflow = computeWorkflow({
    counts,
    borrowersReady: resolvedReady,
    borrowersSyncing,
  })

  return (
    <WorkflowContext.Provider
      value={{
        counts,
        loading,
        refresh,
        borrowerCount: Math.max(borrowerCount ?? 0, counts.borrowers ?? 0),
        ...workflow,
      }}
    >
      {children}
    </WorkflowContext.Provider>
  )
}

export function useWorkflow() {
  const ctx = useContext(WorkflowContext)
  if (!ctx) throw new Error('useWorkflow must be used within WorkflowProvider')
  return ctx
}
