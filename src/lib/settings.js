import * as api from './api'

const KEY = 'smartrepay_settings'

const defaults = {
  autoApproveThreshold: 80,
  autoEscalateOnBreach: true,
  slaHours: { unmatched: 24, duplicate: 4, partial: 24, suspicious: 72 },
  matchingRules: [
    { id: '1', field: 'full_name', weight: 40, active: true },
    { id: '2', field: 'aliases', weight: 35, active: true },
    { id: '3', field: 'employer', weight: 25, active: true },
  ],
}

let cached = null

export function getSettings() {
  if (cached) return cached
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults }
  } catch {
    return { ...defaults }
  }
}

export async function loadSettingsFromApi() {
  try {
    const data = await api.settings.get()
    cached = { ...defaults, ...data }
    localStorage.setItem(KEY, JSON.stringify(cached))
    return cached
  } catch {
    return getSettings()
  }
}

export function saveSettings(partial) {
  const next = { ...getSettings(), ...partial }
  cached = next
  localStorage.setItem(KEY, JSON.stringify(next))
  api.settings.save(next).catch(() => {})
  return next
}

export function getAutoApproveThreshold() {
  return getSettings().autoApproveThreshold ?? 80
}
