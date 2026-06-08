export async function transactionImportHash({ date, payer, amount, reference }) {
  const raw = `${date}|${payer || ''}|${amount}|${reference || ''}`
  const encoded = new TextEncoder().encode(raw)
  const buf = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
