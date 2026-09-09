import { Worker } from 'worker_threads'
import { fileURLToPath } from 'url'

const workerPath = fileURLToPath(new URL('./workers/jobWorker.js', import.meta.url))

let activeWorker = null
let activeJobName = null

/**
 * Run a heavy job in a worker thread so the main Express process stays responsive.
 * Only one heavy job at a time (SQLite + CPU isolation).
 */
export function runHeavyJob(jobName, actor, jobState, { onProgress, onComplete, onError }) {
  if (activeWorker) {
    return { started: false, reason: 'busy', activeJob: activeJobName }
  }

  activeJobName = jobName
  activeWorker = new Worker(workerPath, { workerData: { job: jobName, actor } })

  activeWorker.on('message', (msg) => {
    if (msg.type === 'progress') {
      jobState.progress = { ...jobState.progress, ...msg.progress }
      onProgress?.(jobState.progress)
    } else if (msg.type === 'complete') {
      jobState.status = 'completed'
      jobState.finishedAt = new Date().toISOString()
      jobState.result = msg.result
      if (jobName === 'matching' && msg.result?.searchError && msg.result?.matched === 0 && msg.result?.candidatesFound === 0) {
        jobState.result = {
          ...msg.result,
          message: `LoanDisk search failed: ${msg.result.searchError}`,
        }
      }
      onComplete?.(msg.result)
      cleanup()
    } else if (msg.type === 'error') {
      jobState.status = 'failed'
      jobState.finishedAt = new Date().toISOString()
      jobState.error = msg.error
      onError?.(msg.error)
      cleanup()
    }
  })

  activeWorker.on('error', (err) => {
    jobState.status = 'failed'
    jobState.finishedAt = new Date().toISOString()
    jobState.error = err.message
    onError?.(err.message)
    cleanup()
  })

  activeWorker.on('exit', (code) => {
    if (code !== 0 && jobState.status === 'running') {
      jobState.status = 'failed'
      jobState.finishedAt = new Date().toISOString()
      jobState.error = jobState.error || `Worker exited with code ${code}`
      onError?.(jobState.error)
    }
    cleanup()
  })

  return { started: true }
}

function cleanup() {
  if (activeWorker) {
    activeWorker.removeAllListeners()
    activeWorker = null
  }
  activeJobName = null
}

export function isHeavyJobRunning() {
  return !!activeWorker
}

export function getActiveJobName() {
  return activeJobName
}
