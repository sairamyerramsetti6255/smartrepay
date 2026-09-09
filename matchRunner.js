import { config } from './engine/src/config.js'
import { mapWithConcurrency } from './engine/src/concurrency.js'
import { chatJson, isOpenRouterEnabled } from './engine/src/openrouterClient.js'
import {
  groupLoansByBorrower,
  buildBorrowerIndex,
  classify,
  buildMatchPrompt,
  applyAi,
  setMatchingEngineConfig,
} from './engine/src/matchingEngine.js'
import {
  getBankTransactions,
  getLoanDiskDueRecords,
  saveTransactionMatches,
} from './engine/src/dataAccess.js'
import db from './db.js'
import { buildEngineConfig } from './matchingRules.js'

function loadMatchingEngineConfig() {
  try {
    const row = db.prepare('select value from app_settings where key = ?').get('global')
    const settings = row ? JSON.parse(row.value) : {}
    return buildEngineConfig(settings.matchingRules || settings)
  } catch {
    return buildEngineConfig()
  }
}

/**
 * In-process reconciliation runner. This is the SAME engine that used to live in
 * the separate "Node service" project, now run inside this single backend so the
 * "Run Matching" button no longer spawns a second Node process.
 *
 * It matches Staging_BankTransactions against Staging_LoandiskDueRecords by
 * borrower first/last name + EMI amount (with bi-weekly / summed-EMI support) and
 * uses OpenRouter only for the genuinely ambiguous name ties. Results upsert into
 * Staging_TransactionMatches via CRIF_Operations.
 *
 * Scope: when `fileNames` is a non-empty list, ONLY the staged credits from
 * those uploaded files are (re)classified. Every other file's existing match
 * row is left untouched (Save_TransactionMatches is a per-row MERGE), so you can
 * reconcile one upload at a time instead of re-running the whole book.
 *
 * @param {{ useAi?: boolean, fileNames?: string[]|null, onProgress?: (p: object) => void }} opts
 */
export function isAiAvailable() {
  return isOpenRouterEnabled()
}

export async function runMatch({ useAi = true, fileNames = null, onProgress } = {}) {
  const emit = (p) => {
    try {
      onProgress?.(p)
    } catch {
      // progress sink errors must never abort a run
    }
  }

  const engineCfg = loadMatchingEngineConfig()
  setMatchingEngineConfig(engineCfg)

  try {
  const aiAllowed = useAi && isOpenRouterEnabled() && engineCfg.signals?.useAiAdjudication?.enabled !== false
  emit({ phase: 'starting' })

  const [allBankTx, loans] = await Promise.all([getBankTransactions(), getLoanDiskDueRecords()])

  // Scope to the selected uploaded files, if any.
  const scope =
    Array.isArray(fileNames) && fileNames.length ? new Set(fileNames.map((f) => String(f))) : null
  const bankTx = scope ? allBankTx.filter((t) => scope.has(String(t.FileName))) : allBankTx

  const groups = groupLoansByBorrower(loans)
  const index = buildBorrowerIndex(groups)
  emit({ phase: 'loaded', bankTx: bankTx.length, loans: loans.length, scopedFiles: scope ? scope.size : 0 })

  // Stage 1 — deterministic classification for every transaction.
  const classified = bankTx.map((tx) => ({ tx, ...classify(tx, index) }))
  const tally = () => {
    let matched = 0
    let unmatched = 0
    for (const c of classified) {
      if (c.record.reviewStatus === 'auto_matched' || c.record.reviewStatus === 'confirmed') matched++
      else unmatched++
    }
    return { matched, unmatched }
  }

  // Persist deterministic results immediately so the grid/tiles fill in fast.
  await saveTransactionMatches(classified.map((c) => c.record))

  const aiTargets = aiAllowed ? classified.filter((c) => c.candidates.length && c.needsAi) : []
  {
    const t = tally()
    emit({ phase: 'classified', bankTx: bankTx.length, loans: loans.length, total: aiTargets.length, done: 0, matched: t.matched, unmatched: t.unmatched })
  }

  // Stage 2 — AI adjudication for the ambiguous name ties only.
  let aiOk = 0
  let aiFail = 0
  if (aiTargets.length) {
    // Cap the whole AI phase so a rate-limited free model can't keep the run
    // (and the UI loader) alive for minutes. Once past the deadline, remaining
    // ties keep their deterministic verdict.
    const aiDeadline = Date.now() + config.openrouter.aiPhaseMaxMs
    await mapWithConcurrency(
      aiTargets,
      config.openrouter.concurrency,
      async (item) => {
        if (Date.now() > aiDeadline) {
          item.record.reasoning = `[AI skipped: time budget exhausted] ${item.record.reasoning || ''}`.slice(0, 1000)
          aiFail++
          return
        }
        const { system, user } = buildMatchPrompt(item.tx, item.candidates)
        try {
          const res = await chatJson({
            system,
            user,
            retries: config.openrouter.aiCallRetries,
            timeoutMs: config.openrouter.aiCallTimeoutMs,
          })
          item.record = applyAi(item.tx, item.candidates, res)
          aiOk++
        } catch (e) {
          item.record.reasoning = `[AI failed: ${e.message}] ${item.record.reasoning || ''}`.slice(0, 1000)
          aiFail++
        }
      },
      (done, total) => {
        if (done % 5 === 0 || done === total) {
          const t = tally()
          emit({ phase: 'ai', done, total, matched: t.matched, unmatched: t.unmatched })
        }
      }
    )
  }

  const matches = classified.map((c) => c.record)
  const saved = await saveTransactionMatches(matches)
  const by = (pred) => matches.filter(pred).length
  const t = tally()
  const summary = {
    total: saved,
    autoMatched: by((m) => m.reviewStatus === 'auto_matched'),
    unmatched: by((m) => m.reviewStatus === 'unmatched'),
    ai: aiOk,
    aiFailed: aiFail,
  }
  emit({ phase: 'done', matched: t.matched, unmatched: t.unmatched })
  return summary
  } finally {
    setMatchingEngineConfig(buildEngineConfig())
  }
}
