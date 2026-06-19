import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Upload, Check, X, Loader2, Sparkles, FileSpreadsheet, FileText, Trash2, RefreshCw, ArrowRight } from 'lucide-react'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { WorkflowStepper } from '@/components/WorkflowStepper'
import { formatCurrency, formatDate, cn } from '@/lib/utils'

const ACCEPT = '.csv,.xlsx,.xls,.xlsm,.pdf'
const ALLOWED = ['csv', 'xlsx', 'xls', 'xlsm', 'pdf']

const BOTTOM_TABS = [
  { id: 'files', label: 'Imported files' },
  { id: 'staged', label: 'Staged rows' },
]

const BANK_COLUMNS = [
  { key: 'datePosted', label: 'Date Posted' },
  { key: 'valueDate', label: 'Value Date' },
  { key: 'reference', label: 'Reference' },
  { key: 'particulars', label: 'Particulars' },
  { key: 'name', label: 'Name' },
  { key: 'creditAmount', label: 'Amount', align: 'right' },
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
  const navigate = useNavigate()
  const location = useLocation()
  const [tab, setTab] = useState('files')
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
  const [uploadOpen, setUploadOpen] = useState(false)

  const isBankPdf = source === 'bank' || source === 'pdf'
  const isEmployerPdf = source === 'employer'
  const isPdfDoc = isBankPdf || isEmployerPdf
  const tableColumns = isEmployerPdf ? EMPLOYER_COLUMNS : BANK_COLUMNS
  const showUpload = !parseReady && !preview.length

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
      return toast.error('Use CSV, Excel (.xlsx, .xls), or PDF')
    }

    setParsing(true)
    setParseReady(false)
    setFileName(file.name)

    try {
      const result = await api.ingest.parse(file)
      const rowCount = result.rowCount ?? 0
      if (!rowCount) throw new Error('No transactions found in file')

      const dupCount = result.duplicateCount ?? 0
      const ready = result.readyCount ?? rowCount - dupCount
      const nextSource = result.documentType || result.source || (result.method === 'pdf' ? 'bank' : 'spreadsheet')
      const totalCredits = result.creditCount ?? rowCount

      setParsing(false)
      setParseReady(true)
      setParseId(result.parseId)
      setRawRows(result.rawRows || [])
      setCreditRows(result.creditRows || [])
      setCreditCount(totalCredits)
      setPreview(Array.isArray(result.rows) ? result.rows : [])
      setDuplicates(dupCount)
      setReadyCount(ready)
      setParseMethod(result.method || 'standard')
      setSource(nextSource)

      toast.success(`Parsed ${totalCredits} transaction${totalCredits === 1 ? '' : 's'}`)
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
      toast.success(`Imported ${inserted} transactions`)
      if (stagingError) toast.error(`Staging failed: ${stagingError}`)
      else if (staged > 0) {
        toast.success(`Staged ${staged} credits as "${stagedFileName}"`)
      } else if (stagedDuplicates > 0) {
        toast(`All credits already staged`, { icon: 'ℹ️' })
      }
      reset()
      setUploadOpen(false)
      await loadDocuments()
      await loadBankTx()
      setTab('files')
      window.dispatchEvent(new Event('smartrepay:demo-loaded'))
    } catch (e) {
      toast.error(e.message)
    } finally {
      setImporting(false)
    }
  }

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

  useEffect(() => {
    if (!uploadOpen) return
    setUploadOpen(false)
    reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  function goToMatch(doc) {
    navigate(`/match?file=${encodeURIComponent(doc.filename)}`)
  }

  async function refreshAll() {
    await Promise.all([loadDocuments(), loadBankTx()])
  }

  async function deleteDoc(doc) {
    if (!window.confirm(`Delete "${doc.filename}" and all its staged credits?`)) return
    try {
      const { deleted } = await api.documents.remove(doc.id)
      toast.success(`Removed ${deleted ?? 0} credit(s)`)
      loadDocuments()
      loadBankTx()
    } catch (e) {
      toast.error(e.message)
    }
  }

  function closeUploadModal() {
    if (parsing || importing) return
    setUploadOpen(false)
    reset()
  }

  const displayCreditRows = creditRows.length ? creditRows : rawRows
  const ready = readyCount

  const bankTxColumns = [
    { key: 'TransDate', label: 'Date', render: (r) => (r.TransDate ? formatDate(r.TransDate) : '—') },
    { key: 'BorrowerName', label: 'Borrower', render: (r) => <span className="font-medium">{r.BorrowerName || '—'}</span> },
    {
      key: 'EmiPaidAmount',
      label: 'Amount',
      align: 'right',
      render: (r) => (r.EmiPaidAmount != null ? formatCurrency(r.EmiPaidAmount) : '—'),
    },
    { key: 'SourceType', label: 'Source', render: (r) => (r.SourceType ? <Badge variant="posted">{r.SourceType}</Badge> : '—') },
    { key: 'FileName', label: 'File', render: (r) => <span className="text-[12px] text-[var(--text-secondary)] truncate max-w-[180px] inline-block">{r.FileName || '—'}</span> },
    { key: 'ReferenceNo', label: 'Reference', render: (r) => <span className="mono text-[12px]">{r.ReferenceNo || '—'}</span> },
  ]

  return (
    <div className="-mt-2 flex flex-col gap-4 pb-6 min-h-[calc(100vh-10rem)]">
      <WorkflowStepper current="upload" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[var(--text-primary)] tracking-[-0.02em]">Upload Documents</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="h-4 w-4" />
            Upload
          </Button>
          <Button variant="secondary" size="sm" onClick={refreshAll} disabled={docsLoading || bankTxLoading}>
            <RefreshCw className={cn('h-4 w-4', (docsLoading || bankTxLoading) && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <UploadModal
        open={uploadOpen}
        onClose={closeUploadModal}
        showUpload={showUpload}
        parsing={parsing}
        dragOver={dragOver}
        setDragOver={setDragOver}
        parseFile={parseFile}
        inputRef={inputRef}
        accept={ACCEPT}
        fileName={fileName}
        isPdfDoc={isPdfDoc}
        isEmployerPdf={isEmployerPdf}
        isBankPdf={isBankPdf}
        parseMethod={parseMethod}
        creditCount={creditCount}
        displayCreditRows={displayCreditRows}
        preview={preview}
        tableColumns={tableColumns}
        duplicates={duplicates}
        ready={ready}
        importing={importing}
        reset={reset}
        confirmImport={confirmImport}
      />

      {/* Imported files & staged rows — fills viewport */}
      <div className="flex-1 min-h-[280px] flex flex-col rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-[var(--shadow-xs)] overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]/40 shrink-0">
          {BOTTOM_TABS.map((t) => {
            const c = t.id === 'files' ? documents.length : bankTx.length
            const active = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-md)] text-[12px] font-semibold transition-colors',
                  active
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-card)]'
                )}
              >
                {t.label}
                <span
                  className={cn(
                    'mono text-[10px] font-bold px-1.5 py-px rounded-full min-w-[1.1rem] text-center',
                    active ? 'bg-white/25' : 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]'
                  )}
                >
                  {c}
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          {tab === 'files' ? (
            <FilesTab
              documents={documents}
              loading={docsLoading}
              onDelete={deleteDoc}
              onMatch={goToMatch}
              onUpload={() => setUploadOpen(true)}
            />
          ) : (
            <StagedTab rows={bankTx} columns={bankTxColumns} loading={bankTxLoading} />
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Upload modal ───────────────────────────────────────────────────── */

function UploadModal({
  open,
  onClose,
  showUpload,
  parsing,
  dragOver,
  setDragOver,
  parseFile,
  inputRef,
  accept,
  fileName,
  isPdfDoc,
  isEmployerPdf,
  isBankPdf,
  parseMethod,
  creditCount,
  displayCreditRows,
  preview,
  tableColumns,
  duplicates,
  ready,
  importing,
  reset,
  confirmImport,
}) {
  useEffect(() => {
    if (!open) return
    const onEsc = (e) => {
      if (e.key === 'Escape' && !parsing && !importing) onClose()
    }
    window.addEventListener('keydown', onEsc)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onEsc)
      document.body.style.overflow = ''
    }
  }, [open, onClose, parsing, importing])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="presentation"
    >
      <div
        className="modal-backdrop absolute inset-0 bg-[rgba(28,27,24,0.45)] backdrop-blur-[6px]"
        onClick={() => !parsing && !importing && onClose()}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-modal-title"
        className="modal-panel relative z-[1] w-full max-w-3xl max-h-[min(85vh,760px)] flex flex-col overflow-hidden bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-xl)]"
        style={{ boxShadow: '0 24px 80px rgba(28, 27, 24, 0.22), 0 8px 24px rgba(28, 27, 24, 0.12)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex justify-between items-center px-6 h-14 border-b border-[var(--border-light)] shrink-0 bg-[var(--bg-card)]">
          <h2 id="upload-modal-title" className="text-[15px] font-semibold text-[var(--text-primary)]">
            Upload & import
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={parsing || importing}
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <UploadPanel
            showUpload={showUpload}
            parsing={parsing}
            dragOver={dragOver}
            setDragOver={setDragOver}
            parseFile={parseFile}
            inputRef={inputRef}
            accept={accept}
            fileName={fileName}
            isPdfDoc={isPdfDoc}
            isEmployerPdf={isEmployerPdf}
            isBankPdf={isBankPdf}
            parseMethod={parseMethod}
            creditCount={creditCount}
            displayCreditRows={displayCreditRows}
            preview={preview}
            tableColumns={tableColumns}
            duplicates={duplicates}
            ready={ready}
            importing={importing}
            reset={reset}
            confirmImport={confirmImport}
          />
        </div>
      </div>
    </div>,
    document.body
  )
}

/* ── Upload panel (inside modal) ────────────────────────────────────── */

function UploadPanel({
  showUpload,
  parsing,
  dragOver,
  setDragOver,
  parseFile,
  inputRef,
  accept,
  fileName,
  isPdfDoc,
  isEmployerPdf,
  isBankPdf,
  parseMethod,
  creditCount,
  displayCreditRows,
  preview,
  tableColumns,
  duplicates,
  ready,
  importing,
  reset,
  confirmImport,
}) {
  if (showUpload) {
    return (
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          parseFile(e.dataTransfer.files[0])
        }}
        className={cn(
          'flex flex-col items-center justify-center text-center mx-5 my-5 px-6 py-14 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-light)] bg-[var(--bg-subtle)]/30 transition-colors',
          dragOver ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)]' : '',
          parsing && 'pointer-events-none opacity-70'
        )}
      >
        {parsing ? (
          <>
            <Loader2 className="h-8 w-8 text-[var(--accent)] animate-spin mb-3" />
            <p className="text-[14px] font-medium text-[var(--text-primary)]">Processing {fileName}</p>
          </>
        ) : (
          <>
            <div className="h-11 w-11 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] flex items-center justify-center mb-3">
              <Upload className="h-5 w-5 text-[var(--text-tertiary)]" strokeWidth={1.75} />
            </div>
            <p className="text-[14px] font-semibold text-[var(--text-primary)]">Drop a statement or browse</p>
            <p className="text-[12px] text-[var(--text-tertiary)] mt-1">CSV · Excel · PDF (bank or employer)</p>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              className="hidden"
              onChange={(e) => {
                parseFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <Button variant="secondary" size="sm" className="mt-4" onClick={() => inputRef.current?.click()}>
              <FileSpreadsheet className="h-4 w-4" />
              Browse file
            </Button>
            <p className="text-[10px] text-[var(--text-tertiary)] mt-3 flex items-center gap-1">
              <Sparkles className="h-3 w-3" /> AI mapping for non-standard formats
            </p>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* File bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]/30">
        <div className="flex items-center gap-2.5 min-w-0">
          <Check className="h-4 w-4 text-[var(--success)] shrink-0" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">{fileName}</p>
            <p className="text-[11px] text-[var(--text-tertiary)]">
              {isEmployerPdf ? `${creditCount} deductions` : isBankPdf ? `${creditCount} credits` : `${preview.length} rows`}
              {parseMethod === 'ai' && ' · AI'}
            </p>
          </div>
          {isEmployerPdf && <Badge variant="posted" className="text-[10px]">Employer</Badge>}
          {isBankPdf && <Badge variant="posted" className="text-[10px]">Bank</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8" onClick={reset}>
            <X className="h-3.5 w-3.5" /> Remove
          </Button>
          <Button size="sm" className="h-8" disabled={importing || !ready} onClick={confirmImport}>
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Import {ready} rows
          </Button>
        </div>
      </div>

      {duplicates > 0 && (
        <p className="px-6 py-2.5 text-[12px] text-[var(--warning)] bg-[var(--warning-bg)] border-b border-[var(--warning-border)]">
          {duplicates} duplicate{duplicates === 1 ? '' : 's'} will be skipped
        </p>
      )}

      {/* Preview table */}
      <div className="overflow-x-auto px-2 pb-2">
        {isPdfDoc ? (
          <PreviewTable rows={displayCreditRows.slice(0, 12)} columns={tableColumns} isPdf />
        ) : (
          <PreviewTable
            rows={preview.slice(0, 10).map((r) => ({
              date: formatDate(r.date),
              payer: r.payer,
              creditAmount: formatCurrency(r.amount),
              _dim: r._duplicate,
            }))}
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'payer', label: 'Payer' },
              { key: 'creditAmount', label: 'Amount', align: 'right' },
            ]}
          />
        )}
        {(isPdfDoc ? displayCreditRows.length : preview.length) > 10 && (
          <p className="px-4 py-2.5 text-[11px] text-[var(--text-tertiary)] border-t border-[var(--border-light)]">
            +{(isPdfDoc ? displayCreditRows.length : preview.length) - 10} more rows
          </p>
        )}
      </div>
    </div>
  )
}

function PreviewTable({ rows, columns, isPdf }) {
  return (
    <table className="w-full text-[12px] min-w-[600px]">
      <thead>
        <tr className="bg-[var(--bg-subtle)]/60 border-b border-[var(--border-light)]">
          {columns.map((col) => (
            <th
              key={col.key}
              className={cn(
                'px-4 py-2 font-semibold text-[var(--text-tertiary)] uppercase tracking-wider text-[10px] whitespace-nowrap',
                col.align === 'right' ? 'text-right' : 'text-left'
              )}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={cn('border-b border-[var(--border-light)] last:border-0', r._dim && 'opacity-40')}>
            {columns.map((col) => {
              const val = r[col.key]
              if (col.key === 'creditAmount' && isPdf) {
                return (
                  <td key={col.key} className="px-4 py-2 text-right mono font-medium text-[var(--success)]">
                    {formatCurrency(r.creditAmount)}
                  </td>
                )
              }
              if (col.key === 'datePosted' || col.key === 'valueDate') {
                return (
                  <td key={col.key} className="px-4 py-2 whitespace-nowrap">{formatDate(r[col.key])}</td>
                )
              }
              return (
                <td
                  key={col.key}
                  className={cn(
                    'px-4 py-2 text-[var(--text-secondary)]',
                    col.align === 'right' && 'text-right mono',
                    col.key === 'name' && 'font-medium text-[var(--text-primary)]',
                    (col.key === 'particulars' || col.key === 'remarks') && 'max-w-[200px] truncate'
                  )}
                  title={col.key === 'particulars' || col.key === 'remarks' ? val : undefined}
                >
                  {val ?? '—'}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/* ── Files tab ──────────────────────────────────────────────────────── */

function FilesTab({ documents, loading, onDelete, onMatch, onUpload }) {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    )
  }
  if (documents.length === 0) {
    return (
      <div className="px-4 py-16 text-center">
        <div className="h-12 w-12 mx-auto rounded-[var(--radius-md)] bg-[var(--bg-subtle)] flex items-center justify-center mb-3">
          <FileText className="h-6 w-6 text-[var(--text-tertiary)] opacity-60" />
        </div>
        <p className="text-[13px] font-medium text-[var(--text-secondary)]">No imported files yet</p>
        <p className="text-[12px] text-[var(--text-tertiary)] mt-1 mb-4">Upload a bank or employer statement to get started</p>
        <Button size="sm" onClick={onUpload}>
          <Upload className="h-4 w-4" />
          Upload file
        </Button>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
      {documents.map((doc) => (
        <DocumentGridCard key={doc.id} doc={doc} onDelete={() => onDelete(doc)} onMatch={() => onMatch(doc)} />
      ))}
    </div>
  )
}

const DOC_TYPE_LABELS = {
  bank: 'Bank statement',
  employer: 'Employer report',
  spreadsheet: 'Spreadsheet',
  pdf: 'PDF',
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 1) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DocumentGridCard({ doc, onDelete, onMatch }) {
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
    <article
      className="card card-lift flex flex-col overflow-hidden cursor-pointer group"
      onClick={onMatch}
      onKeyDown={(e) => e.key === 'Enter' && onMatch()}
      role="button"
      tabIndex={0}
      title="Open matching for this file"
    >
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

      <div className="px-4 py-3 border-t border-[var(--border-light)] flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          onClick={(e) => {
            e.stopPropagation()
            onMatch()
          }}
        >
          <ArrowRight className="h-3.5 w-3.5" />
          Match
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="text-[var(--danger)]"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </article>
  )
}

/* ── Staged tab ─────────────────────────────────────────────────────── */

function StagedTab({ rows, columns, loading }) {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <p className="text-[13px] font-medium text-[var(--text-secondary)]">No staged transactions</p>
        <p className="text-[12px] text-[var(--text-tertiary)] mt-1">Import a file to stage credits for matching</p>
      </div>
    )
  }

  return (
    <DataTable
      data={rows}
      columns={columns}
      pageSize={20}
      sortable
      filterable
      emptyMessage="No rows"
    />
  )
}