import { readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import sql from 'mssql'
import { config } from '../src/config.js'
import { closePool } from '../src/dataAccess.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Run every .sql file in the sql/ folder (creates all staging tables). */
async function main() {
  const sqlDir = join(__dirname, '..', 'sql')
  const files = readdirSync(sqlDir).filter((f) => f.toLowerCase().endsWith('.sql')).sort()

  const pool = await new sql.ConnectionPool({
    server: config.db.server,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    options: config.db.options,
    requestTimeout: 60_000,
  }).connect()

  for (const file of files) {
    const ddl = readFileSync(join(sqlDir, file), 'utf8')
    await pool.request().batch(ddl)
    console.log(`Applied ${file}`)
  }

  console.log('All staging tables are ready.')
  await pool.close()
}

main()
  .catch((e) => {
    console.error('initDb failed:', e.message)
    process.exitCode = 1
  })
  .finally(() => closePool())
