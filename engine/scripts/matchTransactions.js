import { config } from '../src/config.js'
import { mapWithConcurrency } from '../src/concurrency.js'
import { chatJson, isOpenRouterEnabled } from '../src/openrouterClient.js'
import {
  groupLoansByBorrower,
  buildBorrowerIndex,
  classify,
  buildMatchPrompt,
  applyAi,
} from '../src/matchingEngine.js'
import {
  getBankTransactions,
  getLoanDiskDueRecords,
  saveTransactionMatches,
  closePool,
} from '../src/dataAccess.js'

/**
 * Match bank/payroll credits (Staging_BankTransactions) to LoanDisk due loans
 * (Staging_LoandiskDueRecords) by borrower first/last name + EMI amount, with
 * subset-sum support (one deposit settling several loans) and an OpenRouter
 * confidence score for the borderline cases. Results upsert into
 * Staging_TransactionMatches.
 *
 * Flags:
 *   --no-ai    deterministic only (skip OpenRouter)
 *   --ai-all   send every candidate to the LLM (not just borderline ones)
 */
const args = new Set(process.argv.slice(2))
const useAi = !args.has('--no-ai') && isOpenRouterEnabled()
const aiAll = args.has('--ai-all')

async function main() {
  const [bankTx, loans] = await Promise.all([getBankTransactions(), getLoanDiskDueRecords()])
  const groups = groupLoansByBorrower(loans)
  const index = buildBorrowerIndex(groups)

  console.log(
    `Bank transactions: ${bankTx.length} | LoanDisk loans: ${loans.length} (${groups.size} borrowers)`
  )
  console.log(
    useAi
      ? `AI: enabled (${config.openrouter.model}, concurrency ${config.openrouter.concurrency}${aiAll ? ', ALL candidates' : ''})`
      : 'AI: disabled — deterministic only'
  )

  // Stage 1 — deterministic classification for every transaction.
  const classified = bankTx.map((tx) => ({ tx, ...classify(tx, index) }))

  // Live tally (matched vs unmatched) emitted as a machine-readable line that the
  // Express runner parses for the on-screen "matched / unmatched" boxes.
  const tally = () => {
    let matched = 0
    let unmatched = 0
    for (const c of classified) {
      if (c.record.reviewStatus === 'auto_matched' || c.record.reviewStatus === 'confirmed') matched++
      else unmatched++
    }
    return { matched, unmatched }
  }
  const emit = (obj) => console.log('@progress ' + JSON.stringify(obj))

  const det = (pred) => classified.filter((c) => pred(c.record)).length
  console.log(
    `Deterministic: ${det((m) => m.reviewStatus === 'auto_matched')} matched · ` +
      `${det((m) => m.reviewStatus === 'unmatched')} unmatched`
  )

  // Stage 2 — AI adjudication for the borderline / ambiguous ones only.
  const aiTargets = useAi
    ? classified.filter((c) => c.candidates.length && (aiAll || c.needsAi))
    : []
  console.log(`AI-eligible (ambiguous) transactions: ${classified.filter((c) => c.candidates.length && c.needsAi).length}`)

  // Persist the deterministic results IMMEDIATELY so the Match grid + tiles fill in
  // within seconds. The AI phase below only refines the ambiguous subset and re-saves.
  await saveTransactionMatches(classified.map((c) => c.record))
  {
    const t = tally()
    emit({ phase: 'classified', bankTx: bankTx.length, loans: loans.length, total: aiTargets.length, done: 0, matched: t.matched, unmatched: t.unmatched })
  }

  let aiOk = 0
  let aiFail = 0
  if (aiTargets.length) {
    console.log(`Sending ${aiTargets.length} transactions to the LLM for adjudication...`)
    await mapWithConcurrency(
      aiTargets,
      config.openrouter.concurrency,
      async (item) => {
        const { system, user } = buildMatchPrompt(item.tx, item.candidates)
        try {
          const ai = await chatJson({ system, user })
          item.record = applyAi(item.tx, item.candidates, ai)
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

  // --- summary -------------------------------------------------------------
  const by = (pred) => matches.filter(pred).length
  const multi = matches.filter((m) => m.loanCount > 1)
  console.log('\nMatch summary')
  console.log(`  auto_matched            : ${by((m) => m.reviewStatus === 'auto_matched')}`)
  console.log(`  unmatched               : ${by((m) => m.reviewStatus === 'unmatched')}`)
  console.log(`  name_and_amount         : ${by((m) => m.matchType === 'name_and_amount')}`)
  console.log(`  multi-loan (summed EMIs): ${multi.length}`)
  console.log(`  decided by AI           : ${aiOk}${aiFail ? ` (failed ${aiFail})` : ''}`)
  console.log(`  total upserted          : ${saved} -> Staging_TransactionMatches`)

  if (multi.length) {
    console.log('\nSample multi-loan matches (one deposit paying several EMIs):')
    console.log(
      JSON.stringify(
        multi.slice(0, 5).map((m) => ({
          borrower: m.loanDiskBorrowerName,
          paid: m.emiPaidAmount,
          loans: m.matchedLoanNumbers,
          summedEMI: m.summedExpectedEmi,
          kind: m.amountMatchKind,
          confidence: m.confidenceScore,
        })),
        null,
        2
      )
    )
  }
}

main()
  .catch((e) => {
    console.error('Matching failed:', e.message)
    process.exitCode = 1
  })
  .finally(() => closePool())
