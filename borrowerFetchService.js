import { randomUUID } from 'crypto'
import { rowBorrower } from './db.js'
import { fetchBorrowerById } from './loandisk.js'
import { upsertLoansForBorrower } from './loanDiskLoans.js'

const CACHE_TTL_MS = 30 * 60 * 1000
const jobs = new Map()

function upsertBorrowerRecord(db, b) {
  const existing = db.prepare('select id from borrowers where loandisk_id = ?').get(b.loandisk_id)
  const aliasesJson = JSON.stringify(b.aliases || [])

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
  return { id, created: true }
}

function resolveLocal(db, param) {
  const local = db.prepare('select * from borrowers where id = ? or loandisk_id = ?').get(param, param)
  const loandiskId = String(local?.loandisk_id || param).trim()
  return { local, loandiskId, localId: local?.id || null }
}

function buildLocalPayload(db, local, localId, apiExtras = null) {
  const borrower = local
    ? {
        ...rowBorrower(local),
        ...(apiExtras || {}),
      }
    : apiExtras
      ? { loandisk_id: apiExtras.loandisk_id, ...apiExtras }
      : null

  const loans = localId ? db.prepare('select * from loans where borrower_id = ?').all(localId) : []
  return { borrower, loans }
}

function enrichBorrowerFromApi(dbRow, apiBorrower) {
  if (!dbRow || !apiBorrower) return dbRow
  return {
    ...dbRow,
    email: apiBorrower.email ?? null,
    mobile: apiBorrower.mobile ?? null,
    unique_number: apiBorrower.unique_number ?? null,
    loan_amount: apiBorrower.loan_amount ?? null,
    emi: apiBorrower.emi ?? null,
  }
}

async function persistBorrowerFetch(db, loandiskId, localId) {
  const result = await fetchBorrowerById(loandiskId)
  let resolvedLocalId = localId

  if (result.borrower) {
    const apiBorrower = result.borrower
    const upserted = upsertBorrowerRecord(db, apiBorrower)
    resolvedLocalId = upserted.id
    const dbRow = rowBorrower(db.prepare('select * from borrowers where id = ?').get(resolvedLocalId))
    result.borrower = enrichBorrowerFromApi(dbRow, apiBorrower)
  }

  if (resolvedLocalId && result.loans?.length) {
    result.loans = upsertLoansForBorrower(db, resolvedLocalId, result.loans)
  } else if (resolvedLocalId) {
    result.loans = db.prepare('select * from loans where borrower_id = ?').all(resolvedLocalId)
  }

  return { ...result, status: 'ready', loandiskId }
}

function shouldStartFetch(job, force) {
  if (force) return true
  if (!job) return true
  if (job.status === 'running') return false
  if (job.status === 'failed') return false
  if (job.status === 'completed' && Date.now() - (job.finishedAt || 0) > CACHE_TTL_MS) return true
  return false
}

export function startBorrowerFetch(db, loandiskId, localId, { force = false } = {}) {
  const key = String(loandiskId)
  const existing = jobs.get(key)

  if (existing?.status === 'running') return existing
  if (existing?.status === 'completed' && !force && Date.now() - (existing.finishedAt || 0) <= CACHE_TTL_MS) {
    return existing
  }
  if (!shouldStartFetch(existing, force)) return existing

  const state = {
    status: 'running',
    startedAt: Date.now(),
    result: null,
    error: null,
    loandiskId: key,
  }
  jobs.set(key, state)

  persistBorrowerFetch(db, key, localId)
    .then((payload) => {
      state.status = 'completed'
      state.result = payload
      state.finishedAt = Date.now()
      state.error = null
    })
    .catch((e) => {
      state.status = 'failed'
      state.error = e.message
      state.finishedAt = Date.now()
      console.warn(`Borrower fetch ${key}:`, e.message)
    })

  return state
}

export function getBorrowerResponse(db, param, { force = false } = {}) {
  const { local, loandiskId, localId } = resolveLocal(db, param)
  const job = jobs.get(loandiskId)
  const localPayload = buildLocalPayload(db, local, localId)

  if (job?.status === 'completed' && job.result && !force) {
    return {
      ...job.result,
      status: 'ready',
      cached: true,
      fetchedAt: job.finishedAt,
    }
  }

  if (job?.status === 'failed' && !force) {
    return {
      status: 'failed',
      borrower: localPayload.borrower,
      loans: localPayload.loans,
      error: job.error,
      loandiskId,
      message: job.error,
    }
  }

  if (job?.status !== 'running' && shouldStartFetch(job, force)) {
    startBorrowerFetch(db, loandiskId, localId, { force })
  }

  const active = jobs.get(loandiskId)

  if (active?.status === 'completed' && active.result) {
    return {
      ...active.result,
      status: 'ready',
      cached: true,
      fetchedAt: active.finishedAt,
    }
  }

  if (active?.status === 'failed') {
    return {
      status: 'failed',
      borrower: localPayload.borrower,
      loans: localPayload.loans,
      error: active.error,
      loandiskId,
      message: active.error,
    }
  }

  const hasCachedLoans = localPayload.loans.some((l) => l.emi != null && Number(l.emi) > 0)

  return {
    status: 'loading',
    borrower: localPayload.borrower,
    loans: localPayload.loans,
    loandiskId,
    cached: hasCachedLoans,
    message: 'Fetching loan & EMI data from LoanDisk — this may take 1–2 minutes…',
    startedAt: active?.startedAt || Date.now(),
  }
}
