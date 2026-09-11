import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { qbMigrateDb } from '../qbMigrate.js'
import { approveTransaction, approveAllValid, rejectTransaction, updateTransaction, deleteTransaction } from '../qbService.js'
import { saveRpaSettings, getRpaStatus, runRpaPipeline, handleRpaChat, buildReviewIif, buildReviewWorkbook } from '../qbRpaService.js'
import { getDesktopStatus, heartbeat, queueDesktopApproved, claimDelivery, acknowledgeDelivery, retryFailedDelivery, getDesktopAccounts, connectorAuth } from '../qbDesktopService.js'
import { executeMcpToolCall } from '../qbMcpService.js'
import { lookupBorrower } from '../qbBorrowerResolver.js'
import { canManageQuickBooks } from '../qbGuards.js'
import * as XLSX from 'xlsx'

process.env.QB_DESKTOP_CONNECTOR_TOKEN = 'test-connector-token-with-at-least-32-characters'
process.env.QB_DESKTOP_COMPANY_NAME = 'Test Company'
process.env.QB_DESKTOP_CURRENCY = 'BSD'
delete process.env.OPENROUTER_API_KEY
const accounts = [{ id:'bank',name:'Bank',type:'Bank',active:true },{id:'loan',name:'Loans Receivable',type:'OtherCurrentAsset',active:true},{id:'interest',name:'Interest Income',type:'Income',active:true}]
function fixture() {
  const db = new DatabaseSync(':memory:')
  qbMigrateDb(db)
  db.exec(`create table borrowers(id text,full_name text,loandisk_id text);
    create table loans(id text,borrower_id text,loan_number text,status text);
    insert into borrowers values('b1','Wellington Antonio Johnson','disk1');
    insert into loans values('l1','b1','LN1','active');`)
  saveRpaSettings(db,{autopilot_enabled:false,auto_ingest_smartrepay:false,auto_export_packages:false})
  return db
}
function transaction(db,id,approval='pending_review',confidence=.95) {
  db.prepare(`insert into qb_transactions (id,template_type,transaction_date,customer_name,reference_number,amount,currency,deposit_to,approval_status,ai_confidence,transaction_hash)
    values (?,'emi_receipt','2026-09-01','Wellington Johnson - paid off',?,100,'BSD','Bank',?,?,?)`).run(id,id,approval,confidence,id)
  for (const [n,account,value] of [[1,'Loans Receivable',83],[2,'Interest Income',17]]) db.prepare('insert into qb_transaction_lines (id,transaction_id,line_number,account_name,amount) values (?,?,?,?,?)').run(id+n,id,n,account,value)
}
function connect(db) { heartbeat(db,{company_name:'Test Company',currency:'BSD',accounts}); saveRpaSettings(db,{desktop_posting_enabled:true}) }

test('migration is repeatable and defaults do not enable posting', () => {
  const db=fixture(); qbMigrateDb(db)
  assert.equal(getRpaStatus(db).settings.desktop_posting_enabled,false)
  assert.equal(getDesktopStatus(db).connected,false)
  db.close()
})
test('missing middle name resolves uniquely; same first and last across borrowers stays ambiguous', () => {
  const db=fixture(); assert.equal(lookupBorrower(db,'Wellington Johnson - paid off').top_match.loan_id,'LN1')
  db.exec("insert into borrowers values('b2','Wellington James Johnson','disk2'); insert into loans values('l2','b2','LN2','active')")
  assert.equal(lookupBorrower(db,'Wellington Johnson').top_match,null)
  assert.equal(lookupBorrower(db,'Johnson').match_count,0); db.close()
})
test('invalid and rejected entries cannot be automatically approved; exported entries stay immutable', () => {
  const db=fixture(); transaction(db,'valid'); transaction(db,'bad'); transaction(db,'rejected','rejected'); transaction(db,'exported','exported')
  db.prepare("update qb_transaction_lines set amount=200 where id='bad1'").run()
  assert.throws(() => approveTransaction(db,'bad'),/invalid/)
  assert.equal(approveTransaction(db,'rejected').approved,true)
  assert.throws(() => approveTransaction(db,'exported'),/immutable/)
  assert.throws(() => rejectTransaction(db,'exported'),/immutable/)
  assert.equal(approveAllValid(db,'all','test').approved_count,1)
  db.close()
})
test('pipeline honors preferences and counts exceptions without inventing splits', async () => {
  const db=fixture(); transaction(db,'good'); transaction(db,'bad'); transaction(db,'unknown','pending_review',null)
  db.prepare("update qb_transaction_lines set amount=200 where id='bad1'").run()
  saveRpaSettings(db,{autopilot_enabled:true})
  const result=await runRpaPipeline(db,{},'test')
  assert.equal(result.status,'completed_with_exceptions')
  assert.equal(result.metrics.records_auto_approved,1)
  assert.equal(result.metrics.records_excepted,1)
  assert.equal(result.metrics.records_exported,0)
  assert.equal(db.prepare("select amount from qb_transaction_lines where id='bad1'").get().amount,200)
  assert.equal(db.prepare("select approval_status from qb_transactions where id='unknown'").get().approval_status,'pending_review')
  assert.equal(db.prepare("select borrower_id from qb_transactions where id='good'").get().borrower_id,'b1')
  db.close()
})
test('disabled borrower resolver and automatic approval remain disabled',async () => {
  const db=fixture(); transaction(db,'a'); saveRpaSettings(db,{auto_resolve_borrowers:false})
  await runRpaPipeline(db,{forceIngest:true},'test')
  assert.equal(db.prepare("select borrower_id from qb_transactions where id='a'").get().borrower_id,null)
  assert.equal(db.prepare("select approval_status from qb_transactions where id='a'").get().approval_status,'pending_review'); db.close()
})
test('queue, claim, acknowledgement is idempotent and locks financial edits', () => {
  const db=fixture(); transaction(db,'a'); approveTransaction(db,'a'); connect(db)
  assert.equal(queueDesktopApproved(db,'test').queued,1)
  assert.equal(queueDesktopApproved(db,'test').queued,0)
  assert.throws(() => updateTransaction(db,'a',{amount:500}),/delivery/)
  assert.throws(() => deleteTransaction(db,'a'),/delivery/)
  const claim=claimDelivery(db); assert.equal(claim.payload.lines[0].amount,83)
  assert.equal(claimDelivery(db),null)
  assert.throws(() => acknowledgeDelivery(db,claim.id,{claim_token:claim.claim_token,status:'posted'}),/ID required/)
  assert.equal(db.prepare("select approval_status from qb_transactions where id='a'").get().approval_status,'approved')
  const result={claim_token:claim.claim_token,status:'posted',external_id:'QB-TXN-1'}
  acknowledgeDelivery(db,claim.id,result); acknowledgeDelivery(db,claim.id,result)
  assert.equal(getDesktopStatus(db).counts.posted,1)
  assert.equal(db.prepare("select approval_status from qb_transactions where id='a'").get().approval_status,'exported')
  assert.equal(queueDesktopApproved(db,'test').queued,0); db.close()
})
test('wrong company, stale heartbeat and posting disabled block claims', () => {
  const db=fixture(); transaction(db,'a'); approveTransaction(db,'a')
  assert.throws(() => heartbeat(db,{company_name:'Wrong',currency:'BSD',accounts}),/does not match/)
  queueDesktopApproved(db,'test'); assert.equal(claimDelivery(db),null)
  connect(db); saveRpaSettings(db,{desktop_posting_enabled:false}); assert.equal(claimDelivery(db),null)
  saveRpaSettings(db,{desktop_posting_enabled:true})
  db.prepare("update qb_desktop_health set last_seen='2020-01-01T00:00:00Z'").run()
  assert.equal(claimDelivery(db),null); assert.equal(getDesktopAccounts(db).stale,true); db.close()
})
test('uncertain delivery is not auto-retried; definitive failure can retry', () => {
  const db=fixture(); transaction(db,'a'); approveTransaction(db,'a'); connect(db); queueDesktopApproved(db,'test')
  const claim=claimDelivery(db)
  db.prepare("update qb_desktop_deliveries set claimed_at=datetime('now','-11 minutes')").run()
  assert.equal(claimDelivery(db),null)
  assert.equal(getDesktopStatus(db).counts.uncertain,1)
  assert.throws(() => retryFailedDelivery(db,claim.id),/Only/)
  acknowledgeDelivery(db,claim.id,{claim_token:claim.claim_token,status:'failed',error:'SDK definite rejection'})
  retryFailedDelivery(db,claim.id); const retry=claimDelivery(db)
  assert.notEqual(retry.claim_token,claim.claim_token)
  assert.throws(() => acknowledgeDelivery(db,claim.id,{claim_token:claim.claim_token,status:'posted',external_id:'x'}),/invalid claim/); db.close()
})
test('repair requires explicit ID and preserves all financial lines',async () => {
  const db=fixture(); transaction(db,'a')
  const before=db.prepare('select * from qb_transaction_lines').all()
  await assert.rejects(executeMcpToolCall(db,'run_self_healing_rebalance',{},'test','accounting'),/required/)
  await assert.rejects(executeMcpToolCall(db,'run_self_healing_rebalance',{transaction_id:'a'},'test','collections'),/role required/)
  await executeMcpToolCall(db,'run_self_healing_rebalance',{transaction_id:'a'},'test','accounting')
  assert.deepEqual(db.prepare('select * from qb_transaction_lines').all(),before)
  assert.equal(db.prepare('select count(*) as n from qb_agent_audit').get().n,1); db.close()
})
test('settings and connector permissions fail closed', () => {
  const db=fixture()
  assert.throws(() => saveRpaSettings(db,{auto_approve_min_confidence:.5}),/confidence/)
  assert.throws(() => saveRpaSettings(db,{autopilot_enabled:'false'}),/true or false/)
  assert.throws(() => saveRpaSettings(db,{schedule_interval:'everysecond'}),/Schedule/)
  assert.equal(canManageQuickBooks(undefined),false); assert.equal(canManageQuickBooks('unknown'),false)
  let status; const res={status(n){status=n;return this},json(){}}
  connectorAuth({headers:{authorization:'Bearer bad'}},res,() => assert.fail('unauthorized'))
  assert.equal(status,401); db.close()
})
test('without AI, questions and unknown record rejection never mutate', async () => {
  const db=fixture(); transaction(db,'a');
  for (const msg of ['Do not run pipeline','Reject transaction #999','Can you approve records?']) {
    const result=await handleRpaChat(db,msg,[],'test','accounting')
    assert.equal(result.action_result,null)
  }
  assert.equal(db.prepare("select approval_status from qb_transactions where id='a'").get().approval_status,'pending_review');db.close()
})
test('agent sends real tools, executes and feeds results back to the model',async () => {
  const db=fixture(); process.env.OPENROUTER_API_KEY='test-only'
  let calls=0
  const fake=async (_url,options) => {
    const body=JSON.parse(options.body); calls++
    assert.ok(body.tools.some(t => t.function.name==='lookup_active_borrower'))
    if(calls===1) return {ok:true,json:async () => ({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call1',type:'function',function:{name:'lookup_active_borrower',arguments:'{"query":"Wellington Johnson"}'}}]}}]})}
    assert.equal(body.messages.at(-1).role,'tool'); assert.match(body.messages.at(-1).content,/LN1/)
    return {ok:true,json:async () => ({choices:[{message:{content:'One active loan found.'}}]})}
  }
  try { const result=await handleRpaChat(db,'Find Wellington Johnson',[],'test','accounting',fake); assert.equal(result.mode,'agent'); assert.equal(result.action_result.length,1); assert.equal(calls,2) }
  finally {delete process.env.OPENROUTER_API_KEY;db.close()}
})
test('review exports preserve split amounts and IIF escaping', () => {
  const t={template_type:'emi_receipt',transaction_date:'2026-09-01',reference_number:'REF\tX',customer_name:'Name',amount:100,deposit_to:'Bank',lines:[{account_name:'Loans Receivable',amount:83,memo:'principal'},{account_name:'Interest Income',amount:17,memo:'interest'}]}
  const preview={emi_receipts:[t],payments_disbursed:[],accounts_to_create:[]}
  const iif=buildReviewIif(preview); assert.match(iif,/-83.00/); assert.match(iif,/-17.00/); assert.ok(!iif.includes('REF\tX'))
  const workbook=buildReviewWorkbook(preview)
  const rows=XLSX.utils.sheet_to_json(workbook.Sheets['EMI Receipts']); assert.equal(rows[0].LineAmount,83);assert.equal(rows[1].LineAmount,17)
})

test('real scheduler respects enablement, saved interval and last persisted run', async t => {
  const {startRpaScheduler}=await import('../qbRpaService.js')
  const db=fixture(); transaction(db,'a');let tick
  t.mock.method(globalThis,'setInterval',fn => {tick=fn;return {unref(){}}})
  t.mock.method(globalThis,'clearInterval',() => {})
  process.env.QB_RPA_SCHEDULER_ENABLED='true'
  const stop=startRpaScheduler(db)
  try {
    await tick();assert.equal(getRpaStatus(db).historical.total_runs,0)
    saveRpaSettings(db,{autopilot_enabled:true,schedule_interval:'hourly'})
    await tick();assert.equal(getRpaStatus(db).historical.total_runs,1)
    await tick();assert.equal(getRpaStatus(db).historical.total_runs,1)
    assert.equal(getRpaStatus(db).scheduler_enabled,true)
  } finally {stop();delete process.env.QB_RPA_SCHEDULER_ENABLED;db.close()}
})

test('cancel only unsent work, retain audit, then allow correction',async () => {
  const {cancelUnsentDelivery}=await import('../qbDesktopService.js')
  const db=fixture();transaction(db,'a');approveTransaction(db,'a');connect(db);queueDesktopApproved(db,'test')
  let delivery=db.prepare('select id from qb_desktop_deliveries').get()
  cancelUnsentDelivery(db,delivery.id,'accountant')
  assert.equal(db.prepare("select count(*) as n from qb_agent_audit where tool_name='cancel_unsent_delivery'").get().n,1)
  assert.equal(queueDesktopApproved(db,'test').queued,1)
  delivery=claimDelivery(db)
  assert.throws(() => cancelUnsentDelivery(db,delivery.id,'accountant'),/Only/)
  db.close()
})

test('connector HTTP endpoints enforce their own credential and acknowledgement contract',async () => {
  const express=(await import('express')).default
  const {createConnectorRouter}=await import('../qbConnectorRoutes.js')
  const db=fixture();transaction(db,'a');approveTransaction(db,'a');connect(db);queueDesktopApproved(db,'test')
  const app=express();app.use(express.json());app.use('/connector',createConnectorRouter(db))
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve))
  const base=`http://127.0.0.1:${server.address().port}/connector`
  const post=(route,body={},token=process.env.QB_DESKTOP_CONNECTOR_TOKEN)=>fetch(base+route,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})
  try {
    assert.equal((await post('/claim',{},'wrong')).status,401)
    const response=await post('/claim');assert.equal(response.status,200)
    const {delivery}=await response.json();assert.ok(delivery.id)
    const ack=await post(`/deliveries/${delivery.id}/ack`,{claim_token:delivery.claim_token,status:'posted',external_id:'actual-sdk-id'})
    assert.equal(ack.status,200);assert.equal(getDesktopStatus(db).counts.posted,1)
  } finally {await new Promise(resolve=>server.close(resolve));db.close()}
})

test('AI selects the Excel tool for the reported command; no keyword bypass', async () => {
  const db=fixture();transaction(db,'excel');approveTransaction(db,'excel')
  process.env.OPENROUTER_API_KEY='test-funded-key'
  let calls=0
  const provider=async (_url,options) => {
    calls++;const request=JSON.parse(options.body)
    assert.ok(request.tools.some(t => t.function.name==='open_excel_workbook'))
    return {ok:true,json:async () => ({choices:[{message:{role:'assistant',tool_calls:[{id:'excel-call',type:'function',function:{name:'open_excel_workbook',arguments:'{}'}}]}}]})}
  }
  try {
    const res=await handleRpaChat(db,'open and fill it in the microsoft excel',[],'test','accounting',provider)
    assert.equal(calls,1);assert.equal(res.client_action.type,'open_excel');assert.equal(res.mode,'agent')
    assert.equal(db.prepare("select count(*) as n from qb_agent_audit where tool_name='open_excel_workbook'").get().n,1)
  } finally {delete process.env.OPENROUTER_API_KEY;db.close()}
})

test('Excel tool requires accounting permissions and approved records',async () => {
  const db=fixture();transaction(db,'pending')
  const res=await executeMcpToolCall(db,'open_excel_workbook',{},'test','accounting')
  assert.equal(res.result.data.client_action,null)
  await assert.rejects(executeMcpToolCall(db,'open_excel_workbook',{},'test','collections'),/role required/)
  const noKey=await handleRpaChat(db,'Open Excel',[],'test','accounting')
  assert.equal(noKey.client_action,undefined);assert.equal(noKey.mode,'not_configured');db.close()
})

test('402 retains provider explanation and never falls back to a non-AI Excel action',async () => {
  const db=fixture();process.env.OPENROUTER_API_KEY='test-unfunded-key'
  try {
    const res=await handleRpaChat(db,'Open Excel',[],'test','accounting',async () => ({ok:false,status:402,json:async () => ({error:{message:'This account never purchased credits.'}})}))
    assert.match(res.reply,/never purchased credits/);assert.equal(res.client_action,undefined);assert.equal(res.action_result,null)
  } finally {delete process.env.OPENROUTER_API_KEY;db.close()}
})

test('AI reject-all rejects editable records, protects deliveries/exported rows, and audits actual counts',async () => {
  const db=fixture();transaction(db,'pending');transaction(db,'approved');transaction(db,'delivered');transaction(db,'exported','exported');transaction(db,'rejected','rejected')
  approveTransaction(db,'delivered');connect(db);queueDesktopApproved(db,'test');approveTransaction(db,'approved')
  process.env.OPENROUTER_API_KEY='test-only'
  try {
    const provider=async (_url,options) => {
      assert.ok(JSON.parse(options.body).tools.some(t=>t.function.name==='reject_all_unposted_records'))
      return {ok:true,json:async()=>({choices:[{message:{role:'assistant',tool_calls:[{id:'reject1',type:'function',function:{name:'reject_all_unposted_records',arguments:JSON.stringify({reason:'User requested rejection of all records'})}}]}}]})}
    }
    const res=await handleRpaChat(db,'reject all the records once',[],'accountant','accounting',provider)
    assert.match(res.reply,/Rejected 2 records/);assert.match(res.reply,/2 exported\/delivery/)
    for(const id of ['pending','approved']) assert.equal(db.prepare('select approval_status from qb_transactions where id=?').get(id).approval_status,'rejected')
    assert.equal(db.prepare("select approval_status from qb_transactions where id='delivered'").get().approval_status,'approved')
    assert.equal(db.prepare("select approval_status from qb_transactions where id='exported'").get().approval_status,'exported')
    const audit=db.prepare("select * from qb_agent_audit where tool_name='reject_all_unposted_records'").get()
    assert.equal(audit.actor,'accountant');assert.equal(JSON.parse(audit.result_json).prior_records.length,2)
    const again=await executeMcpToolCall(db,'reject_all_unposted_records',{reason:'Repeated request'},'accountant','accounting')
    assert.equal(again.result.data.rejected_count,0)
  } finally {delete process.env.OPENROUTER_API_KEY;db.close()}
})

test('bulk rejection fails closed for unauthorized roles and missing reason',async () => {
  const db=fixture();transaction(db,'pending')
  await assert.rejects(executeMcpToolCall(db,'reject_all_unposted_records',{reason:'Reject all'},'viewer','collections'),/role required/)
  await assert.rejects(executeMcpToolCall(db,'reject_all_unposted_records',{},'accountant','accounting'),/required/)
  assert.equal(db.prepare("select approval_status from qb_transactions where id='pending'").get().approval_status,'pending_review');db.close()
})

test('review explains failures and saves an evidenced correction without automatic approval',async()=>{
  const {getReviewDetail,correctReviewRecord}=await import('../qbOperationsService.js')
  const db=fixture();transaction(db,'review')
  db.prepare("update qb_transaction_lines set amount=82 where id='review1'").run()
  const before=getReviewDetail(db,'review');assert.ok(before.issues.some(i=>i.code==='QB005'))
  const corrected=correctReviewRecord(db,'review',{review_version:before.review_version,reason:'Verified principal 83 and interest 17 on source statement',changes:{lines:[{account_name:'Loans Receivable',amount:83},{account_name:'Interest Income',amount:17}]}},'accountant')
  assert.equal(corrected.validation_status,'valid');assert.equal(corrected.approval_status,'pending_review')
  assert.throws(()=>correctReviewRecord(db,'review',{review_version:before.review_version,reason:'old view',changes:{amount:500}},'accountant'),/changed/)
  assert.equal(db.prepare("select count(*) as n from qb_agent_audit where tool_name='correct_review_record'").get().n,1);db.close()
})
test('reviewed approval rejects stale versions and invalid borrower selections',async()=>{
  const {getReviewDetail,correctReviewRecord,approveReviewedRecord}=await import('../qbOperationsService.js')
  const db=fixture();transaction(db,'review');const before=getReviewDetail(db,'review')
  assert.throws(()=>correctReviewRecord(db,'review',{review_version:before.review_version,reason:'pick',changes:{borrower_id:'b1',loan_id:'wrong'}},'accountant'),/active loan/)
  assert.throws(()=>approveReviewedRecord(db,'review','old-version','accountant'),/changed/)
  approveReviewedRecord(db,'review',before.review_version,'accountant')
  assert.equal(getReviewDetail(db,'review').editable,false);db.close()
})
test('report distinguishes file exports from confirmed postings and groups currencies',async()=>{
  const {reconciliationReport}=await import('../qbOperationsService.js')
  const db=fixture();transaction(db,'posted');transaction(db,'file','exported');transaction(db,'usd')
  db.prepare("update qb_transactions set currency='USD' where id='usd'").run()
  approveTransaction(db,'posted');connect(db);queueDesktopApproved(db,'test');const claim=claimDelivery(db)
  acknowledgeDelivery(db,claim.id,{claim_token:claim.claim_token,status:'posted',external_id:'QB-TEST'})
  const r=reconciliationReport(db,{from:'2026-09-01',to:'2026-09-30'}),bsd=r.totals.find(t=>t.currency==='BSD')
  assert.equal(bsd.records,2);assert.equal(bsd.file_exported,1);assert.equal(bsd.posted,1);assert.equal(bsd.posted_cents,10000)
  assert.equal(r.totals.length,2);assert.equal(r.rows.find(t=>t.id==='posted').quickbooks_id,'QB-TEST')
  assert.equal(reconciliationReport(db,{from:'2026-10-01'}).rows.length,0)
  assert.throws(()=>reconciliationReport(db,{from:'2026-02-30'}),/valid dates/)
  assert.throws(()=>reconciliationReport(db,{from:'2026-09-30',to:'2026-09-01'}),/precede/);db.close()
})
test('pipeline publishes genuine intermediate progress before completion',async()=>{
  const db=fixture();transaction(db,'live')
  const pending=runRpaPipeline(db,{},'test')
  const live=getRpaStatus(db).recent_runs[0]
  assert.equal(live.status,'running');assert.ok(live.logs.some(l=>l.status==='running'))
  await pending;assert.equal(getRpaStatus(db).recent_runs[0].status,'completed');db.close()
})

test('read-only agent tools explain review issues and report measured totals',async()=>{
  const db=fixture();transaction(db,'read')
  const review=await executeMcpToolCall(db,'list_reconciliation_exceptions',{search:'Wellington'},'viewer','collections')
  assert.equal(review.result.data.total,1);assert.equal(review.result.data.rows[0].id,'read')
  const report=await executeMcpToolCall(db,'get_reconciliation_report',{from:'2026-09-01',to:'2026-09-30'},'viewer','collections')
  assert.equal(report.result.data.totals[0].records,1);assert.equal(report.result.data.totals[0].posted,0)
  assert.equal(db.prepare("select approval_status from qb_transactions where id='read'").get().approval_status,'pending_review');db.close()
})

test('LoanDisk borrower validation checks borrower list on QB import and flags missing borrowers', async () => {
  const { createTransaction, getTransaction } = await import('../qbService.js')
  const db = fixture()

  // 1. Existing LoanDisk borrower -> borrower_id auto-resolved, ruleQB009 passes
  const matchedTxn = createTransaction(db, {
    template_type: 'emi_receipt',
    customer_name: 'Wellington Johnson - paid off',
    amount: 100,
    reference_number: 'REF-MATCH-01',
    transaction_date: '2026-09-01',
  }, 'test')
  assert.equal(matchedTxn.borrower_id, 'b1')
  assert.equal(matchedTxn.loan_id, 'LN1')
  const valRows1 = db.prepare('select * from qb_validation_results where transaction_id = ? and rule_code = ?').all(matchedTxn.id, 'QB009')
  assert.equal(valRows1.length, 1)
  assert.equal(valRows1[0].status, 'pass')

  // 2. Non-existent LoanDisk borrower -> borrower_id is null, ruleQB009 fails
  const unmatchedTxn = createTransaction(db, {
    template_type: 'emi_receipt',
    customer_name: 'Nonexistent Unknown Person',
    amount: 150,
    reference_number: 'REF-UNMATCH-02',
    transaction_date: '2026-09-01',
  }, 'test')
  assert.equal(unmatchedTxn.borrower_id, null)
  const valRows2 = db.prepare('select * from qb_validation_results where transaction_id = ? and rule_code = ?').all(unmatchedTxn.id, 'QB009')
  assert.equal(valRows2.length, 1)
  assert.equal(valRows2[0].status, 'fail')
  assert.ok(valRows2[0].message.includes('LoanDisk'))

  // 3. Payment disbursement -> borrower check not required (passes)
  const disburseTxn = createTransaction(db, {
    template_type: 'payment_disbursed',
    vendor_name: 'ABC Supplier LLC',
    amount: 500,
    reference_number: 'CHK-001',
    bank_account: 'Operating Bank Account',
    transaction_date: '2026-09-01',
  }, 'test')
  const valRows3 = db.prepare('select * from qb_validation_results where transaction_id = ? and rule_code = ?').all(disburseTxn.id, 'QB009')
  assert.equal(valRows3.length, 1)
  assert.equal(valRows3[0].status, 'pass')

  db.close()
})

test('text extraction parses tab-separated transaction rows accurately without AI dependency', async () => {
  const { extractFromText, heuristicExtractFromText } = await import('../qbAiExtract.js')
  const rawText = "04/30/2026\t17128\tLonette Nekisha Penn\tGeneral Bank Account\t179.73\tLoans Receivable\t179.73\tEMI Payment"
  
  const res = await extractFromText(rawText, { templateType: 'emi_receipt' })
  assert.equal(res.fields.customer_name.value, 'Lonette Nekisha Penn')
  assert.equal(res.fields.reference_number.value, '17128')
  assert.equal(res.fields.transaction_date.value, '2026-04-30')
  assert.equal(res.fields.amount.value, 179.73)
  assert.equal(res.fields.deposit_to.value, 'General Bank Account')
})

test('matching algorithm validates borrower name, borrower ID, and EMI amount for receipts and payments', async () => {
  const { createTransaction, getTransaction } = await import('../qbService.js')
  const { lookupBorrower } = await import('../qbBorrowerResolver.js')
  const db = fixture()

  // Seed borrower with active loan and expected EMI
  db.exec("insert into borrowers values('b_tarez', 'Tarez Lavana Ferguson', '6068266'); insert into loans values('l_tarez', 'b_tarez', '90007366', 'active');")
  // Add emi column if not present in fixture
  try { db.exec("alter table loans add column emi real;") } catch {}
  db.exec("update loans set emi = 230.86 where id = 'l_tarez'")

  // 1. Validate matching lookup returns exact name and exact EMI match
  const lookup1 = lookupBorrower(db, 'Tarez Lavana Ferguson', 230.86)
  assert.ok(lookup1.top_match)
  assert.equal(lookup1.top_match.score, 100)
  assert.equal(lookup1.top_match.loandisk_id, '6068266')
  assert.equal(lookup1.top_match.loan_id, '90007366')
  assert.equal(lookup1.top_match.emi_match_status, 'exact_emi')
  assert.equal(lookup1.top_match.expected_emi, 230.86)

  // 2. Transposed name matching ("Ferguson, Tarez")
  const lookup2 = lookupBorrower(db, 'Ferguson, Tarez', 230.86)
  assert.ok(lookup2.top_match)
  assert.equal(lookup2.top_match.score, 98)

  // 3. Create EMI Receipt with matching name and amount
  const receiptTxn = createTransaction(db, {
    template_type: 'emi_receipt',
    customer_name: 'Tarez Lavana Ferguson',
    amount: 230.86,
    reference_number: 'REF-90007366',
    transaction_date: '2026-07-03',
  }, 'test')
  assert.equal(receiptTxn.borrower_id, 'b_tarez')
  assert.equal(receiptTxn.loan_id, '90007366')
  assert.equal(receiptTxn.validation_status, 'valid')

  // 4. Create Payment Disbursed with borrower matching
  const paymentTxn = createTransaction(db, {
    template_type: 'payment_disbursed',
    vendor_name: 'Tarez Lavana Ferguson',
    amount: 230.86,
    reference_number: 'CHK-90007366',
    bank_account: 'Operating Bank Account',
    transaction_date: '2026-07-03',
  }, 'test')
  assert.equal(paymentTxn.borrower_id, 'b_tarez')
  assert.equal(paymentTxn.loan_id, '90007366')

  // 5. Provided mismatching Borrower ID raises validation warning
  const mismatchTxn = createTransaction(db, {
    template_type: 'emi_receipt',
    customer_name: 'Tarez Lavana Ferguson',
    borrower_id: 'WRONG_ID_9999',
    amount: 230.86,
    reference_number: 'REF-001',
    transaction_date: '2026-07-03',
  }, 'test')
  const valRows = db.prepare('select * from qb_validation_results where transaction_id = ? and rule_code = ?').all(mismatchTxn.id, 'QB009')
  assert.equal(valRows[0].status, 'fail')
  assert.ok(valRows[0].message.includes('does not match'))

  db.close()
})

test('statement parsing extracts multi-row transactions and runs matching algorithm against LoanDisk', async () => {
  const db = fixture()
  try { db.exec('alter table loans add column emi real') } catch {}
  db.exec(`
    insert into borrowers (id, full_name, loandisk_id) values
      ('b_lonette', 'Lonette Nekisha Penn', 'LD-17128'),
      ('b_tarez', 'Tarez Lavana Ferguson', 'LD-88321');
    insert into loans (id, borrower_id, loan_number, emi, status) values
      ('l_lonette', 'b_lonette', '17128', 179.73, 'active'),
      ('l_tarez', 'b_tarez', '90007366', 230.86, 'active');
  `)

  const { parseStatementBuffer } = await import('../../parseStatement.js')
  const csvBuffer = Buffer.from(`Date,Name,Reference,Amount,Description\n2026-05-08,Lonette Penn,REF-17128,179.73,Salary deduction — Cable Bahamas\n2026-05-08,Tarez Ferguson,REF-88321,230.86,Salary deduction — Cable Bahamas`)
  
  const parsed = await parseStatementBuffer(csvBuffer, 'Cable Bahamas 8 May 2026.csv')
  assert.equal(parsed.rows.length, 2)

  // Verify borrower matching on parsed rows
  const match1 = lookupBorrower(db, parsed.rows[0].payer, parsed.rows[0].amount)
  assert.equal(match1.top_match.borrower_id, 'b_lonette')
  assert.equal(match1.top_match.loan_id, '17128')
  assert.equal(match1.top_match.emi_match_status, 'exact_emi')

  const match2 = lookupBorrower(db, parsed.rows[1].payer, parsed.rows[1].amount)
  assert.equal(match2.top_match.borrower_id, 'b_tarez')
  assert.equal(match2.top_match.loan_id, '90007366')
  assert.equal(match2.top_match.emi_match_status, 'exact_emi')

  db.close()
})
