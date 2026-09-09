/** Group borrowers by LoanDisk branch for branch-wise matching UI. */
export function groupBorrowersByBranch(borrowers) {
  const map = new Map()
  for (const b of borrowers) {
    const key = String(b.branch_id || b.branch_name || 'unknown')
    const name = b.branch_name || b.branch_id || 'Unknown branch'
    if (!map.has(key)) {
      map.set(key, { branchKey: key, branchId: b.branch_id || null, branchName: name, borrowers: [] })
    }
    map.get(key).borrowers.push(b)
  }
  return [...map.values()].sort((a, b) => a.branchName.localeCompare(b.branchName))
}

export function buildLoansByBorrowerId(loans) {
  const map = new Map()
  for (const loan of loans) {
    if (!map.has(loan.borrower_id)) map.set(loan.borrower_id, [])
    map.get(loan.borrower_id).push(loan)
  }
  return map
}

/** Preview summary shown before / during matching run. */
export function buildBranchSummaries(branchGroups, loans, pendingTxs = []) {
  const loansByBorrower = buildLoansByBorrowerId(loans)
  const totalPendingEmi = pendingTxs.reduce((s, t) => s + (Number(t.amount) || 0), 0)

  return branchGroups.map((br) => {
    let totalLoanEmi = 0
    for (const b of br.borrowers) {
      const bl = loansByBorrower.get(b.id) || []
      totalLoanEmi += bl.reduce((s, l) => s + (Number(l.emi) || 0), 0)
    }
    return {
      branchKey: br.branchKey,
      branchId: br.branchId,
      branchName: br.branchName,
      borrowerCount: br.borrowers.length,
      totalLoanEmi: Math.round(totalLoanEmi * 100) / 100,
      pendingCount: pendingTxs.length,
      totalPendingEmi: Math.round(totalPendingEmi * 100) / 100,
      processed: 0,
      matched: 0,
      unmatched: 0,
      totalEmiReceived: 0,
      percent: 0,
      status: 'pending',
    }
  })
}

export function enrichTxForMatching(rawTx, docFilenames) {
  const docName = rawTx.source_document_id ? docFilenames.get(rawTx.source_document_id) : ''
  return {
    ...rawTx,
    description: [rawTx.description, docName].filter(Boolean).join(' '),
    reference: [rawTx.reference, docName?.replace(/\.[^.]+$/, '')].filter(Boolean).join(' '),
  }
}
