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

  signInWithMicrosoft: (idToken) =>
    request('/auth/microsoft', { method: 'POST', body: JSON.stringify({ idToken }) }),

  microsoftConfig: () => request('/auth/microsoft/config'),

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

  repayments: (loanNumber) =>

    request(`/loans/${encodeURIComponent(loanNumber)}/repayments`),

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

  remove: (id) => request(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),

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

  syncSql: () => request('/loandisk/sync-sql', { method: 'POST', body: '{}', timeout: 30000 }),

  syncSqlStatus: () => request('/loandisk/sync-sql/status', { timeout: 30000 }),

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

  matchingRules: {
    get: () => request('/settings/matching-rules'),
    save: (rules) => request('/settings/matching-rules', { method: 'PUT', body: JSON.stringify({ rules }) }),
    preview: (body) => request('/settings/matching-rules/preview', { method: 'POST', body: JSON.stringify(body) }),
  },

}



export const demo = {

  seed: () => request('/demo/seed', { method: 'POST', body: '{}' }),

  counts: () => request('/transactions/counts'),

}



export const ingest = {

  async parse(file, { documentType, fileParticulars } = {}) {

    const form = new FormData()

    form.append('file', file)
    if (documentType) form.append('documentType', documentType)
    if (fileParticulars) form.append('fileParticulars', fileParticulars)

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

  import: (parseIdOrIds) => {
    const parseIds = Array.isArray(parseIdOrIds) ? parseIdOrIds : [parseIdOrIds]
    return request('/ingest/import', { method: 'POST', body: JSON.stringify({ parseIds }) })
  },

  async parseBatch(files, { documentType, fileParticulars } = {}) {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    if (documentType) form.append('documentType', documentType)
    if (fileParticulars) form.append('fileParticulars', fileParticulars)

    const token = getToken()
    const res = await fetch(`${getApiUrl()}/ingest/parse-batch`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`)
    return data
  },

}



export const activeLoans = {

  list: (search) =>
    request(`/active-loans${search ? `?search=${encodeURIComponent(search)}` : ''}`),

  get: (loanNumber) => request(`/active-loans/${encodeURIComponent(loanNumber)}`),

}



export const bankTransactions = {

  list: (search) =>

    request(`/bank-transactions${search ? `?search=${encodeURIComponent(search)}` : ''}`),

}



export const staging = {

  summary: () => request('/staging/summary'),

}



export const dashboard = {

  stats: () => request('/dashboard/stats'),

}



export const sqlMatch = {

  results: (search) =>

    request(`/sql/match-results${search ? `?search=${encodeURIComponent(search)}` : ''}`),

  updateReview: (bankTxId, body) =>

    request(`/sql/match-results/${bankTxId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  run: (useAi = true, fileNames = null) =>

    request('/sql/match/run', { method: 'POST', body: JSON.stringify({ useAi, fileNames }) }),

  status: () => request('/sql/match/status'),

}



export const receipts = {
  searchBorrowers: (search) =>
    request(`/receipts/borrowers?search=${encodeURIComponent(search)}`),

  loans: (borrowerId) => request(`/receipts/loans/${encodeURIComponent(borrowerId)}`),

  list: () => request('/receipts'),

  create: async (payload, file) => {
    const form = new FormData()
    Object.entries(payload).forEach(([k, v]) => {
      if (v != null && v !== '') form.append(k, String(v))
    })
    if (file) form.append('receipt', file)

    const token = getToken()
    const res = await fetch(`${getApiUrl()}/receipts`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || res.statusText || 'Could not save receipt')
    return data
  },

  update: async (id, payload, file) => {
    const form = new FormData()
    Object.entries(payload).forEach(([k, v]) => {
      if (v != null && v !== '') form.append(k, String(v))
    })
    if (file) form.append('receipt', file)

    const token = getToken()
    const res = await fetch(`${getApiUrl()}/receipts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || res.statusText || 'Could not update receipt')
    return data
  },

  remove: (id) =>
    request(`/receipts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

export const crif = {
  parseBorrowerIds: async (file) => {
    const form = new FormData()
    form.append('file', file)

    const token = getToken()
    const res = await fetch(`${getApiUrl()}/crif/parse-borrower-ids`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || res.statusText || 'Could not parse borrower file')
    return data
  },

  pullBorrowerFromMonthlyBull: async ({ branchIDs, performMigration, file }) => {
    const form = new FormData()
    if (branchIDs) form.append('branchIDs', branchIDs)
    form.append('performMigration', performMigration ? 'true' : 'false')
    if (file) form.append('file', file)

    const token = getToken()
    const res = await fetch(`${getApiUrl()}/crif/pull-borrower-from-monthly-bull`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || res.statusText || 'Pull request failed')
    return data
  },

  /** Excel → LoanDisk API → NodeCRIF_SubjectData / NodeCRIF_ContractData */
  syncFromLoandisk: async ({ branchIDs, file, borrowerIDs }) => {
    const form = new FormData()
    if (branchIDs) form.append('branchIDs', branchIDs)
    if (borrowerIDs) form.append('borrowerIDs', borrowerIDs)
    if (file) form.append('file', file)

    const token = getToken()
    const res = await fetch(`${getApiUrl()}/crif/sync-from-loandisk`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      // Large Excel files can take several minutes (LoanDisk per-borrower)
      signal: AbortSignal.timeout(600_000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || res.statusText || 'LoanDisk sync failed')
    return data
  },

  syncStatus: () => request('/crif/sync-status', { timeout: 120000 }),

  universalSync: (body = {}) =>
    request('/crif/sync', {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: 300000,
    }),

  migrationLogs: (params = {}) => {
    const qs = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value != null && value !== '') qs.set(key, String(value))
    })
    const query = qs.toString()
    return request(`/crif/migration-logs${query ? `?${query}` : ''}`)
  },

  migrationFailedRecords: (params = {}) => {
    const qs = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value != null && value !== '') qs.set(key, String(value))
    })
    const query = qs.toString()
    return request(`/crif/migration-failed-records${query ? `?${query}` : ''}`, { timeout: 120000 })
  },

  nodeData: (params = {}) => {
    const qs = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value != null && value !== '') qs.set(key, String(value))
    })
    const query = qs.toString()
    return request(`/crif/node-data${query ? `?${query}` : ''}`, { timeout: 120000 })
  },

  generateFile: (body) =>
    request('/crif/generate-file', {
      method: 'POST',
      body: JSON.stringify(body),
      timeout: 300000,
    }),

  /** Download generated CRIF file via our API proxy (forces local save). */
  downloadGeneratedFile: async (fileUrl) => {
    const token = getToken()
    const qs = new URLSearchParams({ url: fileUrl })
    const res = await fetch(`${getApiUrl()}/crif/download-file?${qs}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || res.statusText || 'Download failed')
    }

    const disposition = res.headers.get('Content-Disposition') || ''
    const match = disposition.match(/filename="([^"]+)"/i)
    const fileName = match?.[1] || String(fileUrl).split('/').pop()?.split('?')[0] || 'CRIF_File.txt'
    const blob = await res.blob()
    return { blob, fileName }
  },
}

// ---------------------------------------------------------------------------
// QuickBooks Data module API client
// ---------------------------------------------------------------------------

export const quickbooks = {
  summary: () => request('/quickbooks/summary'),

  library: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return request(`/quickbooks/library${q ? `?${q}` : ''}`)
  },

  libraryItem: (id) => request(`/quickbooks/library/${id}`),

  importSmartRepay: (limit = 100) =>
    request('/quickbooks/import/smartrepay', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),

  importText: (text, context = {}) =>
    request('/quickbooks/import/text', {
      method: 'POST',
      body: JSON.stringify({ text, ...context }),
    }),

  async importFiles(files, context = {}) {
    const form = new FormData()
    for (const file of files) form.append('files', file)
    Object.entries(context).forEach(([k, v]) => { if (v != null) form.append(k, String(v)) })
    const token = getToken()
    const res = await fetch(`${getApiUrl()}/quickbooks/import/files`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`)
    return data
  },

  transactions: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return request(`/quickbooks/transactions${q ? `?${q}` : ''}`)
  },

  transaction: (id) => request(`/quickbooks/transactions/${id}`),

  validate: (id) => request(`/quickbooks/transactions/${id}/validate`, { method: 'POST', body: '{}' }),

  approve: (id) => request(`/quickbooks/transactions/${id}/approve`, { method: 'POST', body: '{}' }),

  approveAll: (templateType = 'emi_receipt') =>
    request('/quickbooks/approve-all', {
      method: 'POST',
      body: JSON.stringify({ templateType }),
    }),

  reject: (id, reason = '') =>
    request(`/quickbooks/transactions/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  emiReceipts: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return request(`/quickbooks/emi-receipts${q ? `?${q}` : ''}`)
  },

  paymentsDisbursed: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return request(`/quickbooks/payments-disbursed${q ? `?${q}` : ''}`)
  },

  createTransaction: (data) =>
    request('/quickbooks/transactions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateTransaction: (id, data) =>
    request(`/quickbooks/transactions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteTransaction: (id) =>
    request(`/quickbooks/transactions/${id}`, {
      method: 'DELETE',
    }),

  accounts: () => request('/quickbooks/accounts'),

  createAccount: (data) =>
    request('/quickbooks/accounts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateAccount: (id, data) =>
    request(`/quickbooks/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteAccount: (id) =>
    request(`/quickbooks/accounts/${id}`, {
      method: 'DELETE',
    }),

  exceptions: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return request(`/quickbooks/exceptions${q ? `?${q}` : ''}`)
  },

  preview: () => request('/quickbooks/preview'),

  export: (format = 'json') =>
    request('/quickbooks/export', {
      method: 'POST',
      body: JSON.stringify({ format }),
    }),

  exports: () => request('/quickbooks/exports'),

  exportById: (id) => request(`/quickbooks/exports/${id}`),
}
