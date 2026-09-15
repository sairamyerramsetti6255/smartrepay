export function fileFacts(result) {
  const rows = result.rows || []
  const dates = rows.map(r=>r.datePosted || r.date).filter(Boolean).sort()
  const byDate = {}
  for (const r of rows) {
    const d = r.datePosted || r.date
    const entry = byDate[d] ||= { count: 0, cents: 0 }
    entry.count++; entry.cents += Math.round(Number(r.amount)*100)
  }
  return { creditCount: rows.length, creditTotal: rows.reduce((s,r)=>s+Math.round(Number(r.amount)*100),0)/100,
    firstPostedDate: dates[0] || null, lastPostedDate: dates.at(-1) || null,
    byDate, debitCount: result.diagnostics?.debitCount ?? null,
    complete: result.diagnostics?.complete ?? true, warnings: result.diagnostics?.warnings || [] }
}
export async function summarizeFile(result, generate) {
  const facts = fileFacts(result)
  try {
    // All model monetary values use currency units, never cents.
    const aiFacts = { ...facts, currencyUnit: 'currency units (not cents)', byDate: Object.fromEntries(Object.entries(facts.byDate).map(([date, entry])=>[date,{count:entry.count,totalAmount:entry.cents/100}])) }
    const text = await generate(aiFacts)
    return { facts, text, status: 'ai' }
  } catch {
    return { facts, text: 'AI summary unavailable. Verified extraction totals remain available below.', status: 'unavailable' }
  }
}
