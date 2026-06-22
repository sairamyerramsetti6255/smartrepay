import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import bcrypt from 'bcryptjs'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID, createHash } from 'crypto'
import db, { initDb, resetAppData, rowBorrower, parseJson } from './db.js'
import { authMiddleware, signToken } from './auth.js'
import { matchTransaction, detectExceptionType } from './matcher.js'
import { runHeavyJob, isHeavyJobRunning, getActiveJobName } from './jobRunner.js'
import { getMatchingPreview, getBranchTransactions } from './matchingService.js'
import { parseStatementBuffer } from './parseStatement.js'
import {
  getLoanDiskToken,
  normalizeLoanDiskBorrower,
  normalizeBorrowersFromPayload,
  borrowerSearch,
  parseBorrowerSearchResults,
} from './loandisk.js'
import {
  RULE_CATALOG,
  DEFAULT_MATCHING_RULES,
  resolveMatchingRules,
  previewMatchSample,
  testAliasPattern,
} from './matchingRules.js'
import { getBorrowerResponse } from './borrowerFetchService.js'
import { runMatch } from './matchRunner.js'
import {
  insertBankTransactions,
  uniqueFileName,
  getActiveLoans,
  getBankTransactions,
  getStagingCounts,
  getDashboardStats,
  getSqlMatchResults,
  updateSqlMatchReview,
  getDocuments,
  deleteDocument,
  flagDuplicateRows,
  getLoansByBorrowerId,
  saveManualReceipt,
  getManualReceipts,
  searchBorrowersForReceipts,
  getLoanRepayments,
} from './stagingDb.js'

import { UPLOADS_DIR, ensureDataDirs } from './paths.js'

ensureDataDirs()

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

initDb()

const app = express()
const PORT = process.env.PORT || 3001

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true)
      if (process.env.NODE_ENV === 'production') return cb(null, true)
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true)
      return cb(null, false)
    },
    credentials: true,
  })
)
app.use(express.json({ limit: '50mb' }))
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Pragma', 'no-cache')
  next()
})

function loanDiskConfigured() {
  return !!(process.env.LOANDISK_USERNAME || process.env.LOANDISK_PASSWORD || process.env.LOANDISK_ACCESS_TOKEN)
}

function audit(entity, entityId, action, actor, priorValue, newValue) {
  db.prepare(
    `insert into audit_log (id, entity, entity_id, action, actor, prior_value, new_value) values (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    entity,
    entityId || null,
    action,
    actor,
    priorValue ? JSON.stringify(priorValue) : null,
    newValue ? JSON.stringify(newValue) : null
  )
}

function getSettings() {
  try {
    const row = db.prepare('select value from app_settings where key = ?').get('global')
    if (!row?.value) return {}
    return JSON.parse(row.value)
  } catch {
    return {}
  }
}

function saveSettings(partial, actor) {
  const current = getSettings()
  const next = { ...current, ...partial }
  db.prepare('insert into app_settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(
    'global',
    JSON.stringify(next)
  )
  if (actor) audit('settings', null, 'update', actor, current, next)
  return next
}

function importHash(row) {
  return createHash('sha256').update(`${row.date}|${row.payer}|${row.amount}|${row.reference}`).digest('hex')
}

const parseCache = new Map()
const PARSE_TTL_MS = 30 * 60 * 1000

function cacheParse(id, data) {
  parseCache.set(id, { ...data, cachedAt: Date.now() })
}

function getCachedParse(id) {
  const entry = parseCache.get(id)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > PARSE_TTL_MS) {
    parseCache.delete(id)
    return null
  }
  return entry
}

function bulkInsertRows(rows, actor, documentId = null) {
  const inserted = []
  for (const row of rows) {
    const hash = row.import_hash || importHash(row)
    const exists = db.prepare('select id from transactions where import_hash = ?').get(hash)
    if (exists) continue
    const id = randomUUID()
    db.prepare(
      `insert into transactions (id, date, payer, description, amount, reference, status, import_hash, source_document_id)
       values (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(id, row.date, row.payer, row.description, row.amount, row.reference, hash, documentId)
    inserted.push(id)
  }
  if (inserted.length && actor) {
    audit('transactions', null, 'bulk_import', actor, null, { count: inserted.length, documentId })
  }
  return inserted
}

function saveUploadedDocument({ buffer, filename, mimeType, documentType, uploadedBy, rowCount }) {
  const docId = randomUUID()
  const safeName = path.basename(filename || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload'
  const docDir = path.join(UPLOADS_DIR, docId)
  fs.mkdirSync(docDir, { recursive: true })
  const storagePath = path.join(docDir, safeName)
  if (buffer?.length) fs.writeFileSync(storagePath, buffer)
  db.prepare(
    `insert into documents (id, filename, mime_type, size_bytes, storage_path, uploaded_by, document_type, row_count)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(docId, filename, mimeType || null, buffer?.length || 0, storagePath, uploadedBy, documentType || null, rowCount || 0)
  return docId
}

setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of parseCache) {
    if (now - entry.cachedAt > PARSE_TTL_MS) parseCache.delete(id)
  }
}, 5 * 60 * 1000)

// --- Health ---
app.get('/api/health', (_req, res) =>
  res.json({
    ok: true,
    backend: 'node-sqlite',
    ai: !!process.env.OPENROUTER_API_KEY,
    build: '1.8.0',
    heavyJob: getActiveJobName(),
    features: {
      documents: true,
      loandiskBorrowerSearch: true,
    },
  })
)

// --- Ingest ---
app.post('/api/ingest/parse', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const documentType = String(req.body.documentType || '').trim().toLowerCase() || null
    const fileParticulars = String(req.body.fileParticulars || '').trim() || null
    if (!documentType) {
      return res.status(400).json({ error: 'Select a document type before uploading' })
    }

    const result = await parseStatementBuffer(req.file.buffer, req.file.originalname, {
      documentType,
      fileParticulars,
    })
    // Duplicate detection now runs purely against SQL Server (Staging_BankTransactions),
    // so an empty SQL table means zero duplicates regardless of old SQLite history.
    const dupFlags = await flagDuplicateRows(result.rows)
    const rows = result.rows.map((r, i) => ({
      date: r.date,
      payer: r.payer,
      description: r.description,
      amount: r.amount,
      reference: r.reference,
      import_hash: r.import_hash,
      _duplicate: dupFlags[i] || false,
    }))
    audit('ingest', null, 'parse_statement', req.user.email, null, {
      file: req.file.originalname,
      count: rows.length,
      method: result.method,
      documentType,
      fileParticulars,
    })
    const creditCount = result.creditRows?.length ?? rows.length
    const duplicateCount = rows.filter((r) => r._duplicate).length
    const readyCount = rows.length - duplicateCount
    const parseId = randomUUID()

    cacheParse(parseId, {
      rows,
      richRows: result.rows,
      userId: req.user.sub,
      filename: req.file.originalname,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      documentType: result.documentType || documentType,
      fileParticulars,
    })

    res.json({
      parseId,
      method: result.method,
      source: result.source || result.documentType || documentType,
      documentType: result.documentType || documentType,
      fileParticulars,
      rawRows: result.rawRows,
      creditRows: result.creditRows?.slice(0, 25) || null,
      creditCount,
      rowCount: rows.length,
      duplicateCount,
      readyCount,
      rows: rows.slice(0, 25),
      filename: req.file.originalname,
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/ingest/import', authMiddleware, async (req, res) => {
  try {
    const { parseId } = req.body
    if (!parseId) return res.status(400).json({ error: 'Missing parseId — re-upload the file' })

    const cached = getCachedParse(parseId)
    if (!cached) return res.status(400).json({ error: 'Parse session expired — re-upload the file' })
    if (cached.userId !== req.user.sub) return res.status(403).json({ error: 'Unauthorized' })

    const toInsert = cached.rows.filter((r) => !r._duplicate)
    if (!toInsert.length) return res.status(400).json({ error: 'No new rows to import' })

    const documentId = saveUploadedDocument({
      buffer: cached.buffer,
      filename: cached.filename,
      mimeType: cached.mimeType,
      documentType: cached.documentType,
      uploadedBy: req.user.email,
      rowCount: toInsert.length,
    })

    const inserted = bulkInsertRows(toInsert, req.user.email, documentId)

    // Stage the parsed credits into SQL Server (Staging_BankTransactions) under a
    // unique, timestamped file name so they can be matched against LoanDisk.
    const stagedFileName = uniqueFileName(cached.filename)
    let staged = 0
    let stagedDuplicates = 0
    let stagingError = null
    try {
      const stagingRows = (cached.richRows || []).map((r) => ({
        ...r,
        documentType: r.documentType || cached.documentType,
        employerOrBank:
          r.employerOrBank ||
          r.employer ||
          (cached.documentType === 'employer' ? cached.fileParticulars : null) ||
          cached.fileParticulars ||
          null,
        particulars: cached.fileParticulars
          ? [cached.fileParticulars, r.particulars || r.description].filter(Boolean).join(' — ')
          : r.particulars || r.description,
      }))
      const stagingResult = await insertBankTransactions(stagingRows, {
        fileName: stagedFileName,
        uploadedDate: new Date(),
      })
      staged = stagingResult.inserted
      stagedDuplicates = stagingResult.skipped
    } catch (e) {
      stagingError = e.message
      console.error('Staging_BankTransactions insert failed:', e.message)
    }

    parseCache.delete(parseId)

    audit('ingest', null, 'import_statement', req.user.email, null, {
      file: cached.filename,
      stagedFile: stagedFileName,
      count: inserted.length,
      staged,
      stagedDuplicates,
      documentId,
    })

    res.json({
      inserted: inserted.length,
      documentId,
      staged,
      stagedDuplicates,
      stagedFileName,
      stagingError,
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// --- Active loans (LoanDisk due-records staging table on SQL Server) ---
app.get('/api/active-loans', authMiddleware, async (req, res) => {
  try {
    const rows = await getActiveLoans({ search: req.query.search || '' })
    res.json({ rows })
  } catch (e) {
    res.status(500).json({ error: `Could not load active loans: ${e.message}` })
  }
})

// --- Staged bank transactions (Staging_BankTransactions on SQL Server) ---
app.get('/api/bank-transactions', authMiddleware, async (req, res) => {
  try {
    const rows = await getBankTransactions({ search: req.query.search || '' })
    res.json({ rows })
  } catch (e) {
    res.status(500).json({ error: `Could not load bank transactions: ${e.message}` })
  }
})

// --- Staging counts for tiles ---
app.get('/api/staging/summary', authMiddleware, async (_req, res) => {
  try {
    res.json(await getStagingCounts())
  } catch (e) {
    res.status(500).json({ error: `Could not load staging summary: ${e.message}` })
  }
})

app.get('/api/dashboard/stats', authMiddleware, async (_req, res) => {
  try {
    res.json(await getDashboardStats())
  } catch (e) {
    res.status(500).json({ error: `Could not load dashboard stats: ${e.message}` })
  }
})

// --- Manual receipt upload (walk-in / WhatsApp / email / phone) ---
app.get('/api/receipts/borrowers', authMiddleware, async (req, res) => {
  try {
    const borrowers = await searchBorrowersForReceipts({ search: req.query.search || '' })
    res.json({ borrowers })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/receipts/loans/:borrowerId', authMiddleware, async (req, res) => {
  try {
    const loans = await getLoansByBorrowerId(req.params.borrowerId)
    res.json({ loans })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/receipts', authMiddleware, async (_req, res) => {
  try {
    const rows = await getManualReceipts()
    res.json({ rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// --- Repayment ledger for a single loan (synced + manual receipts) ---
app.get('/api/loans/:loanNumber/repayments', authMiddleware, async (req, res) => {
  try {
    const data = await getLoanRepayments(req.params.loanNumber)
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: `Could not load repayments: ${e.message}` })
  }
})

app.post('/api/receipts', authMiddleware, upload.single('receipt'), async (req, res) => {
  try {
    const borrowerId = String(req.body.borrowerId || '').trim()
    const loanNumber = String(req.body.loanNumber || '').trim()
    const amountReceived = req.body.amountReceived
    const particulars = String(req.body.particulars || '').trim()
    const sourceChannel = String(req.body.sourceChannel || '').trim().toLowerCase()
    const collectedDate = req.body.collectedDate || new Date().toISOString().slice(0, 10)
    const branchId = req.body.branchId || null
    const borrowerName = req.body.borrowerName || null

    if (!borrowerId) return res.status(400).json({ error: 'Borrower ID is required' })
    if (!loanNumber) return res.status(400).json({ error: 'Select a loan' })

    let receiptDocumentId = null
    let receiptFileName = null
    if (req.file) {
      receiptDocumentId = saveUploadedDocument({
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        documentType: 'receipt',
        uploadedBy: req.user.email,
        rowCount: 1,
      })
      receiptFileName = req.file.originalname
    }

    const result = await saveManualReceipt({
      borrowerId,
      loanNumber,
      branchId,
      borrowerName,
      amountReceived,
      particulars,
      sourceChannel,
      collectedDate,
      receiptFileName,
      receiptDocumentId,
      enteredBy: req.user.email,
    })

    audit('receipt', loanNumber, 'manual_receipt', req.user.email, null, {
      borrowerId,
      loanNumber,
      amountReceived,
      sourceChannel,
      receiptDocumentId,
    })

    res.json({ ok: true, receiptDocumentId, ...result })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// --- Match results straight from SQL Server (the single source of truth) ---
app.get('/api/sql/match-results', authMiddleware, async (req, res) => {
  try {
    res.json(await getSqlMatchResults({ search: req.query.search || '' }))
  } catch (e) {
    res.status(500).json({ error: `Could not load match results: ${e.message}` })
  }
})

app.patch('/api/sql/match-results/:bankTxId', authMiddleware, async (req, res) => {
  try {
    await updateSqlMatchReview({
      bankTransactionId: req.params.bankTxId,
      reviewStatus: req.body.reviewStatus,
      borrowerId: req.body.borrowerId ?? null,
      borrowerName: req.body.borrowerName ?? null,
      loanNumber: req.body.loanNumber ?? null,
      confidence: req.body.confidence ?? null,
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: `Could not update match: ${e.message}` })
  }
})

// --- SQL/AI matching runner -------------------------------------------------
// Runs the reconciliation engine IN-PROCESS (no separate Node project): matches
// Staging_BankTransactions against Staging_LoandiskDueRecords (fuzzy name +
// subset-sum / bi-weekly EMI + OpenRouter AI for ambiguous ties) and upserts
// Staging_TransactionMatches via CRIF_Operations.
const sqlMatchJob = {
  status: 'idle', // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  useAi: true,
  scope: null, // { fileNames: string[], fileCount } | null (null = whole book)
  progress: null, // { phase, done, total, bankTx, loans, matched, unmatched }
  summary: null, // { autoMatched, unmatched, total, ai }
  error: null,
}

app.post('/api/sql/match/run', authMiddleware, (req, res) => {
  if (sqlMatchJob.status === 'running') {
    return res.json({ status: 'running', message: 'Matching already in progress', progress: sqlMatchJob.progress })
  }

  const useAi = req.body?.useAi !== false
  const fileNames = Array.isArray(req.body?.fileNames)
    ? req.body.fileNames.map((f) => String(f)).filter(Boolean)
    : null
  const scope = fileNames && fileNames.length ? { fileNames, fileCount: fileNames.length } : null
  const runToken = new Date().toISOString()
  Object.assign(sqlMatchJob, {
    status: 'running',
    startedAt: runToken,
    finishedAt: null,
    useAi,
    scope,
    progress: { phase: 'starting', done: 0, total: 0 },
    summary: null,
    error: null,
  })

  // Watchdog: guarantee the job always reaches a terminal state so the UI loader
  // can never spin forever (e.g. if a DB / OpenRouter call hangs). Only trips if
  // THIS run is still in flight (startedAt unchanged).
  const MATCH_TIMEOUT_MS = Number(process.env.MATCH_JOB_TIMEOUT_MS) || 8 * 60 * 1000
  const watchdog = setTimeout(() => {
    if (sqlMatchJob.status === 'running' && sqlMatchJob.startedAt === runToken) {
      sqlMatchJob.status = 'error'
      sqlMatchJob.error = 'Matching timed out — please try again'
      sqlMatchJob.progress = { ...(sqlMatchJob.progress || {}), phase: 'done' }
      sqlMatchJob.finishedAt = new Date().toISOString()
    }
  }, MATCH_TIMEOUT_MS)
  if (typeof watchdog.unref === 'function') watchdog.unref()

  // Fire-and-forget: the client polls /api/sql/match/status for progress.
  runMatch({
    useAi,
    fileNames,
    onProgress: (p) => {
      // Ignore progress from a superseded run.
      if (sqlMatchJob.startedAt !== runToken) return
      sqlMatchJob.progress = { ...(sqlMatchJob.progress || {}), ...p }
    },
  })
    .then((summary) => {
      if (sqlMatchJob.startedAt !== runToken) return
      sqlMatchJob.summary = summary
      sqlMatchJob.status = 'done'
      sqlMatchJob.progress = { ...(sqlMatchJob.progress || {}), phase: 'done' }
      sqlMatchJob.finishedAt = new Date().toISOString()
    })
    .catch((e) => {
      if (sqlMatchJob.startedAt !== runToken) return
      sqlMatchJob.status = 'error'
      sqlMatchJob.error = e.message
      sqlMatchJob.progress = { ...(sqlMatchJob.progress || {}), phase: 'done' }
      sqlMatchJob.finishedAt = new Date().toISOString()
    })
    .finally(() => clearTimeout(watchdog))

  res.json({
    status: 'started',
    useAi,
    message: useAi ? 'AI matching started' : 'Deterministic matching started',
  })
})

app.get('/api/sql/match/status', authMiddleware, (_req, res) => {
  res.json({
    status: sqlMatchJob.status,
    useAi: sqlMatchJob.useAi,
    scope: sqlMatchJob.scope,
    progress: sqlMatchJob.progress,
    summary: sqlMatchJob.summary,
    error: sqlMatchJob.error,
    startedAt: sqlMatchJob.startedAt,
    finishedAt: sqlMatchJob.finishedAt,
  })
})

// --- Auth ---
// Self-service signup is disabled — accounts are provisioned by the administrator.
app.post('/api/auth/signup', (_req, res) => {
  res.status(403).json({ error: 'Account creation is disabled. Contact the administrator.' })
})

app.post('/api/auth/signin', (req, res) => {
  const { email, password } = req.body
  const user = db.prepare('select * from users where email = ?').get(email)
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' })
  }
  const token = signToken(user)
  res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
  })
})

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('select id, email, role, full_name from users where id = ?').get(req.user.sub)
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ user })
})

// --- Settings ---
app.get('/api/settings', authMiddleware, (_req, res) => res.json(getSettings()))

app.put('/api/settings', authMiddleware, (req, res) => {
  if (req.user.role !== 'system_owner') return res.status(403).json({ error: 'Forbidden' })
  res.json(saveSettings(req.body, req.user.email))
})

app.get('/api/settings/matching-rules', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'system_owner') return res.status(403).json({ error: 'Forbidden' })
    const settings = getSettings()
    res.json({
      rules: resolveMatchingRules(settings.matchingRules),
      catalog: RULE_CATALOG,
      defaults: DEFAULT_MATCHING_RULES,
    })
  } catch (e) {
    console.error('GET /api/settings/matching-rules:', e)
    res.status(500).json({ error: e.message || 'Could not load matching rules' })
  }
})

app.put('/api/settings/matching-rules', authMiddleware, (req, res) => {
  try {
    if (req.user.role !== 'system_owner') return res.status(403).json({ error: 'Forbidden' })
    const rules = resolveMatchingRules(req.body?.rules || req.body)
    const next = saveSettings(
      {
        matchingRules: rules,
        autoApproveThreshold: rules.thresholds.autoMatchConfidence,
      },
      req.user.email
    )
    res.json({ rules: resolveMatchingRules(next.matchingRules), ok: true })
  } catch (e) {
    console.error('PUT /api/settings/matching-rules:', e)
    res.status(500).json({ error: e.message || 'Could not save matching rules' })
  }
})

app.post('/api/settings/matching-rules/preview', authMiddleware, async (req, res) => {
  if (req.user.role !== 'system_owner') return res.status(403).json({ error: 'Forbidden' })
  try {
    const rules = req.body?.rules ? resolveMatchingRules(req.body.rules) : resolveMatchingRules(getSettings().matchingRules)
    const preview = await previewMatchSample(req.body?.sample || {}, rules)
    res.json(preview)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/settings/matching-rules/test-pattern', authMiddleware, (req, res) => {
  if (req.user.role !== 'system_owner') return res.status(403).json({ error: 'Forbidden' })
  const { pattern, flags, testString } = req.body || {}
  res.json(testAliasPattern(pattern, flags, testString))
})

// --- Borrowers ---
app.get('/api/borrowers', authMiddleware, (_req, res) => {
  const rows = db.prepare('select * from borrowers order by full_name').all() || []
  res.json(rows.map(rowBorrower).filter(Boolean))
})

app.post('/api/borrowers', authMiddleware, (req, res) => {
  const { full_name, employer, aliases } = req.body
  const id = randomUUID()
  db.prepare('insert into borrowers (id, full_name, employer, aliases) values (?, ?, ?, ?)').run(
    id,
    full_name,
    employer || null,
    JSON.stringify(aliases || [])
  )
  audit('borrower', id, 'create', req.user.email, null, req.body)
  res.json(rowBorrower(db.prepare('select * from borrowers where id = ?').get(id)))
})

app.patch('/api/borrowers/:id', authMiddleware, (req, res) => {
  const prior = rowBorrower(db.prepare('select * from borrowers where id = ?').get(req.params.id))
  if (!prior) return res.status(404).json({ error: 'Not found' })
  const { full_name, employer, aliases } = req.body
  db.prepare('update borrowers set full_name = ?, employer = ?, aliases = ? where id = ?').run(
    full_name ?? prior.full_name,
    employer ?? prior.employer,
    JSON.stringify(aliases ?? prior.aliases),
    req.params.id
  )
  const next = rowBorrower(db.prepare('select * from borrowers where id = ?').get(req.params.id))
  audit('borrower', req.params.id, 'update', req.user.email, prior, next)
  res.json(next)
})

// --- Loans ---
app.get('/api/loans', authMiddleware, (_req, res) => {
  res.json(db.prepare('select * from loans order by loan_number').all())
})

app.post('/api/loans', authMiddleware, (req, res) => {
  const { borrower_id, loan_number, outstanding_balance, status } = req.body
  const id = randomUUID()
  db.prepare(
    'insert into loans (id, borrower_id, loan_number, outstanding_balance, status) values (?, ?, ?, ?, ?)'
  ).run(id, borrower_id, loan_number, outstanding_balance ?? null, status || 'active')
  audit('loan', id, 'create', req.user.email, null, req.body)
  res.json(db.prepare('select * from loans where id = ?').get(id))
})

// --- Transactions ---
app.get('/api/transactions', authMiddleware, (req, res) => {
  let sql = `select t.*, d.filename as source_filename
    from transactions t
    left join documents d on d.id = t.source_document_id`
  const params = []
  const where = []
  if (req.query.date) {
    where.push('t.date = ?')
    params.push(req.query.date)
  }
  if (req.query.status) {
    where.push('t.status = ?')
    params.push(req.query.status)
  }
  if (req.query.since) {
    where.push('t.date >= ?')
    params.push(req.query.since)
  }
  if (req.query.document_id) {
    where.push('t.source_document_id = ?')
    params.push(req.query.document_id)
  }
  if (where.length) sql += ` where ${where.join(' and ')}`
  sql += ' order by t.created_at desc'
  res.json(db.prepare(sql).all(...params))
})

app.get('/api/transactions/counts', authMiddleware, (_req, res) => {
  const borrowers = db.prepare('select count(*) as c from borrowers').get().c
  const transactions = db.prepare('select count(*) as c from transactions').get().c
  const exceptions = db.prepare('select count(*) as c from exceptions').get().c
  const documents = db.prepare('select count(*) as c from documents').get().c
  const openExceptions = db.prepare("select count(*) as c from exceptions where status = 'open'").get().c
  const statusRows = db.prepare('select status, count(*) as c from transactions group by status').all()
  const byStatus = { pending: 0, matched: 0, exception: 0, posted: 0 }
  for (const row of statusRows) {
    if (row.status in byStatus) byStatus[row.status] = row.c
  }
  res.json({
    borrowers,
    transactions,
    exceptions,
    documents,
    openExceptions,
    pending: byStatus.pending,
    matched: byStatus.matched,
    unmatched: byStatus.exception,
    posted: byStatus.posted,
  })
})

app.post('/api/transactions/bulk', authMiddleware, (req, res) => {
  const rows = req.body.rows || []
  const inserted = bulkInsertRows(rows, req.user.email)
  res.json({ inserted: inserted.length, ids: inserted })
})

app.patch('/api/transactions/:id', authMiddleware, (req, res) => {
  const prior = db.prepare('select * from transactions where id = ?').get(req.params.id)
  if (!prior) return res.status(404).json({ error: 'Not found' })
  const fields = ['status', 'confidence_score', 'matched_borrower_id', 'loan_id', 'payer', 'description', 'amount', 'reference']
  const updates = []
  const values = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`)
      values.push(req.body[f] === '' ? null : req.body[f])
    }
  }
  if (!updates.length) return res.json(prior)
  values.push(req.params.id)
  db.prepare(`update transactions set ${updates.join(', ')} where id = ?`).run(...values)
  const next = db.prepare('select * from transactions where id = ?').get(req.params.id)
  audit('transaction', req.params.id, req.body.action || 'update', req.user.email, prior, next)
  res.json(next)
})

app.get('/api/transactions/hashes', authMiddleware, (_req, res) => {
  const rows = db.prepare('select import_hash from transactions where import_hash is not null').all()
  res.json(rows.map((r) => r.import_hash))
})

function upsertBorrowerRecord(b) {
  const existing = db.prepare('select id from borrowers where loandisk_id = ?').get(b.loandisk_id)
  const aliasesJson = JSON.stringify(b.aliases || [])

  if (existing) {
    db.prepare(
      `update borrowers set full_name = ?, first_name = ?, last_name = ?, employer = ?, aliases = ?, branch_id = ?, branch_name = ? where id = ?`
    ).run(
      b.full_name,
      b.first_name,
      b.last_name,
      b.employer,
      aliasesJson,
      b.branch_id,
      b.branch_name,
      existing.id
    )
    return { id: existing.id, created: false }
  }

  const id = randomUUID()
  db.prepare(
    `insert into borrowers (id, full_name, first_name, last_name, employer, aliases, loandisk_id, branch_id, branch_name)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    b.full_name,
    b.first_name,
    b.last_name,
    b.employer,
    aliasesJson,
    b.loandisk_id,
    b.branch_id,
    b.branch_name
  )

  const loanNum = b.unique_number || `LD-${b.loandisk_id}`
  const loanExists = db.prepare('select id from loans where loan_number = ?').get(loanNum)
  if (!loanExists) {
    db.prepare(
      'insert into loans (id, borrower_id, loan_number, outstanding_balance, status) values (?, ?, ?, ?, ?)'
    ).run(randomUUID(), id, loanNum, null, 'active')
  }
  return { id, created: true }
}

function importBorrowerBatch(borrowers, actor, meta = {}) {
  let created = 0
  let updated = 0

  for (const raw of borrowers) {
    const b = raw.loandisk_id && raw.full_name ? raw : normalizeLoanDiskBorrower(raw.raw || raw)
    if (!b?.loandisk_id) continue
    const result = upsertBorrowerRecord(b)
    if (result.created) created++
    else updated++
  }

  audit('loandisk', null, 'import_borrowers', actor, null, { created, updated, ...meta })
  return { created, updated, synced: created + updated, total: borrowers.length, source: 'GetAllBorrowers', ...meta }
}

const syncJob = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
  progress: null,
}

const matchingJob = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  progress: null,
  result: null,
  error: null,
}

// --- LoanDisk ---
app.get('/api/loandisk/token', authMiddleware, async (_req, res) => {
  try {
    const token = await getLoanDiskToken()
    res.json({ token })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/loandisk/import-raw', authMiddleware, (req, res) => {
  try {
    const parsed = normalizeBorrowersFromPayload(req.body)
    const result = importBorrowerBatch(parsed.borrowers, req.user.email, {
      branches: parsed.branches,
      totalReported: parsed.totalReported,
      message: parsed.message,
    })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/loandisk/import-borrowers', authMiddleware, (req, res) => {
  try {
    const incoming = req.body.borrowers || req.body.rows || []
    if (!incoming.length) return res.status(400).json({ error: 'No borrowers to import' })
    res.json(importBorrowerBatch(incoming, req.user.email))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/loandisk/status', authMiddleware, async (_req, res) => {
  try {
    const token = await getLoanDiskToken()
    const localCount = db.prepare('select count(*) as c from borrowers').get().c
    res.json({
      ok: true,
      hasToken: !!token,
      borrowerId: process.env.LOANDISK_BORROWER_ID || '4617884',
      endpoint: 'SP/GetAllBorrowers',
      localBorrowers: localCount,
    })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

app.get('/api/loandisk/sync/status', authMiddleware, (_req, res) => {
  res.json({
    status: syncJob.status,
    result: syncJob.result,
    error: syncJob.error,
    startedAt: syncJob.startedAt,
    finishedAt: syncJob.finishedAt,
  })
})

app.post('/api/loandisk/sync', authMiddleware, (req, res) => {
  try {
    if (syncJob.status === 'running' || isHeavyJobRunning()) {
      return res.json({
        status: 'running',
        message: 'Borrower sync already in progress',
        activeJob: getActiveJobName(),
      })
    }
    syncJob.status = 'running'
    syncJob.startedAt = new Date().toISOString()
    syncJob.finishedAt = null
    syncJob.result = null
    syncJob.error = null
    syncJob.progress = { phase: 'starting' }

    const { started, activeJob } = runHeavyJob('sync', req.user.email, syncJob, {
      onProgress: (p) => {
        syncJob.progress = p
      },
      onError: (err) => console.error('Borrower sync failed:', err),
    })

    if (!started) {
      syncJob.status = 'idle'
      return res.json({ status: 'busy', message: `Server busy with ${activeJob}` })
    }

    res.json({ status: 'started', message: 'Borrower sync started in background worker' })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.post('/api/loandisk/search', authMiddleware, async (req, res) => {
  try {
    const criteria = req.body.searchCriteria || req.body.names?.map((n) => ({ name: n })) || []
    if (!criteria.length) return res.status(400).json({ error: 'searchCriteria required' })
    const data = await borrowerSearch(criteria)
    const names = criteria.map((c) => c.name || c)
    const parsed = parseBorrowerSearchResults(data, names)
    res.json(parsed)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/loandisk/borrower/:id', authMiddleware, (req, res) => {
  try {
    const force = req.query.refresh === '1'
    res.json(getBorrowerResponse(db, req.params.id, { force }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// --- Documents ---
app.get('/api/documents', authMiddleware, async (_req, res) => {
  try {
    res.json(await getDocuments())
  } catch (e) {
    res.status(500).json({ error: `Could not load documents: ${e.message}` })
  }
})

// Cascade-delete a file's staged credits (and their matches) from SQL Server.
app.delete('/api/documents/:id', authMiddleware, async (req, res) => {
  try {
    const deleted = await deleteDocument(decodeURIComponent(req.params.id))
    res.json({ ok: true, deleted })
  } catch (e) {
    res.status(500).json({ error: `Could not delete document: ${e.message}` })
  }
})

app.get('/api/documents/:id/download', authMiddleware, (req, res) => {
  const doc = db.prepare('select * from documents where id = ?').get(req.params.id)
  if (!doc) return res.status(404).json({ error: 'Document not found' })
  if (!fs.existsSync(doc.storage_path)) return res.status(404).json({ error: 'File missing on server' })
  res.download(doc.storage_path, doc.filename)
})

app.get('/api/documents/:id/transactions', authMiddleware, (req, res) => {
  const rows = db
    .prepare(
      `select t.*, b.full_name as matched_borrower_name
       from transactions t
       left join borrowers b on b.id = t.matched_borrower_id
       where t.source_document_id = ?
       order by t.date asc`
    )
    .all(req.params.id)
  res.json(rows)
})

// --- Matching (background job — avoids proxy/client timeout on large files) ---
app.get('/api/matching/preview', authMiddleware, (_req, res) => {
  try {
    res.json(getMatchingPreview(db))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/matching/branches/:branchKey/transactions', authMiddleware, (req, res) => {
  try {
    const status = req.query.status || 'all'
    res.json(getBranchTransactions(db, req.params.branchKey, status))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

app.get('/api/matching/status', authMiddleware, (_req, res) => {
  resetStaleJob(matchingJob, 'Matching')
  res.json({
    status: matchingJob.status,
    progress: matchingJob.progress,
    result: matchingJob.result,
    error: matchingJob.error,
    startedAt: matchingJob.startedAt,
    finishedAt: matchingJob.finishedAt,
    activeJob: getActiveJobName(),
  })
})

function resetStaleJob(job, jobName) {
  if (job.status === 'running' && !isHeavyJobRunning()) {
    job.status = 'idle'
    job.error = job.error || `${jobName} interrupted — safe to retry`
    return true
  }
  return false
}

app.post('/api/matching/run', authMiddleware, (req, res) => {
  try {
    resetStaleJob(matchingJob, 'Matching')
    resetStaleJob(syncJob, 'Sync')

    const currentJob = getActiveJobName()
    if (matchingJob.status === 'running' && currentJob === 'matching') {
      return res.json({
        status: 'running',
        message: 'Matching already in progress',
        progress: matchingJob.progress,
        activeJob: currentJob,
      })
    }
    if (isHeavyJobRunning() && currentJob !== 'matching') {
      return res.json({
        status: 'busy',
        message: `Server busy with ${currentJob} — wait or retry in a moment`,
        progress: matchingJob.progress,
        activeJob: currentJob,
      })
    }

    const queueCount = db
      .prepare("select count(*) as c from transactions where status in ('pending', 'exception')")
      .get().c
    if (!queueCount) {
      return res.json({
        status: 'idle',
        matched: 0,
        excepted: 0,
        pending: 0,
        message: 'No transactions to match — import a statement first',
      })
    }

    matchingJob.status = 'running'
    matchingJob.startedAt = new Date().toISOString()
    matchingJob.finishedAt = null
    matchingJob.result = null
    matchingJob.error = null
    matchingJob.progress = { phase: 'starting', processed: 0, total: queueCount, matched: 0, excepted: 0 }

    const { started, activeJob } = runHeavyJob('matching', req.user.email, matchingJob, {
      onProgress: (p) => {
        matchingJob.progress = p
      },
      onError: (err) => console.error('Matching job failed:', err),
    })

    if (!started) {
      matchingJob.status = 'idle'
      return res.json({ status: 'busy', message: `Server busy with ${activeJob}` })
    }

    res.json({
      status: 'started',
      message: 'Matching started in background worker',
      progress: matchingJob.progress,
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// --- Exceptions ---
app.get('/api/exceptions', authMiddleware, (_req, res) => {
  const rows = db.prepare('select * from exceptions order by created_at desc').all()
  const borrowers = Object.fromEntries(
    db.prepare('select * from borrowers').all().map((b) => [b.id, rowBorrower(b)])
  )
  const loans = Object.fromEntries(db.prepare('select * from loans').all().map((l) => [l.id, l]))
  const txMap = Object.fromEntries(db.prepare('select * from transactions').all().map((t) => [t.id, t]))

  res.json(
    rows.map((ex) => {
      const t = txMap[ex.transaction_id]
      return {
        ...ex,
        transactions: t
          ? {
              ...t,
              borrowers: t.matched_borrower_id ? borrowers[t.matched_borrower_id] : null,
              loans: t.loan_id ? loans[t.loan_id] : null,
            }
          : null,
      }
    })
  )
})

app.post('/api/exceptions', authMiddleware, (req, res) => {
  const { transaction_id, type, assigned_to, sla_hours } = req.body
  const id = randomUUID()
  db.prepare(
    'insert into exceptions (id, transaction_id, type, status, assigned_to, sla_hours) values (?, ?, ?, ?, ?, ?)'
  ).run(id, transaction_id, type || 'unmatched', 'open', assigned_to || req.user.email, sla_hours ?? 24)
  res.json(db.prepare('select * from exceptions where id = ?').get(id))
})

app.patch('/api/exceptions/:id', authMiddleware, (req, res) => {
  const prior = db.prepare('select * from exceptions where id = ?').get(req.params.id)
  if (!prior) return res.status(404).json({ error: 'Not found' })
  const fields = ['status', 'assigned_to', 'resolution_note', 'resolved_at', 'type']
  const updates = []
  const values = []
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`)
      values.push(req.body[f])
    }
  }
  if (!updates.length) return res.json(prior)
  values.push(req.params.id)
  db.prepare(`update exceptions set ${updates.join(', ')} where id = ?`).run(...values)
  const next = db.prepare('select * from exceptions where id = ?').get(req.params.id)
  audit('exception', req.params.id, req.body.action || 'update', req.user.email, prior, next)
  res.json(next)
})

// --- Audit ---
app.get('/api/audit', authMiddleware, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500)
  const rows = db.prepare('select * from audit_log order by created_at desc limit ?').all(limit)
  res.json(
    rows.map((r) => ({
      ...r,
      prior_value: parseJson(r.prior_value),
      new_value: parseJson(r.new_value),
    }))
  )
})

app.post('/api/audit', authMiddleware, (req, res) => {
  const { entity, entityId, action, priorValue, newValue } = req.body
  audit(entity, entityId, action, req.user.email, priorValue, newValue)
  res.json({ ok: true })
})

// --- Data reset ---
app.post('/api/data/reset', authMiddleware, (req, res) => {
  try {
    const before = {
      transactions: db.prepare('select count(*) as c from transactions').get().c,
      borrowers: db.prepare('select count(*) as c from borrowers').get().c,
      loans: db.prepare('select count(*) as c from loans').get().c,
      exceptions: db.prepare('select count(*) as c from exceptions').get().c,
    }
    resetAppData()
    parseCache.clear()
    audit('data', null, 'reset', req.user.email, before, { cleared: true })
    res.json({ ok: true, cleared: before })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// --- Demo seed ---
app.post('/api/demo/seed', authMiddleware, (req, res) => {
  const DEMO_BORROWERS = [
    { full_name: 'John Martinez', aliases: ['J. Martinez', 'Martinez Consulting'], employer: 'Acme Corp' },
    { full_name: 'Sarah Chen', aliases: ['S. Chen LLC'], employer: 'TechStart Inc' },
    { full_name: 'Robert Williams', aliases: ['Bob Williams', 'R. Williams'], employer: 'Global Finance' },
  ]
  const DEMO_LOANS = [
    { full_name: 'John Martinez', loan_number: 'LN-10042', outstanding_balance: 12500 },
    { full_name: 'Sarah Chen', loan_number: 'LN-10089', outstanding_balance: 8200.5 },
    { full_name: 'Robert Williams', loan_number: 'LN-10115', outstanding_balance: 45000 },
  ]
  const today = new Date().toISOString().slice(0, 10)
  const DEMO_TX = [
    { date: today, payer: 'John Martinez', description: 'Loan repayment Acme Corp payroll', amount: 500, reference: 'REF-1001' },
    { date: today, payer: 'Sarah Chen', description: 'Monthly payment TechStart Inc', amount: 350.5, reference: 'REF-1002' },
    { date: today, payer: 'Robert Williams', description: 'Wire Global Finance', amount: 1200, reference: 'REF-1003' },
    { date: today, payer: 'Unknown Vendor LLC', description: 'Unidentified deposit', amount: 99, reference: 'REF-9999' },
    { date: today, payer: 'J. Martinez', description: 'Martinez Consulting partial', amount: 250, reference: 'REF-1004' },
  ]

  const byName = {}
  for (const row of DEMO_BORROWERS) {
    let b = db.prepare('select * from borrowers where full_name = ?').get(row.full_name)
    if (!b) {
      const id = randomUUID()
      db.prepare('insert into borrowers (id, full_name, employer, aliases) values (?, ?, ?, ?)').run(
        id,
        row.full_name,
        row.employer,
        JSON.stringify(row.aliases)
      )
      b = { id }
    }
    byName[row.full_name] = b.id
  }

  for (const row of DEMO_LOANS) {
    const exists = db.prepare('select id from loans where loan_number = ?').get(row.loan_number)
    if (!exists) {
      db.prepare(
        'insert into loans (id, borrower_id, loan_number, outstanding_balance, status) values (?, ?, ?, ?, ?)'
      ).run(randomUUID(), byName[row.full_name], row.loan_number, row.outstanding_balance, 'active')
    }
  }

  let added = 0
  for (const tx of DEMO_TX) {
    const hash = importHash(tx)
    const exists = db.prepare('select id from transactions where import_hash = ?').get(hash)
    if (exists) continue
    db.prepare(
      `insert into transactions (id, date, payer, description, amount, reference, status, import_hash)
       values (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(randomUUID(), tx.date, tx.payer, tx.description, tx.amount, tx.reference, hash)
    added++
  }

  audit('demo', null, 'load_demo_data', req.user.email, null, { transactions_added: added })
  res.json({ borrowers: DEMO_BORROWERS.length, transactionsAdded: added })
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distPath = path.resolve(__dirname, '..', 'dist')
const indexHtml = path.join(distPath, 'index.html')

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath, { index: false, fallthrough: true }))

  // SPA fallback — refresh on /match, /settings/sla, etc. must return index.html
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api')) return next()
    const lastSegment = req.path.split('/').pop() || ''
    if (lastSegment.includes('.')) return next()
    res.sendFile(indexHtml, (err) => (err ? next(err) : undefined))
  })

  console.log(`Serving frontend from ${distPath}`)
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`SmartRepay running on 0.0.0.0:${PORT}`)
  console.log(`Ingest: POST /api/ingest/parse · AI: ${process.env.OPENROUTER_API_KEY ? 'enabled' : 'disabled'}`)
  console.log('Login: admin@pbshope.com')
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other server or run: npm run dev`)
    process.exit(1)
  }
  throw err
})
