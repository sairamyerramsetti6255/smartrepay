import { useCallback, useEffect, useState } from 'react'
import * as api from '@/lib/api'

export function useExceptions() {
  const [exceptions, setExceptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const refetch = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.exceptions.list()
      setExceptions(data)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refetch()
    const onLoaded = () => refetch()
    window.addEventListener('smartrepay:demo-loaded', onLoaded)
    return () => window.removeEventListener('smartrepay:demo-loaded', onLoaded)
  }, [refetch])

  return { exceptions, loading, error, refetch }
}
