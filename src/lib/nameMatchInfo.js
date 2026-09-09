/**
 * Lightweight client-side mirror of the server name matcher (server/engine/src/nameMatch.js)
 * used only to SHOW first/last match status in the review drawer. The authoritative
 * score still comes from the engine (tx.name_score).
 */

const STOP_TOKENS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'the', 'jr', 'sr', 'ii', 'iii'])
const TYPO_FLOOR = 0.7

export function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !STOP_TOKENS.has(t) && (t.length > 1 || /^[a-z]$/.test(t)))
}

function levenshtein(a, b) {
  a = String(a || '')
  b = String(b || '')
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  const dp = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[n]
}

function sim(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  return maxLen ? 1 - levenshtein(a, b) / maxLen : 0
}

/** Match status between two name tokens: exact, initial, typo, or none. */
export function compareTokens(a, b) {
  if (!a || !b) return { match: false, kind: 'missing' }
  if (a === b) return { match: true, kind: 'exact' }
  if (a.length === 1 || b.length === 1) {
    const short = a.length === 1 ? a : b
    const long = a.length === 1 ? b : a
    return long[0] === short ? { match: true, kind: 'initial' } : { match: false, kind: 'none' }
  }
  const s = sim(a, b)
  if (s >= TYPO_FLOOR) return { match: true, kind: s === 1 ? 'exact' : 'typo', similarity: s }
  return { match: false, kind: 'none', similarity: s }
}

const KIND_LABEL = {
  exact: 'Exact',
  initial: 'Initial',
  typo: 'Close (typo)',
  none: 'No match',
  missing: 'Missing',
}

export function kindLabel(kind) {
  return KIND_LABEL[kind] || kind
}

/**
 * Compare a bank/payer name against a borrower name and report first/last status.
 * Picks the orientation (normal vs reversed "Last First") that matches best.
 */
export function analyzeNameMatch(bankName, borrowerName) {
  const ta = tokenize(bankName)
  const tb = tokenize(borrowerName)
  if (!ta.length || !tb.length) {
    return { available: false }
  }

  const fa = ta[0]
  const la = ta[ta.length - 1]
  const fb = tb[0]
  const lb = tb[tb.length - 1]

  const direct = { first: compareTokens(fa, fb), last: compareTokens(la, lb) }
  const reversedCmp = { first: compareTokens(fa, lb), last: compareTokens(la, fb) }

  const directScore = (direct.first.match ? 1 : 0) + (direct.last.match ? 1 : 0)
  const reversedScore = (reversedCmp.first.match ? 1 : 0) + (reversedCmp.last.match ? 1 : 0)
  const reversed = reversedScore > directScore
  const chosen = reversed ? reversedCmp : direct

  // Full name: every bank token is found somewhere in the borrower tokens.
  const fullName =
    ta.length >= 2 &&
    ta.every((t) => tb.some((o) => compareTokens(t, o).match))

  return {
    available: true,
    reversed,
    fullName,
    bankTokens: ta,
    borrowerTokens: tb,
    first: {
      bank: fa,
      borrower: reversed ? lb : fb,
      ...chosen.first,
    },
    last: {
      bank: la,
      borrower: reversed ? fb : lb,
      ...chosen.last,
    },
    bothMatch: chosen.first.match && chosen.last.match,
  }
}
