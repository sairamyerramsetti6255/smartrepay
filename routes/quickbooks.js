import path from 'node:path'
import { createExcelLink } from '../qb/qbExcelLinks.js'
import { listReviewQueue, getReviewDetail, correctReviewRecord, reconciliationReport, approveReviewedRecord } from '../qb/qbOperationsService.js'
import { lookupBorrower } from '../qb/qbBorrowerResolver.js'
import { requireQuickBooksRole, canManageQuickBooks } from '../qb/qbGuards.js'
import { listDeliveries, queueDesktopApproved, retryFailedDelivery, cancelUnsentDelivery } from '../qb/qbDesktopService.js'
import { parseStatementBuffer } from '../parseStatement.js'
import { resolveParticularsFields, isCompanyName } from '../particularsParse.js'
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
import {
  getRpaStatus,
  runRpaPipeline,
  handleRpaChat,
  getRpaLogs,
  getRpaRunById,
  saveRpaSettings,
  getDesktopRpaScript,
  detectDesktopApps,
  generateReconciliationPackage,
  launchDesktopApplication,
} from '../qb/qbRpaService.js'
import { getMcpManifest, executeMcpToolCall } from '../qb/qbMcpService.js'

const router = express.Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })

// ---------------------------------------------------------------------------
// RBAC helpers — backend enforcement
// ---------------------------------------------------------------------------

const canApprove = canManageQuickBooks
const canExport = canManageQuickBooks
// All ledger mutations require an accounting role. Chat independently filters its tool permissions.
router.use((req,res,next) => {
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.path !== '/rpa/chat') return requireQuickBooksRole(req,res,next)
  next()
})

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
// GET /api/quickbooks/match-lookup
// Real-time Matching Algorithm validation for receipts and payments
// ---------------------------------------------------------------------------

router.get('/match-lookup', (req, res) => {
  try {
    const { name, amount, borrowerId, loanId, templateType } = req.query
    const numAmount = amount ? parseFloat(amount) : null
    const lookup = lookupBorrower(db, name || '', numAmount, borrowerId || null)

    res.json({
      success: true,
      query_name: name || '',
      query_amount: numAmount,
      matched: Boolean(lookup.top_match),
      top_match: lookup.top_match,
      matches: lookup.matches,
      match_count: lookup.match_count,
    })
  } catch (e) {
    console.error('[QB] GET /match-lookup error:', e)
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

    // Auto-resolve borrower from LoanDisk for receipts & payments
    let borrowerId = null
    let loanId = null
    if (partyName) {
      const borrowerLookup = lookupBorrower(db, partyName, amount)
      if (borrowerLookup.top_match) {
        borrowerId = borrowerLookup.top_match.loandisk_id || borrowerLookup.top_match.borrower_id
        loanId = borrowerLookup.top_match.loan_id
      }
    }

    const txnForValidation = {
      id: txnId,
      template_type: templateType,
      transaction_date: isoDate,
      customer_name: partyName,
      vendor_name: partyName,
      reference_number: referenceNum,
      amount,
      deposit_to,
      bank_account,
      ai_confidence: extraction.confidence,
      borrower_id: borrowerId,
      loan_id: loanId,
      transaction_hash: hash,
    }
    const { results: validationResults, overallStatus } = validateTransaction(txnForValidation, lines, new Set(), db)

    const mappedPayload = templateType === 'payment_disbursed'
      ? mapToPaymentDisbursed(txnForValidation, lines)
      : mapToEmiReceipt({ ...txnForValidation, id: txnId, input_id: inputId, validation_status: overallStatus }, lines)

    db.prepare(`
      insert into qb_transactions
      (id, input_id, batch_id, template_type, transaction_date, borrower_id, loan_id, customer_name, reference_number,
       amount, deposit_to, bank_account, payment_method, mapped_payload_json, validation_status, approval_status,
       transaction_hash, ai_confidence)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
    `).run(
      txnId, inputId, batchId, templateType, isoDate, borrowerId, loanId, partyName, referenceNum,
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

// Helper to extract rows from uploaded files (PDF, spreadsheet, image, text)
async function extractTransactionsFromFile(file, templateType) {
  const mime = file.mimetype || ''
  const isImg = mime.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.originalname)
  const isPdf = /\.pdf$/i.test(file.originalname) || mime === 'application/pdf'
  const isSpreadsheet = /\.(xlsx?|csv|tsv)$/i.test(file.originalname)
  const sourceType = isImg ? 'image' : (isSpreadsheet ? 'excel' : (isPdf ? 'pdf' : 'text'))

  let extractedRows = []
  let confidence = 0.95

  // 1. Try structured statement / PDF / spreadsheet parser
  if (!isImg) {
    try {
      const parsed = await parseStatementBuffer(file.buffer, file.originalname, {
        documentType: templateType === 'payment_disbursed' ? 'bank' : undefined,
      })
      if (parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
        extractedRows = parsed.rows
        confidence = parsed.method === 'ai' ? 0.85 : 0.95
      }
    } catch (err) {
      console.warn(`[QB Import] parseStatementBuffer fallback for ${file.originalname}:`, err.message)
    }
  }

  // 2. If image, or if structured parser didn't extract rows, try image/OCR
  if (extractedRows.length === 0 && isImg) {
    try {
      const extraction = await extractFromImage(file.buffer, mime || 'image/jpeg')
      if (extraction?.fields) {
        const f = extraction.fields
        extractedRows.push({
          date: f.transaction_date?.value,
          amount: f.amount?.value,
          payer: f.customer_name?.value || f.vendor_name?.value || f.payee?.value,
          reference: f.reference_number?.value || f.invoice_number?.value || f.check_number?.value,
          description: f.bank_account?.value || 'Image extraction',
          bank_account: f.bank_account?.value,
          payment_method: f.payment_method?.value,
        })
        confidence = extraction.confidence || 0.85
      }
    } catch (err) {
      console.warn(`[QB Import] extractFromImage fallback failed for ${file.originalname}:`, err.message)
    }
  }

  // 3. Fallback: text extraction (including PDF text)
  if (extractedRows.length === 0) {
    try {
      let text = ''
      if (isPdf) {
        const { PDFParse } = await import('pdf-parse')
        const parser = new PDFParse({ data: file.buffer })
        try {
          const res = await parser.getText()
          text = res.text || ''
        } finally {
          await parser.destroy()
        }
      } else if (!isImg) {
        text = file.buffer.toString('utf-8')
      }

      if (text.trim()) {
        const extraction = await extractFromText(text.slice(0, 10000), { documentType: sourceType })
        if (extraction?.fields) {
          const f = extraction.fields
          extractedRows.push({
            date: f.transaction_date?.value,
            amount: f.amount?.value,
            payer: f.customer_name?.value || f.vendor_name?.value || f.payee?.value,
            reference: f.reference_number?.value || f.invoice_number?.value || f.check_number?.value,
            description: f.bank_account?.value || 'Text extraction',
            bank_account: f.bank_account?.value,
            payment_method: f.payment_method?.value,
          })
          confidence = extraction.confidence || 0.80
        }
      }
    } catch (err) {
      console.warn(`[QB Import] extractFromText fallback failed for ${file.originalname}:`, err.message)
    }
  }

  return { sourceType, extractedRows, confidence }
}

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

    const existingHashRows = db.prepare('select transaction_hash from qb_transactions where transaction_hash is not null').all()
    const existingHashes = new Set(existingHashRows.map((r) => r.transaction_hash))

    const results = []
    let totalTransactions = 0
    let validCount = 0
    let invalidCount = 0

    for (const file of files) {
      const inputId = randomUUID()
      const { sourceType, extractedRows, confidence } = await extractTransactionsFromFile(file, templateType)

      db.prepare(`
        insert into qb_input_library (id, batch_id, source_type, original_filename, transaction_type, processing_status, created_by)
        values (?, ?, ?, ?, ?, 'processing', ?)
      `).run(inputId, batchId, sourceType, file.originalname, templateType, actor)

      if (!extractedRows || extractedRows.length === 0) {
        db.prepare(`update qb_input_library set processing_status = 'error' where id = ?`).run(inputId)
        invalidCount++
        totalTransactions++
        results.push({ file: file.originalname, input_id: inputId, status: 'error', error: 'No transaction rows could be extracted from file' })
        continue
      }

      let fileValidCount = 0
      let fileInvalidCount = 0

      for (let rowIndex = 0; rowIndex < extractedRows.length; rowIndex++) {
        const row = extractedRows[rowIndex]
        const rawAmount = row.amount ?? row.creditAmount ?? row.emiPaidAmount
        const amount = normalizeAmount(rawAmount) || 0
        const rawDate = row.date ?? row.transDate ?? row.datePosted ?? row.valueDate
        const isoDate = normalizeDate(rawDate) || new Date().toISOString().slice(0, 10)
        const refNum = normalizeReference(row.reference ?? row.referenceNo ?? row.reference_number ?? row.chequeNo ?? '')

        const particularsText = String(row.particulars ?? row.description ?? row.remarks ?? row.transactionDescription ?? '').trim()
        const rawPayer = String(row.payer ?? row.borrowerName ?? row.name ?? row.customer_name ?? row.vendor_name ?? '').trim()
        const resolved = resolveParticularsFields({
          particulars: particularsText,
          borrowerName: rawPayer,
          payer: rawPayer,
          description: row.description,
        })

        let partyName = resolved.borrowerName || rawPayer
        if (isCompanyName(partyName)) {
          partyName = ''
        }

        // Matching algorithm lookup against LoanDisk
        let borrowerId = null
        let loanId = null
        let matchedCustomerName = partyName

        const lookupQuery = partyName || particularsText
        if (lookupQuery) {
          const borrowerLookup = lookupBorrower(db, lookupQuery, amount)
          if (borrowerLookup.top_match) {
            borrowerId = borrowerLookup.top_match.loandisk_id || borrowerLookup.top_match.borrower_id
            loanId = borrowerLookup.top_match.loan_id
            if (!matchedCustomerName) {
              matchedCustomerName = borrowerLookup.top_match.borrower_name
            }
          }
        }

        const finalPartyName = templateType === 'payment_disbursed'
          ? (partyName || matchedCustomerName || 'Operating Vendor')
          : (matchedCustomerName || partyName || 'Unknown Borrower')

        const baseHash = buildTransactionHash(templateType, isoDate, finalPartyName, refNum, amount)
        let hash = baseHash
        if (existingHashes.has(hash)) {
          hash = `${baseHash}_${rowIndex}_${randomUUID().slice(0, 8)}`
        }
        existingHashes.add(hash)

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
          customer_name: templateType === 'payment_disbursed' ? finalPartyName : (matchedCustomerName || partyName),
          vendor_name: templateType === 'payment_disbursed' ? finalPartyName : undefined,
          reference_number: refNum,
          amount: amount,
          deposit_to: 'General Bank Account',
          bank_account: row.bank_account || (templateType === 'payment_disbursed' ? 'Operating Bank Account' : null),
          ai_confidence: confidence,
          borrower_id: borrowerId,
          loan_id: loanId,
          transaction_hash: hash,
          memo: particularsText || undefined,
        }

        const { results: validationResults, overallStatus } = validateTransaction(txnForValidation, lines, new Set(), db)

        const mappedPayload = templateType === 'payment_disbursed'
          ? mapToPaymentDisbursed(txnForValidation, lines)
          : mapToEmiReceipt(txnForValidation, lines)

        db.prepare(`
          insert into qb_transactions
          (id, input_id, batch_id, template_type, transaction_date, borrower_id, loan_id, customer_name, vendor_name, reference_number,
           amount, deposit_to, bank_account, payment_method, mapped_payload_json, validation_status, approval_status,
           transaction_hash, ai_confidence)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
        `).run(
          txnId, inputId, batchId, templateType, isoDate, borrowerId, loanId,
          txnForValidation.customer_name, txnForValidation.vendor_name || null, refNum,
          amount, txnForValidation.deposit_to, txnForValidation.bank_account,
          row.payment_method || 'ACH', JSON.stringify(mappedPayload),
          overallStatus, hash, confidence
        )

        lines.forEach((l, idx) => {
          db.prepare(`insert into qb_transaction_lines (id, transaction_id, line_number, account_name, amount, memo) values (?, ?, ?, ?, ?, ?)`).run(randomUUID(), txnId, idx + 1, l.account_name, l.amount, l.memo)
        })

        for (const vr of validationResults) {
          db.prepare(`insert into qb_validation_results (id, transaction_id, rule_code, field_name, severity, status, message) values (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), txnId, vr.code, vr.field, vr.severity, vr.status, vr.message)
        }

        totalTransactions++
        if (overallStatus === 'valid') {
          validCount++
          fileValidCount++
        } else {
          invalidCount++
          fileInvalidCount++
        }

        results.push({
          file: file.originalname,
          input_id: inputId,
          transaction_id: txnId,
          template_type: templateType,
          status: overallStatus,
          confidence,
          customer_name: txnForValidation.customer_name,
          amount,
        })
      }

      db.prepare(`update qb_input_library set processing_status = 'validated', extraction_confidence = ? where id = ?`)
        .run(confidence, inputId)
    }

    db.prepare(`
      update qb_import_batches set
        total_records = ?, valid_records = ?, invalid_records = ?,
        status = 'completed', completed_at = datetime('now')
      where id = ?
    `).run(totalTransactions, validCount, invalidCount, batchId)

    res.json({
      success: true,
      batch_id: batchId,
      template_type: templateType,
      total: totalTransactions,
      valid: validCount,
      invalid: invalidCount,
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

// ===========================================================================
// RPA AI AGENT ENDPOINTS
// ===========================================================================

// GET /api/quickbooks/rpa/status
router.get('/rpa/status', (req, res) => {
  try {
    const status = getRpaStatus(db)
    res.json(status)
  } catch (e) {
    console.error('[QB RPA] GET /rpa/status error:', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/quickbooks/rpa/pipeline
router.post('/rpa/pipeline', async (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'RPA AI Agent'
    const result = await runRpaPipeline(db, req.body || {}, actor)
    audit('qb_rpa_run', result.run_id, 'qb_rpa_pipeline', actor, null, result.metrics)
    res.json(result)
  } catch (e) {
    console.error('[QB RPA] POST /rpa/pipeline error:', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/quickbooks/rpa/chat
router.post('/rpa/chat', async (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'User'
    const { message, history } = req.body || {}
    const result = await handleRpaChat(db, message, history, actor, req.user?.role)
    res.json(result)
  } catch (e) {
    console.error('[QB RPA] POST /rpa/chat error:', e)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/quickbooks/rpa/logs
router.get('/rpa/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20
    const logs = getRpaLogs(db, limit)
    res.json({ rows: logs, total: logs.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/quickbooks/rpa/runs/:id
router.get('/rpa/runs/:id', (req, res) => {
  try {
    const run = getRpaRunById(db, req.params.id)
    if (!run) return res.status(404).json({ error: 'RPA run not found' })
    res.json(run)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/quickbooks/rpa/settings
router.post('/rpa/settings', (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'system'
    const settings = saveRpaSettings(db, req.body || {})
    audit('qb_rpa_settings', 'default', 'qb_rpa_settings_update', actor, null, settings)
    res.json(settings)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/quickbooks/rpa/script
router.get('/rpa/script', (req, res) => {
  try {
    const format = req.query.format || 'python'
    const script = getDesktopRpaScript(format)
    res.json({ format, script })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/quickbooks/rpa/apps-status
router.get('/rpa/apps-status', (req, res) => {
  try {
    const apps = detectDesktopApps()
    res.json(apps)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Authenticated, accounting-role-only preparation; the resulting link is file scoped.
router.post('/rpa/excel-link', (req, res) => {
  try {
    const pkg = generateReconciliationPackage(db)
    res.set('Cache-Control', 'no-store')
    res.json(createExcelLink(pkg.excelFileName))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/quickbooks/rpa/open-desktop
router.post('/rpa/open-desktop', async (req, res) => {
  try {
    const result = await launchDesktopApplication(db, req.body || {})
    res.json(result)
  } catch (e) {
    console.error('[QB RPA] POST /rpa/open-desktop error:', e)
    res.status(500).json({ error: e.message })
  }
})

// OPTIONS & HEAD & GET /api/quickbooks/rpa/download-file and /api/quickbooks/rpa/excel/:filename
router.options(['/rpa/download-file', '/rpa/excel/:filename'], (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, X-Requested-With')
  res.setHeader('Allow', 'GET, HEAD, OPTIONS')
  res.status(200).end()
})

router.get(['/rpa/download-file', '/rpa/excel/:filename'], (req, res) => {
  try {
    const filename = req.params.filename || ''
    const format = req.query.format || (filename.endsWith('.iif') ? 'iif' : 'excel')
    const pkg = generateReconciliationPackage(db)
    const filePath = format === 'iif' ? pkg.iifPath : pkg.excelPath
    const fileName = filename || (format === 'iif' ? pkg.iifFileName : (pkg.excelFileName || 'smartrepay_reconciliation.xlsx'))
    
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader(
      'Content-Type',
      format === 'iif' ? 'text/plain' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`)
    res.sendFile(path.resolve(filePath))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------------------------------------------------------------------------
// Model Context Protocol (MCP) Standard Endpoints
// ---------------------------------------------------------------------------

// GET /api/quickbooks/mcp/manifest & GET /api/quickbooks/mcp/tools
router.get(['/mcp/manifest', '/mcp/tools'], (req, res) => {
  try {
    const manifest = getMcpManifest()
    res.json(manifest)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/quickbooks/mcp/call & POST /api/quickbooks/mcp/tools/call
router.post(['/mcp/call', '/mcp/tools/call'], async (req, res) => {
  try {
    const actor = req.user?.email || req.user?.sub || 'MCP Client'
    const toolName = req.body.name || req.body.tool || req.body.params?.name
    const args = req.body.arguments || req.body.args || req.body.params?.arguments || {}

    if (!toolName) {
      return res.status(400).json({ error: 'Tool name is required in MCP tool call request' })
    }

    const response = await executeMcpToolCall(db, toolName, args, actor, req.user?.role)
    audit('qb_mcp_tool', toolName, 'mcp_tool_execution', actor, null, { tool: toolName, args })
    res.json(response)
  } catch (e) {
    console.error('[QB MCP Tool Error]', e)
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: e.message },
    })
  }
})

router.get('/rpa/deliveries', (req,res) => res.json({ rows:listDeliveries(db) }))
router.post('/rpa/deliveries', (req,res) => {
  try { res.json(queueDesktopApproved(db,req.user.email || req.user.sub)) }
  catch(e) { res.status(400).json({error:e.message}) }
})
router.post('/rpa/deliveries/:id/retry', (req,res) => {
  try { res.json(retryFailedDelivery(db,req.params.id)) }
  catch(e) { res.status(400).json({error:e.message}) }
})
router.post('/rpa/deliveries/:id/cancel', (req,res) => {
  try { res.json(cancelUnsentDelivery(db,req.params.id,req.user.email || req.user.sub)) }
  catch(e) { res.status(400).json({error:e.message}) }
})
router.get('/rpa/review', (req,res) => {try {res.json(listReviewQueue(db,req.query))} catch(e){res.status(400).json({error:e.message})}})
router.get('/rpa/review/:id', (req,res) => {try {res.json(getReviewDetail(db,req.params.id))} catch(e){res.status(404).json({error:e.message})}})
router.post('/rpa/review/:id', (req,res) => {try {res.json(correctReviewRecord(db,req.params.id,req.body,req.user.email || req.user.sub))} catch(e){res.status(400).json({error:e.message})}})
router.get('/rpa/borrower-options', (req,res) => {try {res.json(lookupBorrower(db,String(req.query.query||'')))} catch(e){res.status(400).json({error:e.message})}})
router.get('/rpa/report', (req,res) => {try {res.json(reconciliationReport(db,req.query))} catch(e){res.status(400).json({error:e.message})}})
router.post('/rpa/review/:id/approve', (req,res) => {try {res.json(approveReviewedRecord(db,req.params.id,req.body.review_version,req.user.email || req.user.sub))} catch(e){res.status(400).json({error:e.message})}})
export default router
