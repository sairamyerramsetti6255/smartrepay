import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import * as api from '@/lib/api'

const MatchingProgressContext = createContext(null)

/**
 * Global matching progress — drives the navbar progress bar and the Match page.
 * Backed by the SQL/AI matching runner in the Node service (OpenRouter), polled
 * via /api/sql/match/status. Progress is reported batch-wise (25 per batch).
 */
export function MatchingProgressProvider({ children }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const poll = useCallback(async () => {
    try {
      const s = await api.sqlMatch.status()
      setProgress(s.progress || null)
      if (s.status === 'running') {
        setRunning(true)
        window.dispatchEvent(new CustomEvent('smartrepay:matching-progress', { detail: s.progress }))
        pollRef.current = setTimeout(poll, 1500)
      } else {
        setRunning(false)
        setSummary(s.summary || null)
        if (s.status === 'error') setError(s.error || 'Matching failed')
        window.dispatchEvent(new CustomEvent('smartrepay:matching-done', { detail: s }))
      }
    } catch {
      // transient — keep last state, stop polling
      setRunning(false)
    }
  }, [])

  // Resume polling if a run is already in flight (e.g. after a page reload).
  useEffect(() => {
    api.sqlMatch
      .status()
      .then((s) => {
        if (s?.status === 'running') {
          setRunning(true)
          setProgress(s.progress || null)
          poll()
        }
      })
      .catch(() => {})
    return stopPoll
  }, [poll, stopPoll])

  const startMatching = useCallback(
    async (useAi = true) => {
      setError(null)
      setSummary(null)
      setProgress({ phase: 'starting' })
      setRunning(true)
      try {
        const r = await api.sqlMatch.run(useAi)
        if (r.status === 'started' || r.status === 'running') {
          poll()
          return r
        }
        setRunning(false)
        throw new Error(r.message || 'Could not start matching')
      } catch (e) {
        setError(e.message)
        setRunning(false)
        throw e
      }
    },
    [poll]
  )

  return (
    <MatchingProgressContext.Provider value={{ running, progress, summary, error, startMatching }}>
      {children}
    </MatchingProgressContext.Provider>
  )
}

export function useMatchingProgress() {
  const ctx = useContext(MatchingProgressContext)
  if (!ctx) throw new Error('useMatchingProgress must be used within MatchingProgressProvider')
  return ctx
}
