/**
 * Hybrid name matching: blended per-token confidence (Jaro-Winkler, Damerau-Levenshtein,
 * Double Metaphone, Levenshtein) with a hard first+last gate.
 *
 * Name score tiers:
 *   0     — first + last do not both clear typo floor
 *   70–89 — first + last match
 *   90–99 — full name (all bank tokens found in borrower name)
 */

const STOP_TOKENS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'the', 'jr', 'sr', 'ii', 'iii'])

const SCORE_FIRST_LAST_BASE = 70
const SCORE_FIRST_LAST_MAX = 89
const SCORE_FULL_NAME_BASE = 90
const SCORE_FULL_NAME_MAX = 99

const W_JARO = 0.45
const W_DAMERAU = 0.3
const W_PHONETIC = 0.15
const W_LEV = 0.1

const TYPO_FLOOR = 0.7

export function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    // Keep multi-char tokens AND single-letter initials (e.g. "K" for "Knowles");
    // drop lone digits and titles.
    .filter((t) => t && !STOP_TOKENS.has(t) && (t.length > 1 || /^[a-z]$/.test(t)))
}

const INITIAL_MATCH = 0.85

/** Single-letter initial vs a full token: match when it is the token's first letter. */
function initialPairScore(a, b) {
  const aInit = a.length === 1
  const bInit = b.length === 1
  if (!aInit && !bInit) return null
  const short = aInit ? a : b
  const long = aInit ? b : a
  if (!long) return 0
  return long[0] === short ? INITIAL_MATCH : 0
}

export function normalizeNameKey(name) {
  return [...nameTokens(name)].sort().join(' ')
}

export function nameKindRank(kind) {
  const k = String(kind || '')
  if (k.includes('full')) return 100
  if (k.startsWith('first+last')) return 80
  if (k.startsWith('last+first')) return 75
  return 0
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

/** Damerau-Levenshtein — adjacent transpositions count as one edit (ISREAL ↔ ISRAEL). */
export function damerauLevenshtein(a, b) {
  a = String(a || '')
  b = String(b || '')
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  const max = m + n
  const da = Object.create(null)
  const d = Array.from({ length: m + 2 }, () => Array(n + 2).fill(0))
  d[0][0] = max
  for (let i = 0; i <= m; i++) {
    d[i + 1][0] = max
    d[i + 1][1] = i
  }
  for (let j = 0; j <= n; j++) {
    d[0][j + 1] = max
    d[1][j + 1] = j
  }
  for (let i = 1; i <= m; i++) {
    let db = 0
    for (let j = 1; j <= n; j++) {
      const i1 = da[b[j - 1]] || 0
      const j1 = db
      let cost = 1
      if (a[i - 1] === b[j - 1]) {
        cost = 0
        db = j
      }
      d[i + 1][j + 1] = Math.min(
        d[i][j + 1] + 1,
        d[i + 1][j] + 1,
        d[i][j] + cost,
        d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1)
      )
    }
    da[a[i - 1]] = i
  }
  return d[m + 1][n + 1]
}

export function damerauSim(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  return maxLen ? 1 - damerauLevenshtein(a, b) / maxLen : 0
}

export function tokenSim(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const maxLen = Math.max(a.length, b.length)
  return maxLen ? 1 - levenshtein(a, b) / maxLen : 0
}

function commonPrefixLen(a, b, max = 4) {
  let n = 0
  const lim = Math.min(max, a.length, b.length)
  while (n < lim && a[n] === b[n]) n++
  return n
}

/** Jaro-Winkler similarity 0..1 */
export function jaroWinkler(s1, s2, prefixScale = 0.1) {
  s1 = String(s1 || '')
  s2 = String(s2 || '')
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1

  const matchDistance = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0)
  const s1Matches = new Array(s1.length).fill(false)
  const s2Matches = new Array(s2.length).fill(false)

  let matches = 0
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, s2.length)
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue
      s1Matches[i] = true
      s2Matches[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0

  let t = 0
  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue
    while (!s2Matches[k]) k++
    if (s1[i] !== s2[k]) t++
    k++
  }
  const jaro = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3
  const prefix = commonPrefixLen(s1, s2, 4)
  return jaro + prefix * prefixScale * (1 - jaro)
}

/** Compact Double Metaphone — primary code sufficient for English names. */
function metaphoneWord(word) {
  let w = String(word || '').toUpperCase().replace(/[^A-Z]/g, '')
  if (!w) return ''
  if (w.startsWith('KN')) w = w.slice(1)
  else if (w.startsWith('GN') || w.startsWith('PN') || w.startsWith('AE') || w.startsWith('WR')) w = w.slice(1)
  else if (w.startsWith('X')) w = 'S' + w.slice(1)

  let out = ''
  let i = 0
  const vowels = 'AEIOU'

  while (i < w.length && out.length < 6) {
    const c = w[i]
    const next = w[i + 1] || ''
    const next2 = w[i + 2] || ''

    if (vowels.includes(c)) {
      if (i === 0) out += c
      i++
      continue
    }

    if (c === 'B' || c === 'F' || c === 'P' || c === 'V') {
      out += c === 'V' ? 'F' : c
      i += next === c ? 2 : 1
      continue
    }
    if (c === 'C') {
      if (next === 'H') {
        out += 'X'
        i += 2
      } else if (next === 'I' || next === 'E' || next === 'Y') {
        out += 'S'
        i += 2
      } else {
        out += 'K'
        i++
      }
      continue
    }
    if (c === 'D') {
      if (next === 'G' && (next2 === 'E' || next2 === 'I' || next2 === 'Y')) {
        out += 'J'
        i += 3
      } else {
        out += 'T'
        i += next === 'G' ? 2 : 1
      }
      continue
    }
    if (c === 'G') {
      if (next === 'H' && !vowels.includes(next2) && next2) {
        i += 2
        continue
      }
      if (next === 'N' && i === w.length - 2) {
        i += 2
        continue
      }
      if (next === 'I' || next === 'E' || next === 'Y') {
        out += 'J'
        i += 2
      } else {
        out += 'K'
        i++
      }
      continue
    }
    if (c === 'H') {
      if (!vowels.includes(next) && (i === 0 || vowels.includes(w[i - 1]))) {
        out += 'H'
      }
      i++
      continue
    }
    if (c === 'J') {
      out += 'J'
      i += next === 'J' ? 2 : 1
      continue
    }
    if (c === 'K') {
      out += 'K'
      i += next === 'K' ? 2 : 1
      continue
    }
    if (c === 'L') {
      out += 'L'
      i += next === 'L' ? 2 : 1
      continue
    }
    if (c === 'M') {
      out += 'M'
      i += next === 'M' ? 2 : 1
      continue
    }
    if (c === 'N') {
      out += 'N'
      i += next === 'N' ? 2 : 1
      continue
    }
    if (c === 'Q') {
      out += 'K'
      i += next === 'Q' ? 2 : 1
      continue
    }
    if (c === 'R') {
      out += 'R'
      i += next === 'R' ? 2 : 1
      continue
    }
    if (c === 'S') {
      if (next === 'H') {
        out += 'X'
        i += 2
      } else if (next === 'I' && (next2 === 'O' || next2 === 'A')) {
        out += 'X'
        i += 3
      } else {
        out += 'S'
        i += next === 'S' ? 2 : 1
      }
      continue
    }
    if (c === 'T') {
      if (next === 'H') {
        out += '0'
        i += 2
      } else if (next === 'I' && (next2 === 'O' || next2 === 'A')) {
        out += 'X'
        i += 3
      } else {
        out += 'T'
        i += next === 'T' ? 2 : 1
      }
      continue
    }
    if (c === 'W') {
      if (vowels.includes(next)) out += 'W'
      i++
      continue
    }
    if (c === 'X') {
      out += 'KS'
      i += next === 'X' ? 2 : 1
      continue
    }
    if (c === 'Z') {
      out += 'S'
      i += next === 'Z' ? 2 : 1
      continue
    }
    i++
  }
  return out
}

export function doubleMetaphone(word) {
  const primary = metaphoneWord(word)
  let alt = primary
  if (primary.startsWith('K') && word.toUpperCase().startsWith('C')) alt = 'S' + primary.slice(1)
  return { primary, alternate: alt }
}

export function phoneticEqual(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  const pa = doubleMetaphone(a)
  const pb = doubleMetaphone(b)
  return (
    pa.primary === pb.primary ||
    pa.primary === pb.alternate ||
    pa.alternate === pb.primary ||
    pa.alternate === pb.alternate
  )
}

/** Weighted blend 0..1 for a single token pair. */
export function tokenConfidence(a, b) {
  if (!a || !b) {
    return { jaro: 0, damerau: 0, phonetic: 0, levenshtein: 0, blended: 0 }
  }
  if (a === b) {
    return { jaro: 1, damerau: 1, phonetic: 1, levenshtein: 1, blended: 1 }
  }
  // Initial match: "K" vs "Knowles" — neither blend nor phonetic apply cleanly.
  const init = initialPairScore(a, b)
  if (init != null) {
    return { jaro: init, damerau: init, phonetic: 0, levenshtein: 0, blended: init, initial: init > 0 }
  }
  const jaro = jaroWinkler(a, b)
  const damerau = damerauSim(a, b)
  const phonetic = phoneticEqual(a, b) ? 1 : 0
  const levenshtein = tokenSim(a, b)
  const blended =
    W_JARO * jaro + W_DAMERAU * damerau + W_PHONETIC * phonetic + W_LEV * levenshtein
  return {
    jaro: round4(jaro),
    damerau: round4(damerau),
    phonetic,
    levenshtein: round4(levenshtein),
    blended: round4(blended),
  }
}

function round4(n) {
  return Math.round(n * 10000) / 10000
}

function tokenMatchesAny(token, others, typoFloor) {
  return others.some((o) => tokenConfidence(token, o).blended >= typoFloor)
}

export function isFullNameMatch(bankTokens, borrowerTokens, typoFloor = TYPO_FLOOR) {
  if (!bankTokens.length) return false
  return bankTokens.every((t) => tokenMatchesAny(t, borrowerTokens, typoFloor))
}

function tieredNameScore(firstLastQuality, fullName) {
  const q = Math.max(0, Math.min(1, firstLastQuality))
  if (fullName) {
    return SCORE_FULL_NAME_BASE + Math.round(q * (SCORE_FULL_NAME_MAX - SCORE_FULL_NAME_BASE))
  }
  return SCORE_FIRST_LAST_BASE + Math.round(q * (SCORE_FIRST_LAST_MAX - SCORE_FIRST_LAST_BASE))
}

function orientationScore(ta, tb, typoFloor) {
  const fa = ta[0]
  const la = ta[ta.length - 1]
  const fb = tb[0]
  const lb = tb[tb.length - 1]

  const ff = tokenConfidence(fa, fb)
  const ll = tokenConfidence(la, lb)
  const fl = tokenConfidence(fa, lb)
  const lf = tokenConfidence(la, fb)

  const orientations = []

  if (ff.blended >= typoFloor && ll.blended >= typoFloor) {
    orientations.push({
      kind: ff.blended === 1 && ll.blended === 1 ? 'first+last' : 'first+last~typo',
      quality: (ff.blended + ll.blended) / 2,
      first: ff,
      last: ll,
    })
  }
  if (fl.blended >= typoFloor && lf.blended >= typoFloor) {
    orientations.push({
      kind: fl.blended === 1 && lf.blended === 1 ? 'last+first' : 'last+first~typo',
      quality: (fl.blended + lf.blended) / 2,
      first: fl,
      last: lf,
    })
  }

  if (!orientations.length) return null
  orientations.sort((a, b) => b.quality - a.quality)
  return orientations[0]
}

export function nameScore(a, b, opts = {}) {
  return scoreNameMatch(a, b, opts).score
}

/**
 * @returns {{ score: number, kind: string, breakdown: object|null }}
 */
export function scoreNameMatch(a, b, opts = {}) {
  const typoFloor = opts.typoFloor ?? TYPO_FLOOR
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  if (!ta.length || !tb.length) return { score: 0, kind: 'none', breakdown: null }

  if (ta.length < 2) return { score: 0, kind: 'none', breakdown: null }

  const orient = orientationScore(ta, tb, typoFloor)
  if (!orient) return { score: 0, kind: 'none', breakdown: null }

  const fullName = isFullNameMatch(ta, tb, typoFloor)
  const kind = fullName ? `${orient.kind}+full` : orient.kind
  const score = tieredNameScore(orient.quality, fullName)

  return {
    score,
    kind,
    breakdown: {
      orientation: orient.kind,
      firstLastQuality: round4(orient.quality),
      fullName,
      first: orient.first,
      last: orient.last,
    },
  }
}

export function formatBreakdownShort(breakdown) {
  if (!breakdown) return ''
  const fmt = (t) =>
    `jw ${Math.round((t.jaro || 0) * 100)}% / dl ${Math.round((t.damerau || 0) * 100)}% / ph ${t.phonetic ? 'Y' : 'N'} / lv ${Math.round((t.levenshtein || 0) * 100)}%`
  return `first[${fmt(breakdown.first)}] last[${fmt(breakdown.last)}]`
}
