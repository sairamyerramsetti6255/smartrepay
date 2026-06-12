// Throwaway probe: learn which read conditions CRIF_Operations supports
const API_BASE = 'https://simplifiedapi.meanhost.in/v1/api'

async function getToken() {
  const res = await fetch(`${API_BASE}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: 'api_admin', Password: 'api_admin@2024' }),
  })
  const data = await res.json()
  return data?.document?.AccessToken
}

async function callCrif(token, condition) {
  const res = await fetch(`${API_BASE}/SP/CRIF_Operations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Json: '{}', Condition: condition, Type: '' }),
  })
  const raw = await res.json().catch(() => ({}))
  let table = null
  try { table = JSON.parse(raw.document)?.Table } catch {}
  const first = Array.isArray(table) ? table[0] : null
  console.log(`\n== ${condition} (HTTP ${res.status}, code=${raw.code}) rows=${Array.isArray(table) ? table.length : 'n/a'}`)
  if (first) console.log('   cols:', Object.keys(first).join(', '))
  else console.log('   msg:', raw.message, '| doc:', String(raw.document).slice(0, 200))
}

const token = await getToken()
for (const c of [
  'Get_BankTransactions',
  'Get_TransactionMatches',
  'Get_LoandiskDueRecords',
  'Get_ActiveLoans',
  'Get_DueRecords',
]) {
  await callCrif(token, c)
}
