import { config } from './engine/src/config.js'
import { mapWithConcurrency } from './engine/src/concurrency.js'
import { chatJson, isOpenRouterEnabled } from './engine/src/openrouterClient.js'
import {
  groupLoansByBorrower,
  buildBorrowerIndex,
  classify,
  buildMatchPrompt,
  applyAi,
} from './engine/src/matchingEngine.js'
import {
  getBankTransactions,
  getLoanDiskDueRecords,
  saveTransactionMatches,
} from './engine/src/dataAccess.js'

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
 * @param {{ useAi?: boolean, onProgress?: (p: object) => void }} opts
 */
export function isAiAvailable() {
  return isOpenRouterEnabled()
}

export async function runMatch({ useAi = true, onProgress } = {}) {
  const emit = (p) => {
    try {
      onProgress?.(p)
    } catch {
      // progress sink errors must never abort a run
    }
  }

  const ai = useAi && isOpenRouterEnabled()
  emit({ phase: 'starting' })

  const [bankTx, loans] = await Promise.all([getBankTransactions(), getLoanDiskDueRecords()])
  const groups = groupLoansByBorrower(loans)
  const index = buildBorrowerIndex(groups)
  emit({ phase: 'loaded', bankTx: bankTx.length, loans: loans.length })

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

  const aiTargets = ai ? classified.filter((c) => c.candidates.length && c.needsAi) : []
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
}
