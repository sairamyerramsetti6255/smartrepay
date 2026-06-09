import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Upload, Check, X, Loader2, Sparkles, FileSpreadsheet, FileText, Download } from 'lucide-react'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { Badge } from '@/components/Badge'
import { formatCurrency, formatDate, cn } from '@/lib/utils'

const ACCEPT = '.csv,.xlsx,.xls,.xlsm,.pdf'
const ALLOWED = ['csv', 'xlsx', 'xls', 'xlsm', 'pdf']

const BANK_COLUMNS = [
  { key: 'datePosted', label: 'Date Posted' },
  { key: 'valueDate', label: 'Value Date' },
  { key: 'reference', label: 'Reference No.' },
  { key: 'particulars', label: 'Particulars' },
  { key: 'name', label: 'Name' },
  { key: 'creditAmount', label: 'Credit Amount', align: 'right' },
]

const EMPLOYER_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'valueDate', label: 'Date' },
  { key: 'creditAmount', label: 'Amount', align: 'right' },
  { key: 'remarks', label: 'Remarks' },
  { key: 'employer', label: 'Employer' },
]

export function Ingest() {
  const inputRef = useRef(null)
  const [preview, setPreview] = useState([])
  const [rawRows, setRawRows] = useState([])
  const [creditRows, setCreditRows] = useState([])
  const [creditCount, setCreditCount] = useState(0)
  const [fileName, setFileName] = useState('')
  const [parseMethod, setParseMethod] = useState('standard')
  const [source, setSource] = useState('spreadsheet')
  const [duplicates, setDuplicates] = useState(0)
  const [readyCount, setReadyCount] = useState(0)
  const [parseId, setParseId] = useState(null)
  const [importing, setImporting] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [parseReady, setParseReady] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [documents, setDocuments] = useState([])
  const [docsLoading, setDocsLoading] = useState(true)

  const isBankPdf = source === 'bank' || source === 'pdf'
  const isEmployerPdf = source === 'employer'
  const isPdfDoc = isBankPdf || isEmployerPdf
  const tableColumns = isEmployerPdf ? EMPLOYER_COLUMNS : BANK_COLUMNS

  const reset = () => {
    setPreview([])
    setRawRows([])
    setCreditRows([])
    setCreditCount(0)
    setFileName('')
    setParseMethod('standard')
    setSource('spreadsheet')
    setDuplicates(0)
    setReadyCount(0)
    setParseId(null)
    setParsing(false)
    setParseReady(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const parseFile = useCallback(async (file) => {
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!ALLOWED.includes(ext)) {
      return toast.error('Use CSV, Excel (.xlsx, .xls), or PDF (bank or employer statements)')
    }

    setParsing(true)
    setParseReady(false)
    setFileName(file.name)

    try {
      const result = await api.ingest.parse(file)
      const rowCount = result.rowCount ?? 0

      if (!rowCount) {
        throw new Error('No transactions found in file')
      }

      const dupCount = result.duplicateCount ?? 0
      const ready = result.readyCount ?? rowCount - dupCount
      const nextSource = result.documentType || result.source || (result.method === 'pdf' ? 'bank' : 'spreadsheet')
      const totalCredits = result.creditCount ?? rowCount
      const previewRows = Array.isArray(result.rows) ? result.rows : []

      setParsing(false)
      setParseReady(true)
      setParseId(result.parseId)
      setRawRows(result.rawRows || [])
      setCreditRows(result.creditRows || [])
      setCreditCount(totalCredits)
      setPreview(previewRows)
      setDuplicates(dupCount)
      setReadyCount(ready)
      setParseMethod(result.method || 'standard')
      setSource(nextSource)

      toast.success(
        nextSource === 'employer'
          ? `Extracted ${totalCredits} salary deductions from employer statement`
          : nextSource === 'bank' || result.method === 'pdf'
            ? `Extracted ${totalCredits} credit transactions from bank statement`
            : result.method === 'ai'
              ? `AI extracted ${rowCount} transactions`
              : `Parsed ${rowCount} transactions`
      )
    } catch (e) {
      setParsing(false)
      setParseReady(false)
      toast.error(e.message)
      reset()
    }
  }, [])

  async function confirmImport() {
    if (!parseId) return toast.error('Upload the file again before importing')
    if (!readyCount) return toast.error('No new rows to import')
    setImporting(true)
    try {
      const { inserted } = await api.ingest.import(parseId)
      toast.success(`Imported ${inserted} transactions — go to Match to run matching`)
      reset()
      await loadDocuments()
      window.dispatchEvent(new Event('smartrepay:demo-loaded'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      setImporting(false)
    }
  }

  const ready = readyCount
  const displayCreditRows = creditRows.length ? creditRows : rawRows
  const showUpload = !parseReady && !preview.length

  async function loadDocuments() {
    setDocsLoading(true)
    try {
      const docs = await api.documents.list()
      setDocuments(Array.isArray(docs) ? docs : [])
    } catch {
      setDocuments([])
    } finally {
      setDocsLoading(false)
    }
  }

  useEffect(() => {
    loadDocuments()
  }, [])

  async function downloadDoc(doc) {
    try {
      await api.documents.download(doc.id, doc.filename)
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <div className={cn('space-y-8', isPdfDoc ? 'max-w-6xl' : 'max-w-5xl')}>
      <PageHeader
        title="Upload Documents"
        subtitle="Upload bank statements (CSV, Excel, PDF) or employer salary reports. Imported files are saved and listed below."
      />

      <div className="flex items-center gap-3 text-[13px]">
        {['Upload', 'Preview', 'Import'].map((step, i) => {
          const active = showUpload ? i === 0 : !importing ? i <= 1 : i <= 2
          return (
            <div key={step} className="flex items-center gap-3">
              {i > 0 && <div className="w-8 h-px bg-[var(--border-light)]" />}
              <span
                className={cn(
                  'flex items-center gap-2',
                  active ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-tertiary)]'
                )}
              >
                <span
                  className={cn(
                    'h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold',
                    active ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-subtle)]'
                  )}
                >
                  {i + 1}
                </span>
                {step}
              </span>
            </div>
          )
        })}
      </div>

      {showUpload ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            parseFile(e.dataTransfer.files[0])
          }}
          className={cn(
            'relative rounded-[var(--radius-xl)] bg-[var(--bg-card)] text-center transition-all duration-200',
            'py-20 px-12 border-2 border-dashed shadow-[var(--shadow-xs)]',
            dragOver ? 'border-[var(--accent)] bg-[var(--accent-subtle)] scale-[1.01]' : 'border-[var(--border-medium)]',
            parsing && 'pointer-events-none opacity-70'
          )}
        >
          {parsing ? (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-10 w-10 text-[var(--accent)] animate-spin" strokeWidth={1.75} />
              <p className="text-[15px] font-medium text-[var(--text-primary)]">
                {fileName.toLowerCase().endsWith('.pdf') ? 'Reading PDF statement…' : 'Extracting transactions…'}
              </p>
              <p className="text-[13px] text-[var(--text-tertiary)]">Processing {fileName}</p>
            </div>
          ) : (
            <>
              <div className="h-14 w-14 mx-auto mb-5 rounded-[var(--radius-lg)] bg-[var(--bg-subtle)] flex items-center justify-center">
                <FileSpreadsheet className="h-7 w-7 text-[var(--text-tertiary)]" strokeWidth={1.5} />
              </div>
              <p className="text-[17px] font-semibold text-[var(--text-primary)] tracking-[-0.01em]">
                Drop your statement here
              </p>
              <p className="text-[13px] text-[var(--text-tertiary)] mt-2 max-w-md mx-auto leading-relaxed">
                CSV, Excel, or PDF · Max 10MB
                <br />
                Bank PDFs: credit transactions · Employer PDFs: name, date, amount, remarks
              </p>
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  parseFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
              <Button
                variant="secondary"
                className="mt-8 min-w-[160px]"
                onClick={() => inputRef.current?.click()}
              >
                <Upload className="h-4 w-4" strokeWidth={1.75} />
                Browse file
              </Button>
              <p className="text-[11px] text-[var(--text-tertiary)] mt-6 flex items-center justify-center gap-1.5">
                <Sparkles className="h-3 w-3" />
                AI-assisted mapping for non-standard spreadsheet formats
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="card px-6 py-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-9 w-9 rounded-[var(--radius-md)] bg-[var(--success-bg)] flex items-center justify-center shrink-0">
                {isPdfDoc ? (
                  <FileText className="h-4 w-4 text-[var(--success)]" strokeWidth={2} />
                ) : (
                  <Check className="h-4 w-4 text-[var(--success)]" strokeWidth={2} />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-[var(--text-primary)] truncate">{fileName}</p>
                <p className="text-[12px] text-[var(--text-tertiary)]">
                  {isEmployerPdf
                    ? `${creditCount || displayCreditRows.length} salary deductions`
                    : isBankPdf
                      ? `${creditCount || displayCreditRows.length} credit transactions`
                      : `${preview.length} rows detected`}
                </p>
              </div>
              {isEmployerPdf && (
                <Badge variant="posted" className="shrink-0">Employer statement</Badge>
              )}
              {isBankPdf && (
                <Badge variant="posted" className="shrink-0">Bank statement</Badge>
              )}
              {parseMethod === 'ai' && (
                <Badge variant="posted" className="shrink-0">
                  <Sparkles className="h-3 w-3 mr-1" /> AI extracted
                </Badge>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={reset}>
              <X className="h-4 w-4" /> Remove
            </Button>
          </div>

          {duplicates > 0 && (
            <div className="rounded-[var(--radius-md)] border border-[var(--warning-border)] bg-[var(--warning-bg)] px-5 py-3.5 text-[13px] text-[var(--warning)]">
              {duplicates} duplicate transactions were detected and will be excluded on import
            </div>
          )}

          {isPdfDoc ? (
            <Card>
              <CardHeader
                title={isEmployerPdf ? 'Salary deductions' : 'Credit transactions'}
                subtitle={
                  isEmployerPdf
                    ? 'Employee name, transaction date, amount, remarks, and employer'
                    : 'Date posted, value date, reference, particulars, name (from |), and credit amount'
                }
              />
              <CardBody className="p-0 pt-0 overflow-x-auto">
                <table className="w-full text-[12px] min-w-[900px]">
                  <thead>
                    <tr className="bg-[#FAFAF8] border-b border-[var(--border-light)]">
                      {tableColumns.map((col) => (
                        <th
                          key={col.key}
                          className={cn(
                            'px-4 py-2.5 font-semibold text-[var(--text-tertiary)] uppercase tracking-wider whitespace-nowrap',
                            col.align === 'right' ? 'text-right' : 'text-left'
                          )}
                        >
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayCreditRows.slice(0, 15).map((r, i) => (
                      <tr key={i} className="border-b border-[var(--border-light)] last:border-0 hover:bg-[var(--bg-subtle)]/50">
                        {tableColumns.map((col) => {
                          const val = r[col.key] ?? r.particulars
                          if (col.key === 'creditAmount') {
                            return (
                              <td key={col.key} className="px-4 py-3 text-right mono font-medium text-[var(--success)]">
                                {formatCurrency(r.creditAmount)}
                              </td>
                            )
                          }
                          if (col.key === 'datePosted' || col.key === 'valueDate') {
                            return (
                              <td key={col.key} className="px-4 py-3 whitespace-nowrap">
                                {formatDate(r[col.key])}
                              </td>
                            )
                          }
                          if (col.key === 'name') {
                            return (
                              <td key={col.key} className="px-4 py-3 font-medium text-[var(--text-primary)] whitespace-nowrap">
                                {r.name || '—'}
                              </td>
                            )
                          }
                          return (
                            <td
                              key={col.key}
                              className={cn(
                                'px-4 py-3 text-[var(--text-secondary)]',
                                col.key === 'remarks' || col.key === 'particulars' ? 'max-w-[280px] truncate' : 'whitespace-nowrap',
                                col.key === 'reference' && 'mono'
                              )}
                              title={col.key === 'remarks' || col.key === 'particulars' ? val : undefined}
                            >
                              {val || (col.key === 'reference' ? '—' : '')}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(creditCount || displayCreditRows.length) > 15 && (
                  <p className="px-5 py-3 text-[11px] text-[var(--text-tertiary)] border-t border-[var(--border-light)]">
                    +{(creditCount || displayCreditRows.length) - 15} more rows
                  </p>
                )}
              </CardBody>
            </Card>
          ) : (
            <div className="grid lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader title="Source preview" subtitle="First rows from your file" />
                <CardBody className="p-0 pt-0 overflow-hidden">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-[#FAFAF8] border-b border-[var(--border-light)]">
                        <th className="px-5 py-2.5 text-left font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">Payer</th>
                        <th className="px-5 py-2.5 text-right font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rawRows.map((r, i) => (
                        <tr key={i} className="border-b border-[var(--border-light)] last:border-0">
                          <td className="px-5 py-3 text-[var(--text-secondary)] truncate max-w-[180px]">
                            {r.payer || r.Payer || r.beneficiary || r.Beneficiary || r.description || r.Description || '—'}
                          </td>
                          <td className="px-5 py-3 text-right mono text-[var(--text-primary)]">
                            {r.amount ?? r.Amount ?? r.creditAmount ?? '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Normalized records" subtitle="Ready for reconciliation" />
                <CardBody className="p-0 pt-0 overflow-hidden">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-[#FAFAF8] border-b border-[var(--border-light)]">
                        <th className="px-4 py-2.5 text-left font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">Date</th>
                        <th className="px-4 py-2.5 text-left font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">Payer</th>
                        <th className="px-4 py-2.5 text-right font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.slice(0, 8).map((r, i) => (
                        <tr
                          key={i}
                          className={cn('border-b border-[var(--border-light)] h-11', r._duplicate && 'opacity-40')}
                        >
                          <td className="px-4">
                            <span className="inline-block px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[11px] font-medium">
                              {formatDate(r.date)}
                            </span>
                          </td>
                          <td className="px-4 font-medium text-[var(--text-primary)] truncate max-w-[100px]">{r.payer}</td>
                          <td className="px-4 text-right mono font-medium">{formatCurrency(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.length > 8 && (
                    <p className="px-5 py-3 text-[11px] text-[var(--text-tertiary)] border-t border-[var(--border-light)]">
                      +{preview.length - 8} more rows
                    </p>
                  )}
                </CardBody>
              </Card>
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-[var(--border-light)]">
            <p className="text-[14px] text-[var(--text-secondary)]">
              <span className="font-semibold text-[var(--text-primary)] mono">{ready}</span> transactions ready to import
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={reset}>Cancel</Button>
              <Button disabled={importing || !ready} onClick={confirmImport}>
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Import Transactions →
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Uploaded documents */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Uploaded documents</h2>
          <span className="text-[12px] text-[var(--text-tertiary)]">{documents.length} file{documents.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="card overflow-hidden">
          {docsLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--text-tertiary)]" />
            </div>
          ) : documents.length === 0 ? (
            <p className="px-6 py-10 text-center text-[13px] text-[var(--text-secondary)]">
              No documents uploaded yet. Upload a file above to get started.
            </p>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border-light)] bg-[var(--bg-subtle)] text-left text-[11px] uppercase tracking-wider text-[var(--text-tertiary)]">
                  <th className="px-5 py-3 font-semibold">Document</th>
                  <th className="px-3 py-3 font-semibold">Uploaded</th>
                  <th className="px-3 py-3 font-semibold">Transaction dates</th>
                  <th className="px-3 py-3 font-semibold text-right">Rows</th>
                  <th className="px-3 py-3 font-semibold text-right">Matched</th>
                  <th className="px-3 py-3 font-semibold text-right">Unmatched</th>
                  <th className="px-5 py-3 font-semibold text-right">Download</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id} className="border-b border-[var(--border-light)] last:border-0 hover:bg-[var(--bg-hover)]">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-[var(--accent)] shrink-0" />
                        <span className="font-medium text-[var(--text-primary)] truncate max-w-[240px]">{doc.filename}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-[var(--text-secondary)] whitespace-nowrap">
                      {doc.created_at ? formatDate(doc.created_at.slice(0, 10)) : '—'}
                    </td>
                    <td className="px-3 py-3 text-[var(--text-secondary)] whitespace-nowrap">
                      {doc.date_from ? (
                        <>
                          {formatDate(doc.date_from)}
                          {doc.date_to && doc.date_to !== doc.date_from ? ` – ${formatDate(doc.date_to)}` : ''}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-3 text-right mono text-[var(--text-secondary)]">{doc.total_rows ?? 0}</td>
                    <td className="px-3 py-3 text-right mono font-medium text-[var(--success)]">{doc.matched_count ?? 0}</td>
                    <td className="px-3 py-3 text-right mono font-medium text-[var(--danger)]">{doc.unmatched_count ?? 0}</td>
                    <td className="px-5 py-3 text-right">
                      <Button variant="secondary" size="sm" onClick={() => downloadDoc(doc)}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
