import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount) {
  const n = Number(amount ?? 0)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

export function formatDate(date) {
  if (!date) return '—'
  return new Date(date + (String(date).includes('T') ? '' : 'T00:00:00')).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatDateTime(date) {
  if (!date) return '—'
  return new Date(date).toLocaleString('en-US', {
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
