import { useEffect, useState } from 'react'
import * as api from '@/lib/api'

export function useAuditLog(limit = 200) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.audit
      .list(limit)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [limit])

  return { entries, loading }
}
