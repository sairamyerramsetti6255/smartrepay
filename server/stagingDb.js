import path from 'path'
import { crif } from './crifClient.js'
import { resolveParticularsFields } from './particularsParse.js'

/**
 * Call the dynamic dispatcher stored procedure dbo.CRIF_Operations over HTTP
 * (meanhost API gateway) — see crifClient.js for why we no longer open a direct
 * mssql connection. Returns the recordset (rows include Result/Message markers).
 */
async function execCrif(json, condition, type = '') {
  return crif(json, condition, type)
}

const NAME_STOP_WORDS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'the', 'jr', 'sr', 'ii', 'iii', 'iv',
])

/** Sorted-token key so "Russell, Calvin" and "Calvin Russell" match. */
function normalizeNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && t.length > 1 && !NAME_STOP_WORDS.has(t))
    .sort()
    .join(' ')
}

/** Append the current HHMM so each import lands under its own file name. */
export function uniqueFileName(originalName) {
  const now = new Date()
  const hhmm =
    String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0')
  const ext = path.extname(originalName || '')
  const base = path.basename(originalName || 'upload', ext)
  return `${base}_${hhmm}${ext}`
}

function toDateOrNull(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function toAmountOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

function dateKey(value) {
  const d = value instanceof Date ? value : toDateOrNull(value)
  return d ? d.toISOString().slice(0, 10) : ''
}

/**
 * Content signature used to detect duplicate credit rows across uploads.
 * Two rows are the "same transaction" when their date, reference, borrower
 * (normalized) and amount all match — regardless of file name / upload time.
 */
function transactionSignature({ transDate, referenceNo, normalizedName, amount }) {
  return [
    dateKey(transDate),
    String(referenceNo || '').trim().toLowerCase(),
    String(normalizedName || '').trim().toLowerCase(),
    amount == null ? '' : Number(amount).toFixed(2),
  ].join('|')
}

/**
 * Compute the dedup signature for a parser "rich" row (same field handling as
 * the staging insert) so the parse preview and the actual insert agree.
 */
function signatureForParsedRow(r) {
  const borrowerName = r.borrowerName || r.name || r.payer || null
  const transDate = (() => {
    const d = toDateOrNull(r.transDate || r.date || r.valueDate || r.datePosted)
    return d ? d.toISOString().slice(0, 10) : null
  })()
  const referenceNo =
    r.referenceNo || r.reference ? String(r.referenceNo || r.reference).slice(0, 100) : null
  const normalizedName = normalizeNameKey(borrowerName).slice(0, 255) || null
  const amount = toAmountOrNull(r.emiPaidAmount ?? r.amount ?? r.creditAmount)
  return transactionSignature({ transDate, referenceNo, normalizedName, amount })
}

/**
 * Flag which parsed rows are duplicates — against what is already staged in SQL
 * Server (Staging_BankTransactions) AND against earlier rows in the same batch.
 * Returns a boolean[] aligned to `records`. If SQL is empty, nothing is flagged.
 */
export async function flagDuplicateRows(records) {
  const rows = Array.isArray(records) ? records : []
  if (!rows.length) return []
  const seen = await loadExistingSignatures()
  return rows.map((r) => {
    const sig = signatureForParsedRow(r)
    if (seen.has(sig)) return true
    seen.add(sig)
    return false
  })
}

/** Load signatures already present in the table so re-uploads can skip them. */
async function loadExistingSignatures() {
  const rows = await execCrif('{}', 'Get_BankTransactions')
  const set = new Set()
  for (const row of rows) {
    set.add(
      transactionSignature({
        transDate: row.TransDate,
        referenceNo: row.ReferenceNo,
        normalizedName: row.NormalizedName,
        amount: row.EmiPaidAmount,
      })
    )
  }
  return set
}

/**
 * Bulk insert parsed credit rows into Staging_BankTransactions.
 *
 * `records` are the rich rows produced by the statement parser. Existing rows
 * (and repeats within this batch) are skipped using a content signature, so we
 * only stage genuinely new transactions to match. Returns
 * `{ inserted, skipped, total }`.
 */
export async function insertBankTransactions(records, { fileName, uploadedDate } = {}) {
  const rows = Array.isArray(records) ? records : []
  if (!rows.length) return { inserted: 0, skipped: 0, total: 0 }

  const uploaded = (uploadedDate ? new Date(uploadedDate) : new Date()).toISOString()
  const fileType = (path.extname(fileName || '').replace('.', '') || null)
  const isoDate = (v) => {
    const d = toDateOrNull(v)
    return d ? d.toISOString().slice(0, 10) : null
  }

  // Build prepared rows (proc JSON shape) + their dedup signatures.
  const prepared = rows.map((r) => {
    const particulars = (r.particulars || r.description || '') || null
    const parsed = resolveParticularsFields({
      particulars,
      borrowerName: r.borrowerName || r.name || r.payer,
    })
    const borrowerName = parsed.borrowerName || null
    const sourceType = r.sourceType || r.documentType || (r.employer ? 'employer' : 'bank')
    const employerOrBank =
      r.employerOrBank || r.employer || (sourceType === 'bank' ? r.bank || null : null)
    const transDate = isoDate(r.transDate || r.date || r.valueDate || r.datePosted)
    const referenceNo =
      r.referenceNo || r.reference ? String(r.referenceNo || r.reference).slice(0, 100) : null
    const normalizedName = normalizeNameKey(borrowerName).slice(0, 255) || null
    const amount = toAmountOrNull(r.emiPaidAmount ?? r.amount ?? r.creditAmount)

    return {
      row: {
        FileName: fileName,
        FileType: fileType,
        SourceType: sourceType ? String(sourceType).slice(0, 20) : null,
        EmployerOrBank: employerOrBank ? String(employerOrBank).slice(0, 255) : null,
        TransDate: transDate,
        ReferenceNo: referenceNo,
        Particulars: particulars ? String(particulars).slice(0, 500) : null,
        BorrowerName: borrowerName ? String(borrowerName).slice(0, 255) : null,
        NormalizedName: normalizedName,
        EmiPaidAmount: amount,
        UploadedDate: uploaded,
      },
      signature: signatureForParsedRow(r),
    }
  })

  const seen = await loadExistingSignatures()

  const toInsert = []
  let skipped = 0
  for (const p of prepared) {
    if (seen.has(p.signature)) {
      skipped += 1
      continue
    }
    seen.add(p.signature)
    toInsert.push(p.row)
  }

  // Write the new rows through CRIF_Operations / Save_BankTransactions.
  for (let i = 0; i < toInsert.length; i += 500) {
    await execCrif(toInsert.slice(i, i + 500), 'Save_BankTransactions')
  }

  return { inserted: toInsert.length, skipped, total: prepared.length }
}

/**
 * Active loans for the "Active Loans" screen — read straight from the LoanDisk
 * due-records staging table. Optional server-side search across name / loan no.
 * / borrower id / branch.
 */
export async function getActiveLoans({ search = '', limit = 10000 } = {}) {
  const rows = await execCrif('{}', 'Get_LoandiskDueRecords')
  const q = String(search || '').trim().toLowerCase()
  const max = Math.min(Number(limit) || 10000, 20000)
  const filtered = !q
    ? rows
    : rows.filter((r) =>
        [r.BorrowerFullName, r.LoanNumber, r.BorrowerId, r.BranchName].some((v) =>
          String(v ?? '').toLowerCase().includes(q)
        )
      )
  return filtered.slice(0, max)
}

/** Staged bank/payroll credit transactions (for the Upload Documents grid). */
export async function getBankTransactions({ search = '' } = {}) {
  const rows = await execCrif('{}', 'Get_BankTransactions')
  const shaped = rows.map((r) => {
    const parsed = resolveParticularsFields({
      particulars: r.Particulars,
      borrowerName: r.BorrowerName,
    })
    return {
      ...r,
      TransactionDescription: parsed.description || null,
      BorrowerName: parsed.borrowerName || r.BorrowerName || null,
    }
  })
  const q = String(search || '').trim().toLowerCase()
  if (!q) return shaped
  return shaped.filter((r) =>
    [r.BorrowerName, r.TransactionDescription, r.Particulars, r.FileName, r.EmployerOrBank, r.ReferenceNo]
      .some((v) => String(v ?? '').toLowerCase().includes(q))
  )
}

/** Map the SQL ReviewStatus to the UI status vocabulary. */
function reviewStatusToUi(rs) {
  if (rs === 'auto_matched' || rs === 'confirmed') return 'matched'
  if (rs === 'unmatched') return 'exception' // processed by a run, no match found
  if (rs === 'needs_review') return 'pending'
  return 'pending' // null / no match row yet => not matched yet (PENDING, not unmatched)
}

function shapeMatchRow(r) {
  const parsed = resolveParticularsFields({
    particulars: r.Particulars,
    borrowerName: r.BorrowerName,
  })
  return {
    id: String(r.Id),
    bank_transaction_id: r.Id,
    date: r.TransDate,
    payer: parsed.borrowerName || r.BorrowerName || null,
    transaction_description: parsed.description || null,
    amount: r.EmiPaidAmount != null ? Number(r.EmiPaidAmount) : null,
    reference: r.ReferenceNo,
    description: r.Particulars,
    source_filename: r.FileName,
    source_type: r.SourceType,
    employer_or_bank: r.EmployerOrBank,
    status: reviewStatusToUi(r.ReviewStatus),
    review_status: r.ReviewStatus || null,
    confidence_score: r.ConfidenceScore != null ? Number(r.ConfidenceScore) : null,
    matched_borrower_id: r.BorrowerId || null,
    matched_borrower_name: r.LoanDiskBorrowerName || null,
    borrower_loandisk_id: r.BorrowerId || null,
    loan_number: r.LoanNumber || null,
    matched_loan_numbers: r.MatchedLoanNumbers || null,
    loan_count: r.LoanCount != null ? Number(r.LoanCount) : null,
    summed_expected_emi: r.SummedExpectedEMI != null ? Number(r.SummedExpectedEMI) : null,
    amount_diff: r.AmountDiff != null ? Number(r.AmountDiff) : null,
    match_type: r.MatchType || null,
    amount_match_kind: r.AmountMatchKind || null,
    name_score: r.NameScore != null ? Number(r.NameScore) : null,
    match_method: r.MatchMethod || null,
    reasoning: r.Reasoning || null,
  }
}

/**
 * Match results read straight from SQL Server: every staged bank credit joined
 * to its (optional) match row. This is the single source of truth for the Match
 * screen — truncating the staging tables empties the screen.
 */
export async function getSqlMatchResults({ search = '' } = {}) {
  const rows = await execCrif('{}', 'Get_TransactionMatches')
  const q = String(search || '').trim().toLowerCase()
  const filtered = !q
    ? rows
    : rows.filter((r) =>
        [r.BorrowerName, r.FileName, r.ReferenceNo, r.LoanDiskBorrowerName]
          .some((v) => String(v ?? '').toLowerCase().includes(q))
      )

  const transactions = filtered.map(shapeMatchRow)
  const counts = transactions.reduce(
    (acc, t) => {
      acc.total += 1
      if (t.status === 'matched') acc.matched += 1
      else if (t.status === 'pending') acc.pending += 1
      else acc.unmatched += 1
      return acc
    },
    { total: 0, matched: 0, pending: 0, unmatched: 0 }
  )
  counts.matchedPct = counts.total ? Math.round((counts.matched / counts.total) * 100) : 0
  counts.unmatchedPct = counts.total ? Math.round((counts.unmatched / counts.total) * 100) : 0
  return { transactions, counts }
}

/** Confirm / reject / reassign a single bank transaction's match in SQL. */
export async function updateSqlMatchReview({
  bankTransactionId,
  reviewStatus,
  borrowerId = null,
  borrowerName = null,
  loanNumber = null,
  confidence = null,
}) {
  await execCrif(
    {
      BankTransactionId: Number(bankTransactionId),
      ReviewStatus: reviewStatus,
      BorrowerId: borrowerId,
      BorrowerName: borrowerName,
      LoanNumber: loanNumber,
      Confidence: confidence,
    },
    'Update_MatchReview'
  )
  return true
}

/** Lightweight counts for dashboard tiles (via CRIF_Operations / Get_MatchSummary). */
export async function getStagingCounts() {
  const rows = await execCrif('{}', 'Get_MatchSummary')
  const r = rows[0] || {}
  return {
    activeLoans: r.ActiveLoans ?? 0,
    bankTransactions: r.TotalTransactions ?? 0,
    matched: r.Matched ?? 0,
    unmatched: r.Unmatched ?? 0,
    pending: r.Pending ?? 0,
  }
}

function isoDay(d) {
  return d.toISOString().slice(0, 10)
}

function bump(map, key, n = 1) {
  const k = key || 'unknown'
  map[k] = (map[k] || 0) + n
}

function mapToSortedList(map, labelKey = 'name') {
  return Object.entries(map)
    .map(([name, count]) => ({ [labelKey]: name, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Reconciliation dashboard stats — matching + receipts + imports only.
 * No active-loan book figures (balances, borrowers, EMI totals).
 */
export async function getDashboardStats() {
  const [summaryRows, matchResult, documents, receipts] = await Promise.all([
    execCrif('{}', 'Get_MatchSummary'),
    getSqlMatchResults(),
    getDocuments(),
    getManualReceipts(),
  ])

  const s = summaryRows[0] || {}
  const stagedCredits = s.TotalTransactions ?? 0
  const matched = s.Matched ?? 0
  const unmatched = s.Unmatched ?? 0
  const pending = s.Pending ?? 0
  const processed = matched + unmatched
  const matchRate = processed ? Math.round((matched / processed) * 100) : 0

  const byReviewStatus = {}
  const bySourceType = {}
  const byMatchMethod = {}
  const byMatchType = {}
  let autoMatched = 0
  let confirmed = 0
  let needsReview = 0

  for (const t of matchResult.transactions) {
    const rs = t.review_status || 'pending'
    bump(byReviewStatus, rs)
    bump(bySourceType, t.source_type)
    if (t.match_method) bump(byMatchMethod, t.match_method)
    if (t.match_type) bump(byMatchType, t.match_type)
    if (rs === 'auto_matched') autoMatched += 1
    if (rs === 'confirmed') confirmed += 1
    if (rs === 'needs_review') needsReview += 1
  }

  const today = isoDay(new Date())
  const weekStart = isoDay(new Date(Date.now() - 6 * 86400000))
  const dailyMap = new Map()
  for (let i = 6; i >= 0; i--) {
    const d = isoDay(new Date(Date.now() - i * 86400000))
    dailyMap.set(d, { date: d, staged: 0, matched: 0, unmatched: 0, receipts: 0 })
  }

  for (const t of matchResult.transactions) {
    const day = t.date ? String(t.date).slice(0, 10) : null
    if (!day || !dailyMap.has(day)) continue
    const row = dailyMap.get(day)
    row.staged += 1
    if (t.status === 'matched') row.matched += 1
    else if (t.status === 'exception') row.unmatched += 1
  }

  const byFileSource = {}
  let filesWithUnmatched = 0
  let filesFullyMatched = 0
  let totalImportedRows = 0
  for (const d of documents) {
    bump(byFileSource, d.source_type || d.document_type)
    totalImportedRows += d.total_rows ?? 0
    if ((d.unmatched_count ?? 0) > 0) filesWithUnmatched += 1
    if ((d.total_rows ?? 0) > 0 && (d.unmatched_count ?? 0) === 0 && (d.matched_count ?? 0) > 0) {
      filesFullyMatched += 1
    }
  }

  const byReceiptChannel = {}
  let receiptsToday = 0
  let receiptsThisWeek = 0
  let receiptsWithAttachment = 0
  for (const r of receipts) {
    bump(byReceiptChannel, r.sourceChannel)
    const day = (r.collectedDate || r.createdAt || '').slice(0, 10)
    if (day === today) receiptsToday += 1
    if (day && day >= weekStart) receiptsThisWeek += 1
    if (r.receiptDocumentId || r.receiptFileName) receiptsWithAttachment += 1
    if (day && dailyMap.has(day)) dailyMap.get(day).receipts += 1
  }

  const importFiles = documents
    .map((d) => ({
      filename: d.filename,
      sourceType: d.source_type || d.document_type || 'unknown',
      totalRows: d.total_rows ?? 0,
      matchedCount: d.matched_count ?? 0,
      unmatchedCount: d.unmatched_count ?? 0,
      pendingCount: Math.max(0, (d.total_rows ?? 0) - (d.matched_count ?? 0) - (d.unmatched_count ?? 0)),
    }))
    .sort((a, b) => b.unmatchedCount - a.unmatchedCount || b.totalRows - a.totalRows)
    .slice(0, 8)

  return {
    matching: {
      stagedCredits,
      matched,
      unmatched,
      pending,
      processed,
      matchRate,
      autoMatched,
      confirmed,
      needsReview,
      byReviewStatus: mapToSortedList(byReviewStatus, 'status'),
      bySourceType: mapToSortedList(bySourceType, 'source'),
      byMatchMethod: mapToSortedList(byMatchMethod, 'method'),
      byMatchType: mapToSortedList(byMatchType, 'type'),
    },
    imports: {
      totalFiles: documents.length,
      totalRows: totalImportedRows,
      filesWithUnmatched,
      filesFullyMatched,
      bySourceType: mapToSortedList(byFileSource, 'source'),
      recentFiles: importFiles,
    },
    receipts: {
      total: receipts.length,
      today: receiptsToday,
      thisWeek: receiptsThisWeek,
      withAttachment: receiptsWithAttachment,
      byChannel: mapToSortedList(byReceiptChannel, 'channel'),
    },
    pipeline: {
      importedFiles: documents.length,
      stagedCredits,
      processed,
      matched,
      unmatched,
      pending,
      manualReceipts: receipts.length,
    },
    activity: {
      daily: [...dailyMap.values()],
    },
  }
}

/** Uploaded-document list derived purely from staged credits in SQL Server. */
export async function getDocuments() {
  const rows = await execCrif('{}', 'Get_Documents')
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    document_type: r.document_type || null,
    source_type: r.source_type || null,
    employer_or_bank: r.employer_or_bank || null,
    date_from: r.date_from || null,
    date_to: r.date_to || null,
    total_rows: r.total_rows ?? 0,
    matched_count: r.matched_count ?? 0,
    unmatched_count: r.unmatched_count ?? 0,
    created_at: r.created_at || null,
  }))
}

/** Cascade-delete a file's staged credits (and their matches) from SQL Server. */
export async function deleteDocument(fileName) {
  const rows = await execCrif({ FileName: fileName }, 'Delete_Documents')
  return rows[0]?.Deleted ?? 0
}

const RECEIPT_SOURCES = new Set(['walkin', 'whatsapp', 'email', 'phone'])

export function isValidReceiptSource(source) {
  return RECEIPT_SOURCES.has(String(source || '').trim().toLowerCase())
}

function shapeLoanForReceipt(r) {
  const emi = r.ExpectedEMIAmount != null ? Number(r.ExpectedEMIAmount) : null
  const totalPaid = r.TotalPaid != null ? Number(r.TotalPaid) : 0
  const installmentsPaid =
    r.InstallmentsPaid != null
      ? Number(r.InstallmentsPaid)
      : emi && emi > 0
        ? Math.floor(totalPaid / emi)
        : 0

  return {
    loanNumber: String(r.LoanNumber ?? ''),
    borrowerId: String(r.BorrowerId ?? ''),
    borrowerName: r.BorrowerFullName ?? null,
    principalAmount: r.PrincipalAmount != null ? Number(r.PrincipalAmount) : null,
    disbursedAmount:
      r.DisbursedAmount != null
        ? Number(r.DisbursedAmount)
        : r.TotalLoanAmount != null
          ? Number(r.TotalLoanAmount)
          : r.PrincipalAmount != null
            ? Number(r.PrincipalAmount)
            : null,
    disbursedDate: r.DisbursedDate ?? r.ReleasedDate ?? null,
    emiAmount: emi,
    totalDue: r.TotalDue != null ? Number(r.TotalDue) : null,
    totalPaid,
    totalInstallments: r.TotalInstallments != null ? Number(r.TotalInstallments) : r.NumOfRepayments ?? null,
    installmentsPaid,
    lastEmiPaidDate: r.EMILastPaidDate ?? null,
    loanBalance: r.LoanBalanceAmount != null ? Number(r.LoanBalanceAmount) : null,
    branchId: r.BranchId ?? null,
    branchName: r.BranchName ?? null,
    loanStatus: r.LoanStatus ?? null,
  }
}

function fallbackLoansByBorrowerId(borrowerId) {
  return getActiveLoans({ search: borrowerId, limit: 500 }).then((rows) =>
    rows
      .filter((r) => String(r.BorrowerId ?? '') === String(borrowerId))
      .map(shapeLoanForReceipt)
  )
}

/** Search borrowers by name (or ID) from active-loan staging — one row per borrower. */
export async function searchBorrowersForReceipts({ search = '', limit = 30 } = {}) {
  const q = String(search || '').trim()
  if (q.length < 2) return []

  const rows = await getActiveLoans({ search: q, limit: 10000 })
  const map = new Map()

  for (const r of rows) {
    const id = String(r.BorrowerId ?? '').trim()
    if (!id) continue
    const name = String(r.BorrowerFullName || '').trim() || `Borrower ${id}`
    if (!map.has(id)) {
      map.set(id, {
        borrowerId: id,
        borrowerName: name,
        branchName: r.BranchName ?? null,
        loanCount: 0,
      })
    }
    map.get(id).loanCount += 1
  }

  return [...map.values()]
    .sort((a, b) => a.borrowerName.localeCompare(b.borrowerName))
    .slice(0, Math.min(Number(limit) || 30, 50))
}

/** Active loans for a borrower (SILLoans via CRIF, staging fallback). */
export async function getLoansByBorrowerId(borrowerId) {
  const id = String(borrowerId || '').trim()
  if (!id) return []

  try {
    const rows = await execCrif({ BorrowerId: id }, 'Get_LoansByBorrowerId')
    if (rows?.length) return rows.map(shapeLoanForReceipt)
  } catch {
    /* fall through to staging */
  }

  return fallbackLoansByBorrowerId(id)
}

/** Persist a manual receipt to staging + SILloanrepayments. */
export async function saveManualReceipt(payload) {
  const source = String(payload.sourceChannel || '').trim().toLowerCase()
  if (!isValidReceiptSource(source)) {
    throw new Error('Source must be walkin, whatsapp, email, or phone')
  }

  const amount = Number(payload.amountReceived)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount received must be a positive number')
  }

  const row = {
    BorrowerId: String(payload.borrowerId || '').trim(),
    LoanNumber: String(payload.loanNumber || '').trim(),
    BranchId: payload.branchId ?? null,
    BorrowerFullName: payload.borrowerName ?? null,
    AmountReceived: amount,
    Particulars: String(payload.particulars || '').trim() || null,
    SourceChannel: source,
    EntryType: 'manual',
    CollectedDate: payload.collectedDate || new Date().toISOString().slice(0, 10),
    ReceiptFileName: payload.receiptFileName ?? null,
    ReceiptDocumentId: payload.receiptDocumentId ?? null,
    EnteredBy: payload.enteredBy ?? null,
  }

  if (!row.BorrowerId) throw new Error('Borrower ID is required')
  if (!row.LoanNumber) throw new Error('Loan is required')

  const result = await execCrif([row], 'Save_ManualReceipt')
  return result[0] || { Inserted: 1 }
}

/**
 * Unified repayment ledger for one loan: synced LoanDisk repayments + manual
 * receipts entered in SmartRepay (newest first). Returns rows plus an analysis
 * summary so the UI can render detailed analytics without a second round-trip.
 */
export async function getLoanRepayments(loanNumber) {
  const loan = String(loanNumber || '').trim()
  if (!loan) return { rows: [], summary: emptyRepaymentSummary() }

  let raw = []
  try {
    raw = await execCrif({ LoanNumber: loan }, 'Get_LoanRepayments')
  } catch {
    raw = []
  }

  const rows = raw
    .filter((r) => r.EntryId != null || r.Amount != null)
    .map((r) => ({
      entryId: r.EntryId != null ? String(r.EntryId) : null,
      source: r.Source || 'loandisk',
      loanNumber: r.LoanNumber != null ? String(r.LoanNumber) : loan,
      branchId: r.BranchId ?? null,
      branchName: r.BranchName ?? null,
      date: r.RepaymentDate ?? r.RepaymentDateRaw ?? null,
      amount: r.Amount != null ? Number(r.Amount) : null,
      principalAmount: r.PrincipalAmount != null ? Number(r.PrincipalAmount) : null,
      interestAmount: r.InterestAmount != null ? Number(r.InterestAmount) : null,
      feesAmount: r.FeesAmount != null ? Number(r.FeesAmount) : null,
      penaltyAmount: r.PenaltyAmount != null ? Number(r.PenaltyAmount) : null,
      method: r.Method ?? null,
      description: r.Description ?? null,
      sourceChannel: r.SourceChannel ?? null,
      particulars: r.Particulars ?? null,
      receiptFileName: r.ReceiptFileName ?? null,
      receiptDocumentId: r.ReceiptDocumentId ?? null,
      enteredBy: r.EnteredBy ?? null,
      createdAt: r.CreatedAt ?? null,
    }))

  return { rows, summary: summarizeRepayments(rows) }
}

function emptyRepaymentSummary() {
  return {
    totalPaid: 0,
    paymentCount: 0,
    manualCount: 0,
    syncedCount: 0,
    manualTotal: 0,
    syncedTotal: 0,
    principalPaid: 0,
    interestPaid: 0,
    feesPaid: 0,
    penaltyPaid: 0,
    firstPaymentDate: null,
    lastPaymentDate: null,
    averagePayment: 0,
  }
}

function summarizeRepayments(rows) {
  const s = emptyRepaymentSummary()
  for (const r of rows) {
    const amt = Number(r.amount) || 0
    s.totalPaid += amt
    s.paymentCount += 1
    if (r.source === 'manual') {
      s.manualCount += 1
      s.manualTotal += amt
    } else {
      s.syncedCount += 1
      s.syncedTotal += amt
    }
    s.principalPaid += Number(r.principalAmount) || 0
    s.interestPaid += Number(r.interestAmount) || 0
    s.feesPaid += Number(r.feesAmount) || 0
    s.penaltyPaid += Number(r.penaltyAmount) || 0
    const d = r.date ? String(r.date).slice(0, 10) : null
    if (d) {
      if (!s.firstPaymentDate || d < s.firstPaymentDate) s.firstPaymentDate = d
      if (!s.lastPaymentDate || d > s.lastPaymentDate) s.lastPaymentDate = d
    }
  }
  s.averagePayment = s.paymentCount ? Math.round((s.totalPaid / s.paymentCount) * 100) / 100 : 0
  return s
}

/** List manual receipts (newest first). */
export async function getManualReceipts() {
  try {
    const rows = await execCrif('{}', 'Get_ManualReceipts')
    return rows.map((r) => ({
      id: r.Id,
      borrowerId: r.BorrowerId,
      loanNumber: r.LoanNumber,
      branchId: r.BranchId,
      borrowerName: r.BorrowerFullName,
      amountReceived: r.AmountReceived != null ? Number(r.AmountReceived) : null,
      particulars: r.Particulars,
      sourceChannel: r.SourceChannel,
      entryType: r.EntryType,
      collectedDate: r.CollectedDate,
      receiptFileName: r.ReceiptFileName,
      receiptDocumentId: r.ReceiptDocumentId,
      enteredBy: r.EnteredBy,
      createdAt: r.CreatedAt,
    }))
  } catch {
    return []
  }
}
