import { randomUUID } from 'crypto'
import { normalizeLoanDiskBorrower } from './loandisk.js'
import { fetchAllBorrowers } from './loandisk.js'
import { yieldEventLoop } from './asyncUtil.js'

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

  const loanNum = b.unique_number || `LD-${b.loandisk_id}`
  const loanExists = db.prepare('select id from loans where loan_number = ?').get(loanNum)
  if (!loanExists) {
    db.prepare(
      'insert into loans (id, borrower_id, loan_number, outstanding_balance, status) values (?, ?, ?, ?, ?)'
    ).run(randomUUID(), id, loanNum, null, 'active')
  }
  return { id, created: true }
}

async function importBorrowerBatch(db, borrowers, actor, meta = {}, onProgress) {
  let created = 0
  let updated = 0

  for (let i = 0; i < borrowers.length; i++) {
    const raw = borrowers[i]
    const b = raw.loandisk_id && raw.full_name ? raw : normalizeLoanDiskBorrower(raw.raw || raw)
    if (b?.loandisk_id) {
      const result = upsertBorrowerRecord(db, b)
      if (result.created) created++
      else updated++
    }
    if (i % 25 === 0) {
      onProgress?.({ processed: i, total: borrowers.length, created, updated })
      await yieldEventLoop()
    }
  }

  audit(db, 'loandisk', null, 'import_borrowers', actor, null, { created, updated, ...meta })
  return { created, updated, synced: created + updated, total: borrowers.length, source: 'GetAllBorrowers', ...meta }
}

export async function runBorrowerSync(db, actor, onProgress) {
  const { borrowers, total, orgId, source, branches, totalReported, message } = await fetchAllBorrowers()
  return importBorrowerBatch(db, borrowers, actor, { total, orgId, source, branches, totalReported, message }, onProgress)
}
