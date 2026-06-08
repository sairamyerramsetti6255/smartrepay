import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

export const supabaseConfigError = !supabaseUrl || !supabaseAnonKey
  ? 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env — restart the dev server after editing.'
  : null

if (supabaseConfigError) {
  console.error('[SmartRepay]', supabaseConfigError)
}

export const supabase = createClient(supabaseUrl || 'http://localhost', supabaseAnonKey || 'missing-key', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

export async function checkSupabaseConnection() {
  if (supabaseConfigError) return { ok: false, error: supabaseConfigError }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: supabaseAnonKey },
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, error: `Supabase returned HTTP ${res.status}` }
    return { ok: true, error: null }
  } catch (e) {
    const msg = e?.name === 'AbortError'
      ? 'Connection timed out — Supabase host is unreachable.'
      : e?.message || 'Network error'
    return {
      ok: false,
      error: `${msg} Check internet, DNS, VPN, firewall, or ad-blockers blocking *.supabase.co`,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function clearSupabaseSession() {
  const ref = supabaseUrl?.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]
  if (ref) localStorage.removeItem(`sb-${ref}-auth-token`)
}
