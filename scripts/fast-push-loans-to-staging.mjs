/**
 * Fast bulk push of Active (status 1) and Current (status 18) loans
 * from LoanDisk directly to dbo.Staging_LoandiskDueRecords in SQL Server.
 */
import { config } from '../engine/src/config.js'
import { branchUrl, loandiskRequest } from '../engine/src/httpClient.js'
import { mapLoanRecord, loanFingerprint } from '../engine/src/currentLoansClient.js'
import { bulkInsertStagingRecords, getPool, closePool } from '../engine/src/dataAccess.js'
import { writeLoanRefresh } from '../loanRefreshState.js'
import db from '../db.js'

const STATUSES = [
  { id: '1', label: 'active' },
  { id: '18', label: 'current' },
]

const PAGE_SIZE = 500

async function fetchStatusLoans(branch, statusId, statusLabel) {
  const url = branchUrl(branch.id, 'advanced_search_loans')
  let page = 1
  let allRows = []

  while (true) {
    const payload = { from: page, count: PAGE_SIZE, loan_status_id: statusId }
    const res = await loandiskRequest(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: 60000,
    })

    const node = res?.response || res?.Response
    const results = node?.Results || node?.results
    if (!results || !results.length) break

    let pageLoans = []
    const first = results[0]
    if (Array.isArray(first)) {
      for (const entry of results) {
        if (Array.isArray(entry)) {
          for (const item of entry) {
            if (item && typeof item === 'object' && item.loan_id) pageLoans.push(item)
          }
        }
      }
    } else if (typeof first === 'object') {
      for (const [key, val] of Object.entries(first)) {
        if (val && typeof val === 'object' && val.loan_id) pageLoans.push(val)
      }
    }

    if (!pageLoans.length) break
    allRows.push(...pageLoans)

    const totalResults = Number(node?.TotalResults || 0)
    if (page * PAGE_SIZE >= totalResults || pageLoans.length < PAGE_SIZE) {
      break
    }
    page++
  }

  return allRows.map((r) => mapLoanRecord(r, branch, statusLabel)).filter(Boolean)
}

async function run() {
  const startTime = Date.now()
  console.log('🚀 Starting Fast Bulk Push: LoanDisk -> SQL Server Staging_LoandiskDueRecords...')

  const pool = await getPool()
  const beforeCount = await pool.request().query('SELECT COUNT(*) as cnt FROM dbo.Staging_LoandiskDueRecords')
  console.log(`📊 Current records in Staging_LoandiskDueRecords: ${beforeCount.recordset[0].cnt}`)

  let allLoans = []
  let activeCount = 0
  let currentCount = 0
  const branchSummary = []

  for (const branch of config.loandisk.branches) {
    console.log(`\n⏳ Fetching branch: ${branch.name} (${branch.id})...`)
    let branchTotal = 0

    for (const { id: statusId, label } of STATUSES) {
      const loans = await fetchStatusLoans(branch, statusId, label)
      if (label === 'active') activeCount += loans.length
      if (label === 'current') currentCount += loans.length
      branchTotal += loans.length
      allLoans.push(...loans)
      console.log(`   - Status ${statusId} (${label}): ${loans.length} loans`)
    }

    branchSummary.push({ branch: branch.name, count: branchTotal })
  }

  console.log(`\n✅ Total loans fetched from LoanDisk: ${allLoans.length} (Active: ${activeCount}, Current: ${currentCount})`)
  console.log(`⏱️ Fetch duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  // De-dupe loans by loanNumber
  const loanMap = new Map()
  for (const l of allLoans) {
    if (l.loanNumber) loanMap.set(l.loanNumber, l)
  }
  const uniqueLoans = [...loanMap.values()]
  console.log(`🔍 Unique loans to push to SQL Server: ${uniqueLoans.length}`)

  console.log(`💾 Merging into dbo.Staging_LoandiskDueRecords (SQL Server)...`)
  const saveStart = Date.now()
  const { upserted, inserted, updated } = await bulkInsertStagingRecords(uniqueLoans)
  console.log(`✅ SQL Server merge complete in ${((Date.now() - saveStart) / 1000).toFixed(1)}s: ${upserted} total (${inserted} inserted, ${updated} updated)`)

  // Also update SQLite fingerprint cache so delta sync knows they are current
  try {
    const insertBorrower = db.prepare(`
      INSERT INTO borrowers (id, full_name, employer, loandisk_id, first_name, last_name, branch_id, branch_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        full_name = excluded.full_name,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        branch_id = excluded.branch_id,
        branch_name = excluded.branch_name
    `)
    const insertLoan = db.prepare(`
      INSERT INTO loans (id, borrower_id, loan_number, outstanding_balance, emi, status, synced_at, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        borrower_id = excluded.borrower_id,
        loan_number = excluded.loan_number,
        outstanding_balance = excluded.outstanding_balance,
        emi = excluded.emi,
        status = excluded.status,
        synced_at = excluded.synced_at,
        fingerprint = excluded.fingerprint
    `)

    const now = new Date().toISOString()
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        const borrowerId = r.borrowerId ? String(r.borrowerId) : `b_${r.loanId}`
        const fullName = r.borrowerFullName || 'Unknown Borrower'
        const parts = fullName.split(/\s+/).filter(Boolean)
        insertBorrower.run(
          borrowerId,
          fullName,
          null,
          r.borrowerId ? String(r.borrowerId) : null,
          parts[0] || '',
          parts.slice(1).join(' ') || '',
          r.branchId || null,
          r.branchName || null
        )
        insertLoan.run(
          r.loanId,
          borrowerId,
          r.loanNumber,
          r.loanBalanceAmount || r.totalDue || 0,
          r.expectedEmiAmount || 0,
          r.loanStatus || 'active',
          now,
          loanFingerprint(r)
        )
      }
    })
    tx(uniqueLoans)
    console.log(`✅ SQLite cache updated with ${uniqueLoans.length} loans`)
  } catch (dbErr) {
    console.warn('SQLite update note:', dbErr.message)
  }

  const afterCount = await pool.request().query('SELECT COUNT(*) as cnt FROM dbo.Staging_LoandiskDueRecords')
  console.log(`\n🎉 DONE! Total records now in Staging_LoandiskDueRecords: ${afterCount.recordset[0].cnt}`)
  console.log(`⏱️ Total process time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`)

  // Update loan-refresh-status.json
  writeLoanRefresh({
    status: 'idle',
    lastSuccessfulAt: new Date().toISOString(),
    error: null,
    progress: { phase: 'done', count: uniqueLoans.length, percent: 100 },
    activeLoans: uniqueLoans.length,
    activeCount,
    currentCount,
    totalLoans: uniqueLoans.length,
    stale: false,
  })

  await closePool()
  process.exit(0)
}

run().catch((e) => {
  console.error('❌ Error during fast push:', e)
  process.exit(1)
})
