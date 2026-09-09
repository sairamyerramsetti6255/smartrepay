/** Client-side catalog normalizer — handles old API `thresholds` vs new grouped catalog. */

const SCORE_LIMIT_KEYS = new Set(['nameMinScore', 'nameStrongScore', 'autoMatchConfidence', 'ambiguityConfidenceGap'])
const CONFIDENCE_WEIGHT_KEYS = new Set(['nameConfidenceWeight', 'amountConfidenceWeight'])
const TUNING_KEYS = new Set(['amountTolerancePercent', 'typoToleranceFloor'])

const FALLBACK = {
  scoreLimits: [
    {
      key: 'nameMinScore',
      label: 'Minimum name score',
      hint: 'Below this, a borrower is not considered a candidate. First + last must match for at least 70.',
      default: 70,
      min: 0,
      max: 100,
      step: 1,
      unit: 'points',
    },
    {
      key: 'nameStrongScore',
      label: 'Strong name score',
      hint: 'Full name match tier (90+). With amount reconciliation, confidence becomes 100.',
      default: 90,
      min: 0,
      max: 100,
      step: 1,
      unit: 'points',
    },
    {
      key: 'autoMatchConfidence',
      label: 'Auto-match confidence',
      hint: 'At or above this, a match is auto-approved (very likely / same person bands).',
      default: 85,
      min: 0,
      max: 100,
      step: 1,
      unit: 'points',
    },
    {
      key: 'ambiguityConfidenceGap',
      label: 'Ambiguity gap',
      hint: 'If top two candidates are within this gap, flag as ambiguous.',
      default: 8,
      min: 1,
      max: 30,
      step: 1,
      unit: 'points',
    },
  ],
  tuning: [
    {
      key: 'amountTolerancePercent',
      label: 'Amount tolerance',
      hint: 'Allowed variance vs expected EMI (e.g. 0.02 = ±2%).',
      default: 0.02,
      min: 0,
      max: 0.1,
      step: 0.005,
      unit: 'percent',
    },
    {
      key: 'typoToleranceFloor',
      label: 'Typo similarity floor',
      hint: 'Per-token blend must reach this (0–1) for first and last to count as a match.',
      default: 0.7,
      min: 0.5,
      max: 1,
      step: 0.05,
      unit: 'similarity',
    },
  ],
  signals: [
    { key: 'useBorrowerName', label: 'Borrower name field', hint: 'Match using payer / borrower name from particulars.', default: true },
    { key: 'useDescription', label: 'Transaction description', hint: 'Also match text before the | in particulars.', default: true },
  ],
  amountComponents: [
    { key: 'exact_single', label: 'Single EMI exact', default: 100 },
    { key: 'sum_all', label: 'All loans sum', default: 100 },
    { key: 'subset', label: 'Subset of loans', default: 100 },
    { key: 'partial', label: 'Partial payment', default: 55 },
    { key: 'mismatch', label: 'Amount mismatch', default: 25 },
    { key: 'none', label: 'No amount data', default: 10 },
  ],
  nameAlgorithm: {
    title: 'Per-token name blend',
    description:
      'Each first/last token is scored with a weighted blend. Both tokens must clear the typo floor or the name score is 0.',
    blend: [
      { key: 'jaro', label: 'Jaro-Winkler', weight: 0.45 },
      { key: 'damerau', label: 'Damerau-Levenshtein', weight: 0.3 },
      { key: 'phonetic', label: 'Double Metaphone', weight: 0.15 },
      { key: 'levenshtein', label: 'Levenshtein similarity', weight: 0.1 },
    ],
    tiers: [
      { range: '0', label: 'No match', description: 'First or last name failed the typo floor.' },
      { range: '70–89', label: 'First + last', description: 'Both first and last names match.' },
      { range: '90–99', label: 'Full name', description: 'All bank name tokens found in borrower name.' },
      { range: '100', label: 'Full name + amount', description: 'Strong name + EMI reconciles.' },
    ],
  },
  confidenceBuckets: [
    { key: 'same_person', min: 95, label: 'Same person', hint: '≥95% — exact / same person.' },
    { key: 'very_likely_match', min: 85, max: 94, label: 'Very likely', hint: '85–94% — likely same person.' },
    { key: 'possible_review', min: 70, max: 84, label: 'Review', hint: '70–84% — manual review.' },
    { key: 'different_person', max: 69, label: 'Different person', hint: '<70% — not a valid match.' },
  ],
}

function inferUnit(key, item = {}) {
  if (item.unit) return item.unit
  if (CONFIDENCE_WEIGHT_KEYS.has(key)) return 'weight'
  if (key === 'typoToleranceFloor') return 'similarity'
  if (key === 'amountTolerancePercent') return 'percent'
  return 'points'
}

export function normalizeMatchingRulesCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') {
    return { ...FALLBACK }
  }

  if (Array.isArray(catalog.scoreLimits) && catalog.scoreLimits.length) {
    return {
      scoreLimits: catalog.scoreLimits,
      tuning: catalog.tuning?.length ? catalog.tuning : FALLBACK.tuning,
      signals: catalog.signals?.length ? catalog.signals : FALLBACK.signals,
      amountComponents: catalog.amountComponents?.length ? catalog.amountComponents : FALLBACK.amountComponents,
      nameAlgorithm: catalog.nameAlgorithm || FALLBACK.nameAlgorithm,
      confidenceBuckets: catalog.confidenceBuckets?.length ? catalog.confidenceBuckets : FALLBACK.confidenceBuckets,
    }
  }

  const flat = Array.isArray(catalog.thresholds) ? catalog.thresholds : []
  const scoreLimits = []
  const tuning = []

  for (const item of flat) {
    if (!item?.key || item.key === 'amountToleranceMin') continue
    if (CONFIDENCE_WEIGHT_KEYS.has(item.key)) continue
    const meta = { ...item, unit: inferUnit(item.key, item) }
    if (SCORE_LIMIT_KEYS.has(item.key)) scoreLimits.push(meta)
    else if (TUNING_KEYS.has(item.key)) tuning.push(meta)
  }

  return {
    scoreLimits: scoreLimits.length ? scoreLimits : FALLBACK.scoreLimits,
    tuning: tuning.length ? tuning : FALLBACK.tuning,
    signals: catalog.signals?.length ? catalog.signals : FALLBACK.signals,
    amountComponents: catalog.amountComponents?.length ? catalog.amountComponents : FALLBACK.amountComponents,
    nameAlgorithm: catalog.nameAlgorithm || FALLBACK.nameAlgorithm,
    confidenceBuckets: catalog.confidenceBuckets?.length ? catalog.confidenceBuckets : FALLBACK.confidenceBuckets,
  }
}
