import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from './paths.js'

/** Thin wrapper so existing better-sqlite3-style calls keep working. */
export class SqliteDatabase {
  constructor(filePath) {
    this._db = new DatabaseSync(filePath)
    this._db.exec('PRAGMA journal_mode = WAL')
    this._db.exec('PRAGMA foreign_keys = ON')
    this._db.exec('PRAGMA busy_timeout = 30000')
    this._db.exec('PRAGMA synchronous = NORMAL')
  }

  pragma(statement) {
    this._db.exec(`PRAGMA ${statement}`)
  }

  exec(sql) {
    this._db.exec(sql)
  }

  prepare(sql) {
    const stmt = this._db.prepare(sql)
    return {
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
      run: (...params) => stmt.run(...params),
    }
  }

  transaction(fn) {
    return (...args) => {
      this._db.exec('BEGIN TRANSACTION')
      try {
        const result = fn(...args)
        this._db.exec('COMMIT')
        return result
      } catch (err) {
        this._db.exec('ROLLBACK')
        throw err
      }
    }
  }
}

export function openDatabase(filePath = DB_PATH) {
  return new SqliteDatabase(filePath)
}
