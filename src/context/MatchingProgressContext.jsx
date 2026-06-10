import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import * as api from '@/lib/api'

const MatchingProgressContext = createContext(null)

export function MatchingProgressProvider({ children }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const refreshStatus = useCallback(async () => {
    try {
      const snap = await api.matching.status()
      if (snap.progress) setProgress(snap.progress)
      if (snap.status === 'running') {
        setRunning(true)
        window.dispatchEvent(new CustomEvent('smartrepay:matching-progress', { detail: snap.progress }))
        return snap
      }
      if (snap.status === 'completed') {
        setRunning(false)
        setResult(snap.result)
        window.dispatchEvent(new CustomEvent('smartrepay:matching-done', { detail: snap.result }))
        return snap
      }
      if (snap.status === 'failed') {
        setRunning(false)
        setError(snap.error || 'Matching failed')
        return snap
      }
      setRunning(false)
      return snap
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!running) return undefined
    const id = setInterval(refreshStatus, 2000)
    return () => clearInterval(id)
  }, [running, refreshStatus])

  const startMatching = useCallback(async () => {
    setError(null)
    setResult(null)
    setProgress({ phase: 'starting' })
    setRunning(true)
    try {
      const res = await api.matching.run((p) => setProgress(p))
      setResult(res)
      setRunning(false)
      window.dispatchEvent(new CustomEvent('smartrepay:matching-done', { detail: res }))
      return res
    } catch (e) {
      setError(e.message)
      setRunning(false)
      throw e
    }
  }, [])

  return (
    <MatchingProgressContext.Provider value={{ running, progress, result, error, startMatching, refreshStatus }}>
      {children}
    </MatchingProgressContext.Provider>
  )
}

export function useMatchingProgress() {
  const ctx = useContext(MatchingProgressContext)
  if (!ctx) throw new Error('useMatchingProgress must be used within MatchingProgressProvider')
  return ctx
}
