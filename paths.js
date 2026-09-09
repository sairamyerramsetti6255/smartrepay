import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __serverDir = path.dirname(fileURLToPath(import.meta.url))

/** Persistent files only — mount this path in Coolify, not /app/server (that shadows index.js). */
export const DATA_DIR = process.env.DATA_DIR || path.join(__serverDir, 'data')
export const DB_PATH = path.join(DATA_DIR, 'smartrepay.db')
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')

const LEGACY_DB = path.join(__serverDir, 'smartrepay.db')
const LEGACY_UPLOADS = path.join(__serverDir, 'uploads')

export function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(UPLOADS_DIR, { recursive: true })
  migrateLegacyData()
}

function migrateLegacyData() {
  if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB)) {
    fs.copyFileSync(LEGACY_DB, DB_PATH)
    for (const suffix of ['-wal', '-shm']) {
      const legacy = LEGACY_DB + suffix
      if (fs.existsSync(legacy)) fs.copyFileSync(legacy, DB_PATH + suffix)
    }
    console.log(`Migrated database to ${DB_PATH}`)
  }

  if (!fs.existsSync(LEGACY_UPLOADS)) return
  try {
    for (const name of fs.readdirSync(LEGACY_UPLOADS)) {
      const src = path.join(LEGACY_UPLOADS, name)
      const dest = path.join(UPLOADS_DIR, name)
      if (!fs.existsSync(dest)) {
        fs.cpSync(src, dest, { recursive: true })
      }
    }
  } catch {
    /* ignore */
  }
}
