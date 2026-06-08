export function getSlaBucket(createdAt, slaHours = 24) {
  const created = new Date(createdAt)
  const hoursElapsed = (Date.now() - created.getTime()) / (1000 * 60 * 60)
  const pct = (hoursElapsed / slaHours) * 100

  if (pct > 100) return { bucket: 'breached', label: 'Breached', pct, hoursElapsed, className: 'badge-breached' }
  if (pct >= 70) return { bucket: 'at_risk', label: 'At Risk', pct, hoursElapsed, className: 'badge-exception' }
  return { bucket: 'on_track', label: 'On Track', pct, hoursElapsed, className: 'badge-matched' }
}

export function formatAge(createdAt) {
  const hours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60)
  if (hours < 1) return `${Math.floor(hours * 60)}m`
  const h = Math.floor(hours)
  const m = Math.floor((hours - h) * 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export function aggregateSlaBuckets(exceptions) {
  const counts = { on_track: 0, at_risk: 0, breached: 0 }
  for (const ex of exceptions) {
    if (ex.status !== 'open') continue
    const { bucket } = getSlaBucket(ex.created_at, ex.sla_hours ?? 24)
    counts[bucket]++
  }
  return counts
}
