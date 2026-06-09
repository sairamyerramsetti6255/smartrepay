import * as XLSX from 'xlsx'

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ key: string, label: string, value?: (row: Record<string, unknown>) => unknown }[]} columns
 * @param {string} filename
 */
export function exportToExcel(rows, columns, filename) {
  if (!rows.length) return false

  const data = rows.map((row) => {
    const out = {}
    for (const col of columns) {
      out[col.label] = col.value ? col.value(row) : row[col.key] ?? ''
    }
    return out
  })

  const sheet = XLSX.utils.json_to_sheet(data)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Report')
  XLSX.writeFile(workbook, filename)
  return true
}
