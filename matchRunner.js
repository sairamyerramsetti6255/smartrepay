import { groupLoansByBorrower, buildBorrowerIndex, classify } from './engine/src/matchingEngine.js'
import { getBankTransactions, getLoanDiskDueRecords, getMatchHistory, saveTransactionMatches } from './engine/src/dataAccess.js'
import db from './db.js'
import { buildEngineConfig } from './matchingRules.js'
import { yieldEventLoop } from './asyncUtil.js'

function loadMatchingEngineConfig() {
  const row = db.prepare('select value from app_settings where key = ?').get('global')
  const settings = row ? JSON.parse(row.value) : {}
  return buildEngineConfig(settings.matchingRules || settings)
}

// Retained for API compatibility. Models cannot adjudicate borrower identities.
export function isAiAvailable() { return false }

/** Match selected files against the existing master; human reviews are preserved. */
export async function runMatch({ fileNames = null, onProgress } = {}) {
  const emit = (progress) => { try { onProgress?.(progress) } catch { /* UI disconnect must not abort the run. */ } }
  const engineCfg = loadMatchingEngineConfig()
  emit({ phase: 'starting' })
  const [allBankTx, loans, history] = await Promise.all([getBankTransactions(), getLoanDiskDueRecords(), getMatchHistory()])
  const scope = Array.isArray(fileNames) && fileNames.length ? new Set(fileNames.map(String)) : null
  const protectedIds = new Set(history.filter((r) => (['confirmed', 'rejected'].includes(r.ReviewStatus) || (r.ReviewStatus === 'auto_matched' && r.MatchMethod === 'manual'))).map((r) => String(r.Id)))
  const scoped = allBankTx.filter((t) => !scope || scope.has(String(t.FileName)))
  const bankTx = scoped.filter((t) => !protectedIds.has(String(t.Id)))
  const master = new Map(db.prepare('select loandisk_id, aliases, employer from borrowers where loandisk_id is not null').all().map((b) => [String(b.loandisk_id), b]))
  const groups = groupLoansByBorrower(loans.map((loan) => ({ ...loan,
    Aliases: loan.Aliases || master.get(String(loan.BorrowerId))?.aliases,
    Employer: loan.Employer || master.get(String(loan.BorrowerId))?.employer,
  })))
  const index = buildBorrowerIndex(groups, history)
  emit({ phase: 'loaded', bankTx: bankTx.length, loans: loans.length, scopedFiles: scope?.size || 0 })
  const matches = []
  const counts = { matched: 0, unmatched: 0, needsReview: 0 }
  for (const tx of bankTx) {
    const record = classify(tx, index, engineCfg).record
    matches.push(record)
    if (record.reviewStatus === 'auto_matched') counts.matched++
    else if (record.reviewStatus === 'needs_review') counts.needsReview++
    else counts.unmatched++
    if (record.matchType === 'review_required') counts.needsReview++
    if (matches.length % 50 === 0) {
      emit({ phase: 'classifying', done: matches.length, total: bankTx.length, ...counts })
      await yieldEventLoop()
    }
  }
  const saved = await saveTransactionMatches(matches)
  const summary = { total: saved, autoMatched: counts.matched, unmatched: counts.unmatched, needsReview: counts.needsReview,
    preserved: scoped.length - bankTx.length, ai: 0, aiFailed: 0 }
  emit({ phase: 'done', done: matches.length, total: bankTx.length, ...counts })
  return summary
}
