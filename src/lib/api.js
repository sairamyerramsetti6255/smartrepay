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



async function request(path, options = {}) {

  const headers = {

    'Content-Type': 'application/json',

    'Cache-Control': 'no-cache',

    ...options.headers,

  }

  const token = getToken()

  if (token) headers.Authorization = `Bearer ${token}`



  const controller = new AbortController()

  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 60000)



  try {

    const res = await fetch(`${getApiUrl()}${path}`, { ...options, headers, signal: controller.signal })

    const data = await res.json().catch(() => ({}))

    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed')

    return data

  } catch (e) {

    if (e?.name === 'AbortError') throw new Error('Request timed out — is the API server running?')

    throw e

  } finally {

    clearTimeout(timeout)

  }

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

  start: () => request('/matching/run', { method: 'POST', body: '{}', timeout: 30000 }),

  status: () => request('/matching/status', { timeout: 45000 }),

  async pollUntilComplete(onProgress) {
    const deadline = Date.now() + 20 * 60 * 1000
    while (Date.now() < deadline) {
      const snap = await matching.status()
      if (snap.progress) onProgress?.(snap.progress)
      if (snap.status === 'completed') return snap.result
      if (snap.status === 'failed') throw new Error(snap.error || 'Matching failed')
      if (snap.status === 'idle') throw new Error('Matching stopped unexpectedly')
      await sleep(2000)
    }
    throw new Error(
      'Matching is still running on the server — wait a minute, refresh the page, and check Match results.'
    )
  },

  /** Start background matching and poll until complete (up to 20 min). */
  async run(onProgress) {
    const started = await matching.start()
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

  borrower: (id) => request(`/loandisk/borrower/${id}`, { timeout: 60000 }),

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

