const BUILD_DEFAULTS = {
  apiUrl: import.meta.env.VITE_API_URL || '/api',
  useApi: import.meta.env.VITE_USE_API !== 'false',
  simplifiedApiUrl: import.meta.env.VITE_SIMPLIFIED_API_URL || '/simplified-api',
  appUrl: '',
  appName: 'SmartRepay AI',
}

let cached = null

export function getRuntimeConfig() {
  if (cached) return cached
  cached = { ...BUILD_DEFAULTS }
  return cached
}

export function getApiUrl() {
  return getRuntimeConfig().apiUrl || '/api'
}

export function isApiMode() {
  return getRuntimeConfig().useApi !== false
}

export function getSimplifiedApiUrl() {
  return getRuntimeConfig().simplifiedApiUrl || '/simplified-api'
}

export function getAppUrl() {
  return getRuntimeConfig().appUrl || (typeof window !== 'undefined' ? window.location.origin : '')
}

/** Load /config.json at runtime — edit this file on Coolify without rebuilding. */
export async function loadRuntimeConfig() {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      cached = { ...BUILD_DEFAULTS, ...data }
      return cached
    }
  } catch {
    /* fall through */
  }
  cached = { ...BUILD_DEFAULTS }
  if (!cached.appUrl && typeof window !== 'undefined') {
    cached.appUrl = window.location.origin
  }
  return cached
}
