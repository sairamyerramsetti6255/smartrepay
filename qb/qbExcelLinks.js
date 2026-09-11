import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'

const fallbackSecret = randomBytes(32)
const lifetimeMs = 10 * 60 * 1000
const validFilename = /^smartrepay_qb_[0-9a-f-]{36}\.xlsx$/
const signature = (filename, expires) => createHmac('sha256', process.env.JWT_SECRET || fallbackSecret)
  .update(`qb-excel-download\n${filename}\n${expires}`).digest('hex')

export function createExcelLink(filename, now = Date.now()) {
  if (!validFilename.test(filename)) throw new Error('Invalid workbook filename')
  const expires = String(now + lifetimeMs)
  return { fileName: filename, expiresAt: new Date(Number(expires)).toISOString(),
    downloadPath: `/quickbooks-excel/${filename}?expires=${expires}&signature=${signature(filename, expires)}` }
}

export function verifyExcelLink(filename, expires, supplied, now = Date.now()) {
  if (!validFilename.test(filename) || typeof expires !== 'string' || !/^\d{13}$/.test(expires) ||
      Number(expires) <= now || Number(expires) > now + lifetimeMs ||
      typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)) return false
  return timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(filename, expires), 'hex'))
}

// Excel cannot supply the browser's Authorization header. This capability grants
// read-only access to exactly one existing workbook, never to other API routes.
export function serveExcelLink(req, res) {
  res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' })
  if (!verifyExcelLink(req.params.filename, req.query.expires, req.query.signature)) {
    return res.status(403).send('Workbook link is invalid or expired. Prepare a new link in QuickBooks.')
  }
  const filename = req.params.filename
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.set('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${filename}"`)
  res.sendFile(path.resolve(process.env.QB_EXPORT_DIR || 'data/exports', filename), err => {
    if (err && !res.headersSent) res.status(err.statusCode || 500).send('Workbook unavailable. Prepare a new link in QuickBooks.')
  })
}
