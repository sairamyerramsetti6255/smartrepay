import { config } from './config.js'

/**
 * Shared LoanDisk HTTP client.
 *
 * The original C# created a `new HttpClient()` for every single request
 * (SendLoandiskPostRequestAsync) which exhausts sockets and pays a TLS
 * handshake per call. Node's global `fetch` (undici) keeps connections alive
 * and pools them per origin automatically, so a single shared helper here is
 * enough to reuse sockets across thousands of calls.
 */

const { baseUrl, publicKey, authToken } = config.loandisk
const { requestTimeoutMs, maxRetries } = config.performance

const baseHeaders = {
  Authorization: `Basic ${authToken}`,
  Accept: 'application/json',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isTransient(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

/** Build a branch-scoped LoanDisk URL: {base}/{publicKey}/{branchId}/{path} */
export function branchUrl(branchId, path) {
  return `${baseUrl}/${publicKey}/${branchId}/${path.replace(/^\/+/, '')}`
}

/**
 * Perform a LoanDisk request with timeout, retry and JSON parsing.
 * Returns parsed JSON, or null when `allowEmpty` and the resource is missing.
 */
export async function loandiskRequest(url, { method = 'GET', body = null, allowEmpty = false, timeoutMs } = {}) {
  let lastError
  const effectiveTimeout = timeoutMs || requestTimeoutMs

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), effectiveTimeout)

    try {
      const init = { method, headers: { ...baseHeaders }, signal: controller.signal }
      if (body != null) {
        init.headers['Content-Type'] = 'application/json'
        init.body = typeof body === 'string' ? body : JSON.stringify(body)
      }

      const res = await fetch(url, init)

      if (!res.ok) {
        if (allowEmpty && (res.status === 404 || res.status === 204)) return null
        if (isTransient(res.status) && attempt < maxRetries) {
          lastError = new Error(`HTTP ${res.status} from ${url}`)
          await sleep(250 * 2 ** attempt)
          continue
        }
        throw new Error(`LoanDisk request failed: HTTP ${res.status} from ${url}`)
      }

      const text = await res.text()
      if (!text) return allowEmpty ? null : {}

      const data = JSON.parse(text)

      // LoanDisk returns HTTP 200 even for failures, with an { error: {...} }
      // envelope. Without this check those failures look like "empty results"
      // and get silently swallowed (the original 0-borrowers-no-errors bug).
      if (data && data.error && (data.error.message || data.error.code)) {
        const err = new Error(`LoanDisk API error ${data.error.code ?? ''}: ${data.error.message ?? 'unknown'} (${url})`)
        err.loandiskCode = data.error.code
        throw err
      }

      return data
    } catch (e) {
      lastError = e
      const retryable = e.name === 'AbortError' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || /fetch failed/i.test(e.message)
      if (retryable && attempt < maxRetries) {
        await sleep(250 * 2 ** attempt)
        continue
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError || new Error(`LoanDisk request failed: ${url}`)
}
