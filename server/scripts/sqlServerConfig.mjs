import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env') })

/** Shared mssql config for direct SQL Server scripts (staging refresh, schema migrations). */
export function getSqlServerConfig() {
  const password = process.env.DB_PASSWORD
  if (!password) {
    throw new Error('Set DB_PASSWORD in server/.env before running SQL migrations.')
  }

  return {
    server: process.env.DB_SERVER || '185.136.157.11',
    port: Number(process.env.DB_PORT || 9933),
    database: process.env.DB_DATABASE || 'Simplified_db',
    user: process.env.DB_USER || 'Simplified_user',
    password,
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERT !== 'false',
    },
    connectionTimeout: 30_000,
    requestTimeout: 120_000,
  }
}
