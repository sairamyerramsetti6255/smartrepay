import { readFileSync, statSync, readdirSync } from 'fs'
import { basename, resolve, join, extname } from 'path'
import { parseStatement, detectFileType } from '../src/statementParser.js'
import { normalizeNameKey } from '../src/nameMatch.js'
import { bulkInsertBankTransactions, closePool } from '../src/dataAccess.js'

/**
 * CLI: parse one or more client-uploaded transaction files (PDF / Excel / CSV /
 * text), keep only CREDIT rows, and load them into Staging_BankTransactions.
 *
 * Usage:
 *   node scripts/importTransactions.js "<file1>" "<file2>" ...
 *   node scripts/importTransactions.js "<folder>"
 */
const SUPPORTED = /\.(pdf|xlsx|xls|xlsm|csv|txt|tsv|text)$/i

function collectFiles(inputs) {
  const files = []
  for (const input of inputs) {
    const abs = resolve(input)
    const st = statSync(abs)
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) {
        if (SUPPORTED.test(name)) files.push(join(abs, name))
      }
    } else if (SUPPORTED.test(abs)) {
      files.push(abs)
    } else {
      console.warn(`Skipping unsupported file: ${basename(abs)}`)
    }
  }
  return files
}

async function importOne(absPath) {
  const fileName = basename(absPath)
  const buffer = readFileSync(absPath)
  const { fileType, sourceType, rows } = await parseStatement(buffer, fileName)

  const records = rows.map((r) => ({
    ...r,
    fileType,
    normalizedName: normalizeNameKey(r.borrowerName),
  }))

  const named = records.filter((r) => r.borrowerName).length
  const total = records.reduce((s, r) => s + (r.emiPaidAmount || 0), 0)
  const saved = await bulkInsertBankTransactions(records, {
    fileName,
    uploadedDate: new Date(),
  })

  console.log(
    `  ${fileName}\n    type=${fileType} source=${sourceType} credits=${saved} ` +
      `named=${named} total=${total.toFixed(2)}`
  )
  return saved
}

async function main() {
  const inputs = process.argv.slice(2)
  if (!inputs.length) {
    console.error('Usage: node scripts/importTransactions.js <file|folder> [more...]')
    process.exitCode = 1
    return
  }

  const files = collectFiles(inputs)
  if (!files.length) {
    console.error('No supported files found.')
    process.exitCode = 1
    return
  }

  console.log(`Importing ${files.length} file(s):`)
  let grand = 0
  for (const f of files) {
    try {
      grand += await importOne(f)
    } catch (e) {
      console.error(`  FAILED ${basename(f)} (${detectFileType(f)}): ${e.message}`)
    }
  }
  console.log(`\nDone. ${grand} credit transactions loaded into Staging_BankTransactions.`)
}

main()
  .catch((e) => {
    console.error('Import failed:', e.message)
    process.exitCode = 1
  })
  .finally(() => closePool())
