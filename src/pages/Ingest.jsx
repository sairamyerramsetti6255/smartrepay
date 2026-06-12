import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Upload, Check, X, Loader2, Sparkles, FileSpreadsheet, FileText, Trash2 } from 'lucide-react'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { WorkflowStepper } from '@/components/WorkflowStepper'
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
  const [bankTx, setBankTx] = useState([])
  const [bankTxLoading, setBankTxLoading] = useState(true)

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
      const { inserted, staged, stagedDuplicates, stagedFileName, stagingError } =
        await api.ingest.import(parseId)
      toast.success(`Imported ${inserted} transactions — go to Match to run matching`)
      if (stagingError) {
        toast.error(`Staging to SQL failed: ${stagingError}`)
      } else if (staged > 0) {
        toast.success(
          `Staged ${staged} new credit${staged === 1 ? '' : 's'} as "${stagedFileName}"` +
            (stagedDuplicates > 0 ? ` · skipped ${stagedDuplicates} duplicate${stagedDuplicates === 1 ? '' : 's'}` : '')
        )
      } else if (stagedDuplicates > 0) {
        toast(`All ${stagedDuplicates} credit${stagedDuplicates === 1 ? '' : 's'} already staged — no new rows to match`, {
          icon: 'ℹ️',
        })
      }
      reset()
      await loadDocuments()
      await loadBankTx()
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

  async function loadBankTx() {
    setBankTxLoading(true)
    try {
      const { rows } = await api.bankTransactions.list()
      setBankTx(Array.isArray(rows) ? rows : [])
    } catch {
      setBankTx([])
    } finally {
      setBankTxLoading(false)
    }
  }

  useEffect(() => {
    loadDocuments()
    loadBankTx()
  }, [])

  const bankTxColumns = [
    { key: 'TransDate', label: 'Date', render: (r) => (r.TransDate ? formatDate(r.TransDate) : '—') },
    { key: 'BorrowerName', label: 'Borrower', render: (r) => <span className="font-medium">{r.BorrowerName || '—'}</span> },
    {
      key: 'EmiPaidAmount',
      label: 'EMI Paid',
      align: 'right',
      render: (r) => (r.EmiPaidAmount != null ? formatCurrency(r.EmiPaidAmount) : '—'),
    },
    { key: 'SourceType', label: 'Source', render: (r) => (r.SourceType ? <Badge variant="posted">{r.SourceType}</Badge> : '—') },
    { key: 'EmployerOrBank', label: 'Employer / Bank', render: (r) => r.EmployerOrBank || '—' },
    { key: 'ReferenceNo', label: 'Reference', render: (r) => <span className="mono text-[12px]">{r.ReferenceNo || '—'}</span> },
    {
      key: 'FileName',
      label: 'File',
      render: (r) => <span className="text-[12px] text-[var(--text-secondary)] truncate max-w-[200px] inline-block">{r.FileName || '—'}</span>,
    },
    { key: 'UploadedDate', label: 'Uploaded', render: (r) => (r.UploadedDate ? formatDate(r.UploadedDate) : '—') },
  ]

  async function deleteDoc(doc) {
    if (!window.confirm(`Delete "${doc.filename}" and all its staged credits from SQL Server? This cannot be undone.`)) return
    try {
      const { deleted } = await api.documents.remove(doc.id)
      toast.success(`Removed ${deleted ?? 0} staged credit(s) for ${doc.filename}`)
      loadDocuments()
      loadBankTx()
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <div className={cn('space-y-8', isPdfDoc ? 'max-w-6xl' : 'max-w-5xl')}>
      <WorkflowStepper current="upload" />

      <PageHeader
        eyebrow="Step 1 of 4"
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

      {/* Uploaded documents grid */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Uploaded documents</h2>
            <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">All imported statement files</p>
          </div>
          <span className="text-[12px] font-medium text-[var(--text-secondary)] bg-[var(--bg-subtle)] px-3 py-1 rounded-full">
            {documents.length} file{documents.length !== 1 ? 's' : ''}
          </span>
        </div>

        {docsLoading ? (
          <div className="flex justify-center py-16 card">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--text-tertiary)]" />
          </div>
        ) : documents.length === 0 ? (
          <div className="card px-6 py-14 text-center">
            <FileText className="h-10 w-10 mx-auto text-[var(--text-tertiary)] opacity-50 mb-3" />
            <p className="text-[14px] font-medium text-[var(--text-primary)]">No documents yet</p>
            <p className="text-[13px] text-[var(--text-secondary)] mt-1">Upload a file above to see it here</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {documents.map((doc) => (
              <DocumentGridCard key={doc.id} doc={doc} onDelete={() => deleteDoc(doc)} />
            ))}
          </div>
        )}
      </section>

      {/* Staged bank transactions (SQL Server: Staging_BankTransactions) */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Bank transactions (staged)</h2>
            <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
              Credit transactions extracted into Staging_BankTransactions, ready for matching
            </p>
          </div>
          <span className="text-[12px] font-medium text-[var(--text-secondary)] bg-[var(--bg-subtle)] px-3 py-1 rounded-full">
            {bankTx.length} row{bankTx.length !== 1 ? 's' : ''}
          </span>
        </div>

        {bankTxLoading ? (
          <div className="flex justify-center py-16 card">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--text-tertiary)]" />
          </div>
        ) : (
          <DataTable
            data={bankTx}
            columns={bankTxColumns}
            pageSize={25}
            sortable
            filterable
            emptyMessage="No staged bank transactions"
            emptyDescription="Import a statement above to stage credit transactions here."
          />
        )}
      </section>
    </div>
  )
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 1) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const DOC_TYPE_LABELS = {
  bank: 'Bank statement',
  employer: 'Employer report',
  spreadsheet: 'Spreadsheet',
  pdf: 'PDF',
}

function DocumentGridCard({ doc, onDelete }) {
  const ext = doc.filename?.split('.').pop()?.toLowerCase() || ''
  const isPdf = ext === 'pdf'
  const isSheet = ['csv', 'xlsx', 'xls', 'xlsm'].includes(ext)
  const total = doc.total_rows ?? 0
  const matched = doc.matched_count ?? 0
  const unmatched = doc.unmatched_count ?? 0
  const matchPct = total > 0 ? Math.round((matched / total) * 100) : 0
  const dateRange = doc.date_from
    ? `${formatDate(doc.date_from)}${doc.date_to && doc.date_to !== doc.date_from ? ` – ${formatDate(doc.date_to)}` : ''}`
    : '—'
  const typeLabel = DOC_TYPE_LABELS[doc.document_type] || (isPdf ? 'PDF' : isSheet ? 'Spreadsheet' : ext.toUpperCase())
  const sizeLabel = formatFileSize(doc.size_bytes)

  const Icon = isSheet ? FileSpreadsheet : FileText
  const iconBg = isPdf ? 'bg-[var(--danger-bg)]' : isSheet ? 'bg-[var(--success-bg)]' : 'bg-[var(--accent-subtle)]'
  const iconColor = isPdf ? 'text-[var(--danger)]' : isSheet ? 'text-[var(--success)]' : 'text-[var(--accent)]'

  return (
    <article className="card card-lift flex flex-col overflow-hidden">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-start gap-3">
          <div className={cn('h-11 w-11 shrink-0 rounded-[var(--radius-md)] flex items-center justify-center', iconBg)}>
            <Icon className={cn('h-5 w-5', iconColor)} strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-[var(--text-primary)] leading-snug line-clamp-2" title={doc.filename}>
              {doc.filename}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              <Badge variant="posted" className="text-[10px] py-0 px-1.5">{typeLabel}</Badge>
              {sizeLabel && (
                <span className="text-[10px] text-[var(--text-tertiary)] mono">{sizeLabel}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 pb-3 space-y-2.5 flex-1 text-[12px] border-t border-[var(--border-light)] pt-3">
        <div className="flex justify-between gap-2">
          <span className="text-[var(--text-tertiary)]">Uploaded</span>
          <span className="text-[var(--text-secondary)] font-medium">
            {doc.created_at ? formatDate(doc.created_at.slice(0, 10)) : '—'}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-[var(--text-tertiary)]">Txn dates</span>
          <span className="text-[var(--text-secondary)] font-medium text-right truncate max-w-[58%]" title={dateRange}>
            {dateRange}
          </span>
        </div>
        {total > 0 && (
          <div className="pt-1">
            <div className="flex justify-between text-[11px] mb-1.5">
              <span className="text-[var(--text-tertiary)]">Match rate</span>
              <span className="mono font-semibold text-[var(--text-primary)]">{matchPct}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-[var(--bg-subtle)] overflow-hidden flex">
              <div
                className="h-full bg-[var(--success)] transition-all duration-300"
                style={{ width: `${matchPct}%` }}
              />
              {unmatched > 0 && (
                <div
                  className="h-full bg-[var(--danger)]/70"
                  style={{ width: `${100 - matchPct}%` }}
                />
              )}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 divide-x divide-[var(--border-light)] border-t border-[var(--border-light)] bg-[var(--bg-subtle)]/30">
        <div className="px-3 py-3 text-center">
          <p className="mono text-[17px] font-bold text-[var(--text-primary)] leading-none">{total}</p>
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] mt-1">Rows</p>
        </div>
        <div className="px-3 py-3 text-center">
          <p className="mono text-[17px] font-bold text-[var(--success)] leading-none">{matched}</p>
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] mt-1">Matched</p>
        </div>
        <div className="px-3 py-3 text-center">
          <p className="mono text-[17px] font-bold text-[var(--danger)] leading-none">{unmatched}</p>
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] mt-1">Unmatched</p>
        </div>
      </div>

      <div className="px-4 py-3 border-t border-[var(--border-light)]">
        <Button variant="secondary" size="sm" className="w-full text-[var(--danger)]" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </article>
  )
}
