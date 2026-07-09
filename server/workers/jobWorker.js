import 'dotenv/config'
import { parentPort, workerData } from 'worker_threads'
import { openDatabase } from '../dbFactory.js'
import { runMatchingBatch } from '../matchingService.js'
import { runBorrowerSync } from '../syncService.js'

const db = openDatabase()

function post(type, payload) {
  parentPort.postMessage({ type, ...payload })
}

async function main() {
  const { job, actor } = workerData
  try {
    if (job === 'matching') {
      const result = await runMatchingBatch(db, actor, (progress) => post('progress', { progress }))
      post('complete', { result })
      return
    }
    if (job === 'sync') {
      const result = await runBorrowerSync(db, actor, (progress) => post('progress', { progress }))
      post('complete', { result })
      return
    }
    throw new Error(`Unknown job type: ${job}`)
  } catch (e) {
    post('error', { error: e.message || String(e) })
  }
}

main()
