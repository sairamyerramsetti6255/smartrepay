import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'crypto'
import bcrypt from 'bcryptjs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, 'smartrepay.db')

/** Thin wrapper so existing better-sqlite3-style calls keep working. */
class SqliteDatabase {
  constructor(filePath) {
    this._db = new DatabaseSync(filePath)
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
}

const db = new SqliteDatabase(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

function migrateDb() {
  const borrowerCols = db.prepare('pragma table_info(borrowers)').all().map((c) => c.name)
  if (!borrowerCols.includes('loandisk_id')) {
    db.exec('alter table borrowers add column loandisk_id text')
    db.exec('create unique index if not exists idx_borrowers_loandisk on borrowers(loandisk_id)')
  }
  for (const col of ['first_name', 'last_name', 'branch_id', 'branch_name']) {
    if (!borrowerCols.includes(col)) db.exec(`alter table borrowers add column ${col} text`)
  }
}

export function resetAppData() {
  db.exec(`
    delete from exceptions;
    delete from transactions;
    delete from loans;
    delete from borrowers;
    delete from audit_log;
  `)
}

export function initDb() {
  migrateDb()
  db.exec(`
    create table if not exists users (
      id text primary key,
      email text unique not null,
      password_hash text not null,
      role text not null default 'collections',
      full_name text,
      created_at text default (datetime('now'))
    );

    create table if not exists borrowers (
      id text primary key,
      full_name text not null,
      aliases text,
      employer text,
      created_at text default (datetime('now'))
    );

    create table if not exists loans (
      id text primary key,
      borrower_id text references borrowers(id),
      loan_number text unique not null,
      outstanding_balance real,
      status text default 'active',
      created_at text default (datetime('now'))
    );

    create table if not exists transactions (
      id text primary key,
      date text not null,
      payer text,
      description text,
      amount real not null,
      reference text,
      status text default 'pending' check (status in ('pending','matched','exception','posted')),
      confidence_score real,
      matched_borrower_id text references borrowers(id),
      loan_id text references loans(id),
      import_hash text unique,
      created_at text default (datetime('now'))
    );

    create table if not exists exceptions (
      id text primary key,
      transaction_id text references transactions(id),
      type text check (type in ('unmatched','duplicate','partial','suspicious')),
      assigned_to text,
      sla_hours integer default 24,
      status text default 'open' check (status in ('open','resolved','escalated')),
      resolution_note text,
      created_at text default (datetime('now')),
      resolved_at text
    );

    create table if not exists audit_log (
      id text primary key,
      entity text,
      entity_id text,
      action text,
      actor text,
      prior_value text,
      new_value text,
      created_at text default (datetime('now'))
    );

    create table if not exists app_settings (
      key text primary key,
      value text not null
    );

    create index if not exists idx_transactions_status on transactions(status);
    create index if not exists idx_transactions_date on transactions(date);
    create index if not exists idx_exceptions_status on exceptions(status);
  `)

  const userCount = db.prepare('select count(*) as c from users').get().c
  if (userCount === 0) {
    const id = randomUUID()
    const hash = bcrypt.hashSync('demo1234', 10)
    db.prepare(
      'insert into users (id, email, password_hash, role, full_name) values (?, ?, ?, ?, ?)'
    ).run(id, 'demo@smartrepay.local', hash, 'system_owner', 'Demo User')
  }

  const settingsCount = db.prepare('select count(*) as c from app_settings').get().c
  if (settingsCount === 0) {
    const defaults = {
      autoApproveThreshold: 80,
      autoEscalateOnBreach: true,
      slaHours: { unmatched: 24, duplicate: 4, partial: 24, suspicious: 72 },
      matchingRules: [
        { id: '1', field: 'full_name', weight: 40, active: true },
        { id: '2', field: 'aliases', weight: 35, active: true },
        { id: '3', field: 'employer', weight: 25, active: true },
      ],
    }
    db.prepare('insert into app_settings (key, value) values (?, ?)').run('global', JSON.stringify(defaults))
  }

  if (process.env.RESET_APP_DATA === 'true') {
    resetAppData()
    console.log('RESET_APP_DATA: cleared transactions, borrowers, loans, exceptions, and audit log')
  }
}

export function parseJson(val) {
  if (!val) return null
  try {
    return JSON.parse(val)
  } catch {
    return null
  }
}

export function rowBorrower(r) {
  if (!r) return null
  return {
    ...r,
    aliases: parseJson(r.aliases) || [],
    loandisk_id: r.loandisk_id || null,
    first_name: r.first_name || null,
    last_name: r.last_name || null,
    branch_id: r.branch_id || null,
    branch_name: r.branch_name || null,
  }
}

export default db
