import * as api from '@/lib/api'
import { syncBorrowersToLocal } from '@/lib/loandiskClient'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let syncPromise = null
let state = {
  running: false,
  ready: false,
  error: null,
  result: null,
  borrowerCount: 0,
}

function emitState() {
  window.dispatchEvent(new CustomEvent('smartrepay:borrower-sync-state', { detail: { ...state } }))
}

function setState(patch) {
  state = { ...state, ...patch }
  emitState()
}

export function getBorrowerSyncState() {
  return { ...state }
}

export function resetBorrowerSyncSession() {
  syncPromise = null
  state = { running: false, ready: false, error: null, result: null, borrowerCount: 0 }
  emitState()
}

async function pollServerSync(onProgress) {
  const deadline = Date.now() + 30 * 60 * 1000
  while (Date.now() < deadline) {
    const snap = await api.loandisk.syncStatus()
    onProgress?.(snap)
    if (snap.status === 'completed') return snap.result
    if (snap.status === 'failed') throw new Error(snap.error || 'Borrower sync failed')
    if (snap.status === 'idle') return null
    await sleep(2500)
  }
  throw new Error('Borrower sync is still running — please wait a moment')
}

/** Fire-and-forget LoanDisk sync — runs once per session. */
export function startBorrowerBackgroundSync() {
  if (syncPromise) return syncPromise

  setState({ running: true, ready: false, error: null })

  syncPromise = (async () => {
    try {
      const started = await syncBorrowersToLocal()
      let result = started

      if (started.background || started.status === 'started' || started.status === 'running') {
        const polled = await pollServerSync()
        if (polled) result = { ...started, ...polled, synced: polled.synced ?? started.synced }
      }

      const list = await api.borrowers.list()
      const count = Array.isArray(list) ? list.length : 0

      setState({
        running: false,
        ready: true,
        error: null,
        result,
        borrowerCount: count,
      })

      window.dispatchEvent(new CustomEvent('smartrepay:borrowers-synced', { detail: result }))
      return result
    } catch (err) {
      const message = err?.message || 'Background sync failed'
      setState({ running: false, ready: state.borrowerCount > 0, error: message })
      syncPromise = null
      window.dispatchEvent(new CustomEvent('smartrepay:borrowers-sync-failed', { detail: message }))
      return null
    }
  })()

  return syncPromise
}

/** If borrowers already in DB, mark ready immediately then refresh in background. */
export async function ensureBorrowersOnLogin() {
  try {
    const list = await api.borrowers.list()
    const count = Array.isArray(list) ? list.length : 0
    if (count > 0) {
      setState({ borrowerCount: count, ready: true, running: false })
    }
  } catch {
    /* ignore */
  }
  return startBorrowerBackgroundSync()
}
