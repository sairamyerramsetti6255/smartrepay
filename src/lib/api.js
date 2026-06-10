import { getApiUrl, isApiMode, loadRuntimeConfig } from '@/lib/runtimeConfig'



export { isApiMode, loadRuntimeConfig }



const TOKEN_KEY = 'smartrepay_token'



export function getToken() {

  return localStorage.getItem(TOKEN_KEY)

}



export function setToken(token) {

  if (token) localStorage.setItem(TOKEN_KEY, token)

  else localStorage.removeItem(TOKEN_KEY)

}



function isRetryableError(e, status) {
  if (e?.name === 'AbortError') return true
  if (e?.message?.includes('Failed to fetch') || e?.message?.includes('NetworkError')) return true
  if (status === 502 || status === 503 || status === 504) return true
  return false
}

async function requestOnce(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ...options.headers,
  }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timeoutMs = options.timeout ?? 90000
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${getApiUrl()}${path}`, { ...options, headers, signal: controller.signal })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || 'Request failed')
      err.status = res.status
      throw err
    }
    return data
  } catch (e) {
    if (e?.name === 'AbortError') {
      const err = new Error('Request timed out — server may be busy, retrying…')
      err.status = 408
      throw err
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }
}

async function request(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const maxAttempts = options.retries ?? (method === 'GET' ? 3 : 1)
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestOnce(path, options)
    } catch (e) {
      lastError = e
      if (attempt >= maxAttempts || e.status === 401 || e.status === 403 || e.status === 400) throw e
      if (!isRetryableError(e, e.status)) throw e
      await sleep(1000 * attempt)
    }
  }
  throw lastError
}



export async function checkApiConnection() {

  const apiUrl = getApiUrl()

  try {

    const controller = new AbortController()

    const t = setTimeout(() => controller.abort(), 5000)

    const res = await fetch(`${apiUrl}/health`, { signal: controller.signal })

    clearTimeout(t)

    if (!res.ok) return { ok: false, error: `API returned ${res.status}` }

    return { ok: true, error: null }

  } catch (e) {

    return {

      ok: false,

      error: e?.name === 'AbortError'

        ? 'API timed out'

        : `Cannot reach API at ${apiUrl}`,

    }

  }

}



export const auth = {

  signIn: (email, password) => request('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password }) }),

  signUp: (email, password, role) =>

    request('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, role }) }),

  me: () => request('/auth/me'),

}



export const borrowers = {

  list: async () => {

    const data = await request('/borrowers')

    return Array.isArray(data) ? data : []

  },

  create: (body) => request('/borrowers', { method: 'POST', body: JSON.stringify(body) }),

  update: (id, body) => request(`/borrowers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

}



export const loans = {

  list: () => request('/loans'),

  create: (body) => request('/loans', { method: 'POST', body: JSON.stringify(body) }),

}



export const transactions = {

  list: (params = {}) => {

    const q = new URLSearchParams(params).toString()

    return request(`/transactions${q ? `?${q}` : ''}`)

  },

  counts: () => request('/transactions/counts'),

  hashes: () => request('/transactions/hashes'),

  bulkInsert: (rows) => request('/transactions/bulk', { method: 'POST', body: JSON.stringify({ rows }) }),

  update: (id, body) => request(`/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

}



export const exceptions = {

  list: () => request('/exceptions'),

  create: (body) => request('/exceptions', { method: 'POST', body: JSON.stringify(body) }),

  update: (id, body) => request(`/exceptions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

}



export const audit = {

  list: (limit = 200) => request(`/audit?limit=${limit}`),

  write: (body) => request('/audit', { method: 'POST', body: JSON.stringify(body) }),

}



const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const matching = {

  preview: () => request('/matching/preview'),

  branchTransactions: (branchKey, status = 'all') =>
    request(`/matching/branches/${encodeURIComponent(branchKey)}/transactions?status=${status}`),

  start: () => request('/matching/run', { method: 'POST', body: '{}', timeout: 30000 }),

  status: () => request('/matching/status', { timeout: 90000, retries: 2 }),

  async pollUntilComplete(onProgress) {
    const deadline = Date.now() + 30 * 60 * 1000
    let statusErrors = 0
    while (Date.now() < deadline) {
      try {
        const snap = await matching.status()
        statusErrors = 0
        if (snap.progress) onProgress?.(snap.progress)
        if (snap.status === 'completed') return snap.result
        if (snap.status === 'failed') throw new Error(snap.error || 'Matching failed')
        if (snap.status === 'idle') throw new Error('Matching stopped unexpectedly')
      } catch (e) {
        statusErrors++
        if (statusErrors >= 20) throw e
        // Server busy — keep polling; do not cancel other API calls
      }
      await sleep(3000)
    }
    throw new Error(
      'Matching is still running on the server — refresh the page and check Match results.'
    )
  },

  /** Start background matching and poll until complete (up to 20 min). */
  async run(onProgress) {
    const started = await matching.start()
    if (started.status === 'busy') {
      throw new Error(started.message || `Server busy with ${started.activeJob || 'another job'}`)
    }
    if (started.status === 'running' && started.message?.includes('already in progress')) {
      return matching.pollUntilComplete(onProgress)
    }
    if (started.message && started.matched === 0 && started.excepted === 0 && started.status === 'idle') {
      return started
    }
    if (started.progress) onProgress?.(started.progress)
    return matching.pollUntilComplete(onProgress)
  },

}



export const documents = {

  list: () => request('/documents'),

  transactions: (id) => request(`/documents/${id}/transactions`),

  downloadUrl: (id) => `${getApiUrl()}/documents/${id}/download`,

  async download(id, filename) {

    const token = getToken()

    const res = await fetch(`${getApiUrl()}/documents/${id}/download`, {

      headers: token ? { Authorization: `Bearer ${token}` } : {},

    })

    if (!res.ok) throw new Error('Download failed')

    const blob = await res.blob()

    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')

    a.href = url

    a.download = filename || 'document'

    a.click()

    URL.revokeObjectURL(url)

  },

}



export const loandisk = {

  status: () => request('/loandisk/status'),

  token: () => request('/loandisk/token'),

  sync: () => request('/loandisk/sync', { method: 'POST', body: '{}', timeout: 30000 }),

  syncStatus: () => request('/loandisk/sync/status', { timeout: 30000 }),

  search: (searchCriteria) =>

    request('/loandisk/search', { method: 'POST', body: JSON.stringify({ searchCriteria }), timeout: 120000 }),

  borrower: (id, { refresh = false } = {}) =>
    request(`/loandisk/borrower/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`, {
      timeout: 20000,
      retries: 3,
    }),

  async pollUntilReady(id, onProgress, { refresh = false, maxMinutes = 5 } = {}) {
    const deadline = Date.now() + maxMinutes * 60 * 1000
    let first = true
    while (Date.now() < deadline) {
      const snap = await loandisk.borrower(id, { refresh: refresh && first })
      first = false
      onProgress?.(snap)
      if (snap.status === 'ready') return snap
      if (snap.status === 'failed') throw new Error(snap.error || snap.message || 'LoanDisk fetch failed')
      await sleep(4000)
    }
    throw new Error('Still loading from LoanDisk — tap Refresh to check again')
  },

  importBorrowers: (borrowers) =>

    request('/loandisk/import-borrowers', {

      method: 'POST',

      body: JSON.stringify({ borrowers }),

      timeout: 60000,

    }),

}



export const data = {

  reset: () => request('/data/reset', { method: 'POST', body: '{}' }),

}



export const settings = {

  get: () => request('/settings'),

  save: (body) => request('/settings', { method: 'PUT', body: JSON.stringify(body) }),

}



export const demo = {

  seed: () => request('/demo/seed', { method: 'POST', body: '{}' }),

  counts: () => request('/transactions/counts'),

}



export const ingest = {

  async parse(file) {

    const form = new FormData()

    form.append('file', file)

    const token = getToken()

    const res = await fetch(`${getApiUrl()}/ingest/parse`, {

      method: 'POST',

      headers: token ? { Authorization: `Bearer ${token}` } : {},

      body: form,

    })

    let data = {}

    try {

      data = await res.json()

    } catch {

      throw new Error('Upload failed — invalid server response')

    }

    if (!res.ok) {

      if (res.status === 401) throw new Error('Sign in required before uploading statements')

      throw new Error(data.error || `Upload failed (${res.status})`)

    }

    return data

  },

  import: (parseId) =>

    request('/ingest/import', { method: 'POST', body: JSON.stringify({ parseId }) }),

}

