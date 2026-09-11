export const QB_ROLES = ['accounting', 'system_owner', 'admin', 'system_admin']
export function canManageQuickBooks(role) { return QB_ROLES.includes(role) }
export function requireQuickBooksRole(req, res, next) {
  if (!canManageQuickBooks(req.user?.role)) return res.status(403).json({ error: 'Accounting or administrator role required' })
  next()
}
export function atomic(db, fn) {
  db.exec('SAVEPOINT qb_operation')
  try { const result = fn(); db.exec('RELEASE qb_operation'); return result }
  catch (error) { db.exec('ROLLBACK TO qb_operation'); db.exec('RELEASE qb_operation'); throw error }
}
export function assertEditable(db, id) {
  const t = db.prepare('select approval_status from qb_transactions where id = ?').get(id)
  if (!t) throw new Error('Transaction not found')
  if (t.approval_status === 'exported') throw new Error('Exported transactions are immutable; reconcile or reverse in QuickBooks')
  const delivery = db.prepare('select status from qb_desktop_deliveries where transaction_id = ?').get(id)
  if (delivery) throw new Error('Transaction has a Desktop delivery record; resolve the delivery before changing it')
}
