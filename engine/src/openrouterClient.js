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

/** Read an SSE chat stream and concatenate the delta content. */
async function readStreamedContent(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return content
      try {
        const json = JSON.parse(payload)
        content += json?.choices?.[0]?.delta?.content || ''
      } catch {
        // Ignore keep-alive comments / partial frames.
      }
    }
  }
  return content
}

/**
 * Send a chat completion and return the model's parsed JSON object.
 * @param {{system?: string, user: string, model?: string, temperature?: number, maxTokens?: number, retries?: number, nitro?: boolean, stream?: boolean}} opts
 */
export async function chatJson(opts) {
  const {
    system,
    user,
    model = config.openrouter.model,
    temperature = 0,
    maxTokens = config.openrouter.maxTokens,
    retries = config.performance.maxRetries,
    timeoutMs = config.performance.requestTimeoutMs,
    nitro = config.openrouter.nitro,
    stream = config.openrouter.stream,
  } = opts

  if (!isOpenRouterEnabled()) {
    throw new Error('OPENROUTER_API_KEY is not set — AI matching is disabled')
  }

  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: user })

  const payload = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  }
  // Nitro: prefer the fastest providers for this request (OpenRouter routing).
  if (nitro) payload.provider = { sort: 'throughput' }
  if (stream) payload.stream = true

  const body = JSON.stringify(payload)

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
          Accept: stream ? 'text/event-stream' : 'application/json',
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

      const content = stream && res.body
        ? await readStreamedContent(res)
        : (await res.json())?.choices?.[0]?.message?.content || ''

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
