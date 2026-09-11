import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createExcelLink, verifyExcelLink, serveExcelLink } from '../qbExcelLinks.js'

test('Excel capabilities expire and cannot authorize another file or altered expiry', () => {
  const filename = `smartrepay_qb_${randomUUID()}.xlsx`
  const now = Date.now()
  const link = createExcelLink(filename, now)
  const query = new URL(link.downloadPath, 'https://example.test').searchParams
  const expires = query.get('expires'), signature = query.get('signature')
  assert.equal(verifyExcelLink(filename, expires, signature, now), true)
  assert.equal(verifyExcelLink(filename, expires, signature, Number(expires)), false)
  assert.equal(verifyExcelLink(`smartrepay_qb_${randomUUID()}.xlsx`, expires, signature, now), false)
  assert.equal(verifyExcelLink(filename, String(Number(expires) - 1), signature, now), false)
  assert.equal(verifyExcelLink('../secret.xlsx', expires, signature, now), false)
  assert.equal(verifyExcelLink(filename, expires, 'invalid', now), false)
  assert.equal(verifyExcelLink(filename, [expires], signature, now), false)
})

test('Excel can GET, HEAD, and range-read the same file without a browser session', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qb-excel-'))
  const priorDir = process.env.QB_EXPORT_DIR
  process.env.QB_EXPORT_DIR = dir
  const filename = `smartrepay_qb_${randomUUID()}.xlsx`
  const bytes = Buffer.from('PK-test-workbook-snapshot')
  writeFileSync(path.join(dir, filename), bytes)
  const app = express()
  app.get('/api/quickbooks-excel/:filename', serveExcelLink)
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  try {
    const root = `http://127.0.0.1:${server.address().port}/api`
    const url = root + createExcelLink(filename).downloadPath
    const head = await fetch(url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(bytes.length))
    assert.match(head.headers.get('content-type'), /spreadsheetml/)
    assert.match(head.headers.get('cache-control'), /no-store/)
    const get = await fetch(url)
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes)
    const range = await fetch(url, { headers: { Range: 'bytes=0-1' } })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'PK')
    const download = await fetch(url + '&download=1')
    assert.match(download.headers.get('content-disposition'), /^attachment;/)
    assert.equal((await fetch(`${root}/quickbooks-excel/${filename}`)).status, 403)
    assert.equal((await fetch(url.replace('signature=', 'signature=0'))).status, 403)
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (priorDir === undefined) delete process.env.QB_EXPORT_DIR
    else process.env.QB_EXPORT_DIR = priorDir
    rmSync(dir, { recursive: true, force: true })
  }
})
