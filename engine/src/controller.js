import { Router } from 'express'
import { runBorrowerSync, runDueLoansSync } from './reconciliationManager.js'

/**
 * HTTP controller — port of controller.cs / ReconciliationController.cs.
 *
 * The sync can take a while on large data sets, so a job-state guard prevents
 * overlapping runs. Progress is captured for status polling.
 */
const router = Router()

const job = {
  status: 'idle', // idle | running | completed | failed
  startedAt: null,
  finishedAt: null,
  progress: null,
  result: null,
  error: null,
}

async function startSync(runner) {
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  job.finishedAt = null
  job.progress = { phase: 'starting' }
  job.result = null
  job.error = null

  try {
    job.result = await runner((p) => {
      job.progress = p
    })
    job.status = 'completed'
  } catch (e) {
    job.status = 'failed'
    job.error = e.message
  } finally {
    job.finishedAt = new Date().toISOString()
  }
}

// POST /api/due-loans/sync — RECOMMENDED fast path (single due_loans endpoint).
router.post('/due-loans/sync', async (_req, res) => {
  if (job.status === 'running') {
    return res.status(409).json({ success: false, message: 'Sync already in progress', progress: job.progress })
  }
  try {
    await startSync(runDueLoansSync)
    if (job.status === 'failed') return res.status(500).json({ success: false, message: job.error })
    return res.json({ success: true, ...job.result })
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message })
  }
})

// POST /api/GetAllBorrowers — legacy 3-stage pipeline (borrowers -> loans -> repayments).
router.post('/GetAllBorrowers', async (_req, res) => {
  if (job.status === 'running') {
    return res.status(409).json({ success: false, message: 'Sync already in progress', progress: job.progress })
  }
  try {
    await startSync(runBorrowerSync)
    if (job.status === 'failed') {
      return res.status(500).json({ success: false, message: job.error })
    }
    return res.json({ success: true, ...job.result })
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message })
  }
})

// POST /api/reconciliation-pipeline/process — fire-and-forget background run (fast path).
router.post('/reconciliation-pipeline/process', (_req, res) => {
  if (job.status === 'running') {
    return res.status(409).json({ success: false, message: 'Sync already in progress', progress: job.progress })
  }
  startSync(runDueLoansSync) // intentionally not awaited
  res.json({ success: true, message: 'Reconciliation pipeline started in background.' })
})

// GET /api/reconciliation-pipeline/status — poll background progress.
router.get('/reconciliation-pipeline/status', (_req, res) => {
  res.json({
    status: job.status,
    progress: job.progress,
    result: job.result,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  })
})

export default router
