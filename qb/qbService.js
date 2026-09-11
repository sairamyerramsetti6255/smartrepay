import { assertEditable, atomic } from './qbGuards.js'
import { randomUUID } from 'crypto'
import {
  normalizeDate,
  normalizeAmount,
  normalizeName,
  normalizeReference,
  buildTransactionHash,
  toQbDate,
} from './qbNormalize.js'
import { validateTransaction } from './qbValidation.js'
import { mapToEmiReceipt, mapToPaymentDisbursed, buildQbExportPayload } from './qbMapper.js'
import { getSqlMatchResults } from '../stagingDb.js'

/**
 * QuickBooks Data — Core Service Layer
 *
 * All DB reads/writes go through this service.
 * Deterministic logic only. AI calls are handled by qbAiExtract.js.
 */

// ---------------------------------------------------------------------------
// Summary / Overview
// ---------------------------------------------------------------------------

export function getSummary(db) {
  const totals = db.prepare(`
    select
      count(*) as total_records,
      sum(case when validation_status = 'valid' then 1 else 0 end) as valid_records,
      sum(case when validation_status = 'invalid' then 1 else 0 end) as invalid_records,
      sum(case when validation_status = 'needs_review' then 1 else 0 end) as needs_review,
      sum(case when validation_status = 'duplicate' then 1 else 0 end) as duplicates,
      sum(case when template_type = 'emi_receipt' then 1 else 0 end) as emi_receipts,
      sum(case when template_type = 'payment_disbursed' then 1 else 0 end) as payments_disbursed,
      sum(case when template_type = 'account_to_create' then 1 else 0 end) as accounts_to_create,
      sum(case when approval_status = 'approved' then 1 else 0 end) as approved,
      sum(case when approval_status = 'pending_review' or approval_status is null then 1 else 0 end) as pending_review,
      sum(case when approval_status = 'exported' then 1 else 0 end) as exported,
      sum(case when approval_status = 'rejected' then 1 else 0 end) as rejected,
      sum(amount) as total_value
    from qb_transactions
  `).get()

  const batches = db.prepare(`
    select count(*) as total_batches from qb_import_batches
  `).get()

  const recentBatches = db.prepare(`
    select id, source_type, source_name, total_records, valid_records, invalid_records,
           duplicate_records, status, created_at, completed_at
    from qb_import_batches
    order by created_at desc
    limit 5
  `).all()

  return {
    ...totals,
    total_batches: batches.total_batches,
    recent_batches: recentBatches,
  }
}

// ---------------------------------------------------------------------------
// Input Library
// ---------------------------------------------------------------------------

export function getInputLibrary(db, { page = 1, pageSize = 50, sourceType, status, search } = {}) {
  const offset = (page - 1) * pageSize
  const conditions = []
  const params = []

  if (sourceType) { conditions.push('source_type = ?'); params.push(sourceType) }
  if (status) { conditions.push('processing_status = ?'); params.push(status) }
  if (search) {
    conditions.push('(original_filename like ? or original_text like ? or email_subject like ?)')
    const like = `%${search}%`
    params.push(like, like, like)
  }

  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''

  const total = db.prepare(`select count(*) as c from qb_input_library ${where}`).get(...params).c
  const rows = db.prepare(`
    select * from qb_input_library ${where}
    order by created_at desc
    limit ? offset ?
  `).all(...params, pageSize, offset)

  return { rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
}

export function getInputItem(db, id) {
  return db.prepare('select * from qb_input_library where id = ?').get(id)
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export function getTransactions(db, {
  page = 1, pageSize = 50, validationStatus, approvalStatus,
  templateType, search, dateFrom, dateTo
} = {}) {
  const offset = (page - 1) * pageSize
  const conditions = []
  const params = []

  if (validationStatus) { conditions.push('t.validation_status = ?'); params.push(validationStatus) }
  if (approvalStatus) { conditions.push('t.approval_status = ?'); params.push(approvalStatus) }
  if (templateType) { conditions.push('t.template_type = ?'); params.push(templateType) }
  if (dateFrom) { conditions.push('t.transaction_date >= ?'); params.push(dateFrom) }
  if (dateTo) { conditions.push('t.transaction_date <= ?'); params.push(dateTo) }
  if (search) {
    conditions.push('(t.customer_name like ? or t.reference_number like ? or t.vendor_name like ? or i.original_filename like ? or i.source_type like ? or t.borrower_id like ? or t.loan_id like ?)')
    const like = `%${search}%`
    params.push(like, like, like, like, like, like, like)
  }

  const where = conditions.length ? `where ${conditions.join(' and ')}` : ''

  const total = db.prepare(`
    select count(*) as c
    from qb_transactions t
    left join qb_input_library i on i.id = t.input_id
    ${where}
  `).get(...params).c
  const rows = db.prepare(`
    select t.*, i.source_type, i.original_filename
    from qb_transactions t
    left join qb_input_library i on i.id = t.input_id
    ${where}
    order by t.created_at desc
    limit ? offset ?
  `).all(...params, pageSize, offset)

  // Attach line items
  const txnIds = rows.map((r) => r.id)
  const linesMap = {}
  if (txnIds.length) {
    const placeholders = txnIds.map(() => '?').join(',')
    const lines = db.prepare(`
      select * from qb_transaction_lines where transaction_id in (${placeholders}) order by line_number
    `).all(...txnIds)
    for (const l of lines) {
      if (!linesMap[l.transaction_id]) linesMap[l.transaction_id] = []
      linesMap[l.transaction_id].push(l)
    }
  }

  const summary = db.prepare(`
    select
      count(*) as total,
      sum(case when validation_status = 'valid' then 1 else 0 end) as valid,
      sum(case when validation_status = 'needs_review' then 1 else 0 end) as needs_review,
      sum(case when validation_status = 'invalid' then 1 else 0 end) as invalid,
      sum(case when approval_status = 'pending_review' then 1 else 0 end) as pending_review,
      sum(case when approval_status = 'approved' then 1 else 0 end) as approved,
      sum(case when approval_status = 'rejected' then 1 else 0 end) as rejected,
      sum(case when approval_status = 'exported' then 1 else 0 end) as exported
    from qb_transactions
    ${templateType ? `where template_type = '${templateType}'` : ''}
  `).get()

  const enriched = rows.map((r) => ({ ...r, lines: linesMap[r.id] || [] }))
  return { rows: enriched, total, page, pageSize, totalPages: Math.ceil(total / pageSize), summary }
}

export function getTransaction(db, id) {
  const txn = db.prepare('select * from qb_transactions where id = ?').get(id)
  if (!txn) return null
  const lines = db.prepare('select * from qb_transaction_lines where transaction_id = ? order by line_number').all(id)
  const validation = db.prepare('select * from qb_validation_results where transaction_id = ? order by created_at').all(id)
  const input = txn.input_id ? db.prepare('select * from qb_input_library where id = ?').get(txn.input_id) : null
  return { ...txn, lines, validation_results: validation, input }
}

// ---------------------------------------------------------------------------
// Seed from SmartRepay transactions — KEY FEATURE
// ---------------------------------------------------------------------------

/**
 * Import existing SmartRepay transactions as EMI receipts.
 * Treats all matched transactions (e.g. all 539 from SQL Server staging) as customer EMI payments received.
 *
 * @param {object} db - SQLite database instance
 * @param {string} actor - User email/id performing the import
 * @param {number} limit - Max records to import (default 1000)
 * @returns {{ batch_id, total, valid, skipped, invalid }}
 */
export async function seedFromSmartRepay(db, actor, limit = 1000) {
  let srTransactions = []

  // 1. First attempt to pull directly from SQL Server staging match results (contains all 539 matched rows with source filenames)
  try {
    const sqlResult = await getSqlMatchResults()
    if (sqlResult?.transactions?.length) {
      const matched = sqlResult.transactions.filter((t) =>
        t.status === 'matched' || t.status === 'posted' || t.review_status === 'auto_matched'
      )
      if (matched.length > 0) {
        srTransactions = matched.slice(0, limit).map((t) => ({
          id: t.bank_transaction_id || t.id,
          date: t.date,
          payer: t.payer,
          description: t.description || t.transaction_description,
          amount: t.amount,
          reference: t.reference || String(t.bank_transaction_id || t.id),
          status: 'matched',
          matched_borrower_id: t.matched_borrower_id,
          loan_id: t.loan_number,
          borrower_name: t.matched_borrower_name || t.payer,
          loan_number: t.loan_number,
          source_filename: t.source_filename || null,
          source_type: t.source_type || 'smartrepay',
          confidence_score: t.confidence_score,
        }))
      }
    }
  } catch (err) {
    console.warn('[QB] SQL Server match results pull failed, falling back to local SQLite:', err.message)
  }

  // 2. Fallback to local SQLite if SQL Server returned 0 rows
  if (!srTransactions.length) {
    srTransactions = db.prepare(`
      select
        t.id, t.date, t.payer, t.description, t.amount, t.reference,
        t.status, t.matched_borrower_id, t.loan_id,
        b.full_name as borrower_name,
        l.loan_number,
        d.filename as source_filename
      from transactions t
      left join borrowers b on b.id = t.matched_borrower_id
      left join loans l on l.id = t.loan_id
      left join documents d on d.id = t.source_document_id
      where t.status in ('matched', 'posted')
      order by t.date desc
      limit ?
    `).all(limit)
  }

  if (!srTransactions.length) {
    return { batch_id: null, total: 0, valid: 0, skipped: 0, invalid: 0, message: 'No matched or posted transactions found in SmartRepay' }
  }

  // Create import batch
  const batchId = randomUUID()
  db.prepare(`
    insert into qb_import_batches (id, source_type, source_name, status, created_by)
    values (?, 'smartrepay', 'SmartRepay Matched Transactions', 'processing', ?)
  `).run(batchId, actor)

  let valid = 0
  let skipped = 0
  let invalid = 0

  // Collect existing hashes for duplicate detection
  const existingHashRows = db.prepare('select transaction_hash from qb_transactions where transaction_hash is not null').all()
  const existingHashes = new Set(existingHashRows.map((r) => r.transaction_hash))

  const insertInput = db.prepare(`
    insert into qb_input_library
    (id, batch_id, source_type, original_filename, source_reference_id, document_type, transaction_type, processing_status, extraction_confidence, created_by)
    values (?, ?, ?, ?, ?, 'emi_receipt', 'emi_receipt', 'mapped', ?, ?)
  `)

  const insertTxn = db.prepare(`
    insert into qb_transactions
    (id, input_id, batch_id, template_type, transaction_date, borrower_id, loan_id,
     customer_name, reference_number, amount, currency, payment_method, deposit_to,
     mapped_payload_json, validation_status, approval_status, transaction_hash, source_smartrepay_id,
     ai_confidence, created_at, updated_at)
    values
    (?, ?, ?, 'emi_receipt', ?, ?, ?,
     ?, ?, ?, 'BSD', 'ACH', 'General Bank Account',
     ?, ?, 'pending_review', ?, ?,
     ?, datetime('now'), datetime('now'))
  `)

  const insertLine = db.prepare(`
    insert into qb_transaction_lines (id, transaction_id, line_number, account_name, amount, memo)
    values (?, ?, ?, ?, ?, ?)
  `)

  const insertValidation = db.prepare(`
    insert into qb_validation_results (id, transaction_id, rule_code, field_name, severity, status, message)
    values (?, ?, ?, ?, ?, ?, ?)
  `)

  // Process all records in a single transaction for performance
  const processAll = db.transaction(() => {
    for (const sr of srTransactions) {
      // Prefer matched borrower name, fallback to payer field
      const customerName = sr.borrower_name || sr.payer || 'Unknown'
      const referenceNum = sr.reference || String(sr.id)
      const isoDate = normalizeDate(sr.date) || (sr.date ? String(sr.date).slice(0, 10) : new Date().toISOString().slice(0, 10))
      const amount = normalizeAmount(sr.amount)
      const confidence = sr.confidence_score ? (sr.confidence_score > 1 ? sr.confidence_score / 100 : sr.confidence_score) : 0.95
      const filename = sr.source_filename || null
      
      const allowedSources = ['pdf', 'image', 'excel', 'csv', 'text', 'free_text', 'email', 'loandisk', 'smartrepay', 'manual']
      let sourceType = 'smartrepay'
      if (sr.source_type) {
        const rawType = String(sr.source_type).toLowerCase()
        if (allowedSources.includes(rawType)) sourceType = rawType
        else if (rawType === 'spreadsheet') sourceType = 'excel'
        else if (rawType.startsWith('image')) sourceType = 'image'
        else if (rawType.includes('pdf')) sourceType = 'pdf'
      }

      // Build deduplication hash
      const hash = buildTransactionHash('emi_receipt', isoDate, customerName, referenceNum, amount)

      // Skip if already imported
      if (existingHashes.has(hash)) {
        skipped++
        continue
      }
      const inputId = randomUUID()
      const txnId = randomUUID()

      // Insert input library record with original filename
      insertInput.run(inputId, batchId, sourceType, filename, String(sr.id), confidence, actor)

      // Build single line item (full amount → Loans Receivable)
      const lines = [
        { account_name: 'Loans Receivable', amount: amount, memo: 'EMI Payment' }
      ]

      // Build QB mapped payload
      const mappedPayload = mapToEmiReceipt(
        {
          id: txnId,
          input_id: inputId,
          transaction_date: isoDate,
          deposit_to: 'General Bank Account',
          reference_number: referenceNum,
          customer_name: customerName,
          payment_method: 'ACH',
          amount: amount,
          validation_status: 'pending',
        },
        lines
      )

      // Validate (existingHashes does not contain current hash yet)
      const txnForValidation = {
        id: txnId,
        template_type: 'emi_receipt',
        transaction_date: isoDate,
        customer_name: customerName,
        reference_number: referenceNum,
        amount: amount,
        deposit_to: 'General Bank Account',
        bank_account: null,
        ai_confidence: confidence,
        borrower_id: sr.matched_borrower_id || null,
        transaction_hash: hash,
      }
      const { results: validationResults, overallStatus } = validateTransaction(txnForValidation, lines, existingHashes)
      existingHashes.add(hash)

      // Insert transaction
      insertTxn.run(
        txnId,
        inputId,
        batchId,
        isoDate,
        sr.matched_borrower_id || null,
        sr.loan_id || null,
        customerName,
        referenceNum,
        amount,
        JSON.stringify(mappedPayload),
        overallStatus,
        hash,
        String(sr.id),
        confidence
      )

      // Insert line items
      lines.forEach((l, idx) => {
        insertLine.run(randomUUID(), txnId, idx + 1, l.account_name, l.amount, l.memo)
      })

      // Insert validation results
      for (const vr of validationResults) {
        insertValidation.run(randomUUID(), txnId, vr.code, vr.field, vr.severity, vr.status, vr.message)
      }

      if (overallStatus === 'valid') valid++
      else invalid++
    }
  })

  processAll()

  // Update batch counts
  db.prepare(`
    update qb_import_batches set
      total_records = ?, valid_records = ?, invalid_records = ?,
      duplicate_records = ?, status = 'completed', completed_at = datetime('now')
    where id = ?
  `).run(valid + invalid, valid, invalid, skipped, batchId)

  return { batch_id: batchId, total: valid + invalid, valid, skipped, invalid }
}

// ---------------------------------------------------------------------------
// Validate a single transaction (re-run rules)
// ---------------------------------------------------------------------------

export function runValidation(db, txnId) {
  const txn = db.prepare('select * from qb_transactions where id = ?').get(txnId)
  if (!txn) throw new Error(`Transaction ${txnId} not found`)

  const lines = db.prepare('select * from qb_transaction_lines where transaction_id = ? order by line_number').all(txnId)

  // Get all existing hashes except this transaction's own
  const existingHashRows = db.prepare(
    'select transaction_hash from qb_transactions where transaction_hash is not null and id != ?'
  ).all(txnId)
  const existingHashes = new Set(existingHashRows.map((r) => r.transaction_hash))

  const { results, overallStatus } = validateTransaction(txn, lines, existingHashes)

  // Clear old validation results
  db.prepare('delete from qb_validation_results where transaction_id = ?').run(txnId)

  const insert = db.prepare(`
    insert into qb_validation_results (id, transaction_id, rule_code, field_name, severity, status, message)
    values (?, ?, ?, ?, ?, ?, ?)
  `)

  for (const vr of results) {
    insert.run(randomUUID(), txnId, vr.code, vr.field, vr.severity, vr.status, vr.message)
  }

  db.prepare(`
    update qb_transactions set validation_status = ?, updated_at = datetime('now') where id = ?
  `).run(overallStatus, txnId)

  return { validation_status: overallStatus, results }
}

// ---------------------------------------------------------------------------
// Approve / Reject
// ---------------------------------------------------------------------------

export function approveTransaction(db, txnId, actor = 'User') {
  let txn = db.prepare('select * from qb_transactions where id = ?').get(txnId)
  if (!txn) throw new Error(`Transaction ${txnId} not found`)
  
  assertEditable(db, txnId)
  const validation = runValidation(db, txnId)
  if (validation.validation_status !== 'valid') throw new Error(`Cannot approve transaction: ${validation.validation_status}`)

  db.prepare(`
    update qb_transactions set
      approval_status = 'approved',
      rejection_reason = null,
      approved_by = ?,
      approved_at = datetime('now'),
      updated_at = datetime('now')
    where id = ?
  `).run(actor, txnId)
  return { approved: true, id: txnId }
}

export function rejectTransaction(db, txnId, actor = 'User', reason = '') {
  return atomic(db, () => rejectTransactionInternal(db, txnId, actor, reason))
}

function rejectTransactionInternal(db, txnId, actor = 'User', reason = '') {
  assertEditable(db, txnId)
  const txn = db.prepare('select * from qb_transactions where id = ?').get(txnId)
  if (!txn) throw new Error(`Transaction ${txnId} not found`)
  db.prepare(`
    update qb_transactions set
      approval_status = 'rejected',
      rejection_reason = ?,
      approved_by = ?,
      approved_at = datetime('now'),
      updated_at = datetime('now')
    where id = ?
  `).run(reason, actor, txnId)
  return { rejected: true, id: txnId }
}

// Reject the local, editable queue as one audited operation. Never alter a Desktop delivery.
export function rejectAllUnpostedRecords(db, actor, reason) {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('A rejection reason is required')
  return atomic(db, () => {
    const rows = db.prepare(`select t.id,t.approval_status,d.id as delivery_id
      from qb_transactions t left join qb_desktop_deliveries d on d.transaction_id=t.id`).all()
    const eligible = rows.filter(t => ['pending_review','approved'].includes(t.approval_status) && !t.delivery_id)
    for (const t of eligible) rejectTransaction(db,t.id,actor,reason.trim())
    const protected_count = rows.filter(t => t.approval_status === 'exported' || t.delivery_id).length
    const already_rejected = rows.filter(t => t.approval_status === 'rejected' && !t.delivery_id).length
    return {rejected_count:eligible.length,protected_count,already_rejected,
      message:`Rejected ${eligible.length} records. Kept ${protected_count} exported/delivery records unchanged; ${already_rejected} were already rejected.`,
      prior_records:eligible.map(t => ({id:t.id,approval_status:t.approval_status}))}
  })
}

export function approveAllValid(db, templateType = null, actor = 'User') {
  const rows = db.prepare(`select id from qb_transactions where approval_status in ('pending_review', 'rejected')
    ${templateType && templateType !== 'all' ? 'and template_type = ?' : ''}`).all(...(templateType && templateType !== 'all' ? [templateType] : []))
  let approved_count = 0
  for (const row of rows) {
    try { approveTransaction(db, row.id, actor); approved_count++ } catch { /* Invalid records stay in review. */ }
  }
  return { approved_count }
}

// ---------------------------------------------------------------------------
// Export approved records
// ---------------------------------------------------------------------------

export function exportApproved(db, format = 'json', actor) {
  return atomic(db, () => exportApprovedInternal(db, format, actor))
}

function exportApprovedInternal(db, format = 'json', actor) {
  if (db.prepare("select 1 from qb_desktop_deliveries d join qb_transactions t on t.id=d.transaction_id where t.approval_status='approved' limit 1").get()) throw new Error('Resolve Desktop deliveries before creating a manual export')
  for (const t of db.prepare("select id from qb_transactions where approval_status='approved' and template_type != 'account_to_create'").all()) {
    if (runValidation(db, t.id).validation_status !== 'valid') throw new Error('An approved record failed revalidation; review before exporting')
  }
  // Get all approved emi_receipt transactions
  const emiTxns = db.prepare(`
    select * from qb_transactions
    where approval_status = 'approved' and template_type = 'emi_receipt'
  `).all()

  const paymentTxns = db.prepare(`
    select * from qb_transactions
    where approval_status = 'approved' and template_type = 'payment_disbursed'
  `).all().map(t => ({ ...t, lines: db.prepare('select * from qb_transaction_lines where transaction_id=? order by line_number').all(t.id) }))

  const accountTxns = db.prepare(`
    select qa.* from qb_accounts_to_create qa
    join qb_transactions qt on qt.id = qa.transaction_id
    where qt.approval_status = 'approved'
  `).all()

  // Attach lines to emi transactions
  const emiWithLines = emiTxns.map((t) => ({
    ...t,
    lines: db.prepare('select * from qb_transaction_lines where transaction_id = ? order by line_number').all(t.id),
  }))

  const payload = buildQbExportPayload(emiWithLines, paymentTxns, accountTxns)

  const totalAmount = [
    ...emiTxns.map((t) => t.amount || 0),
    ...paymentTxns.map((t) => t.amount || 0),
  ].reduce((a, b) => a + b, 0)

  const exportId = randomUUID()
  db.prepare(`
    insert into qb_export_batches (id, format, record_count, total_amount, generated_by, payload_json, status)
    values (?, ?, ?, ?, ?, ?, 'completed')
  `).run(exportId, format, emiTxns.length + paymentTxns.length, totalAmount, actor, JSON.stringify(payload))

  // Mark records as exported
  const allIds = [...emiTxns, ...paymentTxns].map((t) => t.id)
  if (allIds.length) {
    const placeholders = allIds.map(() => '?').join(',')
    db.prepare(`
      update qb_transactions set approval_status = 'exported', updated_at = datetime('now')
      where id in (${placeholders})
    `).run(...allIds)
  }

  return { export_id: exportId, payload, record_count: allIds.length, total_amount: totalAmount }
}

// ---------------------------------------------------------------------------
// Preview (approved records, not yet exported)
// ---------------------------------------------------------------------------

export function getPreview(db) {
  const emiTxns = db.prepare(`
    select * from qb_transactions
    where approval_status = 'approved' and template_type = 'emi_receipt'
    order by transaction_date desc
  `).all().map((t) => ({
    ...t,
    lines: db.prepare('select * from qb_transaction_lines where transaction_id = ? order by line_number').all(t.id),
  }))

  const paymentTxns = db.prepare(`
    select * from qb_transactions
    where approval_status = 'approved' and template_type = 'payment_disbursed'
    order by transaction_date desc
  `).all().map(t => ({ ...t, lines: db.prepare('select * from qb_transaction_lines where transaction_id=? order by line_number').all(t.id) }))

  const accounts = db.prepare(`
    select qa.* from qb_accounts_to_create qa
    join qb_transactions qt on qt.id = qa.transaction_id
    where qt.approval_status = 'approved'
  `).all()

  const payload = buildQbExportPayload(emiTxns, paymentTxns, accounts)
  const totalAmount = [
    ...emiTxns.map((t) => Number(t.amount) || 0),
    ...paymentTxns.map((t) => Number(t.amount) || 0),
  ].reduce((a, b) => a + b, 0)
  const approvedCount = emiTxns.length + paymentTxns.length + accounts.length

  return {
    approved_count: approvedCount,
    total_amount: totalAmount,
    emi_receipts_count: emiTxns.length,
    payments_count: paymentTxns.length,
    accounts_count: accounts.length,
    sample_payload: payload,
    payload,
    emi_receipts: emiTxns,
    payments_disbursed: paymentTxns,
    accounts_to_create: accounts,
    counts: {
      emi: emiTxns.length,
      payments: paymentTxns.length,
      accounts: accounts.length,
    },
  }
}

// ---------------------------------------------------------------------------
// Export history
// ---------------------------------------------------------------------------

export function getExports(db) {
  return db.prepare(`
    select id, format, record_count, total_amount, generated_by, generated_at, status, file_reference
    from qb_export_batches
    order by generated_at desc
  `).all()
}

export function getExportById(db, id) {
  return db.prepare('select * from qb_export_batches where id = ?').get(id)
}

// ---------------------------------------------------------------------------
// Transaction CRUD (Add, Modify, Delete)
// ---------------------------------------------------------------------------

export function createTransaction(db, data, actor = 'system') {
  return atomic(db, () => createTransactionInternal(db, data, actor))
}

function createTransactionInternal(db, data, actor = 'system') {
  const templateType = data.template_type || 'emi_receipt'
  const isoDate = normalizeDate(data.transaction_date) || new Date().toISOString().slice(0, 10)
  const amount = normalizeAmount(data.amount) || 0
  const customerName = normalizeName(data.customer_name || data.vendor_name || '').raw || 'Unknown Customer'
  const referenceNum = normalizeReference(data.reference_number || '')
  const paymentMethod = data.payment_method || 'ACH'
  const depositTo = data.deposit_to || (templateType === 'emi_receipt' ? 'General Bank Account' : null)
  const bankAccount = data.bank_account || (templateType === 'payment_disbursed' ? 'Operating Bank Account' : null)
  const borrowerId = data.borrower_id ? String(data.borrower_id).trim() : null
  const loanId = data.loan_id ? String(data.loan_id).trim() : null
  const currency = data.currency || 'BSD'
  const memo = data.memo || (templateType === 'payment_disbursed' ? 'Disbursement Payment' : 'Customer EMI Payment')

  const hash = buildTransactionHash(templateType, isoDate, customerName, referenceNum, amount)
  const txnId = randomUUID()
  const inputId = randomUUID()
  const batchId = randomUUID()

  // Create manual batch record
  db.prepare(`
    insert into qb_import_batches (id, source_type, source_name, total_records, valid_records, status, created_by)
    values (?, 'manual', ?, 1, 1, 'completed', ?)
  `).run(batchId, `Manual Entry - ${customerName}`, actor)

  // Create manual input record
  db.prepare(`
    insert into qb_input_library
    (id, batch_id, source_type, original_filename, original_text, document_type, transaction_type, processing_status, extraction_confidence, created_by)
    values (?, ?, 'manual', ?, ?, ?, ?, 'validated', 1.0, ?)
  `).run(
    inputId,
    batchId,
    `Manual Entry - ${customerName}`,
    memo,
    templateType,
    templateType,
    actor
  )

  // Build line items
  let lines = []
  if (Array.isArray(data.lines) && data.lines.length > 0) {
    lines = data.lines.map((l) => ({
      account_name: l.account_name || (templateType === 'payment_disbursed' ? 'Loan Disbursements' : 'Loans Receivable'),
      amount: normalizeAmount(l.amount),
      memo: l.memo || memo,
    }))
  } else {
    if (templateType === 'payment_disbursed') {
      lines.push({
        account_name: data.account_name || 'Loan Disbursements',
        amount: amount,
        memo: memo,
      })
    } else {
      if (data.principal_amount != null && data.interest_amount != null) {
        const principal = normalizeAmount(data.principal_amount)
        const interest = normalizeAmount(data.interest_amount)
        lines.push({ account_name: 'Loans Receivable', amount: principal, memo: 'Principal' })
        if (interest > 0) {
          lines.push({ account_name: 'Interest Income', amount: interest, memo: 'Interest' })
        }
      } else {
        lines.push({
          account_name: data.account_name || 'Loans Receivable',
          amount: amount,
          memo: memo,
        })
      }
    }
  }

  // Validate
  const existingHashRows = db.prepare('select transaction_hash from qb_transactions where transaction_hash is not null').all()
  const existingHashes = new Set(existingHashRows.map((r) => r.transaction_hash))

  const txnForValidation = {
    id: txnId,
    template_type: templateType,
    transaction_date: isoDate,
    customer_name: customerName,
    vendor_name: customerName,
    reference_number: referenceNum,
    amount: amount,
    deposit_to: depositTo,
    bank_account: bankAccount,
    ai_confidence: 1.0,
    borrower_id: borrowerId,
    transaction_hash: hash,
  }

  const { results: validationResults, overallStatus } = validateTransaction(txnForValidation, lines, existingHashes)

  const mappedPayload = templateType === 'payment_disbursed'
    ? mapToPaymentDisbursed(txnForValidation, lines)
    : mapToEmiReceipt({ ...txnForValidation, id: txnId, input_id: inputId, validation_status: overallStatus }, lines)

  db.prepare(`
    insert into qb_transactions
    (id, input_id, batch_id, template_type, transaction_date, borrower_id, loan_id,
     vendor_name, customer_name, reference_number, amount, currency, payment_method,
     deposit_to, bank_account, mapped_payload_json, validation_status, approval_status,
     transaction_hash, ai_confidence, created_at, updated_at)
    values
    (?, ?, ?, ?, ?, ?, ?,
     ?, ?, ?, ?, ?, ?,
     ?, ?, ?, ?, 'pending_review',
     ?, 1.0, datetime('now'), datetime('now'))
  `).run(
    txnId,
    inputId,
    batchId,
    templateType,
    isoDate,
    borrowerId,
    loanId,
    customerName,
    customerName,
    referenceNum,
    amount,
    currency,
    paymentMethod,
    depositTo,
    bankAccount,
    JSON.stringify(mappedPayload),
    overallStatus,
    hash
  )

  // Insert lines
  const insertLine = db.prepare(`
    insert into qb_transaction_lines (id, transaction_id, line_number, account_name, amount, memo)
    values (?, ?, ?, ?, ?, ?)
  `)
  lines.forEach((l, idx) => {
    insertLine.run(randomUUID(), txnId, idx + 1, l.account_name, l.amount, l.memo)
  })

  // Insert validation results
  const insertVal = db.prepare(`
    insert into qb_validation_results (id, transaction_id, rule_code, field_name, severity, status, message)
    values (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const vr of validationResults) {
    insertVal.run(randomUUID(), txnId, vr.code, vr.field, vr.severity, vr.status, vr.message)
  }

  return getTransaction(db, txnId)
}

export function updateTransaction(db, id, data, actor = 'system') {
  return atomic(db, () => updateTransactionInternal(db, id, data, actor))
}

function updateTransactionInternal(db, id, data, actor = 'system') {
  assertEditable(db, id)
  const existing = db.prepare('select * from qb_transactions where id = ?').get(id)
  if (!existing) throw new Error(`Transaction ${id} not found`)

  const templateType = data.template_type || existing.template_type || 'emi_receipt'
  const isoDate = data.transaction_date ? (normalizeDate(data.transaction_date) || String(data.transaction_date).slice(0, 10)) : existing.transaction_date
  const amount = data.amount != null ? normalizeAmount(data.amount) : existing.amount
  const customerName = data.customer_name != null ? normalizeName(data.customer_name).raw : existing.customer_name
  const referenceNum = data.reference_number != null ? normalizeReference(data.reference_number) : existing.reference_number
  const paymentMethod = data.payment_method || existing.payment_method || 'ACH'
  const depositTo = data.deposit_to !== undefined ? data.deposit_to : existing.deposit_to
  const bankAccount = data.bank_account !== undefined ? data.bank_account : existing.bank_account
  const borrowerId = data.borrower_id !== undefined ? (data.borrower_id ? String(data.borrower_id).trim() : null) : existing.borrower_id
  const loanId = data.loan_id !== undefined ? (data.loan_id ? String(data.loan_id).trim() : null) : existing.loan_id
  const currency = data.currency || existing.currency || 'BSD'
  const memo = data.memo || (templateType === 'payment_disbursed' ? 'Disbursement Payment' : 'Customer EMI Payment')

  const hash = buildTransactionHash(templateType, isoDate, customerName, referenceNum, amount)

  // Handle line items
  let lines = []
  if (Array.isArray(data.lines) && data.lines.length > 0) {
    lines = data.lines.map((l) => ({
      account_name: l.account_name || (templateType === 'payment_disbursed' ? 'Loan Disbursements' : 'Loans Receivable'),
      amount: normalizeAmount(l.amount),
      memo: l.memo || memo,
    }))
  } else {
    // Check existing lines
    const currentLines = db.prepare('select * from qb_transaction_lines where transaction_id = ? order by line_number').all(id)
    if (currentLines.length > 0) {
      lines = currentLines.map((l) => ({ account_name: l.account_name, amount: amount, memo: l.memo || memo }))
    } else {
      lines = [{ account_name: templateType === 'payment_disbursed' ? 'Loan Disbursements' : 'Loans Receivable', amount, memo }]
    }
  }

  // Validate
  const existingHashRows = db.prepare('select transaction_hash from qb_transactions where transaction_hash is not null and id != ?').all(id)
  const existingHashes = new Set(existingHashRows.map((r) => r.transaction_hash))

  const txnForValidation = {
    id,
    template_type: templateType,
    transaction_date: isoDate,
    customer_name: customerName,
    vendor_name: customerName,
    reference_number: referenceNum,
    amount: amount,
    deposit_to: depositTo,
    bank_account: bankAccount,
    ai_confidence: existing.ai_confidence || 1.0,
    borrower_id: borrowerId,
    transaction_hash: hash,
  }

  const { results: validationResults, overallStatus } = validateTransaction(txnForValidation, lines, existingHashes)

  const mappedPayload = templateType === 'payment_disbursed'
    ? mapToPaymentDisbursed(txnForValidation, lines)
    : mapToEmiReceipt({ ...txnForValidation, id, input_id: existing.input_id, validation_status: overallStatus }, lines)

  db.prepare(`
    update qb_transactions set
      template_type = ?,
      transaction_date = ?,
      borrower_id = ?,
      loan_id = ?,
      vendor_name = ?,
      customer_name = ?,
      reference_number = ?,
      amount = ?,
      currency = ?,
      payment_method = ?,
      deposit_to = ?,
      bank_account = ?,
      mapped_payload_json = ?,
      validation_status = ?,
      transaction_hash = ?,
      updated_at = datetime('now')
    where id = ?
  `).run(
    templateType,
    isoDate,
    borrowerId,
    loanId,
    customerName,
    customerName,
    referenceNum,
    amount,
    currency,
    paymentMethod,
    depositTo,
    bankAccount,
    JSON.stringify(mappedPayload),
    overallStatus,
    hash,
    id
  )

  // Replace line items
  db.prepare('delete from qb_transaction_lines where transaction_id = ?').run(id)
  const insertLine = db.prepare(`
    insert into qb_transaction_lines (id, transaction_id, line_number, account_name, amount, memo)
    values (?, ?, ?, ?, ?, ?)
  `)
  lines.forEach((l, idx) => {
    insertLine.run(randomUUID(), id, idx + 1, l.account_name, l.amount, l.memo)
  })

  // Replace validation results
  db.prepare('delete from qb_validation_results where transaction_id = ?').run(id)
  const insertVal = db.prepare(`
    insert into qb_validation_results (id, transaction_id, rule_code, field_name, severity, status, message)
    values (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const vr of validationResults) {
    insertVal.run(randomUUID(), id, vr.code, vr.field, vr.severity, vr.status, vr.message)
  }

  return getTransaction(db, id)
}

export function deleteTransaction(db, id, actor = 'system') {
  return atomic(db, () => deleteTransactionInternal(db, id, actor))
}

function deleteTransactionInternal(db, id, actor = 'system') {
  assertEditable(db, id)
  const existing = db.prepare('select * from qb_transactions where id = ?').get(id)
  if (!existing) throw new Error(`Transaction ${id} not found`)

  db.prepare('delete from qb_transaction_lines where transaction_id = ?').run(id)
  db.prepare('delete from qb_validation_results where transaction_id = ?').run(id)
  db.prepare('delete from qb_accounts_to_create where transaction_id = ?').run(id)
  db.prepare('delete from qb_transactions where id = ?').run(id)

  return { success: true, deleted_id: id }
}

// ---------------------------------------------------------------------------
// Accounts CRUD (Add, Modify, Delete)
// ---------------------------------------------------------------------------

export function createAccount(db, data, actor = 'system') {
  const accountName = String(data.account_name || '').trim()
  if (!accountName) throw new Error('Account name is required')
  const accountType = String(data.account_type || 'Expense').trim()
  const accountNumber = data.account_number ? String(data.account_number).trim() : null
  const subAccountOf = data.sub_account_of ? String(data.sub_account_of).trim() : null
  const description = data.description ? String(data.description).trim() : null
  const existenceStatus = data.existence_status || 'new_required'

  const id = randomUUID()
  db.prepare(`
    insert into qb_accounts_to_create
    (id, transaction_id, account_name, account_type, account_number, sub_account_of, description, validation_status, existence_status)
    values (?, null, ?, ?, ?, ?, ?, 'valid', ?)
  `).run(id, accountName, accountType, accountNumber, subAccountOf, description, existenceStatus)

  return db.prepare('select * from qb_accounts_to_create where id = ?').get(id)
}

export function updateAccount(db, id, data, actor = 'system') {
  const existing = db.prepare('select * from qb_accounts_to_create where id = ?').get(id)
  if (!existing) throw new Error(`Account ${id} not found`)
  if (existing.transaction_id) assertEditable(db,existing.transaction_id)

  const accountName = data.account_name !== undefined ? String(data.account_name).trim() : existing.account_name
  if (!accountName) throw new Error('Account name cannot be empty')
  const accountType = data.account_type !== undefined ? String(data.account_type).trim() : existing.account_type
  const accountNumber = data.account_number !== undefined ? (data.account_number ? String(data.account_number).trim() : null) : existing.account_number
  const subAccountOf = data.sub_account_of !== undefined ? (data.sub_account_of ? String(data.sub_account_of).trim() : null) : existing.sub_account_of
  const description = data.description !== undefined ? (data.description ? String(data.description).trim() : null) : existing.description
  const existenceStatus = data.existence_status || existing.existence_status || 'new_required'

  db.prepare(`
    update qb_accounts_to_create set
      account_name = ?,
      account_type = ?,
      account_number = ?,
      sub_account_of = ?,
      description = ?,
      existence_status = ?
    where id = ?
  `).run(accountName, accountType, accountNumber, subAccountOf, description, existenceStatus, id)

  return db.prepare('select * from qb_accounts_to_create where id = ?').get(id)
}

export function deleteAccount(db, id, actor = 'system') {
  const existing = db.prepare('select * from qb_accounts_to_create where id = ?').get(id)
  if (!existing) throw new Error(`Account ${id} not found`)
  if (existing.transaction_id) assertEditable(db,existing.transaction_id)

  db.prepare('delete from qb_accounts_to_create where id = ?').run(id)
  return { success: true, deleted_id: id }
}

