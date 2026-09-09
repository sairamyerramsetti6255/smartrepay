import { runBorrowerSync, runDueLoansSync } from '../src/reconciliationManager.js'
import { closePool } from '../src/dataAccess.js'

/**
 * CLI entry point: `npm run sync` — runs the pipeline once and exits.
 * Use `npm run sync -- --legacy` to run the old 3-stage borrower pipeline.
 */
async function main() {
  const legacy = process.argv.includes('--legacy')
  const runner = legacy ? runBorrowerSync : runDueLoansSync
  console.log(`Starting LoanDisk sync (${legacy ? 'legacy borrower pipeline' : 'due_loans fast path'})...`)

  const result = await runner((p) => {
    if (p.phase === 'loans') {
      process.stdout.write(`\r  loans: ${p.processed}/${p.total}   `)
    } else if (p.phase === 'loan_details') {
      process.stdout.write(`\r  loan details: ${p.processed}/${p.total}   `)
    } else if (p.phase === 'due_loans') {
      process.stdout.write(`\r  ${p.branch}: page ${p.page} (${p.count} loans)   `)
    } else {
      console.log(`  ${p.phase}${p.count != null ? `: ${p.count}` : ''}`)
    }
  })
  console.log('\n' + JSON.stringify(result, null, 2))
}

main()
  .catch((e) => {
    console.error('Sync failed:', e.message)
    process.exitCode = 1
  })
  .finally(() => closePool())
