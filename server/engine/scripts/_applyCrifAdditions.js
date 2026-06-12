// Idempotently splice the new conditions in CRIF_Operations_additions.sql into the
// live dbo.CRIF_Operations procedure WITHOUT altering existing conditions.
// Strategy: pull the current definition, CREATE->ALTER, and inject the additions
// (wrapped in markers) just before the procedure's final END. Re-running replaces
// only the marked region.
import dotenv from 'dotenv'
import sql from 'mssql'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// scripts live in server/engine/scripts -> the server's .env is two levels up.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') })

const START = '-- >>> SMARTREPAY_ADDITIONS_START'
const END = '-- <<< SMARTREPAY_ADDITIONS_END'

const cfg = {
  server: process.env.DB_SERVER,
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 60000,
}

const run = async () => {
  const additions = fs.readFileSync(path.join(__dirname, '..', 'sql', 'CRIF_Operations_additions.sql'), 'utf8')
  const block = `\n${START}\n${additions}\n${END}\n`

  const pool = await new sql.ConnectionPool(cfg).connect()
  const def = (
    await pool.request().query(`SELECT OBJECT_DEFINITION(OBJECT_ID('CRIF_Operations')) AS def`)
  ).recordset[0]?.def
  if (!def) throw new Error('CRIF_Operations not found')

  let body = def.replace(/\bCREATE\s+Procedure\b/i, 'ALTER Procedure')

  if (body.includes(START) && body.includes(END)) {
    // Replace the previously-injected region.
    const re = new RegExp(`${START}[\\s\\S]*?${END}`)
    body = body.replace(re, `${START}\n${additions}\n${END}`)
  } else {
    // Insert before the procedure's final END.
    const idx = body.toUpperCase().lastIndexOf('\nEND')
    if (idx === -1) throw new Error('Could not locate final END of procedure')
    body = body.slice(0, idx) + block + body.slice(idx)
  }

  await pool.request().batch(body)
  console.log('CRIF_Operations altered successfully.')

  // Smoke test the read conditions (tables may be empty — that is fine).
  for (const cond of ['Get_BankTransactions', 'Get_TransactionMatches', 'Get_MatchSummary']) {
    const r = await pool
      .request()
      .input('Json', sql.VarChar(sql.MAX), '{}')
      .input('Condition', sql.VarChar(100), cond)
      .input('Type', sql.VarChar(100), '')
      .execute('CRIF_Operations')
    console.log(`  ${cond}: ${r.recordset?.length ?? 0} row(s)`) 
  }

  await pool.close()
}

run().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
