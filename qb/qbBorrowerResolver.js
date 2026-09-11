// Conservative entity linking. A missing middle name is allowed; ambiguity is never guessed.
function tokens(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/\bpaid\s*off\b.*$/i,'').replace(/[^a-z0-9 ]/g,' ').trim().split(/\s+/).filter(Boolean)
}
export function lookupBorrower(db, query) {
  const q = tokens(query)
  if (!q.length) return { matches: [], top_match: null, match_count: 0 }
  const rows = db.prepare(`select b.id as borrower_id,b.full_name,l.loan_number as loan_id
    from borrowers b join loans l on (l.borrower_id=b.id or l.borrower_id=b.loandisk_id)
    where lower(coalesce(l.status,'active'))='active'`).all()
  const matches = rows.filter(r => {
    if (String(r.loan_id).toLowerCase() === String(query).trim().toLowerCase()) return true
    const n = tokens(r.full_name)
    return q.length >= 2 && n.length >= 2 && (q.join(' ') === n.join(' ') ||
      (q.length === 2 && q[0] === n[0] && q[1] === n[n.length-1]))
  })
  return { matches: matches.slice(0,20), top_match: matches.length === 1 ? matches[0] : null, match_count: matches.length }
}
export function resolveBorrower(db, t) {
  const lookup = lookupBorrower(db,t.customer_name)
  const candidates = lookup.matches.filter(m => (!t.borrower_id || t.borrower_id === m.borrower_id) && (!t.loan_id || t.loan_id === m.loan_id))
  if (lookup.match_count > 20 || candidates.length !== 1) return false
  const match = candidates[0]
  db.prepare("update qb_transactions set borrower_id=?,loan_id=?,updated_at=datetime('now') where id=? and approval_status='pending_review'").run(match.borrower_id,match.loan_id,t.id)
  return true
}
