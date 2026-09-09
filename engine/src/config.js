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
    sync: {
      // due_loans collection-date window, in months relative to today.
      // Defaults are intentionally wide so the matcher sees the FULL loan book
      // (every loan that ever had an installment scheduled), not just the
      // ~active loans due in the next month. Narrow these to restore the
      // legacy "active only" behaviour.
      windowMonthsBack: Math.max(0, optionalNumber('DUE_LOANS_WINDOW_MONTHS_BACK', 120)),
      windowMonthsForward: Math.max(0, optionalNumber('DUE_LOANS_WINDOW_MONTHS_FORWARD', 120)),
      // LoanDisk "Current" status for advanced_search_loans (PDF §16).
      currentLoanStatusId: optionalNumber('LOANDISK_CURRENT_LOAN_STATUS_ID', 18),
      // Status ids pulled into staging: 1 = Active (open), 18 = Current.
      // First match wins on de-dupe, so 18 (current) is listed first.
      statusIds: (process.env.LOANDISK_STATUS_IDS || '18,1')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n)),
      // advanced_search_loans presigns S3 file URLs server-side and is slow for
      // big branches, so it gets a much longer per-request timeout.
      searchTimeoutMs: optionalNumber('LOANDISK_SEARCH_TIMEOUT_MS', 180_000),
      // When true, closed / fully paid / settled loans are also synced and
      // matched (a bank credit can be the final payment that closed a loan).
      includeInactive: optionalBool('DUE_LOANS_INCLUDE_INACTIVE', true),
    },
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
    concurrency: Math.max(1, optionalNumber('MATCH_CONCURRENCY', 8)),
    // Nitro = route to the fastest providers (provider.sort = throughput).
    nitro: optionalBool('OPENROUTER_NITRO', true),
    // Stream tokens (lower time-to-first-byte, snappier batch throughput).
    stream: optionalBool('OPENROUTER_STREAM', true),
    // Token budget for the answer. Reasoning models spend tokens "thinking"
    // before the JSON, so keep enough headroom or responses get truncated.
    maxTokens: Math.max(256, optionalNumber('OPENROUTER_MAX_TOKENS', 800)),
    // Per-AI-call budget during matching. Free models get rate-limited (429),
    // so fail fast and fall back to the deterministic result instead of spinning
    // for minutes — keeps the "Run Matching" loader from hanging.
    aiCallRetries: Math.max(0, optionalNumber('OPENROUTER_AI_CALL_RETRIES', 1)),
    aiCallTimeoutMs: Math.max(5_000, optionalNumber('OPENROUTER_AI_CALL_TIMEOUT_MS', 20_000)),
    // Hard ceiling on the whole AI adjudication phase. Once exceeded, remaining
    // ambiguous ties keep their deterministic verdict so the run finishes.
    aiPhaseMaxMs: Math.max(10_000, optionalNumber('OPENROUTER_AI_PHASE_MAX_MS', 120_000)),
  },
  port: optionalNumber('PORT', 4000),
}
