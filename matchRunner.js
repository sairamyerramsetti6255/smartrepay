import { loadPaymentHistory } from './paymentHistory.js'
import { assessPayment } from './engine/src/paymentAssessment.js'
import { groupLoansByBorrower, buildBorrowerIndex, classify, applyRepaymentHistoryMatch, typicalCentsFromRepaymentRows } from './engine/src/matchingEngine.js'
import { getBankTransactions, getLoanDiskDueRecords, getMatchHistory, getTypicalRepaymentAmounts, saveTransactionMatches } from './engine/src/dataAccess.js'
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
  const [allBankTx, loans, history, repaymentAmounts] = await Promise.all([
    getBankTransactions(),
    getLoanDiskDueRecords(),
    getMatchHistory(),
    getTypicalRepaymentAmounts(),
  ])
  const scope = Array.isArray(fileNames) && fileNames.length ? new Set(fileNames.map(String)) : null
  const protectedIds = new Set(history.filter((r) => (['confirmed', 'rejected'].includes(r.ReviewStatus) || (r.ReviewStatus === 'auto_matched' && r.MatchMethod === 'manual'))).map((r) => String(r.Id)))
  const scoped = allBankTx.filter((t) => !scope || scope.has(String(t.FileName)))
  const bankTx = scoped.filter((t) => !protectedIds.has(String(t.Id)))
  const master = new Map(db.prepare('select loandisk_id, aliases, employer from borrowers where loandisk_id is not null').all().map((b) => [String(b.loandisk_id), b]))
  const groups = groupLoansByBorrower(loans.map((loan) => ({ ...loan,
    Aliases: loan.Aliases || master.get(String(loan.BorrowerId))?.aliases,
    Employer: loan.Employer || master.get(String(loan.BorrowerId))?.employer,
    HistoricalPaymentCents: repaymentAmounts.get(String(loan.LoanNumber)) || [],
  })))
  const index = buildBorrowerIndex(groups, history)
  emit({ phase: 'loaded', bankTx: bankTx.length, loans: loans.length, scopedFiles: scope?.size || 0 })
  // Fetch once per selected loan, with bounded concurrency. No LoanDisk writes.
  const drafts = bankTx.map(tx => ({ tx, record: classify(tx, index, engineCfg).record }))
  const loanIds = new Set()
  for (const { record } of drafts) {
    if (record.loanNumber) loanIds.add(record.loanNumber)
    const group = groups.get(`id:${record.borrowerId}`)
    if (group && (record.firstLastIdentity || record.independentFirstLast) && !record.historyMatched) {
      for (const loan of group.loans) if (loan.loanNumber) loanIds.add(loan.loanNumber)
    }
  }
  const ledgers = new Map()
  const loanIdList = [...loanIds]
  let next = 0, loaded = 0
  await Promise.all(Array.from({length: Math.min(4, loanIdList.length)}, async () => {
    while (next < loanIdList.length) {
      const loanId = loanIdList[next++]
      const loan = [...groups.values()].flatMap(g=>g.loans).find(l=>l.loanNumber===loanId)
      ledgers.set(loanId, loan ? await loadPaymentHistory(loan) : { rows: [], complete: false })
      emit({ phase: 'payment-history', done: ++loaded, total: loanIdList.length })
    }
  }))
  const matches = []
  const counts = { matched: 0, unmatched: 0, needsReview: 0 }
  for (const { tx, record: draft } of drafts) {
    const group = groups.get(`id:${draft.borrowerId}`)
    const typical = new Map()
    for (const loan of group?.loans || []) {
      const fromSql = loan.historicalPaymentCents || []
      const fromLedger = typicalCentsFromRepaymentRows(ledgers.get(loan.loanNumber)?.rows || []).get(String(loan.loanNumber)) || []
      typical.set(String(loan.loanNumber), [...new Set([...fromSql, ...fromLedger])])
    }
    let record = applyRepaymentHistoryMatch(draft, group?.loans || [], typical, engineCfg)
    const loan = group?.loans.find(l=>l.loanNumber===record.loanNumber)
    const historyPerfect = record.historyMatched && Number(record.confidenceScore) >= 100
    if (loan && !historyPerfect) {
      const assessment = assessPayment(tx, loan, ledgers.get(record.loanNumber))
      record.paymentAssessment = assessment
      if (assessment.requiresReview) {
        record.matchType = 'review_required'
        record.emiCount = null
      }
      record.reasoning = record.reasoning.replace(/^(\[[^\]]+\] )/, `$1${assessment.explanation} `).slice(0, 1000)
    } else if (historyPerfect) {
      record.matchType = 'name_and_amount'
      record.emiCount = record.emiCount || 1
    }
    matches.push(record)
    if (record.reviewStatus === 'auto_matched') counts.matched++
    else if (record.reviewStatus === 'unmatched') counts.unmatched++
    if (record.reviewStatus === 'needs_review') counts.needsReview++
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
