/**
 * Dynamic matching rules — stored in app_settings.matchingRules and applied at runtime
 * by the reconciliation engine (see matchingEngine.setMatchingEngineConfig).
 */

export const RULE_CATALOG = {
  thresholds: [
    { key: 'nameMinScore', label: 'Minimum name score', hint: 'Below this, a borrower is not considered a candidate.', min: 0, max: 100, step: 1, default: 55 },
    { key: 'nameStrongScore', label: 'Strong name score', hint: 'Required for name + amount match type at high confidence.', min: 0, max: 100, step: 1, default: 85 },
    { key: 'autoMatchConfidence', label: 'Auto-match confidence', hint: 'At or above this, a match is auto-approved.', min: 0, max: 100, step: 1, default: 70 },
    { key: 'ambiguityConfidenceGap', label: 'Ambiguity gap', hint: 'If top two candidates are within this gap, flag as ambiguous.', min: 1, max: 30, step: 1, default: 8 },
    { key: 'nameConfidenceWeight', label: 'Name weight', hint: 'Share of confidence from name score (0–1).', min: 0, max: 1, step: 0.05, default: 0.6 },
    { key: 'amountConfidenceWeight', label: 'Amount weight', hint: 'Share of confidence from amount reconciliation (0–1).', min: 0, max: 1, step: 0.05, default: 0.4 },
    { key: 'amountTolerancePercent', label: 'Amount tolerance %', hint: 'Allowed variance vs expected EMI (e.g. 0.02 = 2%).', min: 0, max: 0.1, step: 0.005, default: 0.02 },
    { key: 'amountToleranceMin', label: 'Amount tolerance floor ($)', hint: 'Minimum dollar tolerance for small payments.', min: 0, max: 10, step: 0.5, default: 1.5 },
    { key: 'typoToleranceFloor', label: 'Typo tolerance', hint: 'Token similarity floor for typo-tolerant name matching (0–1).', min: 0.5, max: 1, step: 0.05, default: 0.7 },
  ],
  signals: [
    { key: 'useBorrowerName', label: 'Borrower name field', hint: 'Match using payer / borrower name from particulars.', default: true },
    { key: 'useDescription', label: 'Transaction description', hint: 'Also match text before the | in particulars.', default: true },
    { key: 'useLoanNumberHint', label: 'Loan number in text', hint: 'Boost borrower when loan # appears in description.', default: true },
    { key: 'useSubsetSum', label: 'Multi-loan subset sum', hint: 'Allow one deposit to settle several loans (EMI sum).', default: true },
    { key: 'useBiWeekly', label: 'Bi-weekly installments', hint: 'Treat deposit as half of monthly EMI.', default: true },
    { key: 'useWeekly', label: 'Weekly installments', hint: 'Treat deposit as quarter of monthly EMI.', default: true },
    { key: 'useAiAdjudication', label: 'AI adjudication', hint: 'Use AI for ambiguous name ties (when enabled on run).', default: true },
    { key: 'useTypoTolerance', label: 'Typo tolerance', hint: 'Allow minor spelling differences in names.', default: true },
  ],
  amountComponents: [
    { key: 'exact_single', label: 'Single EMI exact', default: 100 },
    { key: 'sum_all', label: 'All loans sum', default: 100 },
    { key: 'subset', label: 'Subset of loans', default: 100 },
    { key: 'partial', label: 'Partial payment', default: 55 },
    { key: 'mismatch', label: 'Amount mismatch', default: 25 },
    { key: 'none', label: 'No amount data', default: 10 },
  ],
}

export const DEFAULT_MATCHING_RULES = {
  version: 1,
  thresholds: Object.fromEntries(RULE_CATALOG.thresholds.map((t) => [t.key, t.default])),
  signals: Object.fromEntries(RULE_CATALOG.signals.map((s) => [s.key, { enabled: s.default, weight: 1 }])),
  amountComponents: Object.fromEntries(RULE_CATALOG.amountComponents.map((a) => [a.key, a.default])),
  aliasPatterns: [
    {
      id: 'borrower-id-numeric',
      label: 'Numeric borrower ID',
      pattern: '\\b(\\d{5,10})\\b',
      field: 'reference',
      flags: 'i',
      active: true,
    },
    {
      id: 'loan-prefix',
      label: 'Loan prefix (LD/BRW/LN)',
      pattern: '\\b(?:LD|BRW|LN)[-\\s#]?(\\d+)\\b',
      field: 'reference',
      flags: 'i',
      active: true,
    },
  ],
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, n))
}

/** Merge partial saved rules with defaults and clamp numeric ranges. */
export function resolveMatchingRules(partial) {
  // DB default is null; legacy UI stored an array of { field, weight, active }
  if (partial == null || typeof partial !== 'object') {
    partial = {}
  } else if (Array.isArray(partial)) {
    partial = migrateLegacyRuleList(partial)
  }

  const thresholds = { ...DEFAULT_MATCHING_RULES.thresholds }
  for (const t of RULE_CATALOG.thresholds) {
    if (partial.thresholds?.[t.key] != null) {
      thresholds[t.key] = clampNum(partial.thresholds[t.key], t.min, t.max, t.default)
    }
  }

  const signals = { ...DEFAULT_MATCHING_RULES.signals }
  for (const s of RULE_CATALOG.signals) {
    const saved = partial.signals?.[s.key]
    signals[s.key] = {
      enabled: saved?.enabled !== undefined ? !!saved.enabled : signals[s.key]?.enabled ?? s.default,
      weight: clampNum(saved?.weight, 0, 2, 1),
    }
  }

  const amountComponents = { ...DEFAULT_MATCHING_RULES.amountComponents }
  for (const a of RULE_CATALOG.amountComponents) {
    if (partial.amountComponents?.[a.key] != null) {
      amountComponents[a.key] = clampNum(partial.amountComponents[a.key], 0, 100, a.default)
    }
  }

  const aliasPatterns = Array.isArray(partial.aliasPatterns)
    ? partial.aliasPatterns
        .filter((p) => p && p.pattern)
        .map((p, i) => ({
          id: String(p.id || `pattern-${i + 1}`),
          label: String(p.label || `Pattern ${i + 1}`),
          pattern: String(p.pattern),
          field: ['reference', 'description', 'particulars', 'borrowerName'].includes(p.field) ? p.field : 'reference',
          flags: String(p.flags || 'i').replace(/[^gimsuy]/g, '') || 'i',
          active: p.active !== false,
        }))
    : [...DEFAULT_MATCHING_RULES.aliasPatterns]

  return { version: 1, thresholds, signals, amountComponents, aliasPatterns }
}

/** Old settings stored matchingRules as [{ field, weight, active }, ...]. */
function migrateLegacyRuleList(list) {
  const out = {
    thresholds: { ...DEFAULT_MATCHING_RULES.thresholds },
    signals: { ...DEFAULT_MATCHING_RULES.signals },
    amountComponents: { ...DEFAULT_MATCHING_RULES.amountComponents },
    aliasPatterns: [...DEFAULT_MATCHING_RULES.aliasPatterns],
  }
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const field = String(row.field || '').toLowerCase()
    const weight = Number(row.weight)
    const active = row.active !== false
    if (field === 'full_name' && Number.isFinite(weight)) {
      out.thresholds.nameConfidenceWeight = Math.min(1, Math.max(0, weight / 100))
    }
    if (field === 'aliases') {
      out.signals.useTypoTolerance = { enabled: active, weight: 1 }
    }
    if (field === 'employer') {
      out.signals.useDescription = { enabled: active, weight: 1 }
    }
  }
  return out
}

/** Engine runtime config derived from saved rules. */
export function buildEngineConfig(rules = DEFAULT_MATCHING_RULES) {
  const r = resolveMatchingRules(rules)
  const t = r.thresholds
  const scales = []
  if (r.signals.useBiWeekly?.enabled !== false) scales.push({ scale: 0.5, freq: 'bi-weekly' })
  if (r.signals.useWeekly?.enabled !== false) scales.push({ scale: 0.25, freq: 'weekly' })
  scales.unshift({ scale: 1, freq: 'monthly' })

  return {
    NAME_MIN: t.nameMinScore,
    NAME_STRONG: t.nameStrongScore,
    AUTO_CONFIDENCE: t.autoMatchConfidence,
    AMBIGUITY_GAP: t.ambiguityConfidenceGap,
    NAME_WEIGHT: t.nameConfidenceWeight,
    AMOUNT_WEIGHT: t.amountConfidenceWeight,
    AMOUNT_TOL_PCT: t.amountTolerancePercent,
    AMOUNT_TOL_MIN: t.amountToleranceMin,
    TYPO_FLOOR: r.signals.useTypoTolerance?.enabled === false ? 1 : t.typoToleranceFloor,
    signals: r.signals,
    amountComponents: r.amountComponents,
    installmentScales: scales,
    useSubsetSum: r.signals.useSubsetSum?.enabled !== false,
    aliasPatterns: r.aliasPatterns.filter((p) => p.active),
    rules: r,
  }
}

export function extractIdsWithPatterns(text, patterns = []) {
  const ids = new Set()
  const s = String(text || '')
  for (const p of patterns) {
    if (!p.active) continue
    try {
      const re = new RegExp(p.pattern, p.flags || 'i')
      for (const m of s.matchAll(re)) {
        const cap = m[1] ?? m[0]
        if (cap) ids.add(String(cap).trim())
      }
    } catch {
      /* invalid pattern — skip */
    }
  }
  return [...ids]
}

export function testAliasPattern(pattern, flags, testString) {
  try {
    const re = new RegExp(pattern, flags || 'i')
    const m = re.exec(String(testString || ''))
    return { ok: true, matches: !!m, groups: m ? [...m] : [] }
  } catch (e) {
    return { ok: false, error: e.message, matches: false, groups: [] }
  }
}

/** Dry-run a sample credit against one borrower using current rule set (no DB). */
export async function previewMatchSample(input, rulesPartial = {}) {
  const {
    groupLoansByBorrower,
    buildBorrowerIndex,
    classify,
    setMatchingEngineConfig,
  } = await import('./engine/src/matchingEngine.js')
  const { scoreNameMatch } = await import('./engine/src/nameMatch.js')
  const { reconcileAmount } = await import('./engine/src/matchingEngine.js')

  const engineCfg = buildEngineConfig(rulesPartial)
  setMatchingEngineConfig(engineCfg)

  const payerName = String(input.payerName || '').trim()
  const description = String(input.description || '').trim()
  const amount = Number(input.amount)
  const reference = String(input.reference || '')
  const borrowerName = String(input.borrowerName || payerName).trim()
  const sampleEmi = Number(input.sampleEmi) || amount || 0

  const particulars = description ? `${description} | ${payerName}` : payerName
  const tx = {
    Id: 0,
    FileName: 'preview',
    BorrowerName: payerName,
    Particulars: particulars,
    EmiPaidAmount: amount,
    ReferenceNo: reference,
    TransDate: new Date().toISOString(),
  }

  const loans = [
    {
      LoanNumber: input.loanNumber || 'PREVIEW-001',
      BorrowerId: input.borrowerId || 'preview',
      BorrowerFullName: borrowerName,
      ExpectedEMIAmount: sampleEmi,
      LoanStatus: 'active',
    },
  ]

  const groups = groupLoansByBorrower(loans)
  const index = buildBorrowerIndex(groups)
  const { record, needsAi, candidates } = classify(tx, index)

  const nameFromPayer = payerName ? scoreNameMatch(payerName, borrowerName, { typoFloor: engineCfg.TYPO_FLOOR }) : { score: 0, kind: 'none' }
  const nameFromDesc =
    description && engineCfg.signals?.useDescription?.enabled !== false
      ? scoreNameMatch(description, borrowerName, { typoFloor: engineCfg.TYPO_FLOOR })
      : { score: 0, kind: 'none' }

  const group = [...groups.values()][0]
  const amountRecon = reconcileAmount(amount, group?.loans || [])

  const patternHits = []
  for (const p of engineCfg.aliasPatterns) {
    const fieldText =
      p.field === 'reference'
        ? reference
        : p.field === 'description'
          ? description
          : p.field === 'borrowerName'
            ? payerName
            : particulars
    const test = testAliasPattern(p.pattern, p.flags, fieldText)
    if (test.matches) patternHits.push({ id: p.id, label: p.label, field: p.field, groups: test.groups })
  }

  setMatchingEngineConfig(buildEngineConfig())

  return {
    nameScore: Math.max(nameFromPayer.score, nameFromDesc.score),
    nameKind: nameFromPayer.score >= nameFromDesc.score ? nameFromPayer.kind : nameFromDesc.kind,
    amountMatchKind: amountRecon.kind,
    confidence: record.confidenceScore,
    reviewStatus: record.reviewStatus,
    matchType: record.matchType,
    wouldAutoMatch: record.reviewStatus === 'auto_matched',
    needsAi,
    reasoning: record.reasoning,
    patternHits,
    rulesApplied: {
      autoMatchThreshold: engineCfg.AUTO_CONFIDENCE,
      nameMin: engineCfg.NAME_MIN,
      nameStrong: engineCfg.NAME_STRONG,
    },
  }
}
