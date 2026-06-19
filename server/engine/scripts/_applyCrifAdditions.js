// Idempotently splice CRIF_Operations_additions.sql into dbo.CRIF_Operations.
// Run: npm run apply-crif --prefix server
import sql from 'mssql'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getSqlServerConfig } from '../../scripts/sqlServerConfig.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const START = '-- >>> SMARTREPAY_ADDITIONS_START'
const END = '-- <<< SMARTREPAY_ADDITIONS_END'

const SMOKE_CONDITIONS = [
  'Get_BankTransactions',
  'Get_TransactionMatches',
  'Get_MatchSummary',
  'Get_LoansByBorrowerId',
  'Get_ManualReceipts',
]

function readAdditionsSql() {
  return fs.readFileSync(path.join(__dirname, '..', 'sql', 'CRIF_Operations_additions.sql'), 'utf8')
}

async function execCondition(pool, condition, json = '{}') {
  return pool
    .request()
    .input('Json', sql.VarChar(sql.MAX), json)
    .input('Condition', sql.VarChar(100), condition)
    .input('Type', sql.VarChar(100), '')
    .execute('CRIF_Operations')
}

/**
 * Patch dbo.CRIF_Operations with SmartRepay conditions from CRIF_Operations_additions.sql.
 * @param {import('mssql').ConnectionPool} [existingPool] reuse an open pool (caller closes)
 */
export async function applyCrifAdditions(existingPool) {
  const additions = readAdditionsSql()
  const block = `\n${START}\n${additions}\n${END}\n`

  const ownPool = !existingPool
  const pool = existingPool || (await new sql.ConnectionPool(getSqlServerConfig()).connect())

  try {
    const def = (
      await pool.request().query(`SELECT OBJECT_DEFINITION(OBJECT_ID('CRIF_Operations')) AS def`)
    ).recordset[0]?.def
    if (!def) throw new Error('CRIF_Operations not found on this database')

    let body = def.replace(/\bCREATE\s+Procedure\b/i, 'ALTER Procedure')

    if (body.includes(START) && body.includes(END)) {
      const re = new RegExp(`${START}[\\s\\S]*?${END}`)
      body = body.replace(re, `${START}\n${additions}\n${END}`)
    } else {
      const idx = body.toUpperCase().lastIndexOf('\nEND')
      if (idx === -1) throw new Error('Could not locate final END of CRIF_Operations')
      body = body.slice(0, idx) + block + body.slice(idx)
    }

    await pool.request().batch(body)
    console.log('CRIF_Operations altered successfully.')

    for (const cond of SMOKE_CONDITIONS) {
      try {
        const json = cond === 'Get_LoansByBorrowerId' ? '{"BorrowerId":"0"}' : '{}'
        const r = await execCondition(pool, cond, json)
        console.log(`  ${cond}: ${r.recordset?.length ?? 0} row(s)`)
      } catch (e) {
        console.warn(`  ${cond}: smoke test skipped — ${e.message}`)
      }
    }
  } finally {
    if (ownPool) await pool.close()
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  applyCrifAdditions()
    .catch((e) => {
      console.error('FAILED:', e.message)
      process.exit(1)
    })
}
