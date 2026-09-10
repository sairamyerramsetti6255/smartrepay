import { stripPaymentNote } from './bankName.js'
import { nameTokens, scoreNameMatch, doubleMetaphone, normalizeNameKey } from './nameMatch.js'
import { resolveParticularsFields, isCompanyName } from '../../particularsParse.js'

export const compactName = (text) => nameTokens(text).join('')
export const normalizeLoanId = (text) => String(text ?? '').toUpperCase().trim().replace(/^LN[\s:#-]*(?=\d)/, '').replace(/[\s:#-]/g, '')
const clean = (text) => String(text ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '')
export const personTokens = (text) => nameTokens(clean(text))
export const activeLoan = (loan) => /^(active|current|open|arrears|overdue|past due|delinquent)$/i.test(String(loan.status || '').trim())
const generic = /^(cash deposit(?: in branch)?|deposit|transfer|salary|salaries|direct credit|loan payment|repayment)$/i

export function transactionIdentity(tx) {
  const parsed = resolveParticularsFields({ particulars: tx.Particulars, borrowerName: tx.BorrowerName })
  let name = parsed.borrowerName
  // A staged payer occasionally contains the entire narrative. Prefer its pipe name.
  if (name?.includes('|')) name = resolveParticularsFields({ particulars: name }).borrowerName
  name = stripPaymentNote(name)
  if (isCompanyName(name) || generic.test(name)) name = ''
  let descriptionName = ''
  if (!name && !parsed.full.includes('|')) {
    descriptionName = parsed.description
      .replace(/\b(?:loan(?:\s*id)?|top[\s-]*up|account|ln)[\s:#-]*[a-z]*\d[\w-]*/gi, ' ')
      .replace(/\b(?:direct credit|cash deposit in branch|ebank|internal|same cust|transfer|salary|salaries|payment|repayment|from|to)\b/gi, ' ')
      .replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim()
    descriptionName = stripPaymentNote(descriptionName)
    if (isCompanyName(descriptionName) || generic.test(descriptionName)) descriptionName = ''
  }
  const employer = String(tx.EmployerName || '').trim() || parsed.description.match(/direct\s+credit\s+(.+?)\s*-\s*(?:salar(?:y|ies)|loans?)\b/i)?.[1] || ''
  return { ...parsed, borrowerName: name, descriptionName, employer,
    cash: /cash\s+deposit(?:\s+in\s+branch)?/i.test(parsed.full) || !!parsed.companyAccount || isCompanyName(tx.BorrowerName) }
}

export function extractLoanIds(text) {
  const ids = new Set()
  // No unlabelled dates, salary batches, substrings, or suffix matching.
  const re = /\b(?:loan(?:\s*(?:id|number|no\.?))?|top[\s-]*up|account(?:\s*(?:no\.?|number))?|ln)[\s:#-]*((?:[a-z]+[\s-]*)?\d+[a-z0-9-]*)\b/gi
  for (const match of String(text || '').matchAll(re)) ids.add(normalizeLoanId(match[1]))
  return [...ids]
}

function add(map, key, group) {
  if (!key) return
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(group)
}

export function createIdentityIndex(groups, history = []) {
  const index = new Map()
  index.groups = groups
  index.phonetic = new Map()
  index.deletions = new Map()
  index.compact = new Map()
  index.cache = new Map()
  index.history = new Map()
  for (const group of groups.values()) {
    for (const alias of group.names) {
      const tokens = personTokens(alias)
      add(index.compact, tokens.join(''), group)
      // Rotation supports surname-first compound surnames without granting arbitrary subsets exact status.
      for (let i = 1; i < tokens.length; i++) add(index.compact, [...tokens.slice(i), ...tokens.slice(0, i)].join(''), group)
      for (const token of new Set(tokens)) {
        add(index, token, group)
        add(index.phonetic, doubleMetaphone(token).primary, group)
        add(index.deletions, token, group)
        if (token.length >= 3) for (let i = 0; i < token.length; i++) add(index.deletions, token.slice(0, i) + token.slice(i + 1), group)
      }
    }
  }
  for (const row of history) {
    if (!(row.ReviewStatus === 'confirmed' || (row.ReviewStatus === 'auto_matched' && row.MatchMethod === 'manual')) || !row.BorrowerId) continue
    const identity = transactionIdentity(row)
    const key = historyKey(identity)
    if (!key) continue
    if (!index.history.has(key)) index.history.set(key, [])
    index.history.get(key).push({ id: String(row.Id), borrowerId: String(row.BorrowerId) })
  }
  return index
}

export function historyKey(identity) {
  // Never learn anonymous cash/amount mappings; source + person must both exist.
  return identity.borrowerName && identity.employer ? `${normalizeNameKey(clean(identity.borrowerName))}|${compactName(identity.employer)}` : null
}

export function confirmedHistory(tx, identity, index) {
  const rows = (index.history?.get(historyKey(identity)) || []).filter((r) => r.id !== String(tx.Id))
  const ids = new Set(rows.map((r) => r.borrowerId))
  return ids.size === 1 ? [...ids][0] : null
}

export function identityNameScore(input, target, floor = 0.7) {
  input = stripPaymentNote(input)
  const a = personTokens(input), b = personTokens(target)
  const empty = { score: 0, nameKind: 'none' }
  if (!a.length || !b.length || isCompanyName(input) || isCompanyName(target)) return empty
  const ca = a.join(''), cb = b.join('')
  const rotateExact = b.some((_, i) => [...b.slice(i), ...b.slice(0, i)].join('') === ca)
  if ((ca === cb || rotateExact || [...a].sort().join(' ') === [...b].sort().join(' ')) && b.length >= 2 && b.every((t) => t.length > 1)) {
    return { score: 99, nameKind: 'exact_full', strongIdentity: true }
  }
  // Bank fields can truncate a compound surname. Three exact, ordered full
  // tokens from the beginning of the master name remain strong evidence.
  if (a.length >= 3 && a.length < b.length && a.every((t, i) => t.length > 1 && t === b[i])) {
    return { score: 94, nameKind: 'truncated_full_name', strongIdentity: true }
  }
  if (a.length === 1) {
    if (a[0].length < 3) return empty
    return b.some((t) => t === a[0]) ? { score: 72, nameKind: 'single_name', partialIdentity: true } : empty
  }
  const match = scoreNameMatch(clean(input), clean(target), { typoFloor: floor })
  if (!match.score) return empty
  const hasInitial = a.some((t) => t.length === 1) || b.some((t) => t.length === 1)
  // A middle initial is not a first-name-only identity. Require two full tokens
  // plus a complete compatible name before treating abbreviated names as strong.
  const initial = hasInitial && !(a.filter((t) => t.length > 1).length >= 2 && match.breakdown?.fullName)
  const strongAbbreviation = hasInitial && !initial
  // Score actual token quality: the old 90..99 tier hid substantial typo differences.
  const pairQuality = (part) => Math.max(part?.blended || 0, ((part?.jaro || 0) + (part?.damerau || 0)) / 2)
  const quality = (pairQuality(match.breakdown?.first) + pairQuality(match.breakdown?.last)) / 2
  const score = strongAbbreviation ? 94 : initial ? Math.min(85, Math.round(quality * 95))
    : match.breakdown?.fullName ? Math.min(97, Math.round(quality * 99)) : Math.min(89, Math.round(quality * 95))
  return { score, nameKind: match.kind, nameBreakdown: match.breakdown, partialIdentity: initial,
    strongIdentity: !initial && score >= 92 }
}

export function nameCandidates(name, index, floor = 0.7) {
  name = stripPaymentNote(name)
  const key = `${floor}:${name}`
  if (index.cache.has(key)) return index.cache.get(key)
  const seen = new Set(index.compact.get(personTokens(name).join('')) || [])
  for (const token of personTokens(name)) {
    for (const group of index.get(token) || []) seen.add(group)
    for (const group of index.phonetic.get(doubleMetaphone(token).primary) || []) seen.add(group)
    const variants = [token]
    if (token.length >= 3) for (let i = 0; i < token.length; i++) variants.push(token.slice(0, i) + token.slice(i + 1))
    for (const variant of variants) for (const group of index.deletions.get(variant) || []) seen.add(group)
    // Initial retrieval requires another informative token before scoring can pass.
  }
  const scored = [...seen].map((group) => {
    const best = group.names.map((alias) => identityNameScore(name, alias, floor)).sort((a, b) => b.score - a.score)[0]
    return { group, ...best, matchedFrom: 'name' }
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.group.key.localeCompare(b.group.key))
  if (index.cache.size >= 2000) index.cache.clear()
  index.cache.set(key, scored)
  return scored
}
