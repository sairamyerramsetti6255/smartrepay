const API_BASE = process.env.LOANDISK_API_URL || 'https://simplifiedapi.meanhost.in/v1/api'
const FETCH_TIMEOUT_MS = Number(process.env.LOANDISK_FETCH_TIMEOUT_MS) || 180_000

let cachedToken = null
let tokenExpiresAt = 0

function isSuccessCode(code) {
  return code === 1 || code === 'SUCCESS' || code === 'success'
}

function pickField(row, ...keys) {
  for (const key of keys) {
    const val = row?.[key]
    if (val !== undefined && val !== null && String(val).trim() !== '') return val
  }
  return null
}

export function getBorrowerRowId(row) {
  const id = pickField(row, 'borrower_id', 'BorrowerId', 'borrowerId', 'Borrower_Id', 'Id', 'id')
  return id != null ? String(id) : null
}

function flattenResults(results) {
  if (!Array.isArray(results)) return []
  return results.flatMap((chunk) => (Array.isArray(chunk) ? chunk : [chunk])).filter((b) => b && typeof b === 'object')
}

/** Parse GetAllBorrowers payload — document is an array of branches. */
export function parseBorrowerApiPayload(data) {
  if (data.code !== undefined && !isSuccessCode(data.code)) {
    throw new Error(data.message || data.title || 'LoanDisk GetAllBorrowers failed')
  }

  const doc = data.document
  const rows = []
  let branches = 0
  let totalReported = 0

  if (Array.isArray(doc)) {
    for (const item of doc) {
      const branchResults = item?.data?.response?.Results
      if (branchResults) {
        branches++
        totalReported += Number(item.data.response.TotalResults) || 0
        for (const row of flattenResults(branchResults)) {
          rows.push({
            ...row,
            _branchId: item.branchId || null,
            _branchName: item.branchName || null,
          })
        }
        continue
      }

      if (item?.response?.Results) {
        branches++
        totalReported += Number(item.response.TotalResults) || 0
        for (const row of flattenResults(item.response.Results)) {
          rows.push(row)
        }
        continue
      }

      if (getBorrowerRowId(item)) {
        rows.push(item)
      }
    }
  } else if (doc?.response?.Results) {
    rows.push(...flattenResults(doc.response.Results))
    totalReported = Number(doc.response.TotalResults) || rows.length
  }

  return { rows, branches, totalReported, message: data.message || null }
}

export async function getLoanDiskToken() {
  if (process.env.LOANDISK_ACCESS_TOKEN) return process.env.LOANDISK_ACCESS_TOKEN
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken

  const res = await fetch(`${API_BASE}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Username: process.env.LOANDISK_USERNAME || 'api_admin',
      Password: process.env.LOANDISK_PASSWORD || 'api_admin@2024',
    }),
    signal: AbortSignal.timeout(30_000),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.document?.AccessToken) {
    throw new Error(data.message || data.title || 'LoanDisk token request failed')
  }

  cachedToken = data.document.AccessToken
  tokenExpiresAt = data.document.ValidTo ? new Date(data.document.ValidTo).getTime() : Date.now() + 7 * 86400000
  return cachedToken
}

export async function fetchGetAllBorrowersRaw() {
  const token = await getLoanDiskToken()
  const res = await fetch(`${API_BASE}/SP/GetAllBorrowers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || data.title || `GetAllBorrowers HTTP ${res.status}`)
  return data
}

export function normalizeLoanDiskBorrower(row) {
  const loandisk_id = getBorrowerRowId(row)
  if (!loandisk_id) return null

  const first = String(pickField(row, 'borrower_firstname', 'BorrowerFirstname', 'firstName') || '').trim()
  const last = String(pickField(row, 'borrower_lastname', 'BorrowerLastname', 'lastName') || '').trim()
  const business = String(pickField(row, 'borrower_business_name', 'BorrowerBusinessName') || '').trim()
  const full_name = business || `${first} ${last}`.trim() || `Borrower ${loandisk_id}`
  const employer = String(
    pickField(row, 'custom_field_8239', 'borrower_working_status', 'employer', 'Employer') || ''
  ).trim()
  const email = pickField(row, 'borrower_email', 'BorrowerEmail', 'email')
  const mobile = pickField(row, 'borrower_mobile', 'BorrowerMobile', 'mobile')
  const unique_number = pickField(row, 'borrower_unique_number', 'BorrowerUniqueNumber', 'uniqueNumber')
  const aliases = [email, mobile, unique_number, first && last ? `${first} ${last}` : null]
    .filter(Boolean)
    .map(String)

  return {
    loandisk_id,
    first_name: first || null,
    last_name: last || null,
    full_name,
    employer: employer || null,
    branch_id: row._branchId ? String(row._branchId) : null,
    branch_name: row._branchName ? String(row._branchName) : null,
    aliases,
    email: email ? String(email) : null,
    mobile: mobile ? String(mobile) : null,
    unique_number: unique_number ? String(unique_number) : null,
  }
}

export function normalizeBorrowersFromPayload(data) {
  const { rows, branches, totalReported, message } = parseBorrowerApiPayload(data)
  const all = []
  const seen = new Set()

  for (const row of rows) {
    const normalized = normalizeLoanDiskBorrower(row)
    if (normalized && !seen.has(normalized.loandisk_id)) {
      all.push(normalized)
      seen.add(normalized.loandisk_id)
    }
  }

  if (!all.length) {
    throw new Error('GetAllBorrowers returned no borrower records — check API response structure')
  }

  return {
    borrowers: all,
    total: all.length,
    totalReported,
    branches,
    message,
    source: 'GetAllBorrowers',
  }
}

export async function fetchAllBorrowers() {
  const data = await fetchGetAllBorrowersRaw()
  return {
    ...normalizeBorrowersFromPayload(data),
    orgId: process.env.LOANDISK_BORROWER_ID || '4617884',
  }
}

/** POST /SP/BorrowerSerch — search by name(s) for matching. */
export async function borrowerSearch(searchCriteria) {
  const token = await getLoanDiskToken()
  const criteria = (Array.isArray(searchCriteria) ? searchCriteria : [searchCriteria])
    .map((c) => ({
      name: String(c.name || c).trim(),
      loanAmount: c.loanAmount ?? '',
      emi: c.emi ?? '',
      branchId: c.branchId ?? '',
    }))
    .filter((c) => c.name.length > 0)

  if (!criteria.length) throw new Error('BorrowerSerch requires at least one name')

  const res = await fetch(`${API_BASE}/SP/BorrowerSerch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ searchCriteria: criteria }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || data.title || `BorrowerSerch HTTP ${res.status}`)
  return data
}

/** First token of payer name — API expects names like "Kevin", "Godfrey". */
export function borrowerSearchTerm(payer) {
  const parts = String(payer || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!parts.length) return ''
  const first = parts[0]
  if (first.length <= 2 && parts.length > 1) {
    return parts.slice(0, 2).join(' ')
  }
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

function registerSearchBorrower(normalized, searchName, ctx) {
  if (!normalized) return
  const { all, seen, bySearchName } = ctx
  if (!seen.has(normalized.loandisk_id)) {
    seen.add(normalized.loandisk_id)
    all.push(normalized)
  }
  if (!searchName) return
  const key = String(searchName).toLowerCase().trim()
  if (!bySearchName.has(key)) bySearchName.set(key, [])
  const list = bySearchName.get(key)
  if (!list.some((b) => b.loandisk_id === normalized.loandisk_id)) {
    list.push(normalized)
  }
}

function ingestSearchRows(rows, searchName, ctx) {
  if (rows == null) return
  for (const row of flattenResults(rows)) {
    registerSearchBorrower(normalizeLoanDiskBorrower(row), searchName, ctx)
  }
}

/** Parse BorrowerSerch response into normalized borrower rows keyed by search name. */
export function parseBorrowerSearchResults(data, searchNames = []) {
  if (data.code !== undefined && !isSuccessCode(data.code)) {
    throw new Error(data.message || data.title || 'BorrowerSerch failed')
  }

  const ctx = { all: [], seen: new Set(), bySearchName: new Map() }
  const doc = data.document

  // Shape A: document.response.Results[i] — one result set per searchCriteria entry
  const parallelResults = doc?.response?.Results ?? doc?.data?.response?.Results
  if (Array.isArray(parallelResults) && parallelResults.length) {
    for (let i = 0; i < parallelResults.length; i++) {
      const searchName = searchNames[i] || null
      const chunk = parallelResults[i]
      if (Array.isArray(chunk)) {
        ingestSearchRows(chunk, searchName, ctx)
      } else if (chunk && typeof chunk === 'object') {
        ingestSearchRows(chunk?.data?.response?.Results ?? chunk?.response?.Results ?? chunk?.Results ?? [chunk], searchName, ctx)
      }
    }
  }

  // Shape B: document[] — one block per criteria
  if (Array.isArray(doc)) {
    for (let i = 0; i < doc.length; i++) {
      const block = doc[i]
      const searchName =
        searchNames[i] ||
        block?.searchName ||
        block?.name ||
        block?.searchCriteria?.name ||
        block?.criteria?.name ||
        null
      const results = block?.data?.response?.Results ?? block?.response?.Results ?? block?.Results
      if (results) ingestSearchRows(results, searchName, ctx)
      else if (getBorrowerRowId(block)) registerSearchBorrower(normalizeLoanDiskBorrower(block), searchName, ctx)
    }
  }

  // Shape C: single object with nested Results
  if (!ctx.all.length && doc && !Array.isArray(doc)) {
    const results = doc?.data?.response?.Results ?? doc?.response?.Results ?? doc?.Results
    if (results) ingestSearchRows(results, searchNames[0] || null, ctx)
    else if (getBorrowerRowId(doc)) registerSearchBorrower(normalizeLoanDiskBorrower(doc), searchNames[0] || null, ctx)
  }

  // Shape D: top-level Results (some gateways)
  if (!ctx.all.length && Array.isArray(data.Results)) {
    ingestSearchRows(data.Results, searchNames[0] || null, ctx)
  }

  // If we got borrowers but no per-name map, attach pool to every search term
  if (ctx.all.length && !ctx.bySearchName.size && searchNames.length) {
    for (const name of searchNames) {
      const key = String(name).toLowerCase().trim()
      ctx.bySearchName.set(key, [...ctx.all])
    }
  }

  return { borrowers: ctx.all, bySearchName: ctx.bySearchName, message: data.message || null }
}

/** Build deduped BorrowerSerch criteria + map search term → payer keys. */
export function buildPayerSearchPlan(payerNames) {
  const termToPayers = new Map()
  const orderedTerms = []

  for (const raw of payerNames) {
    const payer = String(raw || '').trim()
    if (!payer) continue
    const payerKey = payer.toLowerCase()
    const terms = new Set([payer, borrowerSearchTerm(payer)].filter(Boolean))

    for (const term of terms) {
      const termKey = term.toLowerCase().trim()
      if (!termToPayers.has(termKey)) {
        termToPayers.set(termKey, new Set())
        orderedTerms.push(term)
      }
      termToPayers.get(termKey).add(payerKey)
    }
  }

  return { orderedTerms, termToPayers }
}

const SEARCH_BATCH_SIZE = 25

/** Bulk BorrowerSerch for many payers; returns candidate pool + per-payer lists. */
export async function fetchBorrowersForPayers(payerNames) {
  const { orderedTerms, termToPayers } = buildPayerSearchPlan(payerNames)
  const apiPool = []
  const byPayer = new Map()
  const seen = new Set()
  let batches = 0

  for (let i = 0; i < orderedTerms.length; i += SEARCH_BATCH_SIZE) {
    const batch = orderedTerms.slice(i, i + SEARCH_BATCH_SIZE)
    const criteria = batch.map((name) => ({ name, loanAmount: '', emi: '', branchId: '' }))
    const data = await borrowerSearch(criteria)
    const { borrowers, bySearchName } = parseBorrowerSearchResults(data, batch)
    batches++

    for (const b of borrowers) {
      if (!seen.has(b.loandisk_id)) {
        seen.add(b.loandisk_id)
        apiPool.push(b)
      }
    }

    for (const term of batch) {
      const termKey = term.toLowerCase().trim()
      const candidates = bySearchName.get(termKey) || []
      const payerKeys = termToPayers.get(termKey) || new Set()
      for (const payerKey of payerKeys) {
        if (!byPayer.has(payerKey)) byPayer.set(payerKey, [])
        const list = byPayer.get(payerKey)
        for (const b of candidates) {
          if (!list.some((x) => x.loandisk_id === b.loandisk_id)) list.push(b)
        }
      }
    }
  }

  return { apiPool, byPayer, batches, termsSearched: orderedTerms.length }
}

/** GET /SP/Loandisk_OperationsNewForId?borrowerId= — single borrower detail. */
export async function fetchBorrowerById(borrowerId) {
  const token = await getLoanDiskToken()
  const id = String(borrowerId).trim()
  const res = await fetch(`${API_BASE}/SP/Loandisk_OperationsNewForId?borrowerId=${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || data.title || `OperationsNewForId HTTP ${res.status}`)
  if (data.code !== undefined && !isSuccessCode(data.code)) {
    throw new Error(data.message || data.title || 'Borrower lookup failed')
  }

  const doc = data.document
  const row = Array.isArray(doc) ? doc[0] : doc?.response?.Results?.[0]?.[0] ?? doc
  const normalized = normalizeLoanDiskBorrower(row?.borrower_id ? row : { ...row, borrower_id: id })
  return { raw: data, borrower: normalized }
}

export const fetchLoanDiskBorrowers = fetchAllBorrowers
