import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount) {
  const n = Number(amount ?? 0)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

/** Parse API/SQLite date strings without producing Invalid Date. */
export function parseDateInput(date) {
  if (date == null || date === '') return null
  if (date instanceof Date) return Number.isNaN(date.getTime()) ? null : date

  const raw = String(date).trim()
  if (!raw) return null

  // SQLite datetime: "2024-06-09 13:11:33"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) {
    const d = new Date(raw.replace(' ', 'T'))
    if (!Number.isNaN(d.getTime())) return d
  }

  // Date-only: "2024-06-09"
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00`)
    if (!Number.isNaN(d.getTime())) return d
  }

  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDate(date) {
  const d = parseDateInput(date)
  if (!d) return '—'
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatDateTime(date) {
  const d = parseDateInput(date)
  if (!d) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function firstName(email) {
  if (!email) return 'there'
  const part = email.split('@')[0].split('.')[0]
  return part.charAt(0).toUpperCase() + part.slice(1)
}

export function toUuidOrNull(value) {
  if (value == null || value === '') return null
  return value
}

export function sanitizeTxUpdate(payload) {
  if (!payload) return payload
  const out = { ...payload }
  if ('matched_borrower_id' in out) out.matched_borrower_id = toUuidOrNull(out.matched_borrower_id)
  if ('loan_id' in out) out.loan_id = toUuidOrNull(out.loan_id)
  return out
}
