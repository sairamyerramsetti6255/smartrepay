import { getToken } from '@/lib/api'

const SIMPLIFIED_API = import.meta.env.VITE_SIMPLIFIED_API_URL || '/simplified-api'
const API_URL = import.meta.env.VITE_API_URL || '/api'
const IS_DEV = import.meta.env.DEV

export async function fetchLoanDiskToken() {
  const token = getToken()
  const res = await fetch(`${API_URL}/loandisk/token`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Failed to get LoanDisk token')
  return data.token
}

async function syncViaServer() {
  const token = getToken()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 300_000)
  try {
    const res = await fetch(`${API_URL}/loandisk/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: '{}',
      signal: controller.signal,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'LoanDisk sync failed')
    return data
  } finally {
    clearTimeout(timeout)
  }
}

async function syncViaDirectProxy() {
  const token = await fetchLoanDiskToken()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 300_000)
  try {
    const res = await fetch(`${SIMPLIFIED_API}/SP/GetAllBorrowers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload.message || payload.title || `GetAllBorrowers HTTP ${res.status}`)

    const saveRes = await fetch(`${API_URL}/loandisk/import-raw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const data = await saveRes.json().catch(() => ({}))
    if (!saveRes.ok) throw new Error(data.error || 'Failed to save borrowers')
    return data
  } finally {
    clearTimeout(timeout)
  }
}

/** Sync borrowers — uses server API in production, direct proxy in Vite dev. */
export async function syncBorrowersToLocal() {
  if (IS_DEV) {
    try {
      return await syncViaDirectProxy()
    } catch {
      return syncViaServer()
    }
  }
  return syncViaServer()
}
