import 'dotenv/config'

function required(name) {
  const value = process.env[name]
  if (value === undefined || String(value).trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`)
  }
  return value
}

function optionalNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || String(raw).trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function optionalBool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return /^(1|true|yes)$/i.test(String(raw).trim())
}

/** Parse "Name:Id,Name2:Id2" into [{ name, id }]. Mirrors the _allBranches dictionary in manager.cs. */
function parseBranches(raw) {
  if (!raw) return []
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.lastIndexOf(':')
      if (idx === -1) return { name: pair, id: pair }
      return { name: pair.slice(0, idx).trim(), id: pair.slice(idx + 1).trim() }
    })
    .filter((b) => b.id)
}

export const config = {
  loandisk: {
    // NOTE: these are only needed by the LoanDisk SYNC. Keep them soft so simply
    // importing this module (e.g. for in-process matching, or to boot the web
    // server) never throws when they are absent. The sync validates at run time.
    baseUrl: (process.env.LOANDISK_BASE_URL || 'https://api-main.loandisk.com').replace(/\/+$/, ''),
    publicKey: process.env.LOANDISK_PUBLIC_KEY || '',
    authToken: process.env.LOANDISK_AUTH_TOKEN || '',
    branches: parseBranches(process.env.LOANDISK_BRANCHES || 'SimplifiedLending:18279'),
  },
  db: {
    server: process.env.DB_SERVER || 'localhost',
    port: optionalNumber('DB_PORT', 1433),
    database: process.env.DB_DATABASE || 'SmartRepay',
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || '',
    options: {
      encrypt: optionalBool('DB_ENCRYPT', false),
      trustServerCertificate: optionalBool('DB_TRUST_SERVER_CERT', true),
    },
  },
  performance: {
    borrowerConcurrency: Math.max(1, optionalNumber('BORROWER_CONCURRENCY', 20)),
    requestTimeoutMs: optionalNumber('REQUEST_TIMEOUT_MS', 30_000),
    maxRetries: Math.max(0, optionalNumber('MAX_RETRIES', 3)),
    dbBatchSize: Math.max(1, optionalNumber('DB_BATCH_SIZE', 200)),
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    siteUrl: process.env.OPENROUTER_SITE_URL || 'http://localhost:4000',
    appName: process.env.OPENROUTER_APP_NAME || 'SmartRepay Matcher',
    concurrency: Math.max(1, optionalNumber('MATCH_CONCURRENCY', 4)),
  },
  port: optionalNumber('PORT', 4000),
}
