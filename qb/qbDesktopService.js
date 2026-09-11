import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { atomic } from './qbGuards.js'
import { runValidation } from './qbService.js'

export function desktopConfig() {
  return { company: String(process.env.QB_DESKTOP_COMPANY_NAME || '').trim(), currency: process.env.QB_DESKTOP_CURRENCY || 'BSD', token: process.env.QB_DESKTOP_CONNECTOR_TOKEN || '' }
}
export function connectorAuth(req, res, next) {
  const { token } = desktopConfig()
  const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '')
  if (token.length < 32) return res.status(503).json({ error: 'Desktop connector is not configured' })
  const a = createHash('sha256').update(token).digest(), b = createHash('sha256').update(supplied).digest()
  if (!timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid connector credential' })
  next()
}
export function getDesktopStatus(db) {
  const config = desktopConfig()
  const health = db.prepare("select * from qb_desktop_health where id='default'").get()
  const configured = !!config.company && config.token.length >= 32
  const connected = configured && health?.company_name === config.company && health?.currency === config.currency && Date.now() - Date.parse(health.last_seen) < 120000
  const counts = { queued: 0, processing: 0, posted: 0, failed: 0, uncertain: 0 }
  for (const row of db.prepare('select status,count(*) as n from qb_desktop_deliveries group by status').all()) counts[row.status] = row.n
  return { provider: 'desktop', configured, connected: !!connected, company_name: config.company || null, currency: config.currency,
    last_seen: health?.last_seen || null, counts, message: !configured ? 'Set the Desktop connector token and company name on the server.' : !connected ? 'Waiting for the Windows QuickBooks worker.' : 'Windows worker connected to the configured company.' }
}
export function heartbeat(db, body) {
  const config = desktopConfig()
  if (!config.company || body.company_name !== config.company || body.currency !== config.currency) throw new Error('Company name or currency does not match server configuration')
  if (!Array.isArray(body.accounts) || body.accounts.length > 20000) throw new Error('Invalid account inventory')
  const accounts = body.accounts.map(a => {
    if (typeof a.name !== 'string' || !a.name || typeof a.id !== 'string') throw new Error('Invalid account')
    return { id: a.id, name: a.name, type: String(a.type || ''), active: a.active === true }
  })
  db.prepare(`insert into qb_desktop_health (id,company_name,currency,accounts_json,last_seen) values ('default',?,?,?,?)
    on conflict(id) do update set company_name=excluded.company_name,currency=excluded.currency,accounts_json=excluded.accounts_json,last_seen=excluded.last_seen`)
    .run(config.company, config.currency, JSON.stringify(accounts), new Date().toISOString())
  return getDesktopStatus(db)
}
export function getDesktopAccounts(db) {
  const status = getDesktopStatus(db)
  const row = db.prepare("select accounts_json, company_name from qb_desktop_health where id='default'").get()
  return { connected: status.connected, source: 'QuickBooks Desktop worker', stale: !status.connected,
    accounts: row?.company_name === status.company_name ? JSON.parse(row.accounts_json) : [] }
}
export function buildDesktopPayload(db, t) {
  if (!['emi_receipt', 'payment_disbursed'].includes(t.template_type)) throw new Error('Create accounts in QuickBooks before posting transactions')
  const lines = db.prepare('select account_name,amount,memo from qb_transaction_lines where transaction_id=? order by line_number').all(t.id)
  const cents = n => Math.round(Number(n) * 100)
  if (!t.reference_number || !/^\d{4}-\d{2}-\d{2}$/.test(t.transaction_date) || !Number.isFinite(t.amount) || cents(t.amount) <= 0 || !lines.length || lines.some(l => !l.account_name?.trim() || !Number.isFinite(l.amount) || l.amount <= 0 || Math.abs(l.amount*100-Math.round(l.amount*100)) > 0.000001) || lines.reduce((n,l) => n + cents(l.amount),0) !== cents(t.amount)) throw new Error('Positive account lines must balance to the transaction total to the cent')
  if (t.currency !== desktopConfig().currency) throw new Error('Currency differs from configured QuickBooks company currency')
  return { transaction_id: t.id, type: t.template_type, date: t.transaction_date, reference: t.reference_number,
    name: t.template_type === 'emi_receipt' ? t.customer_name : t.vendor_name || t.customer_name, bank_account: t.template_type === 'emi_receipt' ? t.deposit_to : t.bank_account,
    currency: t.currency, amount: t.amount, lines }
}
export function queueDesktopApproved(db, actor) {
  return atomic(db, () => queueDesktopApprovedInternal(db,actor))
}
function queueDesktopApprovedInternal(db, actor) {
  const connection = getDesktopStatus(db)
  if (!connection.configured) throw new Error(connection.message)
  const queued = [], errors = []
  for (const t of db.prepare("select * from qb_transactions where approval_status='approved'").all()) {
    if (db.prepare('select id from qb_desktop_deliveries where transaction_id=?').get(t.id)) continue
    try {
      if (runValidation(db,t.id).validation_status !== 'valid') throw new Error('Validation failed')
      const payload = JSON.stringify(buildDesktopPayload(db,t))
      const id = randomUUID()
      db.prepare(`insert into qb_desktop_deliveries (id,transaction_id,company_name,payload_json,payload_hash,created_by) values (?,?,?,?,?,?)`)
        .run(id,t.id,connection.company_name,payload,createHash('sha256').update(payload).digest('hex'),actor)
      queued.push(id)
    } catch (e) { errors.push({ transaction_id: t.id, error: e.message }) }
  }
  return { queued: queued.length, errors, posted: 0, message: 'Queued records require a QuickBooks acknowledgement before they count as posted.' }
}
export function claimDelivery(db) {
  return atomic(db, () => {
    // A timeout is ambiguous: never automatically repost a potentially accepted entry.
    db.prepare("update qb_desktop_deliveries set status='uncertain',error='Worker acknowledgement overdue; inspect worker journal and QuickBooks before recovery' where status='processing' and claimed_at < datetime('now','-10 minutes')").run()
    if (!getDesktopStatus(db).connected || !db.prepare("select desktop_posting_enabled from qb_rpa_settings where id='default'").get()?.desktop_posting_enabled) return null
    const row = db.prepare("select * from qb_desktop_deliveries where status='queued' and company_name=? order by created_at,id limit 1").get(desktopConfig().company)
    if (!row) return null
    const claim = randomUUID()
    db.prepare("update qb_desktop_deliveries set status='processing',claim_token=?,claimed_at=datetime('now'),updated_at=datetime('now') where id=?").run(claim,row.id)
    return { id: row.id, claim_token: claim, company_name: row.company_name, payload_hash: row.payload_hash, payload_json: row.payload_json, payload: JSON.parse(row.payload_json) }
  })
}
export function acknowledgeDelivery(db, id, result) {
  return atomic(db, () => {
    const row = db.prepare('select * from qb_desktop_deliveries where id=?').get(id)
    if (!row || row.claim_token !== result.claim_token || row.company_name !== desktopConfig().company) throw new Error('Unknown delivery or invalid claim')
    if (!['posted','failed','uncertain'].includes(result.status)) throw new Error('Invalid delivery result')
    if (result.status === 'posted' && (typeof result.external_id !== 'string' || !result.external_id.trim())) throw new Error('QuickBooks transaction ID required')
    if (row.status === 'posted') {
      if (result.status !== 'posted' || result.external_id !== row.external_id) throw new Error('Conflicting acknowledgement')
      return { status: 'posted', external_id: row.external_id }
    }
    if (!['processing','uncertain'].includes(row.status)) throw new Error('Delivery is not awaiting acknowledgement')
    db.prepare("update qb_desktop_deliveries set status=?,external_id=?,error=?,updated_at=datetime('now') where id=?")
      .run(result.status,result.external_id || null,String(result.error || '').slice(0,2000) || null,id)
    if (result.status === 'posted') db.prepare("update qb_transactions set approval_status='exported',updated_at=datetime('now') where id=?").run(row.transaction_id)
    return { status: result.status, external_id: result.external_id || null }
  })
}
export function retryFailedDelivery(db, id) {
  // Only definite rejections are retryable; uncertain deliveries require an acknowledgement from the original worker.
  const info = db.prepare("update qb_desktop_deliveries set status='queued',claim_token=null,claimed_at=null,error=null,updated_at=datetime('now') where id=? and status='failed'").run(id)
  if (!info.changes) throw new Error('Only a definitively failed delivery can be retried')
  return { status: 'queued' }
}
export function listDeliveries(db) {
  return db.prepare('select id,transaction_id,status,company_name,external_id,error,created_at,updated_at from qb_desktop_deliveries order by created_at desc,id limit 100').all()
}

export function cancelUnsentDelivery(db,id,actor) {
  return atomic(db, () => {
    const row = db.prepare('select * from qb_desktop_deliveries where id=?').get(id)
    if (!row || !['queued','failed'].includes(row.status)) throw new Error('Only an unclaimed or definitively failed delivery can be cancelled')
    db.prepare('insert into qb_agent_audit (id,actor,tool_name,arguments_json,result_json,status) values (?,?,?,?,?,?)')
      .run(randomUUID(),actor,'cancel_unsent_delivery',JSON.stringify({id}),JSON.stringify(row),'completed')
    db.prepare('delete from qb_desktop_deliveries where id=?').run(id)
    return {message:'Unsent delivery cancelled. You can correct the source record and review it again.'}
  })
}
