import test from 'node:test'
import assert from 'node:assert/strict'
import { extractBankPages } from '../ingestion/bankPdf.js'
import { assessPayment } from '../engine/src/paymentAssessment.js'
import { parseStatementBuffer } from '../parseStatement.js'
import { summarizeFile } from '../ingestion/fileSummary.js'
const item=(str,x,y,width=40)=>({str,width,transform:[1,0,0,1,x,y]})
const headers=y=>[item('Date Posted',10,y),item('Value',90,y),item('Reference',160,y),item('Particulars',240,y),item('Debit Amount',410,y,60),item('Credit Amount',490,y,60),item('Balance',580,y,50)]
const row=(ref,y,description,credit,debit,balance)=>[item('9/10/26',10,y),item('9/10/26',90,y),item(ref,160,y),item(description,240,y,150),...(credit?[item(credit,510,y,40)]:[]),...(debit?[item(debit,425,y,40)]:[]),item(balance,580,y,60)]
test('first credit retained, debit excluded by column despite narrative, page continuation retained',()=>{
 const result=extractBankPages([{num:1,items:[...headers(700),...row('90010805',680,'Direct Credit', '223.06',null,'840,823.70'),item('Salaries 260910|arlington',240,665,150),item('sweeting',240,650),...row('2',620,'Direct Credit',null,'100.00','840,723.70'),...row('3',590,'Direct', '50.00',null,'840,773.70')]},{num:2,items:[...headers(700),item('Christian Johnson',240,680,130),...row('4',650,'CloseOutWithdrawal-Cheque','12,839.06',null,'853,612.76')]}])
 assert.equal(result.rows.length,4);assert.equal(result.rows[0].reference,'90010805');assert.equal(result.rows[0].direction,'credit')
 assert.match(result.rows[0].particulars,/arlington sweeting/);assert.equal(result.rows[1].direction,'debit')
 assert.match(result.rows[2].particulars,/Christian Johnson/);assert.deepEqual(result.rows[2].sourcePages,[1,2]);assert.equal(result.rows[3].direction,'credit');assert.equal(result.diagnostics.complete,true)
})
test('unknown page and balance discrepancy block completeness',()=>{
 const result=extractBankPages([{num:1,items:[...headers(700),...row('1',680,'Payment','100.00',null,'200.00'),...row('2',650,'Payment','100.00',null,'999.00')]},{num:2,items:[]}])
 assert.equal(result.diagnostics.complete,false);assert.equal(result.diagnostics.warnings.length,2)
})
test('CSV quoted descriptions, posted dates, explicit debits with positive amount',async()=>{
 const result=await parseStatementBuffer(Buffer.from('Date Posted,Value Date,Description,Credit,Debit,Amount,Reference\n9/11/26,9/15/26,"Johnson, Wellington",223.06,,223.06,1\n9/11/26,9/15/26,Outgoing,,100,100,2'), 'bank.csv',{documentType:'bank'})
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].date,'2026-09-11');assert.match(result.rows[0].description,/Johnson, Wellington/)
})
const loan={loanNumber:'1',branch:'A',expectedEMI:400,frequency:'monthly'}
const receipt=(id,date,amount)=>({entryId:id,source:'loandisk',loanNumber:'1',branchName:'A',date,amount})
test('weekly receipts complete monthly obligation; future/other branch excluded',()=>{
 const a=assessPayment({TransDate:'2026-09-22',EmiPaidAmount:100},loan,{complete:true,rows:[receipt('1','2026-09-01',100),receipt('2','2026-09-08',100),receipt('3','2026-09-15',100),receipt('4','2026-09-29',100),{...receipt('5','2026-09-02',999),branchName:'B'}]})
 assert.equal(a.recordedMonthPaid,300);assert.equal(a.observedCadence,'weekly');assert.equal(a.kind,'month_completed_by_installments');assert.equal(a.requiresReview,true)
})
test('arrears do not imply wrong borrower and cached data never claims complete',()=>{
 const a=assessPayment({TransDate:'2026-09-22',EmiPaidAmount:900},loan,{rows:[]})
 assert.equal(a.kind,'possible_arrears_or_advance');assert.equal(a.requiresReview,true)
})
test('no inferred monthly amount from unknown base EMI cadence',()=>{
 const a=assessPayment({TransDate:'2026-09-22',EmiPaidAmount:100},{...loan,frequency:null},{complete:true,rows:[]})
 assert.equal(a.expectedMonthly,null)
})
test('AI failure retains facts without claiming AI completion',async()=>{
 const s=await summarizeFile({rows:[{date:'2026-09-11',amount:223.06}]},async()=>{throw new Error('402')})
 assert.equal(s.status,'unavailable');assert.equal(s.facts.creditTotal,223.06)
})

test('real PDF text coordinates preserve the first credit and cheque posted/value dates', async()=>{
 const {default:PDFDocument}=await import('pdfkit')
 const chunks=[];const doc=new PDFDocument({size:[700,800],margin:0})
 const done=new Promise(resolve=>{doc.on('data',b=>chunks.push(b));doc.on('end',resolve)})
 const put=(text,x,y)=>doc.fontSize(9).text(text,x,y,{lineBreak:false})
 for(const [text,x] of [['Date Posted',10],['Value',90],['Reference',160],['Particulars',240],['Debit Amount',410],['Credit Amount',490],['Balance',580]]) put(text,x,50)
 for(const [text,x] of [['9/11/26',10],['9/15/26',90],['90010805',160],['Direct Credit',240],['223.06',510],['840,823.70',580]]) put(text,x,80)
 put('Salaries 260910|arlington',240,95);put('sweeting',240,110)
 doc.end();await done
 const result=await parseStatementBuffer(Buffer.concat(chunks),'bank.pdf',{documentType:'bank'})
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].date,'2026-09-11');assert.equal(result.rows[0].valueDate,'2026-09-15');assert.equal(result.rows[0].amount,223.06);assert.match(result.rows[0].description,/arlington sweeting/)
})
test('receipt pagination reads all pages and rejects truncated totals',async()=>{
 const {fetchLoanReceiptHistory}=await import('../engine/src/loandiskClient.js')
 let calls=0
 const rows=await fetchLoanReceiptHistory('1','2',async()=>({response:{TotalResults:101,Results:[++calls===1 ? Array.from({length:100},(_,i)=>({repayment_id:i+1})) : [{repayment_id:101}]]}}))
 assert.equal(calls,2);assert.equal(rows.length,101)
 await assert.rejects(()=>fetchLoanReceiptHistory('1','2',async()=>({response:{TotalResults:2,Results:[[{repayment_id:1}]]}})),/truncated/)
})
test('parse sessions survive recreation and are scoped to their owner',async()=>{
 const {ParseSessionStore}=await import('../ingestion/parseSessionStore.js')
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'smartrepay-test-'))
 try {
  const id='12345678-1234-1234-1234-123456789012'
  new ParseSessionStore(dir).set(id,{userId:'a',rows:[],buffer:Buffer.from('original')})
  const restored=new ParseSessionStore(dir)
  assert.equal(restored.get(id).buffer.toString(),'original');assert.equal(restored.list('a').length,1);assert.equal(restored.list('b').length,0)
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
})

test('blank references and fused reference/narrative runs retain all credits',()=>{
 const items=[...headers(700),...row('1582625400306941 Cash Deposit In Branch',680,'','120.00',null,'1000.00'),...row('',650,'Close Out Withdrawal - Cheque','12839.06',null,'13839.06')]
 const r=extractBankPages([{num:1,items}])
 assert.equal(r.rows.length,2);assert.equal(r.diagnostics.complete,true)
 assert.equal(r.rows[0].reference,'1582625400306941');assert.equal(r.rows[0].particulars,'Cash Deposit In Branch')
 assert.equal(r.rows[1].reference,'');assert.equal(r.rows[1].creditAmount,12839.06)
})
test('missing value date does not block a valid posted-date credit',()=>{
 const items=[...headers(700),...row('1',680,'Payment','100.00',null,'200.00').filter(i=>i.transform[4]!==90)]
 const r=extractBankPages([{num:1,items}])
 assert.equal(r.diagnostics.complete,true);assert.equal(r.rows[0].datePosted,'2026-09-10');assert.equal(r.rows[0].valueDate,null)
})
test('AI receives currency units for both overall and per-date totals',async()=>{
 await summarizeFile({rows:[{datePosted:'2026-09-10',amount:2497.27}]},async facts=>{
  assert.equal(facts.creditTotal,2497.27);assert.deepEqual(facts.byDate['2026-09-10'],{count:1,totalAmount:2497.27});return 'Summary'
 })
})
