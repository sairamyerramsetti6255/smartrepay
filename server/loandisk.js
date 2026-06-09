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
  const criteria = (Array.isArray(searchCriteria) ? searchCriteria : [searchCriteria]).map((c) => ({
    name: String(c.name || c).trim(),
    loanAmount: c.loanAmount ?? '',
    emi: c.emi ?? '',
    branchId: c.branchId ?? '',
  }))

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

/** Parse BorrowerSerch response into normalized borrower rows keyed by search name. */
export function parseBorrowerSearchResults(data, searchNames = []) {
  if (data.code !== undefined && !isSuccessCode(data.code)) {
    throw new Error(data.message || data.title || 'BorrowerSerch failed')
  }

  const bySearchName = new Map()
  const all = []
  const seen = new Set()

  const doc = data.document
  const resultBlocks = Array.isArray(doc) ? doc : doc ? [doc] : []

  for (let i = 0; i < resultBlocks.length; i++) {
    const block = resultBlocks[i]
    const searchName = searchNames[i] || block?.searchName || block?.name || null
    const results = block?.data?.response?.Results ?? block?.response?.Results ?? block?.Results
    const rows = flattenResults(results)

    for (const row of rows) {
      const normalized = normalizeLoanDiskBorrower(row)
      if (!normalized || seen.has(normalized.loandisk_id)) continue
      seen.add(normalized.loandisk_id)
      all.push(normalized)
      if (searchName) {
        const key = String(searchName).toLowerCase().trim()
        if (!bySearchName.has(key)) bySearchName.set(key, [])
        bySearchName.get(key).push(normalized)
      }
    }
  }

  // Flat fallback: single Results array on document
  if (!all.length && doc?.response?.Results) {
    for (const row of flattenResults(doc.response.Results)) {
      const normalized = normalizeLoanDiskBorrower(row)
      if (normalized && !seen.has(normalized.loandisk_id)) {
        seen.add(normalized.loandisk_id)
        all.push(normalized)
      }
    }
  }

  return { borrowers: all, bySearchName, message: data.message || null }
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
