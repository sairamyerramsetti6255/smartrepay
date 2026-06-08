export const ROLES = {
  collections: 'collections',
  mid_office: 'mid_office',
  accounting: 'accounting',
  system_owner: 'system_owner',
}

export function getUserRole(user) {
  return user?.user_metadata?.role || ROLES.collections
}

/** Showcase-friendly: all operational roles can run the core workflow */
export function canMatch(role) {
  return true
}

export function canIngest(role) {
  return true
}

export function canResolveExceptions(role) {
  return true
}

export function canPost(role) {
  return [ROLES.collections, ROLES.accounting, ROLES.mid_office, ROLES.system_owner].includes(role)
}

export function canManageBorrowers(role) {
  return true
}

export function canViewAudit(role) {
  return true
}

export function canExport(role) {
  return true
}

export function canAccessSettings(role) {
  return role === ROLES.system_owner
}
