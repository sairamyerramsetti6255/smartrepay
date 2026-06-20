/**
 * Name normalization + scoring used to match bank/employer borrower names
 * against LoanDisk borrower names. Handles "Lastname, Firstname" vs
 * "Firstname Lastname", case, punctuation, and extra middle names.
 */

const STOP_TOKENS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'the', 'jr', 'sr', 'ii', 'iii'])

export function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // drop commas, parens, apostrophes, etc.
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && t.length > 1 && !STOP_TOKENS.has(t))
}

/** Sorted-token key — equal for "Russell, Calvin" and "Calvin Russell". */
export function normalizeNameKey(name) {
  return [...nameTokens(name)].sort().join(' ')
}

/**
 * 0-100 similarity. 100 when the smaller name (>=2 tokens) is fully contained
 * in the larger (handles middle names), otherwise Jaccard token overlap.
 */
export function nameScore(a, b) {
  const ta = new Set(nameTokens(a))
  const tb = new Set(nameTokens(b))
  if (!ta.size || !tb.size) return 0
  const inter = [...ta].filter((t) => tb.has(t)).length
  if (inter === 0) return 0
  const minSize = Math.min(ta.size, tb.size)
  const coverage = inter / minSize
  if (coverage === 1 && minSize >= 2) return 100
  if (coverage === 1 && minSize === 1) return 70 // single shared token (first name only)
  const jaccard = inter / (ta.size + tb.size - inter)
  return Math.round(jaccard * 100)
}

/** Levenshtein edit distance (for typo / spelling-mistake tolerance). */
export function levenshtein(a, b) {
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

/** 0..1 similarity between two single tokens, typo-tolerant. */
export function tokenSim(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  return maxLen ? 1 - levenshtein(a, b) / maxLen : 0
}

// Per-token similarity floor for a token to count as a (typo-tolerant) match.
const TYPO_FLOOR = 0.7

/**
 * Score a name pair by trying several real-world combinations and returning the
 * BEST one with a confidence (0-100) that reflects WHICH combination matched:
 *
 *   first+last (same order)  -> up to 100
 *   last+first (reversed)    -> up to  99
 *   ...both with typos       -> scaled by edit-distance similarity
 *   last name only           -> up to  72
 *   first name only          -> up to  60
 *   token_overlap (fallback) -> Jaccard, handles middle names / 3+ tokens
 *
 * @returns {{ score: number, kind: string }}
 */
export function scoreNameMatch(a, b, opts = {}) {
  const typoFloor = opts.typoFloor ?? TYPO_FLOOR
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  if (!ta.length || !tb.length) return { score: 0, kind: 'none' }

  const fa = ta[0]
  const la = ta[ta.length - 1]
  const fb = tb[0]
  const lb = tb[tb.length - 1]

  const simFF = tokenSim(fa, fb)
  const simLL = tokenSim(la, lb)
  const simFL = tokenSim(fa, lb)
  const simLF = tokenSim(la, fb)

  const cands = []

  if (simFF >= typoFloor && simLL >= typoFloor) {
    const exact = simFF === 1 && simLL === 1
    cands.push({ kind: exact ? 'first+last' : 'first+last~typo', score: Math.round(((simFF + simLL) / 2) * 100) })
  }
  if (simFL >= typoFloor && simLF >= typoFloor) {
    const exact = simFL === 1 && simLF === 1
    cands.push({ kind: exact ? 'last+first' : 'last+first~typo', score: Math.round(((simFL + simLF) / 2) * 100) - 1 })
  }
  if (simLL >= 0.8) {
    cands.push({ kind: simLL === 1 ? 'last_only' : 'last_only~typo', score: Math.round(simLL * 72) })
  }
  if (simFF >= 0.8) {
    cands.push({ kind: simFF === 1 ? 'first_only' : 'first_only~typo', score: Math.round(simFF * 60) })
  }
  const setScore = nameScore(a, b)
  if (setScore > 0) cands.push({ kind: 'token_overlap', score: setScore })

  if (!cands.length) return { score: 0, kind: 'none' }
  cands.sort((x, y) => y.score - x.score)
  return cands[0]
}
