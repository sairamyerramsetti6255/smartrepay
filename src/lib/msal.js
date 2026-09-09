import { PublicClientApplication } from '@azure/msal-browser'
import { getRuntimeConfig } from '@/lib/runtimeConfig'

/**
 * Dedicated static page — NOT a React hash route.
 * HashRouter uses #/login for routing; MSAL needs the URL hash for auth tokens.
 * Redirect URI is always the current host so Hostinger / Coolify / localhost all work.
 */
function getRedirectUri() {
  return `${window.location.origin}/msal-redirect.html`
}

function getPostLogoutRedirectUri() {
  return `${window.location.origin}/#/login`
}

function getAzureConfig() {
  const cfg = getRuntimeConfig()
  const tenantId = String(cfg.azureTenantId || import.meta.env.VITE_AZURE_TENANT_ID || '').trim()
  const clientId = String(cfg.azureClientId || import.meta.env.VITE_AZURE_CLIENT_ID || '').trim()
  return { tenantId, clientId }
}

export function isMicrosoftLoginEnabled() {
  const { tenantId, clientId } = getAzureConfig()
  return Boolean(tenantId && clientId)
}

const loginRequest = {
  scopes: ['openid', 'profile', 'email', 'User.Read'],
  domainHint: 'slendingbahamas.com',
  // Always show Microsoft account picker — never silent SSO into dashboard
  prompt: 'select_account',
}

let msalInstance = null
let initPromise = null
let configuredClientId = null

async function getMsal() {
  const { tenantId, clientId } = getAzureConfig()
  if (!tenantId || !clientId) {
    throw new Error('Microsoft sign-in is not configured')
  }

  if (msalInstance && configuredClientId !== clientId) {
    msalInstance = null
    initPromise = null
  }

  if (!msalInstance) {
    configuredClientId = clientId
    msalInstance = new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri: getRedirectUri(),
        postLogoutRedirectUri: getPostLogoutRedirectUri(),
        navigateToLoginRequestUrl: false,
      },
      cache: {
        cacheLocation: 'sessionStorage',
        storeAuthStateInCookie: false,
      },
    })
  }

  if (!initPromise) {
    initPromise = (async () => {
      await msalInstance.initialize()
      try {
        await msalInstance.handleRedirectPromise()
      } catch (err) {
        if (err?.errorCode !== 'hash_does_not_contain_known_properties') throw err
      }
    })()
  }
  await initPromise
  return msalInstance
}

/**
 * Always open Microsoft account picker (no silent token reuse).
 * Returns the ID token for backend verification.
 */
export async function acquireMicrosoftIdToken() {
  const msal = await getMsal()
  const result = await msal.loginPopup({
    ...loginRequest,
    redirectUri: getRedirectUri(),
  })
  if (!result?.idToken) {
    throw new Error('Microsoft sign-in did not return an ID token')
  }
  return result.idToken
}

/** Clear local MSAL cache without requiring Microsoft logout UI. */
export async function clearMicrosoftSession() {
  if (!isMicrosoftLoginEnabled()) return
  try {
    const msal = await getMsal()
    msal.setActiveAccount(null)
    await msal.clearCache()
  } catch {
    try {
      // Last resort: drop MSAL keys from sessionStorage
      const keys = Object.keys(sessionStorage)
      for (const key of keys) {
        if (key.includes('msal') || key.includes('login.windows') || key.includes('login.microsoft')) {
          sessionStorage.removeItem(key)
        }
      }
    } catch {
      /* ignore */
    }
  }
}

/** Full Microsoft logout (popup) + clear local cache. */
export async function signOutMicrosoft() {
  if (!isMicrosoftLoginEnabled()) return
  try {
    const msal = await getMsal()
    const account = msal.getAllAccounts()[0]
    if (account) {
      await msal.logoutPopup({
        account,
        postLogoutRedirectUri: getPostLogoutRedirectUri(),
      })
    } else {
      await clearMicrosoftSession()
    }
  } catch {
    await clearMicrosoftSession()
  }
}
