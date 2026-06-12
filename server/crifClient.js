import { getLoanDiskToken } from './loandisk.js'

/**
 * HTTP client for the dbo.CRIF_Operations stored procedure, called through the
 * meanhost API gateway (POST /SP/CRIF_Operations) instead of a direct mssql
 * connection.
 *
 * WHY: the deployment host (Coolify) cannot open a TCP connection to the SQL
 * Server (it is firewalled to specific IPs), but the meanhost API CAN reach the
 * same database. Routing every CRIF call over HTTPS removes the need for the app
 * server to ever talk to port 1433/9933 directly.
 *
 * Contract (verified live):
 *   request  : { Json: "<stringified json>", Condition: "<name>", Type: "" }
 *   response : { code: "SUCCESS", document: "{\"Table\":[ ...rows... ]}" }
 * The `document` is itself a JSON string; its `.Table` array is the recordset
 * (equivalent to mssql's `result.recordset`).
 */
const API_BASE = (process.env.LOANDISK_API_URL || 'https://simplifiedapi.meanhost.in/v1/api').replace(/\/+$/, '')
const CRIF_TIMEOUT_MS = Number(process.env.CRIF_TIMEOUT_MS) || 120_000

function isSuccess(code) {
  return code === undefined || code === 'SUCCESS' || code === 'success' || code === 1
}

/**
 * Execute a CRIF_Operations condition and return its recordset (array of rows).
 * @param {object|array|string} json  payload (object/array is stringified)
 * @param {string} condition          condition selector (e.g. 'Get_Documents')
 * @param {string} [type]
 * @returns {Promise<object[]>}
 */
export async function crif(json, condition, type = '') {
  const token = await getLoanDiskToken()
  const payload = typeof json === 'string' ? json : JSON.stringify(json ?? {})

  const res = await fetch(`${API_BASE}/SP/CRIF_Operations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Json: payload, Condition: condition, Type: type }),
    signal: AbortSignal.timeout(CRIF_TIMEOUT_MS),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.message || data.title || `CRIF ${condition} HTTP ${res.status}`)
  if (!isSuccess(data.code)) throw new Error(data.message || `CRIF ${condition} failed`)

  let table = []
  try {
    const doc = typeof data.document === 'string' ? JSON.parse(data.document) : data.document
    table = doc?.Table ?? []
  } catch {
    table = []
  }
  return Array.isArray(table) ? table : []
}
