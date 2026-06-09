const BUILD_DEFAULTS = {
  apiUrl: import.meta.env.VITE_API_URL || '/api',
  useApi: import.meta.env.VITE_USE_API !== 'false',
  simplifiedApiUrl: import.meta.env.VITE_SIMPLIFIED_API_URL || '/simplified-api',
  appUrl: '',
  appName: 'SmartRepay AI',
}

let cached = null

function browserOrigin() {
  if (typeof window === 'undefined') return ''
  return window.location.origin.replace(/\/$/, '')
}

/** Turn "/api" or "api" into a full URL using appUrl or current origin. */
function resolveServiceUrl(url, fallbackPath) {
  const raw = (url || fallbackPath || '').trim()
  if (!raw) return fallbackPath
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '')
  const origin = (cached?.appUrl || browserOrigin()).replace(/\/$/, '')
  if (!origin) return raw
  const path = raw.startsWith('/') ? raw : `/${raw}`
  return `${origin}${path}`.replace(/\/$/, '')
}

export function getRuntimeConfig() {
  if (cached) return cached
  cached = { ...BUILD_DEFAULTS }
  return cached
}

export function getApiUrl() {
  return resolveServiceUrl(getRuntimeConfig().apiUrl, '/api')
}

export function isApiMode() {
  return getRuntimeConfig().useApi !== false
}

export function getSimplifiedApiUrl() {
  return resolveServiceUrl(getRuntimeConfig().simplifiedApiUrl, '/simplified-api')
}

export function getAppUrl() {
  const cfg = getRuntimeConfig()
  return (cfg.appUrl || browserOrigin()).replace(/\/$/, '')
}

/** Load /config.json at runtime — edit on server without rebuilding. */
export async function loadRuntimeConfig() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      cached = { ...BUILD_DEFAULTS, ...data }
      if (!cached.appUrl) cached.appUrl = browserOrigin()
      return cached
    }
  } catch {
    /* fall through */
  }
  cached = { ...BUILD_DEFAULTS }
  if (!cached.appUrl) cached.appUrl = browserOrigin()
  return cached
}
