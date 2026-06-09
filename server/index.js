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
import { bestMatchFromCandidates, matchTransaction, detectExceptionType } from './matcher.js'
import { parseStatementBuffer } from './parseStatement.js'
import {
  getLoanDiskToken,
  normalizeLoanDiskBorrower,
  normalizeBorrowersFromPayload,
  borrowerSearch,
  parseBorrowerSearchResults,
  fetchBorrowerById,
  fetchBorrowersForPayers,
  fetchAllBorrowers,
} from './loandisk.js'

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
  const row = db.prepare('select value from app_settings where key = ?').get('global')
  return row ? JSON.parse(row.value) : {}
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
    build: '1.2.0',
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
    const result = await parseStatementBuffer(req.file.buffer, req.file.originalname)
    const existing = db.prepare('select import_hash from transactions where import_hash is not null').all()
    const hashSet = new Set(existing.map((r) => r.import_hash))
    const rows = result.rows.map((r) => ({
      date: r.date,
      payer: r.payer,
      description: r.description,
      amount: r.amount,
      reference: r.reference,
      import_hash: r.import_hash,
      _duplicate: hashSet.has(r.import_hash),
    }))
    audit('ingest', null, 'parse_statement', req.user.email, null, {
      file: req.file.originalname,
      count: rows.length,
      method: result.method,
    })
    const creditCount = result.creditRows?.length ?? rows.length
    const duplicateCount = rows.filter((r) => r._duplicate).length
    const readyCount = rows.length - duplicateCount
    const parseId = randomUUID()

    cacheParse(parseId, {
      rows,
      userId: req.user.sub,
      filename: req.file.originalname,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      documentType: result.documentType || result.source || null,
    })

    res.json({
      parseId,
      method: result.method,
      source: result.source || result.documentType || (result.method === 'pdf' ? 'bank' : 'spreadsheet'),
      documentType: result.documentType || result.source || null,
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

app.post('/api/ingest/import', authMiddleware, (req, res) => {
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
    parseCache.delete(parseId)

    audit('ingest', null, 'import_statement', req.user.email, null, {
      file: cached.filename,
      count: inserted.length,
      documentId,
    })

    res.json({ inserted: inserted.length, documentId })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// --- Auth ---
app.post('/api/auth/signup', (req, res) => {
  const { email, password, role = 'collections' } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  const existing = db.prepare('select id from users where email = ?').get(email)
  if (existing) return res.status(400).json({ error: 'Email already registered' })
  const id = randomUUID()
  const hash = bcrypt.hashSync(password, 10)
  db.prepare('insert into users (id, email, password_hash, role, full_name) values (?, ?, ?, ?, ?)').run(
    id,
    email,
    hash,
    role,
    email.split('@')[0]
  )
  const token = signToken({ id, email, role })
  res.json({ token, user: { id, email, role, full_name: email.split('@')[0] } })
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
  res.json({ borrowers, transactions, exceptions })
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

async function syncLoanDiskToDb(actor) {
  const { borrowers, total, orgId, source, branches, totalReported, message } = await fetchAllBorrowers()
  const result = importBorrowerBatch(borrowers, actor, { total, orgId, source, branches, totalReported, message })
  return result
}

async function loadAllBorrowersFallback() {
  const { borrowers } = await fetchAllBorrowers()
  return borrowers
}

async function runMatchingBatch(actor) {
  const settings = getSettings()
  const threshold = settings.autoApproveThreshold ?? 80
  const localBorrowers = db.prepare('select * from borrowers').all().map(rowBorrower)
  let loans = db.prepare('select * from loans').all()
  const toMatch = db
    .prepare("select * from transactions where status in ('pending', 'exception') order by date asc")
    .all()
  const allTx = db.prepare('select * from transactions').all()

  const uniquePayers = [...new Set(toMatch.map((t) => String(t.payer || '').trim()).filter(Boolean))]
  let apiPool = []
  let byPayer = new Map()
  let searchSource = 'local'
  let searchError = null
  let termsSearched = 0
  let searchBatches = 0

  if (uniquePayers.length && loanDiskConfigured()) {
    try {
      const searchResult = await fetchBorrowersForPayers(uniquePayers)
      apiPool = searchResult.apiPool
      byPayer = searchResult.byPayer
      termsSearched = searchResult.termsSearched
      searchBatches = searchResult.batches
      searchSource = 'BorrowerSerch'
    } catch (e) {
      searchError = e.message
      console.warn('BorrowerSerch failed:', e.message)
    }
  }

  if (!apiPool.length && loanDiskConfigured()) {
    try {
      const fallback = await loadAllBorrowersFallback()
      if (fallback.length) {
        apiPool = fallback
        searchSource = searchError ? 'GetAllBorrowers' : searchSource === 'BorrowerSerch' ? 'BorrowerSerch+GetAllBorrowers' : 'GetAllBorrowers'
        searchError = null
        for (const payer of uniquePayers) {
          const key = payer.toLowerCase()
          if (!byPayer.has(key) || !byPayer.get(key).length) byPayer.set(key, fallback)
        }
      }
    } catch (e) {
      if (!searchError) searchError = e.message
      console.warn('GetAllBorrowers fallback failed:', e.message)
    }
  }

  let matched = 0
  let excepted = 0

  for (const tx of toMatch) {
    const payerKey = String(tx.payer || '').trim().toLowerCase()
    const payerCandidates = byPayer.get(payerKey) || []
    let candidates = payerCandidates.length ? payerCandidates : apiPool.length ? apiPool : localBorrowers

    let { borrower, score } = bestMatchFromCandidates(tx, candidates)
    if (score < threshold && apiPool.length) {
      const poolMatch = bestMatchFromCandidates(tx, apiPool)
      if (poolMatch.score > score) {
        borrower = poolMatch.borrower
        score = poolMatch.score
      }
    }
    if (score < threshold && localBorrowers.length) {
      const localMatch = bestMatchFromCandidates(tx, localBorrowers)
      if (localMatch.score > score) {
        borrower = localMatch.borrower
        score = localMatch.score
      }
    }

    let resolvedBorrower = borrower
    if (borrower?.loandisk_id) {
      const { id } = upsertBorrowerRecord(borrower)
      resolvedBorrower = rowBorrower(db.prepare('select * from borrowers where id = ?').get(id))
      loans = db.prepare('select * from loans').all()
    }

    const loan = resolvedBorrower ? loans.find((l) => l.borrower_id === resolvedBorrower.id) : null

    if (score >= threshold && resolvedBorrower) {
      db.prepare(
        `update transactions set status = 'matched', confidence_score = ?, matched_borrower_id = ?, loan_id = ? where id = ?`
      ).run(score, resolvedBorrower.id, loan?.id || null, tx.id)
      db.prepare(
        `update exceptions set status = 'resolved', resolved_at = datetime('now')
         where transaction_id = ? and status = 'open'`
      ).run(tx.id)
      matched++
    } else {
      const exType = detectExceptionType(tx, allTx, score)
      db.prepare(
        `update transactions set status = 'exception', confidence_score = ?, matched_borrower_id = ? where id = ?`
      ).run(score, resolvedBorrower?.id || null, tx.id)
      const existing = db
        .prepare("select id from exceptions where transaction_id = ? and status = 'open'")
        .get(tx.id)
      if (!existing) {
        const sla = settings.slaHours?.[exType] ?? 24
        db.prepare(
          `insert into exceptions (id, transaction_id, type, status, assigned_to, sla_hours) values (?, ?, ?, 'open', ?, ?)`
        ).run(randomUUID(), tx.id, exType, actor, sla)
      }
      excepted++
    }
  }

  audit('matching', null, 'run', actor, null, {
    matched,
    excepted,
    searchSource,
    termsSearched,
    candidatesFound: apiPool.length,
    searchError,
  })
  return {
    matched,
    excepted,
    pending: toMatch.length,
    borrowers: db.prepare('select count(*) as c from borrowers').get().c,
    searchSource,
    termsSearched,
    candidatesFound: apiPool.length,
    searchError,
  }
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

app.post('/api/loandisk/sync', authMiddleware, async (req, res) => {
  try {
    const result = await syncLoanDiskToDb(req.user.email)
    res.json(result)
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

app.get('/api/loandisk/borrower/:id', authMiddleware, async (req, res) => {
  try {
    const result = await fetchBorrowerById(req.params.id)
    if (result.borrower) {
      const { id } = upsertBorrowerRecord(result.borrower)
      result.borrower = rowBorrower(db.prepare('select * from borrowers where id = ?').get(id))
    }
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// --- Documents ---
app.get('/api/documents', authMiddleware, (_req, res) => {
  const docs = db
    .prepare(
      `select d.*,
        (select count(*) from transactions t where t.source_document_id = d.id) as total_rows,
        (select count(*) from transactions t where t.source_document_id = d.id and t.status = 'matched') as matched_count,
        (select count(*) from transactions t where t.source_document_id = d.id and t.status in ('exception','pending')) as unmatched_count,
        (select min(t.date) from transactions t where t.source_document_id = d.id) as date_from,
        (select max(t.date) from transactions t where t.source_document_id = d.id) as date_to
      from documents d
      order by d.created_at desc`
    )
    .all()
  res.json(docs)
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

// --- Matching ---
app.post('/api/matching/run', authMiddleware, async (req, res) => {
  try {
    const queueCount = db
      .prepare("select count(*) as c from transactions where status in ('pending', 'exception')")
      .get().c
    if (!queueCount) {
      return res.json({
        matched: 0,
        excepted: 0,
        pending: 0,
        message: 'No transactions to match — import a statement first',
      })
    }

    const result = await runMatchingBatch(req.user.email)
    if (result.searchError && result.matched === 0 && result.candidatesFound === 0) {
      return res.json({
        ...result,
        message: `LoanDisk search failed: ${result.searchError}`,
      })
    }
    res.json(result)
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
  console.log(`Demo login: demo@smartrepay.local / demo1234`)
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other server or run: npm run dev`)
    process.exit(1)
  }
  throw err
})
