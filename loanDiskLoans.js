import { randomUUID } from 'crypto'

function pickField(row, ...keys) {
  for (const key of keys) {
    const val = row?.[key]
    if (val !== undefined && val !== null && String(val).trim() !== '') return val
  }
  return null
}

function isSuccessCode(code) {
  return code === 1 || code === 'SUCCESS' || code === 'success'
}

function flattenLoanRows(node, out = []) {
  if (!node) return out
  if (Array.isArray(node)) {
    for (const item of node) flattenLoanRows(item, out)
    return out
  }
  if (typeof node !== 'object') return out

  const loanId = pickField(node, 'loan_id', 'loanId', 'LoanId', 'id')
  let emi = pickField(
    node,
    'loan_installment_amount',
    'monthly_repayment',
    'monthly_repayment_amount',
    'emi_amount',
    'installment_amount',
    'RepaymentAmount',
    'MonthlyRepayment',
    'LoanRepaymentAmount',
    'InstallmentAmount',
    'emi',
    'EMI'
  )
  const principal = pickField(
    node,
    'loan_principal_amount',
    'loan_amount',
    'principal_amount',
    'loan_principal',
    'LoanAmount',
    'LoanPrincipalAmount'
  )
  const balance = pickField(
    node,
    'loan_balance',
    'outstanding_balance',
    'balance',
    'loan_outstanding',
    'BalanceAmount',
    'PendingDue',
    'PrincipalBalanceAmount'
  )
  const loanNumber = pickField(
    node,
    'loan_unique_number',
    'loan_number',
    'loanNumber',
    'LoanApplicationId',
    'unique_number',
    'borrower_unique_number'
  )
  const status = pickField(node, 'loan_status', 'status', 'Status') || 'active'

  if (emi == null) {
    const totalDue = pickField(node, 'TotalAmountDue', 'total_amount_due')
    const repayments = pickField(node, 'LoanNumOfRepayments', 'loan_num_of_repayments', 'LoanDuration', 'loan_duration')
    if (totalDue != null && repayments != null && Number(repayments) > 0) {
      emi = Math.round((Number(totalDue) / Number(repayments)) * 100) / 100
    }
  }

  if (loanId || emi || principal || loanNumber) {
    out.push({
      loandisk_loan_id: loanId ? String(loanId) : null,
      loan_number: loanNumber ? String(loanNumber) : loanId ? String(loanId) : null,
      emi: emi != null ? Number(emi) : null,
      outstanding_balance: balance != null ? Number(balance) : principal != null ? Number(principal) : null,
      status: String(status).toLowerCase(),
      raw: node,
    })
  }

  for (const key of ['loans', 'Loans', 'loan_list', 'active_loans', 'results', 'Results']) {
    if (node[key]) flattenLoanRows(node[key], out)
  }
  return out
}

/** Parse OperationsNewForId payload — borrower row passed in after normalization. */
export function parseOperationsLoanRows(data, borrowerId, normalizedBorrower = null) {
  if (data.code !== undefined && !isSuccessCode(data.code)) {
    throw new Error(data.message || data.title || 'OperationsNewForId failed')
  }

  const doc = data.document
  const root = Array.isArray(doc) ? doc[0] : doc
  const borrowerRow =
    root?.borrower ||
    root?.Borrower ||
    root?.data?.response?.Results?.[0]?.[0] ||
    root?.response?.Results?.[0]?.[0] ||
    (root?.borrower_id || root?.borrower_firstname ? root : null) ||
    { borrower_id: borrowerId }

  const loans = []
  const seen = new Set()
  for (const src of [root?.loans, root?.Loans, root?.loan, root?.data?.loans, doc, root]) {
    flattenLoanRows(src, loans)
  }

  const unique = []
  for (const l of loans) {
    const key = l.loandisk_loan_id || l.loan_number
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(l)
  }

  if (!unique.length) {
    const emi = pickField(borrowerRow, 'loan_installment_amount', 'monthly_repayment', 'emi')
    const principal = pickField(borrowerRow, 'loan_principal_amount', 'loan_amount')
    if (emi || principal) {
      unique.push({
        loandisk_loan_id: null,
        loan_number: normalizedBorrower?.unique_number || `LD-${borrowerId}`,
        emi: emi != null ? Number(emi) : null,
        outstanding_balance: principal != null ? Number(principal) : null,
        status: 'active',
        raw: borrowerRow,
      })
    }
  }

  return { loans: unique, raw: data, borrowerRow }
}

export function upsertLoansForBorrower(db, localBorrowerId, loanRows) {
  const saved = []
  for (const row of loanRows) {
    const loanNum = row.loan_number || row.loandisk_loan_id || `LD-${localBorrowerId}`
    const existing = db.prepare('select id from loans where loan_number = ?').get(loanNum)
    if (existing) {
      db.prepare(
        `update loans set outstanding_balance = coalesce(?, outstanding_balance), emi = coalesce(?, emi), status = coalesce(?, status) where id = ?`
      ).run(row.outstanding_balance, row.emi, row.status, existing.id)
      saved.push(db.prepare('select * from loans where id = ?').get(existing.id))
    } else {
      const id = randomUUID()
      db.prepare(
        `insert into loans (id, borrower_id, loan_number, outstanding_balance, emi, status) values (?, ?, ?, ?, ?, ?)`
      ).run(id, localBorrowerId, loanNum, row.outstanding_balance, row.emi, row.status || 'active')
      saved.push(db.prepare('select * from loans where id = ?').get(id))
    }
  }
  return saved
}
