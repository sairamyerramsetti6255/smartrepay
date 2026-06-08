const API_URL = import.meta.env.VITE_API_URL || '/api'

export const isApiMode = () => import.meta.env.VITE_USE_API !== 'false'

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
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 30000)

  try {
    const res = await fetch(`${API_URL}${path}`, { ...options, headers, signal: controller.signal })
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
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`${API_URL}/health`, { signal: controller.signal })
    clearTimeout(t)
    if (!res.ok) return { ok: false, error: `API returned ${res.status}` }
    return { ok: true, error: null }
  } catch (e) {
    return {
      ok: false,
      error: e?.name === 'AbortError'
        ? 'API timed out — run: npm run dev:server'
        : `Cannot reach API at ${API_URL}. Start the backend with npm run dev`,
    }
  }
}

// Auth
export const auth = {
  signIn: (email, password) => request('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password }) }),
  signUp: (email, password, role) =>
    request('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, role }) }),
  me: () => request('/auth/me'),
}

// Data
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

export const matching = {
  run: () => request('/matching/run', { method: 'POST', body: '{}', timeout: 120000 }),
}

export const loandisk = {
  status: () => request('/loandisk/status'),
  token: () => request('/loandisk/token'),
  sync: () => request('/loandisk/sync', { method: 'POST', body: '{}', timeout: 180000 }),
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
    const res = await fetch(`${API_URL}/ingest/parse`, {
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
