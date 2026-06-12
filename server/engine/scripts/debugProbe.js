import { config } from '../src/config.js'

/**
 * Diagnostic: verifies the loaded token and hits due_loans once.
 *
 * NOTE: environment variables set in your shell override .env (dotenv does not
 * override existing vars). If you see a short/"dummy" token below, clear the
 * shell var first:  Remove-Item Env:LOANDISK_AUTH_TOKEN
 */
const { baseUrl, publicKey, authToken, branches } = config.loandisk
const branch = branches[0]

console.log('publicKey:', publicKey)
console.log('branch:', JSON.stringify(branch))
console.log('token length:', authToken.length, '(expected 40)')

const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
const today = new Date()
const from = new Date(today); from.setMonth(today.getMonth() - 1)
const to = new Date(today); to.setMonth(today.getMonth() + 1)

const ctrl = new AbortController()
const t = setTimeout(() => ctrl.abort(), 25000)
try {
  const res = await fetch(`${baseUrl}/${publicKey}/${branch.id}/due_loans`, {
    method: 'POST',
    headers: { Authorization: `Basic ${authToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 1,
      count: 3,
      from_collection_date: fmt(from),
      to_collection_date: fmt(to),
      return_fields: 'loan_number,full_name,amortization_due,loan_balance,last_repayment,loan_status',
    }),
    signal: ctrl.signal,
  })
  const text = await res.text()
  console.log('\nstatus:', res.status)
  console.log(text.slice(0, 1200))
} catch (e) {
  console.log('ERROR', e.name, e.message)
} finally {
  clearTimeout(t)
}
