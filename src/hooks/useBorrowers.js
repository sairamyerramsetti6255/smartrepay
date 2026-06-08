import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '@/lib/api'
import { syncBorrowersToLocal } from '@/lib/loandiskClient'

export function useBorrowers() {
  const [borrowers, setBorrowers] = useState([])
  const [loans, setLoans] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const hasLoaded = useRef(false)

  const loadLocal = useCallback(async () => {
    const [b, l] = await Promise.all([api.borrowers.list(), api.loans.list()])
    setBorrowers(Array.isArray(b) ? b : [])
    setLoans(Array.isArray(l) ? l : [])
    return { b, l }
  }, [])

  const syncFromLoanDisk = useCallback(async () => {
    setSyncing(true)
    setError(null)
    try {
      const result = await syncBorrowersToLocal()
      await loadLocal()
      window.dispatchEvent(new CustomEvent('smartrepay:borrowers-synced', { detail: result }))
      return result
    } catch (e) {
      setError(e.message)
      throw e
    } finally {
      setSyncing(false)
    }
  }, [loadLocal])

  const refetch = useCallback(async () => {
    if (hasLoaded.current) setRefreshing(true)
    else setLoading(true)
    try {
      await loadLocal()
      setError(null)
      hasLoaded.current = true
    } catch (e) {
      setError(e.message)
      hasLoaded.current = true
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [loadLocal])

  useEffect(() => {
    refetch()
    const onSync = () => refetch()
    window.addEventListener('smartrepay:borrowers-synced', onSync)
    window.addEventListener('smartrepay:demo-loaded', onSync)
    return () => {
      window.removeEventListener('smartrepay:borrowers-synced', onSync)
      window.removeEventListener('smartrepay:demo-loaded', onSync)
    }
  }, [refetch])

  return { borrowers, loans, loading, syncing, refreshing, error, refetch, syncFromLoanDisk }
}
