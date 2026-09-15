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
 *
 * `maxRetries` can be overridden per-call (e.g. 0 for search-page fetches where
 * the caller's own retry loop handles failures — avoids compounding 4 × 180s waits).
 */
export async function loandiskRequest(url, { method = 'GET', body = null, allowEmpty = false, timeoutMs, signal: externalSignal, maxRetries: callMaxRetries } = {}) {
  let lastError
  const effectiveTimeout = timeoutMs || requestTimeoutMs
  const effectiveMaxRetries = callMaxRetries !== undefined ? Math.max(0, Number(callMaxRetries)) : maxRetries

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    // If global user cancel fired, stop immediately
    if (externalSignal?.aborted) throw new DOMException('Sync cancelled by user', 'AbortError')

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { controller.abort('timeout') } catch {}
    }, effectiveTimeout)

    const onExternalAbort = () => {
      try { controller.abort(externalSignal.reason || 'user_cancel') } catch {}
    }

    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer)
        throw new DOMException('Sync cancelled by user', 'AbortError')
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      const init = { method, headers: { ...baseHeaders }, signal: controller.signal }
      if (body != null) {
        init.headers['Content-Type'] = 'application/json'
        init.body = typeof body === 'string' ? body : JSON.stringify(body)
      }

      const res = await fetch(url, init)

      if (!res.ok) {
        if (allowEmpty && (res.status === 404 || res.status === 204)) return null
        if (isTransient(res.status) && attempt < effectiveMaxRetries) {
          lastError = new Error(`HTTP ${res.status} from ${url}`)
          await sleep(500 * (attempt + 1))
          continue
        }
        throw new Error(`LoanDisk request failed: HTTP ${res.status} from ${url}`)
      }

      const text = await res.text()
      if (!text) return allowEmpty ? null : {}

      const data = JSON.parse(text)

      if (data && data.error && (data.error.message || data.error.code)) {
        const err = new Error(`LoanDisk API error ${data.error.code ?? ''}: ${data.error.message ?? 'unknown'} (${url})`)
        err.loandiskCode = data.error.code
        throw err
      }

      return data
    } catch (e) {
      // If the user cancelled, propagate AbortError immediately without retry
      if (externalSignal?.aborted) {
        throw new DOMException('Sync cancelled by user', 'AbortError')
      }

      // Check if this was an internal timeout
      if (timedOut || e.name === 'AbortError' || e.code === 'ETIMEDOUT') {
        const timeoutErr = new Error(`LoanDisk request timed out after ${effectiveTimeout}ms (${url})`)
        timeoutErr.isTimeout = true
        lastError = timeoutErr
        if (attempt < effectiveMaxRetries) {
          await sleep(1000 * (attempt + 1))
          continue
        }
        throw timeoutErr
      }

      lastError = e
      const retryable = e.code === 'ECONNRESET' || /fetch failed/i.test(e.message)
      if (retryable && attempt < effectiveMaxRetries) {
        await sleep(1000 * (attempt + 1))
        continue
      }
      throw e
    } finally {
      clearTimeout(timer)
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort)
      }
    }
  }

  throw lastError || new Error(`LoanDisk request failed: ${url}`)
}
