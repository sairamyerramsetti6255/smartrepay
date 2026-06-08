import * as api from './api'

export async function writeAuditLog({ entity, entityId, action, actor, priorValue, newValue }) {
  await api.audit.write({ entity, entityId, action, priorValue, newValue })
}

export const logAudit = writeAuditLog
