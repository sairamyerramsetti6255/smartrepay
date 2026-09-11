import { createHash, randomUUID } from 'crypto'
import { getTransaction, updateTransaction, approveTransaction } from './qbService.js'
import { validateTransaction } from './qbValidation.js'
import { atomic } from './qbGuards.js'

export function reviewVersion(t) {
  return createHash('sha256').update(JSON.stringify([t.updated_at,t.approval_status,t.validation_status,t.customer_name,t.borrower_id,t.loan_id,t.reference_number,t.transaction_date,t.amount,t.deposit_to,t.bank_account,t.lines])).digest('hex')
}
export function getReviewDetail(db,id) {
  const t=getTransaction(db,id)
  if(!t) throw new Error('Record not found')
  const hashes=new Set(db.prepare('select transaction_hash from qb_transactions where id!=? and transaction_hash is not null').all(id).map(r=>r.transaction_hash))
  const validation=validateTransaction(t,t.lines,hashes)
  const issues=validation.results.filter(r=>r.status==='fail')
  if (!t.loan_id) issues.push({code:'LOAN_LINK',field:'loan_id',message:'No loan linked. Select the borrower and active loan using source evidence.',severity:'WARNING'})
  if (t.ai_confidence == null) issues.push({code:'MANUAL_APPROVAL',field:'ai_confidence',message:'No confidence score is available; this record requires manual approval.',severity:'INFO'})
  const locked=!!db.prepare('select id from qb_desktop_deliveries where transaction_id=?').get(id) || t.approval_status!=='pending_review'
  return {...t,issues,review_version:reviewVersion(t),editable:!locked}
}
export function listReviewQueue(db,{page=1,search=''}={}) {
  page=Math.max(1,Math.floor(Number(page)||1));const q='%'+String(search).slice(0,200)+'%'
  const where="approval_status='pending_review' and (customer_name like ? or reference_number like ?)"
  const total=db.prepare(`select count(*) as n from qb_transactions where ${where}`).get(q,q).n
  const rows=db.prepare(`select id from qb_transactions where ${where} order by created_at,id limit 20 offset ?`).all(q,q,(page-1)*20)
  return {total,page,page_size:20,rows:rows.map(r=>getReviewDetail(db,r.id))}
}
export function correctReviewRecord(db,id,body,actor) {
  return atomic(db,()=>{
    const current=getReviewDetail(db,id)
    if(!current.editable) throw new Error('This record is no longer editable')
    if(body.review_version!==current.review_version) throw new Error('Record changed since you opened it. Reload before saving.')
    if(typeof body.reason!=='string'||!body.reason.trim()) throw new Error('Explain the source or reason for this correction')
    const changes=body.changes
    if(!changes||typeof changes!=='object'||Array.isArray(changes)) throw new Error('Correction fields required')
    const allowed=['customer_name','reference_number','transaction_date','deposit_to','bank_account','amount','lines','borrower_id','loan_id']
    for(const key of Object.keys(changes)) if(!allowed.includes(key)) throw new Error(`Unsupported correction field: ${key}`)
    if('amount' in changes && (!Number.isFinite(changes.amount)||changes.amount<=0)) throw new Error('Amount must be positive')
    if('lines' in changes && (!Array.isArray(changes.lines)||!changes.lines.length||changes.lines.length>100||changes.lines.some(l=>!l.account_name?.trim()||!Number.isFinite(l.amount)||l.amount<=0))) throw new Error('Supply positive amounts and accounts for all lines')
    if('borrower_id' in changes || 'loan_id' in changes) {
      const match=db.prepare(`select l.loan_number from loans l join borrowers b on l.borrower_id=b.id or l.borrower_id=b.loandisk_id
        where b.id=? and l.loan_number=? and lower(l.status)='active'`).get(changes.borrower_id||'',changes.loan_id||'')
      if(!match) throw new Error('Select a borrower and their active loan together')
    }
    const updated=updateTransaction(db,id,changes,actor)
    db.prepare('insert into qb_agent_audit (id,actor,tool_name,arguments_json,result_json,status) values (?,?,?,?,?,?)')
      .run(randomUUID(),actor,'correct_review_record',JSON.stringify({transaction_id:id,reason:body.reason,changes,prior:current}),JSON.stringify({validation_status:updated.validation_status}),'completed')
    return getReviewDetail(db,id)
  })
}
function dateFilters(from,to) {
  for(const value of [from,to]) if(value && (!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)) throw new Error('Use valid dates in YYYY-MM-DD format')
  if(from&&to&&from>to) throw new Error('Start date must precede end date')
  return {where:`where (?='' or t.transaction_date>=?) and (?='' or t.transaction_date<=?)`,args:[from||'',from||'',to||'',to||'']}
}
export function reconciliationReport(db,filters={}) { return atomic(db,()=>reportSnapshot(db,filters)) }
function reportSnapshot(db,{from='',to=''}={}) {
  const {where,args}=dateFilters(from,to)
  const totals=db.prepare(`select t.currency,count(*) as records,
    sum(round(coalesce(t.amount,0)*100)) as total_cents,
    sum(case when t.approval_status='pending_review' then 1 else 0 end) as pending,
    sum(case when t.approval_status='approved' then 1 else 0 end) as approved,
    sum(case when t.approval_status='rejected' then 1 else 0 end) as rejected,
    sum(case when t.approval_status='exported' and d.status is null then 1 else 0 end) as file_exported,
    sum(case when d.status='posted' then 1 else 0 end) as posted,
    sum(case when d.status='posted' then round(coalesce(t.amount,0)*100) else 0 end) as posted_cents
    from qb_transactions t left join qb_desktop_deliveries d on d.transaction_id=t.id ${where} group by t.currency`).all(...args)
  const rows=db.prepare(`select t.id,t.transaction_date,t.reference_number,t.customer_name,t.amount,t.currency,t.validation_status,t.approval_status,d.status as delivery_status,d.external_id as quickbooks_id
    from qb_transactions t left join qb_desktop_deliveries d on d.transaction_id=t.id ${where} order by t.transaction_date desc,t.id limit 5001`).all(...args)
  const truncated=rows.length>5000
  return {generated_at:new Date().toISOString(),from:from||null,to:to||null,basis:'Current record status filtered by transaction date; amounts grouped by currency. File exports are not confirmed QuickBooks postings.',totals,rows:rows.slice(0,5000),truncated}
}

export function approveReviewedRecord(db,id,version,actor) {
  return atomic(db,()=>{
    const current=getReviewDetail(db,id)
    if(!current.editable || current.review_version!==version) throw new Error('Record changed or is no longer editable. Reload before approval.')
    const result=approveTransaction(db,id,actor)
    db.prepare('insert into qb_agent_audit (id,actor,tool_name,arguments_json,result_json,status) values (?,?,?,?,?,?)')
      .run(randomUUID(),actor,'approve_reviewed_record',JSON.stringify({transaction_id:id,review_version:version}),JSON.stringify(result),'completed')
    return result
  })
}
