/** Remove a trailing payment note without splitting hyphenated surnames. */
export function stripPaymentNote(value) {
  return String(value || '')
    .trim()
    .replace(/(?:\s+[-–—:]\s*|\s+|\s*\(\s*)(?:paid[\s-]+off|paid\s+in\s+full)\s*\)?[.!]?\s*$/i, '')
    .trim()
}
