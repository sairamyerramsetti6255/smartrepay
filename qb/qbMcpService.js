import { listReviewQueue, reconciliationReport } from './qbOperationsService.js'
import { randomUUID } from 'crypto'
import { getTransaction, getPreview, runValidation, createTransaction, rejectAllUnpostedRecords, approveTransaction, approveAllValid } from './qbService.js'
import { buildTransactionHash } from './qbNormalize.js'
import { getDesktopAccounts } from './qbDesktopService.js'
import { lookupBorrower, resolveBorrower } from './qbBorrowerResolver.js'
import { assertEditable, atomic, canManageQuickBooks } from './qbGuards.js'

const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const str = { type: 'string', minLength: 1, maxLength: 500 }
export const MCP_TOOLS = [
  {name:'list_reconciliation_exceptions',description:'Read pending review records and their actual validation issues. Search by borrower or bank reference. Includes record IDs for follow-up.',parameters:object({search:str,page:{type:'number',minimum:1}})},
  {name:'get_reconciliation_report',description:'Read reconciliation totals grouped by currency, with confirmed QuickBooks IDs. Optional ISO from/to dates filter transaction dates. File exports are not confirmed postings.',parameters:object({from:str,to:str})},
  { name:'approve_transaction', description:'Approve an eligible and valid QuickBooks reconciliation transaction by ID.', mutates:true, parameters:object({transaction_id:str},['transaction_id']) },
  { name:'approve_all_valid', description:'Approve all currently valid pending reconciliation records.', mutates:true, parameters:object({template_type:{type:'string',enum:['all','emi_receipt','payment_disbursed']}}) },
  { name:'reject_all_unposted_records', description:'Use only when the user explicitly instructs rejection of ALL QuickBooks records. Rejects editable pending and approved records, preserves exported records and all Desktop deliveries, and reports exact counts. Does not delete records. Never use for a question, a negated instruction, a specific record, or a filtered subset.', mutates:true, parameters:object({reason:str},['reason']) },
  { name: 'open_excel_workbook', description: 'Prepare approved records for a filled Microsoft Excel workbook. Requests the client to open Excel where supported or download the populated XLSX. Does not approve records or post to QuickBooks.', mutates: true, parameters: object() },
  { name: 'query_chart_of_accounts', description: 'Read the latest account inventory received from the Windows QuickBooks worker. Reports staleness; no invented balances.', parameters: object({ search: str, account_type: str }) },
  { name: 'lookup_active_borrower', description: 'Search local active loans by exact name, first plus last name, or loan number. Ambiguous names have no top match.', parameters: object({ query: str }, ['query']) },
  { name: 'validate_double_entry_balance', description: 'Run deterministic validation on an explicit transaction ID.', mutates: true, parameters: object({ transaction_id: str }, ['transaction_id']) },
  { name: 'run_self_healing_rebalance', description: 'Link a unique borrower and revalidate a pending transaction. Never changes amounts or invents principal/interest splits.', mutates: true, parameters: object({ transaction_id: str }, ['transaction_id']) },
  { name: 'verify_sha256_duplicate', description: 'Check the same normalized fingerprint used by transaction ingestion.', parameters: object({ template_type: str, transaction_date: str, customer_name: str, reference_number: str, amount: { type: 'number', minimum: 0.01 } }, ['template_type','transaction_date','customer_name','reference_number','amount']) },
  { name: 'stage_quickbooks_journal_entry', description: 'Create a pending transaction from explicit fields and balanced source line items. Never approves or posts it.', mutates: true, parameters: object({
    template_type: { type: 'string', enum: ['emi_receipt','payment_disbursed'] }, transaction_date: str, customer_name: str,
    borrower_id: str, loan_id: str, reference_number: str, deposit_to: str, bank_account: str,
    amount: { type: 'number', minimum: 0.01 }, line_items: { type: 'array', minItems: 1, maxItems: 100, items: object({ account_name: str, amount: { type: 'number', minimum: 0.01 }, memo: str }, ['account_name','amount']) }
  }, ['template_type','transaction_date','customer_name','reference_number','amount','line_items']) },
  { name: 'log_agent_decision_audit', description: 'Persist a concise action summary and evidence to the local audit log.', mutates: true,
    parameters: object({ action_name: str, target_entity_id: str, summary: str }, ['action_name','target_entity_id','summary']) },
].map(t => ({ ...t, server: 'smartrepay-local-tools', category: t.mutates ? 'Controlled action' : 'Read only' }))
export function getMcpManifest() {
  return { transport: 'local-tool-registry', mcp_servers: [{ id: 'smartrepay-local-tools', name: 'SmartRepay local tool registry', description: 'Application tools backed by SmartRepay data; not external MCP servers.', status: 'available', tools_count: MCP_TOOLS.length, protocol: 'Application JSON API' }], tools: MCP_TOOLS }
}
export function validateToolArgs(schema, value, label = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
    for (const key of schema.required || []) if (!(key in value)) throw new Error(`${label}.${key} is required`)
    for (const [key,v] of Object.entries(value)) {
      if (!schema.properties[key]) throw new Error(`Unknown argument: ${key}`)
      validateToolArgs(schema.properties[key],v,`${label}.${key}`)
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems || 100)) throw new Error(`${label} has invalid items`)
    value.forEach(v => validateToolArgs(schema.items,v,label))
  } else {
    if (typeof value !== schema.type || (schema.type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity)))) throw new Error(`${label} has invalid type or value`)
    if (schema.type === 'string' && (!value.trim() || value.length > (schema.maxLength || 500))) throw new Error(`${label} has invalid length`)
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} is unsupported`)
  }
}
export async function executeMcpToolCall(db, name, args = {}, actor = 'User', role = null) {
  const tool = MCP_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`Unknown tool: ${name}`)
  validateToolArgs(tool.parameters,args)
  if (tool.mutates && !canManageQuickBooks(role)) throw new Error('Accounting or administrator role required')
  const started = Date.now()
  const auditId = randomUUID()
  db.prepare('insert into qb_agent_audit (id,actor,tool_name,arguments_json,status) values (?,?,?,?,?)').run(auditId,actor,name,JSON.stringify(args),'started')
  try {
    const data = atomic(db, () => {
      switch(name) {
        case 'list_reconciliation_exceptions': {
          const q=listReviewQueue(db,args)
          return {...q,rows:q.rows.map(t=>({id:t.id,customer_name:t.customer_name,reference_number:t.reference_number,amount:t.amount,currency:t.currency,issues:t.issues,editable:t.editable}))}
        }
        case 'get_reconciliation_report': {
          const r=reconciliationReport(db,args)
          return {...r,rows:r.rows.slice(0,20),sample_limit:20,message:'Totals cover the complete date range. Open the Reconciliation report panel to download record evidence.'}
        }
        case 'approve_transaction': return approveTransaction(db,args.transaction_id,actor)
        case 'approve_all_valid': return approveAllValid(db,args.template_type,actor)
        case 'reject_all_unposted_records': return rejectAllUnpostedRecords(db,actor,args.reason)
        case 'open_excel_workbook': {
          const preview = getPreview(db)
          if (!preview.approved_count) return {message:'There are no approved records to fill into Excel. Review and approve the required records first.',client_action:null}
          return {message:'Preparing the approved records for Microsoft Excel.',approved_count:preview.approved_count,client_action:{type:'open_excel'}}
        }
        case 'query_chart_of_accounts': {
          const inventory = getDesktopAccounts(db)
          return { ...inventory, accounts: inventory.accounts.filter(a => (!args.search || a.name.toLowerCase().includes(args.search.toLowerCase())) && (!args.account_type || a.type.toLowerCase() === args.account_type.toLowerCase())) }
        }
        case 'lookup_active_borrower': return lookupBorrower(db,args.query)
        case 'validate_double_entry_balance': return runValidation(db,args.transaction_id)
        case 'run_self_healing_rebalance': {
          assertEditable(db,args.transaction_id)
          const t = getTransaction(db,args.transaction_id)
          if (t.approval_status !== 'pending_review') throw new Error('Only pending records can be repaired')
          const linked = (!t.borrower_id || !t.loan_id) && resolveBorrower(db,t)
          const validation = runValidation(db,t.id)
          return { healed: Boolean(linked), new_validation_status: validation.validation_status, results: validation.results, message: 'Existing account lines and monetary values preserved.' }
        }
        case 'verify_sha256_duplicate': {
          const hash = buildTransactionHash(args.template_type,args.transaction_date,args.customer_name,args.reference_number,args.amount)
          return { hash, is_duplicate: !!db.prepare('select id from qb_transactions where transaction_hash=?').get(hash) }
        }
        case 'stage_quickbooks_journal_entry': {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(args.transaction_date)) throw new Error('ISO transaction date required')
          if (!args.deposit_to && args.template_type === 'emi_receipt') throw new Error('Explicit deposit account required')
          if (!args.bank_account && args.template_type === 'payment_disbursed') throw new Error('Explicit bank account required')
          if (args.line_items.reduce((n,l) => n + Math.round(l.amount*100),0) !== Math.round(args.amount*100)) throw new Error('Line items do not balance')
          return createTransaction(db,{ ...args, lines: args.line_items },actor)
        }
        case 'log_agent_decision_audit': return { logged: true, audit_id: auditId, summary: args.summary }
        default: throw new Error('Tool is unavailable')
      }
    })
    db.prepare("update qb_agent_audit set status='completed',result_json=? where id=?").run(JSON.stringify(data),auditId)
    return { jsonrpc: '2.0', result: { tool_name: name, server: tool.server, status: 'success', duration_ms: Date.now()-started, data } }
  } catch (e) {
    db.prepare("update qb_agent_audit set status='failed',result_json=? where id=?").run(JSON.stringify({ error: e.message }),auditId)
    throw e
  }
}
