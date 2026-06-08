import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '@/lib/api'

export function useTransactions(params = {}) {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const hasLoaded = useRef(false)
  const paramsKey = JSON.stringify(params)

  const refetch = useCallback(async () => {
    if (hasLoaded.current) setRefreshing(true)
    else setLoading(true)
    try {
      const data = await api.transactions.list(params)
      setTransactions(data)
      setError(null)
      hasLoaded.current = true
    } catch (e) {
      setError(e.message)
      hasLoaded.current = true
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [paramsKey])

  useEffect(() => {
    hasLoaded.current = false
    setLoading(true)
    refetch()
    const onLoaded = () => refetch()
    window.addEventListener('smartrepay:demo-loaded', onLoaded)
    return () => window.removeEventListener('smartrepay:demo-loaded', onLoaded)
  }, [refetch])

  return { transactions, loading, refreshing, error, refetch }
}
