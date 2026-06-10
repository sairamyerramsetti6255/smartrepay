import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import {
  ensureBorrowersOnLogin,
  getBorrowerSyncState,
  startBorrowerBackgroundSync,
} from '@/lib/borrowerBackgroundSync'

const BorrowerSyncContext = createContext(null)

export function BorrowerSyncProvider({ children }) {
  const { user } = useAuth()
  const [state, setState] = useState(getBorrowerSyncState)

  useEffect(() => {
    const onState = (e) => setState(e.detail || getBorrowerSyncState())
    const onSynced = async () => {
      try {
        const list = await api.borrowers.list()
        const count = Array.isArray(list) ? list.length : 0
        setState((s) => ({ ...s, running: false, ready: true, borrowerCount: count }))
      } catch {
        setState((s) => ({ ...s, running: false, ready: true }))
      }
    }
    window.addEventListener('smartrepay:borrower-sync-state', onState)
    window.addEventListener('smartrepay:borrowers-synced', onSynced)
    return () => {
      window.removeEventListener('smartrepay:borrower-sync-state', onState)
      window.removeEventListener('smartrepay:borrowers-synced', onSynced)
    }
  }, [state.borrowerCount])

  useEffect(() => {
    if (!user) return
    ensureBorrowersOnLogin()
  }, [user?.id])

  const retrySync = useCallback(() => startBorrowerBackgroundSync(), [])

  const canRunMatching = (localBorrowerCount) => {
    if (state.running && (localBorrowerCount ?? 0) === 0) return false
    return (localBorrowerCount ?? 0) > 0 || state.ready
  }

  const waitMessage =
    state.running && (state.borrowerCount ?? 0) === 0
      ? 'Please wait — borrowers are loading from LoanDisk in the background…'
      : null

  return (
    <BorrowerSyncContext.Provider
      value={{
        syncing: state.running,
        ready: state.ready,
        error: state.error,
        borrowerCount: state.borrowerCount,
        canRunMatching,
        waitMessage,
        retrySync,
      }}
    >
      {children}
    </BorrowerSyncContext.Provider>
  )
}

export function useBorrowerSync() {
  const ctx = useContext(BorrowerSyncContext)
  if (!ctx) throw new Error('useBorrowerSync must be used within BorrowerSyncProvider')
  return ctx
}
