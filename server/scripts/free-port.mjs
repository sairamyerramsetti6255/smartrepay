import { execSync } from 'child_process'
import { platform } from 'os'

const port = process.argv[2] || '3001'

function freePortWindows() {
  const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' })
  const pids = new Set()
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('LISTENING')) continue
    const pid = line.trim().split(/\s+/).at(-1)
    if (pid && /^\d+$/.test(pid)) pids.add(pid)
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
      console.log(`Freed port ${port} (stopped PID ${pid})`)
    } catch {
      /* already gone */
    }
  }
}

function freePortUnix() {
  const out = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' })
  const pids = [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))]
  for (const pid of pids) {
    try {
      execSync(`kill -9 ${pid}`, { stdio: 'ignore' })
      console.log(`Freed port ${port} (stopped PID ${pid})`)
    } catch {
      /* already gone */
    }
  }
}

try {
  if (platform() === 'win32') freePortWindows()
  else freePortUnix()
} catch {
  /* port already free */
}
