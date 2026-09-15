// Bank extraction uses page coordinates, never narrative keywords, for direction.
const money = /^-?\d[\d,]*\.\d{2}$/
const amount = s => Number(s.replace(/,/g, ''))
function day(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (!m) return null
  const y = m[3].length === 2 ? `20${m[3]}` : m[3]
  const iso = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : null
}
export function pageLines(items) {
  const lines = []
  for (const item of items.filter(i => i.str?.trim()).sort((a,b) => b.transform[5]-a.transform[5] || a.transform[4]-b.transform[4])) {
    const y = item.transform[5]
    let line = lines.find(l => Math.abs(l.y-y) < 2)
    if (!line) { line = { y, items: [] }; lines.push(line) }
    line.items.push({ text: item.str.trim(), x: item.transform[4], width: item.width || 0 })
  }
  return lines.sort((a,b) => b.y-a.y).map(l => l.items.sort((a,b) => a.x-b.x))
}
function heading(line, label) {
  for (let i=0;i<line.length;i++) for (let n=1;n<=3;n++) {
    const cells = line.slice(i,i+n)
    if (cells.map(c=>c.text).join(' ').toLowerCase() === label.toLowerCase()) {
      return { x: cells[0].x, center: (cells[0].x + cells.at(-1).x + cells.at(-1).width)/2 }
    }
  }
  return null
}
export function extractBankPages(pages) {
  const rows = [], warnings = []
  let current = null, recognizedPages = 0
  for (const page of pages) {
    let columns = null, table = false, seenHeader = false
    for (const line of pageLines(page.items)) {
      const text = line.map(c=>c.text).join(' ')
      const debit = heading(line,'Debit Amount'), credit = heading(line,'Credit Amount'), balance = heading(line,'Balance'), particulars = heading(line,'Particulars')
      if (debit && credit && balance && particulars) {
        columns = { debit, credit, balance, particulars }; table = true; seenHeader = true; continue
      }
      if (!table) continue
      if (/^(?:Important Notice|Conditions of Account|Statement Message|Dr\s*=|Total Value Added|Page\.?\s+\d)/i.test(text)) { table=false; continue }
      if (/balance\s+(?:brought|carried)\s+forward|opening balance|closing balance/i.test(text)) continue
      // Dates establish a row; references can be absent or fused with narrative.
      const start = text.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(\d{1,2}\/\d{1,2}\/\d{2,4}))?\s*/)
      const referenceCell = line.find(c=>c.x < columns.particulars.x-3 && !/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(c.text) && /^\d+(?:\s|$)/.test(c.text))
      const reference = referenceCell?.text.match(/^\d+/)?.[0] || ''
      if (start) {
        current = { datePosted: day(start[1]), valueDate: start[2] ? day(start[2]) : null, reference, particulars: '', sourcePages: [page.num], debitAmount: 0, creditAmount: 0, balance: null, direction: 'unknown' }
        rows.push(current)
      }
      if (!current) continue
      const description = []
      for (const cell of line) {
        if (cell === referenceCell && start) {
          const suffix = cell.text.slice(reference.length).trim()
          if (suffix) description.push(suffix)
          continue
        }
        if (cell.x < columns.particulars.x-3) continue
        if (start && money.test(cell.text) && cell.x >= columns.debit.x-15) {
          const center = cell.x + cell.width/2
          const key = ['debit','credit','balance'].sort((a,b)=>Math.abs(center-columns[a].center)-Math.abs(center-columns[b].center))[0]
          current[key === 'balance' ? 'balance' : `${key}Amount`] = amount(cell.text)
        } else if (cell.x < columns.debit.x-10) description.push(cell.text)
      }
      if (description.length) {
        current.particulars = [current.particulars, description.join(' ')].filter(Boolean).join(' ')
        if (!current.sourcePages.includes(page.num)) current.sourcePages.push(page.num)
      }
    }
    if (seenHeader) recognizedPages++
    else warnings.push(`Page ${page.num}: bank columns not recognized; extraction requires review.`)
  }
  for (let i=0;i<rows.length;i++) {
    const r = rows[i]
    r.sourceSerial = i+1
    r.direction = r.creditAmount > 0 && !r.debitAmount ? 'credit' : r.debitAmount > 0 && !r.creditAmount ? 'debit' : 'unknown'
    if (!r.datePosted || r.direction === 'unknown' || !r.particulars) warnings.push(`Reference ${r.reference}: incomplete posted date, direction or description.`)
    const previous = rows[i-1]
    if (previous?.balance != null && r.balance != null && Math.abs(Math.round((r.balance-previous.balance-r.creditAmount+r.debitAmount)*100)) > 1) warnings.push(`Reference ${r.reference}: running balance does not reconcile.`)
  }
  return { rows, recognizedPages, diagnostics: { complete: warnings.length===0 && rows.length>0, warnings, totalTransactions: rows.length, creditCount: rows.filter(r=>r.direction==='credit').length, debitCount: rows.filter(r=>r.direction==='debit').length, unknownCount: rows.filter(r=>r.direction==='unknown').length, pages: pages.length } }
}
export async function extractPositionedBank(parser) {
  const doc = await parser.load()
  const pages=[]
  for(let num=1;num<=doc.numPages;num++) {
    const page=await doc.getPage(num)
    const content=await page.getTextContent()
    pages.push({num,items:content.items})
  }
  return extractBankPages(pages)
}
