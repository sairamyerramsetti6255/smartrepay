import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'
const file = path.join(DATA_DIR, 'loan-refresh-status.json')
let state
export function readLoanRefresh() {
  try { state = JSON.parse(fs.readFileSync(file,'utf8')) } catch { state ||= {status:'idle',lastSuccessfulAt:null} }
  return state
}
export function writeLoanRefresh(patch) {
  state={...readLoanRefresh(),...patch}
  fs.mkdirSync(DATA_DIR,{recursive:true})
  const temp=`${file}.${process.pid}.tmp`
  fs.writeFileSync(temp,JSON.stringify(state));fs.renameSync(temp,file)
  return state
}
export function loansAreStale(lastUpdated, now=Date.now()) {
  const time=Date.parse(lastUpdated || '')
  return !Number.isFinite(time) || time>now || now-time>7*86400000
}
