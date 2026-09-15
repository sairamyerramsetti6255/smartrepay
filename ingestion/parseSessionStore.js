import fs from 'node:fs'
import path from 'node:path'
/** Durable private parse sessions. A process restart must not erase uploaded work. */
export class ParseSessionStore {
  constructor(directory) { this.directory = directory }
  file(id) {
    if (!/^[a-f0-9-]{36}$/i.test(String(id))) throw new Error('Invalid parse session')
    return path.join(this.directory, `${id}.json`)
  }
  set(id, data) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const target=this.file(id), temporary=`${target}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(temporary,target)
  }
  get(id) {
    try {
      const data=JSON.parse(fs.readFileSync(this.file(id),'utf8'))
      if (data.buffer?.type==='Buffer') data.buffer=Buffer.from(data.buffer.data)
      return data
    } catch { return null }
  }
  list(userId) {
    if (!fs.existsSync(this.directory)) return []
    return fs.readdirSync(this.directory).filter(n=>n.endsWith('.json')).map(n=>({ id:n.slice(0,-5), data:this.get(n.slice(0,-5)) })).filter(e=>e.data?.userId===userId && !e.data.imported)
  }
  delete(id) { fs.rmSync(this.file(id),{force:true}) }
  clear() { /* Uploaded evidence is deliberately not erased by application reset. */ }
}
