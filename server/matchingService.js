import { randomUUID } from 'crypto'
import { rowBorrower } from './db.js'
import { bestMatchFromCandidates, createCandidateMatcher, detectExceptionType } from './matcher.js'
import { yieldEventLoop } from './asyncUtil.js'
import { fetchBorrowersForTransactions, fetchAllBorrowers } from './loandisk.js'

const LARGE_BATCH = 200
const MAX_BORROWER_SEARCH_TERMS = 300

function loanDiskConfigured() {
  return !!(process.env.LOANDISK_USERNAME || process.env.LOANDISK_PASSWORD || process.env.LOANDISK_ACCESS_TOKEN)
}

function getSettings(db) {
  const row = db.prepare('select value from app_settings where key = ?').get('global')
  return row ? JSON.parse(row.value) : {}
}

function audit(db, entity, entityId, action, actor, priorValue, newValue) {
  db.prepare(
    `insert into audit_log (id, entity, entity_id, action, actor, prior_value, new_value) values (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    entity,
    entityId || null,
    action,
    actor,
    priorValue ? JSON.stringify(priorValue) : null,
    newValue ? JSON.stringify(newValue) : null
  )
}

function upsertBorrowerRecord(db, b) {
  const existing = db.prepare('select id from borrowers where loandisk_id = ?').get(b.loandisk_id)
  const aliasesJson = JSON.stringify(b.aliases || [])

  const loanNum = b.unique_number || `LD-${b.loandisk_id}`
  const emi = b.emi != null && !isNaN(Number(b.emi)) ? Number(b.emi) : null
  const balance = b.loan_amount != null && !isNaN(Number(b.loan_amount)) ? Number(b.loan_amount) : null

  if (existing) {
    db.prepare(
      `update borrowers set full_name = ?, first_name = ?, last_name = ?, employer = ?, aliases = ?, branch_id = ?, branch_name = ? where id = ?`
    ).run(
      b.full_name,
      b.first_name,
      b.last_name,
      b.employer,
      aliasesJson,
      b.branch_id,
      b.branch_name,
      existing.id
    )
    const loanRow = db.prepare('select id from loans where borrower_id = ?').get(existing.id)
    if (loanRow && (emi != null || balance != null)) {
      db.prepare(
        'update loans set outstanding_balance = coalesce(?, outstanding_balance), emi = coalesce(?, emi) where borrower_id = ?'
      ).run(balance, emi, existing.id)
    }
    return { id: existing.id, created: false }
  }

  const id = randomUUID()
  db.prepare(
    `insert into borrowers (id, full_name, first_name, last_name, employer, aliases, loandisk_id, branch_id, branch_name)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    b.full_name,
    b.first_name,
    b.last_name,
    b.employer,
    aliasesJson,
    b.loandisk_id,
    b.branch_id,
    b.branch_name
  )

  const loanExists = db.prepare('select id from loans where loan_number = ?').get(loanNum)
  if (!loanExists) {
    db.prepare(
      'insert into loans (id, borrower_id, loan_number, outstanding_balance, emi, status) values (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), id, loanNum, balance, emi, 'active')
  } else if (emi != null || balance != null) {
    db.prepare(
      'update loans set outstanding_balance = coalesce(?, outstanding_balance), emi = coalesce(?, emi) where loan_number = ?'
    ).run(balance, emi, loanNum)
  }
  return { id, created: true }
}

async function loadAllBorrowersFallback() {
  const { borrowers } = await fetchAllBorrowers()
  return borrowers
}

/** Runs in a worker thread — must not block the main Express process. */
export async function runMatchingBatch(db, actor, onProgress) {
  const report = (patch) => onProgress?.(patch)

  const settings = getSettings(db)
  const threshold = settings.autoApproveThreshold ?? 80
  let localBorrowers = db.prepare('select * from borrowers').all().map(rowBorrower)
  const toMatch = db
    .prepare("select * from transactions where status in ('pending', 'exception') order by date asc")
    .all()
  const allTx = db.prepare('select * from transactions').all()
  const docFilenames = new Map(
    db.prepare('select id, filename from documents').all().map((d) => [d.id, d.filename])
  )

  report({ phase: 'preparing', processed: 0, total: toMatch.length, matched: 0, excepted: 0 })
  await yieldEventLoop()

  let apiPool = []
  let byPayer = new Map()
  let searchSource = 'local'
  let searchError = null
  let termsSearched = 0
  let searchBatches = 0

  // Large files: one GetAllBorrowers call beats thousands of BorrowerSerch batches
  if (loanDiskConfigured()) {
    report({ phase: 'loading_borrowers', processed: 0, total: toMatch.length, matched: 0, excepted: 0 })
    try {
      const all = await loadAllBorrowersFallback()
      if (all.length) {
        apiPool = all
        searchSource = 'GetAllBorrowers'
        for (const b of all) upsertBorrowerRecord(db, b)
        localBorrowers.splice(0, localBorrowers.length, ...db.prepare('select * from borrowers').all().map(rowBorrower))
      }
    } catch (e) {
      searchError = e.message
      console.warn('GetAllBorrowers failed:', e.message)
    }
  }

  const uniquePayerCount = new Set(toMatch.map((t) => String(t.payer || '').trim().toLowerCase()).filter(Boolean)).size
  const useTargetedSearch =
    loanDiskConfigured() &&
    toMatch.length <= LARGE_BATCH &&
    uniquePayerCount <= MAX_BORROWER_SEARCH_TERMS

  if (useTargetedSearch) {
    try {
      const searchResult = await fetchBorrowersForTransactions(toMatch, report)
      for (const b of searchResult.apiPool) {
        if (!apiPool.some((x) => x.loandisk_id === b.loandisk_id)) apiPool.push(b)
      }
      for (const [key, list] of searchResult.byPayer) byPayer.set(key, list)
      termsSearched = searchResult.termsSearched
      searchBatches = searchResult.batches
      searchSource = searchSource === 'GetAllBorrowers' ? 'GetAllBorrowers+BorrowerSerch' : 'BorrowerSerch'
    } catch (e) {
      if (!searchError) searchError = e.message
      console.warn('BorrowerSerch failed:', e.message)
    }
  }

  const poolById = new Map()
  for (const b of [...localBorrowers, ...apiPool]) {
    if (b.loandisk_id) poolById.set(b.loandisk_id, b)
  }
  apiPool = [...poolById.values()]

  let matched = 0
  let excepted = 0
  const loans = db.prepare('select * from loans').all()
  const loanByBorrower = new Map(loans.map((l) => [l.borrower_id, l]))
  const loanByLoandisk = new Map()
  for (const b of [...localBorrowers, ...apiPool]) {
    if (!b.loandisk_id) continue
    const loan = b.id ? loanByBorrower.get(b.id) : null
    loanByLoandisk.set(b.loandisk_id, {
      emi: loan?.emi ?? b.emi ?? null,
      outstanding_balance: loan?.outstanding_balance ?? b.loan_amount ?? null,
    })
  }
  const matchFromPool = apiPool.length ? createCandidateMatcher(apiPool, loanByLoandisk) : null
  const matchFromLocal = localBorrowers.length ? createCandidateMatcher(localBorrowers, loanByBorrower) : null

  report({ phase: 'matching', processed: 0, total: toMatch.length, matched: 0, excepted: 0 })

  for (let i = 0; i < toMatch.length; i++) {
    const rawTx = toMatch[i]
    const docName = rawTx.source_document_id ? docFilenames.get(rawTx.source_document_id) : ''
    const tx = {
      ...rawTx,
      description: [rawTx.description, docName].filter(Boolean).join(' '),
      reference: [rawTx.reference, docName?.replace(/\.[^.]+$/, '')].filter(Boolean).join(' '),
    }
    const payerKey = String(tx.payer || '').trim().toLowerCase()
    const payerCandidates = byPayer.get(payerKey) || []

    let { borrower, score } = payerCandidates.length
      ? bestMatchFromCandidates(tx, payerCandidates, loanByLoandisk)
      : { borrower: null, score: 0 }
    if (score < threshold && matchFromLocal) {
      const localMatch = matchFromLocal(tx)
      if (localMatch.score > score) {
        borrower = localMatch.borrower
        score = localMatch.score
      }
    }
    if (score < threshold && matchFromPool) {
      const poolMatch = matchFromPool(tx)
      if (poolMatch.score > score) {
        borrower = poolMatch.borrower
        score = poolMatch.score
      }
    }

    let resolvedBorrower = borrower
    if (borrower?.loandisk_id) {
      const { id } = upsertBorrowerRecord(db, borrower)
      resolvedBorrower = rowBorrower(db.prepare('select * from borrowers where id = ?').get(id))
      const loanRow = db.prepare('select * from loans where borrower_id = ?').get(id)
      if (loanRow) loanByBorrower.set(id, loanRow)
    }

    const loan = resolvedBorrower ? loanByBorrower.get(resolvedBorrower.id) : null

    if (score >= threshold && resolvedBorrower) {
      db.prepare(
        `update transactions set status = 'matched', confidence_score = ?, matched_borrower_id = ?, loan_id = ? where id = ?`
      ).run(score, resolvedBorrower.id, loan?.id || null, tx.id)
      db.prepare(
        `update exceptions set status = 'resolved', resolved_at = datetime('now')
         where transaction_id = ? and status = 'open'`
      ).run(tx.id)
      matched++
    } else {
      const exType = detectExceptionType(tx, allTx, score)
      db.prepare(
        `update transactions set status = 'exception', confidence_score = ?, matched_borrower_id = ? where id = ?`
      ).run(score, resolvedBorrower?.id || null, tx.id)
      const existing = db
        .prepare("select id from exceptions where transaction_id = ? and status = 'open'")
        .get(tx.id)
      if (!existing) {
        const sla = settings.slaHours?.[exType] ?? 24
        db.prepare(
          `insert into exceptions (id, transaction_id, type, status, assigned_to, sla_hours) values (?, ?, ?, 'open', ?, ?)`
        ).run(randomUUID(), tx.id, exType, actor, sla)
      }
      excepted++
    }

    if (i % 5 === 0 || i === toMatch.length - 1) {
      report({ phase: 'matching', processed: i + 1, total: toMatch.length, matched, excepted })
      await yieldEventLoop()
    }
  }

  report({ phase: 'done', processed: toMatch.length, total: toMatch.length, matched, excepted })

  audit(db, 'matching', null, 'run', actor, null, {
    matched,
    excepted,
    searchSource,
    termsSearched,
    candidatesFound: apiPool.length,
    searchError,
  })

  return {
    matched,
    excepted,
    pending: toMatch.length,
    borrowers: db.prepare('select count(*) as c from borrowers').get().c,
    searchSource,
    termsSearched,
    candidatesFound: apiPool.length,
    searchError,
  }
}
