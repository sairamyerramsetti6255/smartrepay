import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'

const file = path.join(DATA_DIR, 'borrower-refresh-status.json')

const EMPTY = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  lastSuccessfulAt: null,
  error: null,
  total: 0,
  processed: 0,
  failed: 0,
  batches: 0,
  batchesComplete: 0,
  batchSize: 100,
  concurrency: 5,
  progress: null,
}

let state

export function readBorrowerRefresh() {
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    state ||= { ...EMPTY }
  }
  return state
}

export function writeBorrowerRefresh(patch) {
  state = { ...readBorrowerRefresh(), ...patch }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state))
  fs.renameSync(temp, file)
  return state
}

export function resetBorrowerRefresh(patch = {}) {
  state = { ...EMPTY, ...patch }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(state))
  fs.renameSync(temp, file)
  return state
}
