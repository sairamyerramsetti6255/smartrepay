const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'for',
  'from',
  'by',
  'on',
  'in',
  'at',
  'dr',
  'cr',
  'ref',
  'no',
  'number',
  'important',
  'notice',
  'please',
  'examine',
  'this',
  'statement',
  'balance',
  'overdrawn',
])

/**
 * Normalize bank narration into a stable bucket key so variants like
 * "SIMPLIFIED LENDING", "Simplified Lending", "Simplified Lend Dr = …"
 * collapse into one dynamic bucket.
 */
export function normalizeNarration(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\|[\s\S]*$/, '') // drop "| borrower name" tail if present
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function narrationBucketKey(text) {
  const normalized = normalizeNarration(text)
  if (!normalized) return 'other'
  const words = normalized
    .split(' ')
    .filter((w) => w.length > 1 && !STOP.has(w))
  if (!words.length) return 'other'

  // Prefer a short, human-meaningful label (first 1–4 content words).
  // Collapse "simplified lend…" → "simplified lending" when lend* is present.
  const joined = words.slice(0, 4).join(' ')
  if (joined.startsWith('simplified lend')) return 'simplified lending'
  if (joined.startsWith('cash deposit')) return 'cash deposited'
  if (joined.startsWith('staff deduction')) return 'staff deductions'
  return joined
}

export function titleCaseNarration(key) {
  if (!key || key === 'other') return 'Other / blank'
  return key
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * Build dynamic narration buckets from the current file/scoped rows.
 * Only groups with at least `minCount` rows become buckets (keeps UI neat).
 */
export function buildNarrationBuckets(rows, { minCount = 2, maxBuckets = 12 } = {}) {
  const map = new Map()
  for (const row of rows || []) {
    const raw =
      row.transaction_description ||
      row.description ||
      ''
    const key = narrationBucketKey(raw)
    const cur = map.get(key) || { key, label: titleCaseNarration(key), count: 0 }
    cur.count += 1
    map.set(key, cur)
  }

  return [...map.values()]
    .filter((b) => b.count >= minCount || b.key === 'other')
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, maxBuckets)
}

export function rowMatchesNarrationBucket(row, bucketKey) {
  if (!bucketKey || bucketKey === 'all') return true
  const raw = row.transaction_description || row.description || ''
  return narrationBucketKey(raw) === bucketKey
}
