import { syncBorrowersToLocal } from '@/lib/loandiskClient'

let syncPromise = null
let lastResult = null
let lastError = null

/** Fire-and-forget LoanDisk sync — runs once per session, never blocks UI. */
export function startBorrowerBackgroundSync() {
  if (syncPromise) return syncPromise

  syncPromise = syncBorrowersToLocal()
    .then((result) => {
      lastResult = result
      lastError = null
      window.dispatchEvent(new CustomEvent('smartrepay:borrowers-synced', { detail: result }))
      window.dispatchEvent(new Event('smartrepay:demo-loaded'))
      return result
    })
    .catch((err) => {
      lastError = err?.message || 'Background sync failed'
      syncPromise = null
      window.dispatchEvent(new CustomEvent('smartrepay:borrowers-sync-failed', { detail: lastError }))
      return null
    })

  return syncPromise
}

export function getBorrowerSyncState() {
  return { running: !!syncPromise && !lastResult, lastResult, lastError }
}

export function resetBorrowerSyncSession() {
  syncPromise = null
  lastResult = null
  lastError = null
}
