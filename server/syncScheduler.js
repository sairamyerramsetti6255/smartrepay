import cron from 'node-cron'
import { runSqlBorrowerLoanSync } from './borrowerLoanSyncService.js'

let lastScheduledRun = null
let scheduledRunning = false

export function startLoanDiskSyncScheduler() {
  const enabled = process.env.LOANDISK_SYNC_ENABLED === 'true'
  const expr = process.env.LOANDISK_SYNC_CRON || '0 2 * * 0'

  if (!enabled) {
    console.log(
      'Loan Disk SQL sync scheduler: automatic weekly sync off (set LOANDISK_SYNC_ENABLED=true). ' +
        'Manual sync via Borrowers → "Sync to SQL Server" or POST /api/loandisk/sync-sql still works.'
    )
    return
  }

  if (!cron.validate(expr)) {
    console.warn(`Loan Disk SQL sync scheduler: invalid cron "${expr}" — not started`)
    return
  }

  cron.schedule(expr, async () => {
    if (scheduledRunning) {
      console.warn('Loan Disk SQL sync skipped — previous run still active')
      return
    }
    scheduledRunning = true
    console.log(`[cron] Loan Disk SQL sync starting (${expr})`)
    try {
      const result = await runSqlBorrowerLoanSync((p) => {
        if (p.phase) console.log('[cron] sync', p.phase, p.count ?? p.processed ?? '')
      })
      lastScheduledRun = { at: new Date().toISOString(), result }
      console.log('[cron] Loan Disk SQL sync done:', result.message)
    } catch (e) {
      lastScheduledRun = { at: new Date().toISOString(), error: e.message }
      console.error('[cron] Loan Disk SQL sync failed:', e.message)
    } finally {
      scheduledRunning = false
    }
  })

  console.log(`Loan Disk SQL sync scheduler: enabled (${expr})`)
}

export function getLastScheduledSyncRun() {
  return lastScheduledRun
}

export function isScheduledSyncRunning() {
  return scheduledRunning
}
