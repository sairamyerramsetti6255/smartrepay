import { isValidDate, normalizeAmount } from './qbNormalize.js'
import { lookupBorrower } from './qbBorrowerResolver.js'

/**
 * QuickBooks Data — Deterministic Validation Engine
 *
 * AI must NOT determine financial validity.
 * These rules are pure code. No LLM calls.
 *
 * Each rule returns: { code, field, severity, status, message }
 * severity: 'INFO' | 'WARNING' | 'ERROR' | 'BLOCKING'
 * status:   'pass' | 'fail'
 */

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

function ruleQB001_referencePresent(txn) {
  const ok = !!txn.reference_number && String(txn.reference_number).trim().length > 0
  return {
    code: 'QB001',
    field: 'reference_number',
    severity: 'BLOCKING',
    status: ok ? 'pass' : 'fail',
    message: ok ? 'Reference number present' : 'Reference number is missing — required for QuickBooks posting',
  }
}

function ruleQB002_amountPositive(txn) {
  const amt = normalizeAmount(txn.amount)
  const ok = !isNaN(amt) && amt > 0
  return {
    code: 'QB002',
    field: 'amount',
    severity: 'BLOCKING',
    status: ok ? 'pass' : 'fail',
    message: ok ? `Amount is valid: ${amt}` : `Amount must be greater than 0 — got: ${txn.amount}`,
  }
}

function ruleQB003_customerNamePresent(txn) {
  const name = txn.customer_name || txn.vendor_name
  const ok = !!name && String(name).trim().length > 0
  return {
    code: 'QB003',
    field: 'customer_name',
    severity: 'BLOCKING',
    status: ok ? 'pass' : 'fail',
    message: ok ? 'Customer / payee name present' : 'Customer / payee name is missing',
  }
}

function ruleQB004_dateValid(txn) {
  const ok = isValidDate(txn.transaction_date)
  return {
    code: 'QB004',
    field: 'transaction_date',
    severity: 'BLOCKING',
    status: ok ? 'pass' : 'fail',
    message: ok ? `Date valid: ${txn.transaction_date}` : `Transaction date is invalid or missing: ${txn.transaction_date}`,
  }
}

function ruleQB005_lineTotalsMatch(txn, lines) {
  // Applies to EMI receipts and payments disbursed
  if (!['emi_receipt', 'payment_disbursed'].includes(txn.template_type)) {
    return { code: 'QB005', field: 'line_items', severity: 'INFO', status: 'pass', message: 'Line total check not applicable for this template type' }
  }
  if (!lines || lines.length === 0) {
    return { code: 'QB005', field: 'line_items', severity: 'BLOCKING', status: 'fail', message: 'Transaction has no line items' }
  }
  const lineTotal = lines.reduce((sum, l) => sum + (normalizeAmount(l.amount) || 0), 0)
  const txnTotal = normalizeAmount(txn.amount) || 0
  const diff = Math.abs(lineTotal - txnTotal)
  const ok = lines.every(l => Number.isFinite(Number(l.amount)) && Number(l.amount) > 0 && String(l.account_name || '').trim()) && lines.reduce((n,l) => n + Math.round(Number(l.amount)*100),0) === Math.round(txnTotal*100)
  return {
    code: 'QB005',
    field: 'line_items',
    severity: 'BLOCKING',
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `Line total ${lineTotal.toFixed(2)} matches total ${txnTotal.toFixed(2)}`
      : `Line total ${lineTotal.toFixed(2)} does not match total ${txnTotal.toFixed(2)} — difference: ${diff.toFixed(2)}`,
  }
}

function ruleQB006_duplicateHash(txn, existingHashes) {
  const isDupe = existingHashes && existingHashes.has(txn.transaction_hash)
  return {
    code: 'QB006',
    field: 'transaction_hash',
    severity: 'BLOCKING',
    status: isDupe ? 'fail' : 'pass',
    message: isDupe
      ? `Duplicate transaction detected — hash ${txn.transaction_hash?.slice(0, 8)}… already exists`
      : 'No duplicate detected',
  }
}

function ruleQB007_depositToPresent(txn) {
  if (txn.template_type !== 'emi_receipt') {
    return { code: 'QB007', field: 'deposit_to', severity: 'INFO', status: 'pass', message: 'Deposit_To not required for this template' }
  }
  const ok = !!txn.deposit_to && String(txn.deposit_to).trim().length > 0
  return {
    code: 'QB007',
    field: 'deposit_to',
    severity: 'ERROR',
    status: ok ? 'pass' : 'fail',
    message: ok ? `Deposit_To: ${txn.deposit_to}` : 'Deposit_To bank account is not set — required for EMI receipts',
  }
}

function ruleQB008_confidenceCheck(txn) {
  const conf = txn.ai_confidence
  if (conf == null) {
    return { code: 'QB008', field: 'ai_confidence', severity: 'INFO', status: 'pass', message: 'No AI confidence score (structured source — skipped)' }
  }
  const ok = conf >= 0.70
  return {
    code: 'QB008',
    field: 'ai_confidence',
    severity: 'WARNING',
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `AI confidence ${(conf * 100).toFixed(0)}% is acceptable`
      : `AI confidence ${(conf * 100).toFixed(0)}% is below 70% — manual review recommended`,
  }
}

function ruleQB009_borrowerMatched(txn, db = null) {
  const isReceipt = txn.template_type === 'emi_receipt'
  const isDisbursed = txn.template_type === 'payment_disbursed'
  const partyName = txn.customer_name || txn.vendor_name || ''

  if (!isReceipt && !isDisbursed) {
    return {
      code: 'QB009',
      field: 'borrower_id',
      severity: 'INFO',
      status: 'pass',
      message: 'Borrower matching not applicable for this template type',
    }
  }

  if (db && (partyName || txn.borrower_id)) {
    const lookup = lookupBorrower(db, partyName, txn.amount, txn.borrower_id)
    if (lookup.top_match) {
      const top = lookup.top_match
      if (txn.borrower_id && String(txn.borrower_id).trim()) {
        const provId = String(txn.borrower_id).trim().toLowerCase()
        const topBId = String(top.borrower_id || '').toLowerCase()
        const topLdId = String(top.loandisk_id || '').toLowerCase()
        const topLoanId = String(top.loan_id || '').toLowerCase()
        const isMatch = provId === topBId || provId === topLdId || provId === topLoanId
        if (!isMatch) {
          return {
            code: 'QB009',
            field: 'borrower_id',
            severity: 'WARNING',
            status: 'fail',
            message: `Provided Borrower ID (${txn.borrower_id}) does not match LoanDisk borrower ${top.full_name} (${top.loandisk_id || top.borrower_id})`,
          }
        }
      }
      return {
        code: 'QB009',
        field: 'borrower_id',
        severity: 'INFO',
        status: 'pass',
        message: `Borrower matched in LoanDisk: ${top.full_name} (ID: ${top.loandisk_id || top.borrower_id}, Name score: ${top.score}%)`,
      }
    } else if (lookup.match_count > 1) {
      return {
        code: 'QB009',
        field: 'borrower_id',
        severity: 'WARNING',
        status: 'fail',
        message: `Multiple candidate borrowers found in LoanDisk for "${partyName}" (${lookup.match_count} matches) — manual review required`,
      }
    } else {
      if (isDisbursed && !txn.borrower_id) {
        return {
          code: 'QB009',
          field: 'borrower_id',
          severity: 'INFO',
          status: 'pass',
          message: 'Payee not linked to LoanDisk borrower (standard disbursement / vendor payment)',
        }
      }
      return {
        code: 'QB009',
        field: 'borrower_id',
        severity: 'WARNING',
        status: 'fail',
        message: `Borrower "${partyName || txn.borrower_id}" not found in LoanDisk active borrowers list — manual review required`,
      }
    }
  }

  if (isDisbursed && !txn.borrower_id) {
    return {
      code: 'QB009',
      field: 'borrower_id',
      severity: 'INFO',
      status: 'pass',
      message: 'Payee not linked to LoanDisk borrower (standard disbursement / vendor payment)',
    }
  }

  const ok = !!txn.borrower_id && String(txn.borrower_id).trim().length > 0
  return {
    code: 'QB009',
    field: 'borrower_id',
    severity: ok ? 'INFO' : 'WARNING',
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `Borrower matched in LoanDisk: ${txn.borrower_id}`
      : `Borrower ${partyName ? `"${partyName}" ` : ''}not found in LoanDisk active borrowers list — manual review required`,
  }
}

function ruleQB010_bankAccountForPayment(txn) {
  if (txn.template_type !== 'payment_disbursed') {
    return { code: 'QB010', field: 'bank_account', severity: 'INFO', status: 'pass', message: 'Bank account check not applicable for this template' }
  }
  const ok = !!txn.bank_account && String(txn.bank_account).trim().length > 0
  return {
    code: 'QB010',
    field: 'bank_account',
    severity: 'BLOCKING',
    status: ok ? 'pass' : 'fail',
    message: ok ? `Bank account: ${txn.bank_account}` : 'Bank account (Payee bank) is required for payment disbursement',
  }
}

function ruleQB011_emiAmountValidation(txn, db = null) {
  const isReceipt = txn.template_type === 'emi_receipt'
  const isDisbursed = txn.template_type === 'payment_disbursed'
  const partyName = txn.customer_name || txn.vendor_name || ''
  const amt = normalizeAmount(txn.amount)

  if (!isReceipt && !isDisbursed) {
    return {
      code: 'QB011',
      field: 'amount',
      severity: 'INFO',
      status: 'pass',
      message: 'EMI amount validation not applicable for this template type',
    }
  }

  if (db && (partyName || txn.borrower_id) && !isNaN(amt) && amt > 0) {
    const lookup = lookupBorrower(db, partyName, amt, txn.borrower_id)
    if (lookup.top_match && lookup.top_match.expected_emi != null && lookup.top_match.expected_emi > 0) {
      const exp = lookup.top_match.expected_emi
      const diff = Math.round(Math.abs(amt - exp) * 100) / 100
      const status = lookup.top_match.emi_match_status
      if (status === 'exact_emi' || diff <= 0.05) {
        return {
          code: 'QB011',
          field: 'amount',
          severity: 'INFO',
          status: 'pass',
          message: `Amount $${amt.toFixed(2)} matches expected EMI $${exp.toFixed(2)} in LoanDisk`,
        }
      } else if (status === 'multiple_emi') {
        return {
          code: 'QB011',
          field: 'amount',
          severity: 'INFO',
          status: 'pass',
          message: `Amount $${amt.toFixed(2)} matches ${lookup.top_match.emi_multiple}x expected EMIs ($${exp.toFixed(2)} each)`,
        }
      } else if (status === 'fraction_emi') {
        return {
          code: 'QB011',
          field: 'amount',
          severity: 'INFO',
          status: 'pass',
          message: `Amount $${amt.toFixed(2)} matches installment fraction of expected EMI $${exp.toFixed(2)}`,
        }
      } else {
        return {
          code: 'QB011',
          field: 'amount',
          severity: 'WARNING',
          status: 'fail',
          message: `Amount $${amt.toFixed(2)} differs from expected EMI $${exp.toFixed(2)} (diff: $${(amt - exp).toFixed(2)}) — review recommended`,
        }
      }
    }
  }

  return {
    code: 'QB011',
    field: 'amount',
    severity: 'INFO',
    status: 'pass',
    message: 'EMI amount recorded',
  }
}

// ---------------------------------------------------------------------------
// Run all rules for a transaction
// ---------------------------------------------------------------------------

/**
 * Validate a transaction record.
 * @param {object} txn - qb_transactions row
 * @param {Array}  lines - qb_transaction_lines rows
 * @param {Set}    existingHashes - Set of known hashes (for duplicate check)
 * @param {object} db - SQLite database (optional, for live LoanDisk validation)
 * @returns {{ results: Array, overallStatus: string }}
 */
export function validateTransaction(txn, lines = [], existingHashes = new Set(), db = null) {
  const results = [
    ruleQB001_referencePresent(txn),
    ruleQB002_amountPositive(txn),
    ruleQB003_customerNamePresent(txn),
    ruleQB004_dateValid(txn),
    ruleQB005_lineTotalsMatch(txn, lines),
    ruleQB006_duplicateHash(txn, existingHashes),
    ruleQB007_depositToPresent(txn),
    ruleQB008_confidenceCheck(txn),
    ruleQB009_borrowerMatched(txn, db),
    ruleQB010_bankAccountForPayment(txn),
    ruleQB011_emiAmountValidation(txn, db),
  ]

  const blockingFail = results.some((r) => r.severity === 'BLOCKING' && r.status === 'fail')
  const errorFail = results.some((r) => r.severity === 'ERROR' && r.status === 'fail')
  const warnFail = results.some((r) => r.severity === 'WARNING' && r.status === 'fail')
  const isDuplicate = results.find((r) => r.code === 'QB006')?.status === 'fail'

  let overallStatus
  if (isDuplicate) {
    overallStatus = 'duplicate'
  } else if (blockingFail) {
    overallStatus = 'invalid'
  } else if (errorFail || warnFail) {
    overallStatus = 'needs_review'
  } else {
    overallStatus = 'valid'
  }

  return { results, overallStatus }
}

