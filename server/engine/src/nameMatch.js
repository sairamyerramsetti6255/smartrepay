/**
 * Name normalization + scoring used to match bank/employer borrower names
 * against LoanDisk borrower names. Handles "Lastname, Firstname" vs
 * "Firstname Lastname", case, punctuation, and extra middle names.
 */

const STOP_TOKENS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'the', 'jr', 'sr', 'ii', 'iii'])

export function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && t.length > 1 && !STOP_TOKENS.has(t))
}

/** Sorted-token key — equal for "Russell, Calvin" and "Calvin Russell". */
export function normalizeNameKey(name) {
  return [...nameTokens(name)].sort().join(' ')
}

/** Rank match kinds for tie-breaking (higher = stronger). */
export function nameKindRank(kind) {
  const k = String(kind || '')
  if (k.startsWith('first+last')) return 100
  if (k.startsWith('last+first')) return 90
  if (k === 'token_overlap') return 70
  if (k.startsWith('last_only')) return 40
  if (k.startsWith('first_only')) return 30
  return 0
}

/**
 * 0-100 similarity. Subset containment when first tokens agree (bank first+last
 * must match borrower first token — avoids "Jamaal Moss" → "Clifford Jamaal Moss").
 */
export function nameScore(a, b, opts = {}) {
  const typoFloor = opts.typoFloor ?? 0.7
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  const taSet = new Set(ta)
  const tbSet = new Set(tb)
  if (!taSet.size || !tbSet.size) return 0

  const inter = [...taSet].filter((t) => tbSet.has(t)).length
  if (inter === 0) return 0

  const minSize = Math.min(taSet.size, tbSet.size)
  const coverage = inter / minSize

  if (coverage === 1 && minSize >= 2) {
    // Bank has first+last: require borrower's first token to match bank's first token.
    if (ta.length >= 2 && tb.length >= 2) {
      const simFirst = tokenSim(ta[0], tb[0])
      if (simFirst < typoFloor) {
        const jaccard = inter / (taSet.size + tbSet.size - inter)
        return Math.round(jaccard * 85)
      }
    }
    return 100
  }

  if (coverage === 1 && minSize === 1) return 70

  const jaccard = inter / (taSet.size + tbSet.size - inter)
  return Math.round(jaccard * 100)
}

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

export function tokenSim(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  return maxLen ? 1 - levenshtein(a, b) / maxLen : 0
}

const TYPO_FLOOR = 0.7

/**
 * @returns {{ score: number, kind: string }}
 */
export function scoreNameMatch(a, b, opts = {}) {
  const typoFloor = opts.typoFloor ?? TYPO_FLOOR
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  if (!ta.length || !tb.length) return { score: 0, kind: 'none' }

  const bankHasFullName = ta.length >= 2

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

  // Last/first-only only when bank name is a single token (e.g. surname-only listings).
  if (!bankHasFullName) {
    if (simLL >= 0.8) {
      cands.push({ kind: simLL === 1 ? 'last_only' : 'last_only~typo', score: Math.round(simLL * 72) })
    }
    if (simFF >= 0.8) {
      cands.push({ kind: simFF === 1 ? 'first_only' : 'first_only~typo', score: Math.round(simFF * 60) })
    }
  }

  const setScore = nameScore(a, b, { typoFloor })
  if (setScore > 0) cands.push({ kind: 'token_overlap', score: setScore })

  if (!cands.length) return { score: 0, kind: 'none' }
  cands.sort((x, y) => y.score - x.score || nameKindRank(y.kind) - nameKindRank(x.kind))
  return cands[0]
}
