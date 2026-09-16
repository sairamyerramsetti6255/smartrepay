import { randomUUID } from 'crypto'
import db from './db.js'

function normalizeEmployerKey(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 80)
}

export function listEmployerMappings(employerKey = null) {
  if (employerKey) {
    return db
      .prepare('select * from employer_employee_map where employer_key = ? and active = 1 order by borrower_name')
      .all(normalizeEmployerKey(employerKey))
  }
  return db.prepare('select * from employer_employee_map where active = 1 order by employer_key, borrower_name').all()
}

export function upsertEmployerMapping({ employerKey, employerLabel, borrowerId, borrowerName, loanNumber }) {
  const key = normalizeEmployerKey(employerKey)
  if (!key || !borrowerName) throw new Error('Employer key and borrower name are required')
  const id = randomUUID()
  db.prepare(`
    insert into employer_employee_map (id, employer_key, employer_label, borrower_id, borrower_name, loan_number, active)
    values (?, ?, ?, ?, ?, ?, 1)
    on conflict(employer_key, borrower_name, loan_number) do update set
      employer_label = excluded.employer_label,
      borrower_id = excluded.borrower_id,
      active = 1
  `).run(id, key, employerLabel || null, borrowerId || null, String(borrowerName).trim(), loanNumber || null)
  return listEmployerMappings(key)
}

/**
 * Store remittance schedule lines. Allocation to bank credits is staff-driven;
 * this never auto-matches by amount alone.
 */
export function saveRemittanceSchedule({ employerKey, fileName, lines = [] }) {
  const key = normalizeEmployerKey(employerKey)
  if (!key) throw new Error('Employer key is required')
  const insert = db.prepare(`
    insert into employer_remittance_lines
      (id, employer_key, file_name, employee_name, amount, loan_number, borrower_id, status)
    values (?, ?, ?, ?, ?, ?, ?, 'pending')
  `)
  const saved = []
  const tx = db.transaction(() => {
    for (const line of lines) {
      const name = String(line.employeeName || line.name || '').trim()
      const amount = Number(line.amount)
      if (!name || !Number.isFinite(amount) || amount <= 0) continue
      const id = randomUUID()
      insert.run(
        id,
        key,
        fileName || null,
        name,
        amount,
        line.loanNumber || null,
        line.borrowerId || null
      )
      saved.push({ id, employerKey: key, employeeName: name, amount })
    }
  })
  tx()
  return { employerKey: key, saved: saved.length, lines: saved }
}

export function listRemittanceLines(employerKey) {
  const key = normalizeEmployerKey(employerKey)
  return db
    .prepare('select * from employer_remittance_lines where employer_key = ? order by created_at desc limit 500')
    .all(key)
}

export { normalizeEmployerKey }
