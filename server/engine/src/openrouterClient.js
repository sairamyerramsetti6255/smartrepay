import { config } from './config.js'

/**
 * Minimal OpenRouter chat client used for AI-assisted reconciliation.
 *
 * Uses the global fetch (Node >= 18). Returns parsed JSON from the model,
 * tolerating ```json fences and leading/trailing prose. Retries transient
 * failures (429 / 5xx / network) with exponential backoff.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'

export function isOpenRouterEnabled() {
  return Boolean(config.openrouter.apiKey)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Pull the first balanced JSON object out of an LLM response. */
export function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Send a chat completion and return the model's parsed JSON object.
 * @param {{system?: string, user: string, model?: string, temperature?: number, maxTokens?: number, retries?: number}} opts
 */
export async function chatJson(opts) {
  const {
    system,
    user,
    model = config.openrouter.model,
    temperature = 0,
    maxTokens = 700,
    retries = config.performance.maxRetries,
    timeoutMs = config.performance.requestTimeoutMs,
  } = opts

  if (!isOpenRouterEnabled()) {
    throw new Error('OPENROUTER_API_KEY is not set — AI matching is disabled')
  }

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: user })

  const body = JSON.stringify({
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  })

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': config.openrouter.siteUrl,
          'X-Title': config.openrouter.appName,
        },
        body,
        signal: controller.signal,
      })

      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`OpenRouter HTTP ${res.status}`)
        // Honor Retry-After (seconds) when the provider sends it, else backoff.
        const retryAfter = Number(res.headers.get('retry-after'))
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** attempt
        await sleep(Math.min(wait, 15_000))
        continue
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`OpenRouter HTTP ${res.status}: ${txt.slice(0, 200)}`)
      }

      const data = await res.json()
      const content = data?.choices?.[0]?.message?.content || ''
      const parsed = extractJson(content)
      if (!parsed) {
        lastErr = new Error('OpenRouter returned non-JSON content')
        await sleep(400 * 2 ** attempt)
        continue
      }
      return parsed
    } catch (e) {
      lastErr = e
      if (attempt < retries) await sleep(500 * 2 ** attempt)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr || new Error('OpenRouter request failed')
}
