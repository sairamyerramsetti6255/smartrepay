// After `vite build`, swap the runtime config so the PRODUCTION bundle points at
// the dedicated API host (frontend and API are on different domains in prod).
// Local dev is unaffected — it serves public/config.json (relative /api proxy).
import { copyFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'public', 'config.production.json')
const dest = join(root, 'dist', 'config.json')

if (!existsSync(src)) {
  console.warn('[apply-prod-config] public/config.production.json not found — keeping default config.json')
  process.exit(0)
}

copyFileSync(src, dest)
console.log('[apply-prod-config] dist/config.json <- public/config.production.json (production API host)')
