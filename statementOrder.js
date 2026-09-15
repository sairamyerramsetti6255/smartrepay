import fs from 'node:fs'
import path from 'node:path'
import { UPLOADS_DIR } from './paths.js'
const cache=new Map()
const key=r=>[String(r.datePosted || r.date || r.TransDate || '').slice(0,10),String(r.reference ?? r.ReferenceNo ?? ''),Math.round(Number(r.amount ?? r.creditAmount ?? r.EmiPaidAmount)*100)].join('|')
export function applyStatementOrder(rows, sources=[]) {
  const files=new Map(sources.map(s=>[s.stagedFileName,s.richRows || s.rows || []]))
  const queues=new Map()
  for(const [file,source] of files) {
    const lookup=new Map()
    source.forEach((r,i)=>{const k=key(r);if(!lookup.has(k))lookup.set(k,[]);lookup.get(k).push(r.sourceSerial || i+1)})
    queues.set(file,lookup)
  }
  const positions=new Map()
  return [...rows].sort((a,b)=>Number(a.Id)-Number(b.Id)).map(r=>{
    const fallback=(positions.get(r.FileName)||0)+1;positions.set(r.FileName,fallback)
    const serial=queues.get(r.FileName)?.get(key(r))?.shift()
    return {...r,SourceSerial:serial ?? fallback,OrderSource:serial!=null?'statement':'import_order'}
  }).sort((a,b)=>String(a.FileName).localeCompare(String(b.FileName)) || a.SourceSerial-b.SourceSerial)
}
export function orderStoredStatements(rows) {
  const dir=path.join(UPLOADS_DIR,'.parse-sessions'),sources=[]
  if(fs.existsSync(dir)) for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.json'))) {
    const full=path.join(dir,file),mtime=fs.statSync(full).mtimeMs
    try {
      if(cache.get(full)?.mtime!==mtime) {const data=JSON.parse(fs.readFileSync(full,'utf8'));cache.set(full,{mtime,data:{stagedFileName:data.stagedFileName,richRows:data.richRows,rows:data.rows}})}
      const data=cache.get(full).data;if(data.stagedFileName)sources.push(data)
    } catch { /* Legacy files keep stable import order. */ }
  }
  return applyStatementOrder(rows,sources)
}
