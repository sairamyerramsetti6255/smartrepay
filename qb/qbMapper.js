import { normalizeDate, normalizeAmount, normalizeReference, normalizeName, toQbDate } from './qbNormalize.js'

/**
 * QuickBooks Data — Template Mapper
 *
 * Maps normalized field data into the required QuickBooks JSON templates.
 * These mappers are deterministic. No AI involvement.
 *
 * Contract (do NOT silently alter):
 * {
 *   accounts_to_create: [...],
 *   payments_disbursed: [...],
 *   emi_receipts: [...]
 * }
 */

// ---------------------------------------------------------------------------
// Template 1: EMI Receipt
// ---------------------------------------------------------------------------

/**
 * Map a transaction + line items into the emi_receipts QB template.
 * @param {object} txn - qb_transactions row
 * @param {Array}  lines - qb_transaction_lines rows
 * @returns {object} emi_receipts template payload
 */
export function mapToEmiReceipt(txn, lines = []) {
  const isoDate = normalizeDate(txn.transaction_date)
  return {
    Txn_Date: isoDate ? toQbDate(isoDate) : txn.transaction_date || '',
    Deposit_To: txn.deposit_to || txn.bank_account || 'General Bank Account',
    Ref_Number: normalizeReference(txn.reference_number) || txn.id,
    Customer_Name: normalizeName(txn.customer_name).raw,
    Payment_Method: txn.payment_method || 'ACH',
    Total_Deposit_Amount: normalizeAmount(txn.amount) || 0,
    line_items: lines.map((l, idx) => ({
      Line_Account: l.account_name || 'Loans Receivable',
      Line_Amount: normalizeAmount(l.amount) || 0,
      Line_Memo: l.memo || `Payment line ${idx + 1}`,
    })),
    _meta: {
      source_id: txn.input_id,
      transaction_id: txn.id,
      template: 'emi_receipt',
      validation_status: txn.validation_status,
    },
  }
}

// ---------------------------------------------------------------------------
// Template 2: Payment Disbursed
// ---------------------------------------------------------------------------

/**
 * Map a transaction into the payments_disbursed QB template.
 * @param {object} txn - qb_transactions row
 * @returns {object} payments_disbursed template payload
 */
export function mapToPaymentDisbursed(txn) {
  const isoDate = normalizeDate(txn.transaction_date)
  return {
    Txn_Date: isoDate ? toQbDate(isoDate) : txn.transaction_date || '',
    Bank_Account: txn.bank_account || txn.deposit_to || '',
    Payee_Name: normalizeName(txn.vendor_name || txn.customer_name).raw,
    Ref_Number: normalizeReference(txn.reference_number) || txn.id,
    Total_Amount: normalizeAmount(txn.amount) || 0,
    Line_Account: txn.lines?.[0]?.account_name || 'Loans Receivable',
    line_items: (txn.lines || []).map(l => ({ Line_Account:l.account_name, Line_Amount:l.amount, Line_Memo:l.memo || '' })),
    Line_Memo: txn.payment_method || 'Loan principal disbursement',
    _meta: {
      source_id: txn.input_id,
      transaction_id: txn.id,
      template: 'payment_disbursed',
      validation_status: txn.validation_status,
    },
  }
}

// ---------------------------------------------------------------------------
// Template 3: Account to Create
// ---------------------------------------------------------------------------

/**
 * Map an account proposal into the accounts_to_create QB template.
 * @param {object} account - qb_accounts_to_create row
 * @returns {object} accounts_to_create template payload
 */
export function mapToAccountToCreate(account) {
  return {
    Account_Name: account.account_name || '',
    Account_Type: account.account_type || 'Other Current Asset',
    Account_Number: account.account_number || '',
    Sub_Account_Of: account.sub_account_of || 'Loans Receivable',
    Description: account.description || '',
    _meta: {
      account_id: account.id,
      template: 'account_to_create',
      validation_status: account.validation_status,
    },
  }
}

// ---------------------------------------------------------------------------
// Full export payload builder
// ---------------------------------------------------------------------------

/**
 * Build the complete QuickBooks export payload from approved records.
 * @param {Array} emiTxns - approved emi_receipt transactions with their lines
 * @param {Array} paymentTxns - approved payment_disbursed transactions
 * @param {Array} accounts - approved accounts_to_create records
 * @returns {object} complete QB payload
 */
export function buildQbExportPayload(emiTxns = [], paymentTxns = [], accounts = []) {
  return {
    generated_at: new Date().toISOString(),
    accounts_to_create: accounts.map(mapToAccountToCreate),
    payments_disbursed: paymentTxns.map((t) => mapToPaymentDisbursed(t)),
    emi_receipts: emiTxns.map((t) => mapToEmiReceipt(t, t.lines || [])),
  }
}
