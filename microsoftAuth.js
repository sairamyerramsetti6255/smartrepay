import * as jose from 'jose'

const tenantId = process.env.AZURE_TENANT_ID || ''
const clientId = process.env.AZURE_CLIENT_ID || ''
const allowedDomain = String(process.env.AZURE_ALLOWED_DOMAIN || 'slendingbahamas.com')
  .trim()
  .toLowerCase()
  .replace(/^@/, '')

export function isMicrosoftAuthConfigured() {
  return Boolean(tenantId && clientId)
}

export function getAllowedMicrosoftDomain() {
  return allowedDomain
}

export function assertAllowedMicrosoftEmail(email) {
  const normalized = String(email || '').trim().toLowerCase()
  const domain = normalized.split('@')[1] || ''
  if (!domain || domain !== allowedDomain) {
    throw new Error(`Only @${allowedDomain} Microsoft accounts can sign in`)
  }
  return normalized
}

function getIssuer() {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`
}

function getJwksUrl() {
  return `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`
}

let jwksCache = null

function getJwks() {
  if (!jwksCache) {
    jwksCache = jose.createRemoteJWKSet(new URL(getJwksUrl()))
  }
  return jwksCache
}

/**
 * Validate a Microsoft ID token from MSAL (popup / redirect).
 * Returns normalized claims including email.
 */
export async function verifyMicrosoftIdToken(idToken) {
  if (!isMicrosoftAuthConfigured()) {
    throw new Error('Microsoft sign-in is not configured on the server')
  }
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Microsoft ID token is required')
  }

  const { payload } = await jose.jwtVerify(idToken, getJwks(), {
    issuer: getIssuer(),
    audience: clientId,
  })

  const email = String(
    payload.preferred_username || payload.email || payload.upn || ''
  )
    .trim()
    .toLowerCase()

  if (!email) {
    throw new Error('Microsoft account did not return an email address')
  }

  assertAllowedMicrosoftEmail(email)

  return {
    email,
    name: payload.name ? String(payload.name) : null,
    oid: payload.oid ? String(payload.oid) : null,
    tid: payload.tid ? String(payload.tid) : tenantId,
  }
}

export function getMicrosoftPublicConfig() {
  if (!isMicrosoftAuthConfigured()) return { enabled: false }
  return {
    enabled: true,
    tenantId,
    clientId,
    authority: getIssuer().replace('/v2.0', ''),
  }
}
