import express from 'express'
import { randomUUID } from 'crypto'
import multer from 'multer'
import db from '../db.js'
import {
  getSummary,
  getInputLibrary,
  getInputItem,
  getTransactions,
  getTransaction,
  seedFromSmartRepay,
  runValidation,
  approveTransaction,
  rejectTransaction,
  approveAllValid,
  exportApproved,
  getPreview,
  getExports,
  getExportById,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  createAccount,
  updateAccount,
  deleteAccount,
} from '../qb/qbService.js'
import { extractFromText, extractFromImage, suggestColumnMapping } from '../qb/qbAiExtract.js'
import { normalizeDate, normalizeAmount, normalizeName, normalizeReference, buildTransactionHash } from '../qb/qbNormalize.js'
import { validateTransaction } from '../qb/qbValidation.js'
import { mapToEmiReceipt, mapToPaymentDisbursed } from '../qb/qbMapper.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })

// ---------------------------------------------------------------------------
// RBAC helpers — backend enforcement
// ---------------------------------------------------------------------------

const QB_APPROVER_ROLES = ['accounting', 'system_owner']
const QB_EXPORT_ROLES = ['accounting', 'system_owner']

function canApprove(role) { return QB_APPROVER_ROLES.includes(role) }
function canExport(role) { return QB_EXPORT_ROLES.includes(role) }

// ---------------------------------------------------------------------------
// Audit helper (reuses existing SmartRepay audit table)
// ---------------------------------------------------------------------------

function audit(entity, entityId, action, actor, priorValue, newValue) {
  try {
    db.prepare(
      `insert into audit_log (id, entity, entity_id, action, actor, prior_value, new_value)
       values (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      entity,
      entityId,
      action,
      actor,
      priorValue ? JSON.stringify(priorValue) : null,
      newValue ? JSON.stringify(newValue) : null
    )
  } catch {
    // Never throw from audit — log only
    console.error('[QB Audit] Failed to write audit log')
  }
}

// ---------------------------------------------------------------------------
// GET /api/quickbooks/summary
// ---------------------------------------------------------------------------

router.get('/summary', (req, res) => {
  try {
    const summary = getSummary(db)
    res.json(summary)
  } catch (e) {
    console.error('[QB] GET /summary error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/library
// ---------------------------------------------------------------------------

router.get('/library', (req, res) => {
  try {
    const { page, pageSize, sourceType, status, search } = req.query
    const result = getInputLibrary(db, {
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 50,
      sourceType,
      status,
      search,
    })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/library/:id
// ---------------------------------------------------------------------------

router.get('/library/:id', (req, res) => {
  try {
    const item = getInputItem(db, req.params.id)
    if (!item) return res.status(404).json({ error: 'Library item not found' })
    res.json(item)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/import/smartrepay
// Seed QB EMI receipts from existing SmartRepay matched/posted transactions
// ---------------------------------------------------------------------------

router.post('/import/smartrepay', async (req, res) => {
  try {
    const limit = parseInt(req.body?.limit) || 1000
    const actor = req.user?.email || req.user?.sub || 'system'

    const result = await seedFromSmartRepay(db, actor, limit)

    audit('qb_import', result.batch_id, 'qb_import', actor, null, result)

    res.json({
      success: true,
      ...result,
      message: result.total === 0 && result.skipped > 0
        ? `All ${result.skipped} records were already imported (no duplicates created)`
        : `Imported ${result.total} transactions (${result.valid} valid, ${result.invalid} needs review, ${result.skipped} skipped as duplicates)`,
    })
  } catch (e) {
    console.error('[QB] POST /import/smartrepay error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/import/text
// Import from free text or email body
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /api/quickbooks/import/text
// Import from free text or email body
// ---------------------------------------------------------------------------

router.post('/import/text', async (req, res) => {
  try {
    const {
      text,
      sourceType = 'free_text',
      templateType = 'emi_receipt',
      emailSender,
      emailSubject,
      documentType,
      fileParticulars,
    } = req.body

    if (!text || String(text).trim().length < 5) {
      return res.status(400).json({ error: 'Text content is required' })
    }

    const actor = req.user?.email || req.user?.sub || 'system'
    const batchId = randomUUID()

    db.prepare(`
      insert into qb_import_batches (id, source_type, source_name, status, created_by)
      values (?, ?, ?, 'processing', ?)
    `).run(batchId, sourceType, emailSubject || `${templateType === 'payment_disbursed' ? 'Payment' : 'Receipt'} Text Import`, actor)

    // Create input library item
    const inputId = randomUUID()
    db.prepare(`
      insert into qb_input_library
      (id, batch_id, source_type, original_text, email_sender, email_subject, transaction_type, processing_status, created_by)
      values (?, ?, ?, ?, ?, ?, ?, 'processing', ?)
    `).run(inputId, batchId, sourceType, text, emailSender || null, emailSubject || null, templateType, actor)

    // AI extraction
    let extraction = null
    let aiError = null
    try {
      extraction = await extractFromText(text, { documentType: documentType || sourceType, fileParticulars })
    } catch (e) {
      aiError = e.message
    }

    if (!extraction) {
      db.prepare(`update qb_input_library set processing_status = 'error' where id = ?`).run(inputId)
      db.prepare(`update qb_import_batches set status = 'failed', completed_at = datetime('now') where id = ?`).run(batchId)
      return res.status(422).json({ error: aiError || 'AI extraction failed' })
    }

    // Normalize extracted fields
    const fields = extraction.fields || {}
    const isoDate = normalizeDate(fields.transaction_date?.value) || new Date().toISOString().slice(0, 10)
    const amount = normalizeAmount(fields.amount?.value) || 0
    const partyName = normalizeName(
      fields.customer_name?.value || fields.vendor_name?.value || fields.payee?.value || ''
    ).raw || 'General Account'
    const referenceNum = normalizeReference(
      fields.reference_number?.value || fields.invoice_number?.value || fields.check_number?.value || ''
    )
    const hash = buildTransactionHash(templateType, isoDate, partyName, referenceNum, amount)

    // Check duplicate
    const existingHash = db.prepare('select id from qb_transactions where transaction_hash = ?').get(hash)
    if (existingHash) {
      db.prepare(`update qb_input_library set processing_status = 'validated', attachment_status = 'duplicate' where id = ?`).run(inputId)
      db.prepare(`update qb_import_batches set status = 'completed', duplicate_records = 1, completed_at = datetime('now') where id = ?`).run(batchId)
      return res.json({ success: true, status: 'duplicate', template_type: templateType, existing_id: existingHash.id, batch_id: batchId })
    }

    const txnId = randomUUID()
    const deposit_to = fields.deposit_to?.value || 'General Bank Account'
    const bank_account = fields.bank_account?.value || (templateType === 'payment_disbursed' ? 'Operating Bank Account' : null)
    const lines = []

    if (templateType === 'payment_disbursed') {
      lines.push({
        account_name: 'Loan Disbursements',
        amount: amount,
        memo: 'Payment Disbursement',
      })
    } else {
      if (fields.principal_amount?.value != null) {
        lines.push({ account_name: 'Loans Receivable', amount: normalizeAmount(fields.principal_amount.value), memo: 'Principal' })
        if (fields.interest_amount?.value != null) {
          lines.push({ account_name: 'Interest Income', amount: normalizeAmount(fields.interest_amount.value), memo: 'Interest' })
        }
      } else {
        lines.push({ account_name: 'Loans Receivable', amount: amount, memo: 'EMI Payment' })
      }
    }

    const txnForValidation = {
      id: txnId,
      template_type: templateType,
      transaction_date: isoDate,
      customer_name: partyName,
      reference_number: referenceNum,
      amount,
      deposit_to,
      bank_account,
      ai_confidence: extraction.confidence,
      borrower_id: null,
      transaction_hash: hash,
    }
    const { results: validationResults, overallStatus } = validateTransaction(txnForValidation, lines, new Set())

    const mappedPayload = templateType === 'payment_disbursed'
      ? mapToPaymentDisbursed(txnForValidation, lines)
      : mapToEmiReceipt({ ...txnForValidation, id: txnId, input_id: inputId, validation_status: overallStatus }, lines)

    db.prepare(`
      insert into qb_transactions
      (id, input_id, batch_id, template_type, transaction_date, customer_name, reference_number,
       amount, deposit_to, bank_account, payment_method, mapped_payload_json, validation_status, approval_status,
       transaction_hash, ai_confidence)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
    `).run(
      txnId, inputId, batchId, templateType, isoDate, partyName, referenceNum,
      amount, deposit_to, bank_account, fields.payment_method?.value || 'ACH',
      JSON.stringify(mappedPayload), overallStatus, hash, extraction.confidence || null
    )

    lines.forEach((l, idx) => {
      db.prepare(`insert into qb_transaction_lines (id, transaction_id, line_number, account_name, amount, memo) values (?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), txnId, idx + 1, l.account_name, l.amount, l.memo)
    })

    for (const vr of validationResults) {
      db.prepare(`insert into qb_validation_results (id, transaction_id, rule_code, field_name, severity, status, message) values (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), txnId, vr.code, vr.field, vr.severity, vr.status, vr.message)
    }

    db.prepare(`update qb_input_library set processing_status = 'validated', extraction_confidence = ? where id = ?`)
      .run(extraction.confidence || null, inputId)
    db.prepare(`update qb_import_batches set total_records=1, valid_records=?, invalid_records=?, status='completed', completed_at=datetime('now') where id=?`)
      .run(overallStatus === 'valid' ? 1 : 0, overallStatus !== 'valid' ? 1 : 0, batchId)

    audit('qb_transaction', txnId, 'qb_import', actor, null, { template: templateType, status: overallStatus })

    res.json({
      success: true,
      transaction_id: txnId,
      batch_id: batchId,
      template_type: templateType,
      validation_status: overallStatus,
      extraction,
    })
  } catch (e) {
    console.error('[QB] POST /import/text error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/import/files
// ---------------------------------------------------------------------------

router.post('/import/files', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files
    if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' })

    const templateType = req.body?.templateType || 'emi_receipt'
    const actor = req.user?.email || req.user?.sub || 'system'
    const batchId = randomUUID()

    db.prepare(`
      insert into qb_import_batches (id, source_type, source_name, total_files, status, created_by)
      values (?, 'files', ?, ?, 'processing', ?)
    `).run(batchId, `${templateType === 'payment_disbursed' ? 'Payment' : 'Receipt'} File Import`, files.length, actor)

    const results = []
    let validCount = 0
    let invalidCount = 0

    for (const file of files) {
      const inputId = randomUUID()
      const mime = file.mimetype || ''
      const isImg = mime.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.originalname)
      const sourceType = isImg ? 'image' : (/\.xlsx?|\.csv$/i.test(file.originalname) ? 'excel' : 'pdf')

      db.prepare(`
        insert into qb_input_library (id, batch_id, source_type, original_filename, transaction_type, processing_status, created_by)
        values (?, ?, ?, ?, ?, 'processing', ?)
      `).run(inputId, batchId, sourceType, file.originalname, templateType, actor)

      try {
        let extraction = null
        if (isImg) {
          extraction = await extractFromImage(file.buffer, mime || 'image/jpeg')
        } else {
          const text = file.buffer.toString('utf-8').slice(0, 10000)
          extraction = await extractFromText(text, { documentType: sourceType })
        }

        const fields = extraction?.fields || {}
        const isoDate = normalizeDate(fields.transaction_date?.value) || new Date().toISOString().slice(0, 10)
        const amount = normalizeAmount(fields.amount?.value) || 0
        const partyName = normalizeName(
          fields.customer_name?.value || fields.vendor_name?.value || fields.payee?.value || file.originalname.replace(/\.[^.]+$/, '')
        ).raw || 'General Account'
        const refNum = normalizeReference(
          fields.reference_number?.value || fields.invoice_number?.value || fields.check_number?.value || ''
        )
        const hash = buildTransactionHash(templateType, isoDate, partyName, refNum, amount)

        const txnId = randomUUID()
        const lines = [
          {
            account_name: templateType === 'payment_disbursed' ? 'Loan Disbursements' : 'Loans Receivable',
            amount: amount,
            memo: templateType === 'payment_disbursed' ? 'Disbursement Payment' : 'EMI Payment',
          }
        ]

        const txnForValidation = {
          id: txnId,
          template_type: templateType,
          transaction_date: isoDate,
          customer_name: partyName,
          reference_number: refNum,
          amount: amount,
          deposit_to: 'General Bank Account',
          bank_account: fields.bank_account?.value || (templateType === 'payment_disbursed' ? 'Operating Bank Account' : null),
          ai_confidence: extraction?.confidence || 0.85,
          borrower_id: null,
          transaction_hash: hash,
        }

        const { results: validationResults, overallStatus } = validateTransaction(txnForValidation, lines, new Set())

        const mappedPayload = templateType === 'payment_disbursed'
          ? mapToPaymentDisbursed(txnForValidation, lines)
          : mapToEmiReceipt(txnForValidation, lines)

        db.prepare(`
          insert into qb_transactions
          (id, input_id, batch_id, template_type, transaction_date, customer_name, reference_number,
           amount, deposit_to, bank_account, payment_method, mapped_payload_json, validation_status, approval_status,
           transaction_hash, ai_confidence)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
        `).run(
          txnId, inputId, batchId, templateType, isoDate, partyName, refNum,
          amount, txnForValidation.deposit_to, txnForValidation.bank_account,
          fields.payment_method?.value || 'ACH', JSON.stringify(mappedPayload),
          overallStatus, hash, extraction?.confidence || 0.85
        )

        lines.forEach((l, idx) => {
          db.prepare(`insert into qb_transaction_lines (id, transaction_id, line_number, account_name, amount, memo) values (?, ?, ?, ?, ?, ?)`).run(randomUUID(), txnId, idx + 1, l.account_name, l.amount, l.memo)
        })

        for (const vr of validationResults) {
          db.prepare(`insert into qb_validation_results (id, transaction_id, rule_code, field_name, severity, status, message) values (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), txnId, vr.code, vr.field, vr.severity, vr.status, vr.message)
        }

        db.prepare(`update qb_input_library set processing_status = 'validated', extraction_confidence = ? where id = ?`)
          .run(extraction?.confidence || 0.85, inputId)

        if (overallStatus === 'valid') validCount++
        else invalidCount++

        results.push({
          file: file.originalname,
          input_id: inputId,
          transaction_id: txnId,
          template_type: templateType,
          status: overallStatus,
          confidence: extraction?.confidence,
        })
      } catch (e) {
        db.prepare(`update qb_input_library set processing_status = 'error' where id = ?`).run(inputId)
        results.push({ file: file.originalname, input_id: inputId, status: 'error', error: e.message })
      }
    }

    db.prepare(`
      update qb_import_batches set
        total_records = ?, valid_records = ?, invalid_records = ?,
        status = 'completed', completed_at = datetime('now')
      where id = ?
    `).run(results.length, validCount, invalidCount, batchId)

    res.json({
      success: true,
      batch_id: batchId,
      template_type: templateType,
      total: results.length,
      valid: validCount,
      results,
    })
  } catch (e) {
    console.error('[QB] POST /import/files error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/transactions
// ---------------------------------------------------------------------------

router.get('/transactions', (req, res) => {
  try {
    const { page, pageSize, validationStatus, approvalStatus, templateType, search, dateFrom, dateTo } = req.query
    const result = getTransactions(db, {
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 50,
      validationStatus,
      approvalStatus,
      templateType,
      search,
      dateFrom,
      dateTo,
    })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/transactions/:id
// ---------------------------------------------------------------------------

router.get('/transactions/:id', (req, res) => {
  try {
    const txn = getTransaction(db, req.params.id)
    if (!txn) return res.status(404).json({ error: 'Transaction not found' })
    res.json(txn)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/transactions/:id/validate
// ---------------------------------------------------------------------------

router.post('/transactions/:id/validate', (req, res) => {
  try {
    const result = runValidation(db, req.params.id)
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/transactions/:id/approve
// ---------------------------------------------------------------------------

router.post('/transactions/:id/approve', (req, res) => {
  const role = req.user?.role
  if (!canApprove(role)) {
    return res.status(403).json({ error: 'Only accounting or system_owner can approve QuickBooks transactions' })
  }
  try {
    const actor = req.user?.email || req.user?.sub
    const prior = db.prepare('select approval_status from qb_transactions where id = ?').get(req.params.id)
    const result = approveTransaction(db, req.params.id, actor)
    audit('qb_transaction', req.params.id, 'qb_approval', actor, prior, { approval_status: 'approved' })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/transactions/:id/reject
// ---------------------------------------------------------------------------

router.post('/transactions/:id/reject', (req, res) => {
  const role = req.user?.role
  if (!canApprove(role)) {
    return res.status(403).json({ error: 'Only accounting or system_owner can reject QuickBooks transactions' })
  }
  try {
    const actor = req.user?.email || req.user?.sub
    const { reason = '' } = req.body
    const prior = db.prepare('select approval_status from qb_transactions where id = ?').get(req.params.id)
    const result = rejectTransaction(db, req.params.id, actor, reason)
    audit('qb_transaction', req.params.id, 'qb_rejection', actor, prior, { approval_status: 'rejected', reason })
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/approve-all
// ---------------------------------------------------------------------------

router.post('/approve-all', (req, res) => {
  const role = req.user?.role
  if (!canApprove(role)) {
    return res.status(403).json({ error: 'Only accounting or system_owner can approve QuickBooks transactions' })
  }
  try {
    const actor = req.user?.email || req.user?.sub
    const templateType = req.body?.templateType || null
    const result = approveAllValid(db, templateType, actor)
    audit('qb_bulk_approval', 'all', 'qb_bulk_approval', actor, null, { templateType, approved_count: result.approved_count })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/emi-receipts
// ---------------------------------------------------------------------------

router.get('/emi-receipts', (req, res) => {
  try {
    const { page, pageSize, validationStatus, approvalStatus, search } = req.query
    const result = getTransactions(db, {
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 50,
      templateType: 'emi_receipt',
      validationStatus,
      approvalStatus,
      search,
    })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/payments-disbursed
// ---------------------------------------------------------------------------

router.get('/payments-disbursed', (req, res) => {
  try {
    const { page, pageSize, search } = req.query
    const result = getTransactions(db, {
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 50,
      templateType: 'payment_disbursed',
      search,
    })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/transactions (Manual Add)
// ---------------------------------------------------------------------------

router.post('/transactions', (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'system'
    const created = createTransaction(db, req.body, actor)
    audit('qb_transaction', created.id, 'qb_create', actor, null, { template: created.template_type, amount: created.amount })
    res.status(201).json(created)
  } catch (e) {
    console.error('[QB] POST /transactions error:', e)
    res.status(400).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// PUT /api/quickbooks/transactions/:id (Modify)
// ---------------------------------------------------------------------------

router.put('/transactions/:id', (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'system'
    const prior = db.prepare('select * from qb_transactions where id = ?').get(req.params.id)
    if (!prior) return res.status(404).json({ error: 'Transaction not found' })
    const updated = updateTransaction(db, req.params.id, req.body, actor)
    audit('qb_transaction', req.params.id, 'qb_update', actor, prior, { template: updated.template_type, amount: updated.amount })
    res.json(updated)
  } catch (e) {
    console.error('[QB] PUT /transactions/:id error:', e)
    res.status(400).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// DELETE /api/quickbooks/transactions/:id (Delete)
// ---------------------------------------------------------------------------

router.delete('/transactions/:id', (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'system'
    const prior = db.prepare('select * from qb_transactions where id = ?').get(req.params.id)
    if (!prior) return res.status(404).json({ error: 'Transaction not found' })
    const result = deleteTransaction(db, req.params.id, actor)
    audit('qb_transaction', req.params.id, 'qb_delete', actor, prior, null)
    res.json(result)
  } catch (e) {
    console.error('[QB] DELETE /transactions/:id error:', e)
    res.status(400).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/accounts
// ---------------------------------------------------------------------------

router.get('/accounts', (req, res) => {
  try {
    const accounts = db.prepare(`
      select qa.*, qt.validation_status as txn_status, qt.approval_status
      from qb_accounts_to_create qa
      left join qb_transactions qt on qt.id = qa.transaction_id
      order by qa.rowid desc
    `).all()
    res.json({ rows: accounts, total: accounts.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/accounts (Add)
// ---------------------------------------------------------------------------

router.post('/accounts', (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'system'
    const created = createAccount(db, req.body, actor)
    audit('qb_account', created.id, 'qb_account_create', actor, null, created)
    res.status(201).json(created)
  } catch (e) {
    console.error('[QB] POST /accounts error:', e)
    res.status(400).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// PUT /api/quickbooks/accounts/:id (Modify)
// ---------------------------------------------------------------------------

router.put('/accounts/:id', (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'system'
    const prior = db.prepare('select * from qb_accounts_to_create where id = ?').get(req.params.id)
    if (!prior) return res.status(404).json({ error: 'Account not found' })
    const updated = updateAccount(db, req.params.id, req.body, actor)
    audit('qb_account', req.params.id, 'qb_account_update', actor, prior, updated)
    res.json(updated)
  } catch (e) {
    console.error('[QB] PUT /accounts/:id error:', e)
    res.status(400).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// DELETE /api/quickbooks/accounts/:id (Delete)
// ---------------------------------------------------------------------------

router.delete('/accounts/:id', (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'system'
    const prior = db.prepare('select * from qb_accounts_to_create where id = ?').get(req.params.id)
    if (!prior) return res.status(404).json({ error: 'Account not found' })
    const result = deleteAccount(db, req.params.id, actor)
    audit('qb_account', req.params.id, 'qb_account_delete', actor, prior, null)
    res.json(result)
  } catch (e) {
    console.error('[QB] DELETE /accounts/:id error:', e)
    res.status(400).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/exceptions
// ---------------------------------------------------------------------------

router.get('/exceptions', (req, res) => {
  try {
    const { page, pageSize, search } = req.query
    const result = getTransactions(db, {
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 50,
      search,
      // Return invalid + needs_review + duplicate
    })
    const filtered = {
      ...result,
      rows: result.rows.filter((r) => ['invalid', 'needs_review', 'duplicate'].includes(r.validation_status)),
    }
    filtered.total = filtered.rows.length
    res.json(filtered)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/preview
// ---------------------------------------------------------------------------

router.get('/preview', (req, res) => {
  try {
    const preview = getPreview(db)
    res.json(preview)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/export
// ---------------------------------------------------------------------------

router.post('/export', (req, res) => {
  const role = req.user?.role
  if (!canExport(role)) {
    return res.status(403).json({ error: 'Only accounting or system_owner can export QuickBooks data' })
  }
  try {
    const format = req.body?.format || 'json'
    const actor = req.user?.email || req.user?.sub
    const result = exportApproved(db, format, actor)
    audit('qb_export', result.export_id, 'qb_export', actor, null, { format, record_count: result.record_count })
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/exports
// ---------------------------------------------------------------------------

router.get('/exports', (req, res) => {
  try {
    res.json(getExports(db))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// GET /api/quickbooks/exports/:id
// ---------------------------------------------------------------------------

router.get('/exports/:id', (req, res) => {
  try {
    const exp = getExportById(db, req.params.id)
    if (!exp) return res.status(404).json({ error: 'Export not found' })
    res.json(exp)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// POST /api/quickbooks/import/loandisk
// Placeholder — uses existing LoanDisk integration
// ---------------------------------------------------------------------------

router.post('/import/loandisk', (req, res) => {
  res.status(501).json({
    error: 'LoanDisk import for QuickBooks is prepared but requires selecting borrower/loan data from the LoanDisk module first.',
    hint: 'Use the existing /loandisk endpoints to fetch data, then pass loan IDs to this endpoint.',
  })
})

export default router
