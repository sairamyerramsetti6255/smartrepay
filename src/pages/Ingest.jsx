import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Upload, Check, X, Loader2, Sparkles, FileSpreadsheet, FileText, Trash2, RefreshCw, ArrowRight, Building2, ImageIcon } from 'lucide-react'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { WorkflowStepper } from '@/components/WorkflowStepper'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { parsePipeParticulars } from '@/lib/particulars'

const DOCUMENT_TYPES = [
  {
    id: 'bank',
    label: 'Bank statement',
    hint: 'PDF or spreadsheet with credit transactions',
    accept: '.pdf,.csv,.xlsx,.xls,.xlsm',
    exts: ['pdf', 'csv', 'xlsx', 'xls', 'xlsm'],
    icon: FileText,
  },
  {
    id: 'employer',
    label: 'Employer statement',
    hint: 'Payroll deductions — employee name and amount per row',
    accept: '.pdf,.csv,.xlsx,.xls,.xlsm',
    exts: ['pdf', 'csv', 'xlsx', 'xls', 'xlsm'],
    icon: Building2,
  },
  {
    id: 'spreadsheet',
    label: 'Excel / CSV',
    hint: 'Repayment export in spreadsheet format',
    accept: '.csv,.xlsx,.xls,.xlsm',
    exts: ['csv', 'xlsx', 'xls', 'xlsm'],
    icon: FileSpreadsheet,
  },
  {
    id: 'image',
    label: 'Image / scan',
    hint: 'Photo or scan of a statement (AI extraction)',
    accept: '.png,.jpg,.jpeg,.webp',
    exts: ['png', 'jpg', 'jpeg', 'webp'],
    icon: ImageIcon,
  },
]

const ALL_EXTS = [...new Set(DOCUMENT_TYPES.flatMap((t) => t.exts))]

const BOTTOM_TABS = [
  { id: 'files', label: 'Imported files' },
  { id: 'staged', label: 'Staged rows' },
]

const BANK_COLUMNS = [
  { key: 'datePosted', label: 'Date Posted' },
  { key: 'valueDate', label: 'Value Date' },
  { key: 'reference', label: 'Reference' },
  { key: 'description', label: 'Description' },
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
  const [batchFiles, setBatchFiles] = useState([])
  const [importing, setImporting] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [parseReady, setParseReady] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [documents, setDocuments] = useState([])
  const [docsLoading, setDocsLoading] = useState(true)
  const [bankTx, setBankTx] = useState([])
  const [bankTxLoading, setBankTxLoading] = useState(true)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [documentType, setDocumentType] = useState('')
  const [fileParticulars, setFileParticulars] = useState('')

  const selectedDocType = DOCUMENT_TYPES.find((t) => t.id === documentType)
  const accept = selectedDocType?.accept || ALL_EXTS.map((e) => `.${e}`).join(',')

  const isEmployerDoc = source === 'employer'
  const isBankDoc = source === 'bank'
  const isPdfDoc = parseMethod === 'pdf' || fileName.toLowerCase().endsWith('.pdf')
  const tableColumns = isEmployerDoc ? EMPLOYER_COLUMNS : BANK_COLUMNS
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
    setBatchFiles([])
    setParsing(false)
    setParseReady(false)
    setDocumentType('')
    setFileParticulars('')
    if (inputRef.current) inputRef.current.value = ''
  }

  const mapParseResult = (result, fileName) => ({
    parseId: result.parseId,
    fileName: result.filename || fileName,
    creditCount: result.creditCount ?? result.rowCount ?? 0,
    readyCount: result.readyCount ?? 0,
    duplicateCount: result.duplicateCount ?? 0,
    rowCount: result.rowCount ?? 0,
    preview: Array.isArray(result.rows) ? result.rows : [],
    rawRows: result.rawRows || [],
    creditRows: result.creditRows || [],
    method: result.method || 'standard',
    source: result.documentType || result.source || 'spreadsheet',
    ok: true,
    error: null,
  })

  const applyBatchSummary = useCallback((files) => {
    const ok = files.filter((f) => f.ok)
    if (!ok.length) return

    const totalCredits = ok.reduce((s, f) => s + f.creditCount, 0)
    const totalReady = ok.reduce((s, f) => s + f.readyCount, 0)
    const totalDup = ok.reduce((s, f) => s + f.duplicateCount, 0)
    const combinedPreview = ok.flatMap((f) =>
      f.preview.map((r) => ({ ...r, _fileName: f.fileName }))
    )

    setBatchFiles(files)
    setParseId(ok[0].parseId)
    setParseReady(true)
    setFileName(ok.length === 1 ? ok[0].fileName : `${ok.length} files`)
    setRawRows(ok[0].rawRows)
    setCreditRows(ok[0].creditRows)
    setCreditCount(totalCredits)
    setPreview(combinedPreview)
    setDuplicates(totalDup)
    setReadyCount(totalReady)
    setParseMethod(ok[0].method)
    setSource(ok[0].source)
  }, [])

  const parseFile = useCallback(async (file) => {
    if (!file) return
    if (!documentType) {
      return toast.error('Select a document type before uploading')
    }
    const ext = file.name.split('.').pop()?.toLowerCase()
    const allowed = selectedDocType?.exts || ALL_EXTS
    if (!allowed.includes(ext)) {
      return toast.error(`For ${selectedDocType?.label || 'this type'}, use ${allowed.join(', ').toUpperCase()}`)
    }

    setParsing(true)
    setParseReady(false)
    setFileName(file.name)

    try {
      const result = await api.ingest.parse(file, {
        documentType,
        fileParticulars: fileParticulars.trim() || undefined,
      })
      const rowCount = result.rowCount ?? 0
      if (!rowCount) throw new Error('No transactions found in file')

      const dupCount = result.duplicateCount ?? 0
      const ready = result.readyCount ?? rowCount - dupCount
      const nextSource = result.documentType || result.source || (result.method === 'pdf' ? 'bank' : 'spreadsheet')
      const totalCredits = result.creditCount ?? rowCount

      setParsing(false)
      applyBatchSummary([mapParseResult(result, file.name)])

      toast.success(`Parsed ${totalCredits} transaction${totalCredits === 1 ? '' : 's'}`)
    } catch (e) {
      setParsing(false)
      setParseReady(false)
      toast.error(e.message)
      reset()
    }
  }, [documentType, fileParticulars, selectedDocType, applyBatchSummary])

  const parseFiles = useCallback(
    async (fileList, { append = false } = {}) => {
      const files = Array.from(fileList || []).filter(Boolean)
      if (!files.length) return
      if (files.length === 1 && !append) return parseFile(files[0])

      if (!documentType) return toast.error('Select a document type before uploading')
      const allowed = selectedDocType?.exts || ALL_EXTS
      for (const file of files) {
        const ext = file.name.split('.').pop()?.toLowerCase()
        if (!allowed.includes(ext)) {
          return toast.error(`${file.name}: use ${allowed.join(', ').toUpperCase()} for this type`)
        }
      }

      setParsing(true)
      if (!append) setParseReady(false)
      setFileName(`${files.length} file${files.length === 1 ? '' : 's'}`)

      try {
        const batch = await api.ingest.parseBatch(files, {
          documentType,
          fileParticulars: fileParticulars.trim() || undefined,
        })
        const parsed = (batch.results || []).map((r) =>
          r.ok
            ? mapParseResult(r, r.filename)
            : { ok: false, fileName: r.filename, error: r.error, parseId: null, creditCount: 0, readyCount: 0, duplicateCount: 0, preview: [], rawRows: [], creditRows: [], method: 'standard', source: 'spreadsheet' }
        )
        const ok = parsed.filter((r) => r.ok)
        if (!ok.length) {
          throw new Error(parsed.find((r) => r.error)?.error || 'No transactions found in uploaded files')
        }

        const merged = append ? [...batchFiles.filter((f) => f.ok), ...parsed] : parsed
        const mergedOk = merged.filter((f) => f.ok)
        applyBatchSummary(merged)

        const totalCredits = mergedOk.reduce((s, r) => s + r.creditCount, 0)
        setParsing(false)
        toast.success(`Parsed ${mergedOk.length} file${mergedOk.length === 1 ? '' : 's'} · ${totalCredits} transactions`)
        const failCount = merged.filter((r) => !r.ok).length
        if (failCount) toast.error(`${failCount} file(s) failed to parse`)
      } catch (e) {
        setParsing(false)
        if (!append) setParseReady(false)
        toast.error(e.message)
        if (!append) reset()
      }
    },
    [documentType, fileParticulars, selectedDocType, parseFile, batchFiles, applyBatchSummary]
  )

  function removeBatchFile(parseIdToRemove) {
    const next = batchFiles.filter((f) => f.parseId !== parseIdToRemove)
    if (!next.length) {
      reset()
      return
    }
    const ok = next.filter((f) => f.ok)
    if (!ok.length) {
      reset()
      return
    }
    applyBatchSummary(next)
  }

  function addMoreFiles() {
    inputRef.current?.click()
  }

  async function confirmImport() {
    let ids = batchFiles.filter((f) => f.ok && f.parseId).map((f) => f.parseId)
    if (!ids.length && parseId) ids = [parseId]
    if (!ids.length) return toast.error('Upload the file again before importing')
    if (!readyCount) return toast.error('No new rows to import')
    setImporting(true)
    try {
      const { inserted, staged, stagedDuplicates, stagedFileName, stagingError, filesImported } =
        await api.ingest.import(ids)
      toast.success(
        filesImported > 1
          ? `Imported ${inserted} transactions from ${filesImported} files`
          : `Imported ${inserted} transactions`
      )
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
    {
      key: 'TransactionDescription',
      label: 'Description',
      render: (r) => (
        <span className="text-[var(--text-secondary)] truncate max-w-[200px] inline-block" title={r.TransactionDescription || r.Particulars}>
          {r.TransactionDescription || '—'}
        </span>
      ),
    },
    { key: 'BorrowerName', label: 'Name', render: (r) => <span className="font-medium">{r.BorrowerName || '—'}</span> },
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
        parseFile={parseFiles}
        batchFiles={batchFiles}
        onRemoveBatchFile={removeBatchFile}
        onAddMoreFiles={addMoreFiles}
        appendMode={parseReady && batchFiles.length > 0}
        inputRef={inputRef}
        accept={accept}
        documentType={documentType}
        setDocumentType={setDocumentType}
        fileParticulars={fileParticulars}
        setFileParticulars={setFileParticulars}
        fileName={fileName}
        isPdfDoc={isPdfDoc}
        isEmployerDoc={isEmployerDoc}
        isBankDoc={isBankDoc}
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
  batchFiles,
  onRemoveBatchFile,
  onAddMoreFiles,
  appendMode,
  inputRef,
  accept,
  documentType,
  setDocumentType,
  fileParticulars,
  setFileParticulars,
  fileName,
  isPdfDoc,
  isEmployerDoc,
  isBankDoc,
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
            batchFiles={batchFiles}
            onRemoveBatchFile={onRemoveBatchFile}
            onAddMoreFiles={onAddMoreFiles}
            appendMode={appendMode}
            inputRef={inputRef}
            accept={accept}
            documentType={documentType}
            setDocumentType={setDocumentType}
            fileParticulars={fileParticulars}
            setFileParticulars={setFileParticulars}
            fileName={fileName}
            isPdfDoc={isPdfDoc}
            isEmployerDoc={isEmployerDoc}
            isBankDoc={isBankDoc}
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
  batchFiles,
  onRemoveBatchFile,
  onAddMoreFiles,
  appendMode,
  inputRef,
  accept,
  documentType,
  setDocumentType,
  fileParticulars,
  setFileParticulars,
  fileName,
  isPdfDoc,
  isEmployerDoc,
  isBankDoc,
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
  const selectedType = DOCUMENT_TYPES.find((t) => t.id === documentType)
  const canDrop = Boolean(documentType) && !parsing
  const okBatch = (batchFiles || []).filter((f) => f.ok)
  const multiFile = okBatch.length > 1

  const handleFilePick = (fileList) => {
    if (!fileList?.length) return
    parseFile(fileList, { append: appendMode })
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        disabled={!documentType}
        onChange={(e) => {
          handleFilePick(e.target.files)
          e.target.value = ''
        }}
      />

      {showUpload ? (
      <div className="px-5 py-5 space-y-5">
        <div>
          <p className="text-[12px] font-semibold text-[var(--text-primary)] mb-2">Document type</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {DOCUMENT_TYPES.map((type) => {
              const Icon = type.icon
              const active = documentType === type.id
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => setDocumentType(type.id)}
                  className={cn(
                    'flex items-start gap-3 rounded-[var(--radius-md)] border px-3 py-3 text-left transition-colors',
                    active
                      ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)]'
                      : 'border-[var(--border-light)] bg-[var(--bg-subtle)]/40 hover:bg-[var(--bg-subtle)]'
                  )}
                >
                  <div
                    className={cn(
                      'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
                      active ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-tertiary)]'
                    )}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--text-primary)]">{type.label}</p>
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 leading-snug">{type.hint}</p>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <label htmlFor="file-particulars" className="text-[12px] font-semibold text-[var(--text-primary)]">
            File particulars
          </label>
          <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 mb-2">
            Employer name, pay period, bank account, or other notes to help matching
          </p>
          <textarea
            id="file-particulars"
            rows={2}
            value={fileParticulars}
            onChange={(e) => setFileParticulars(e.target.value)}
            placeholder="e.g. ABC Corp payroll — March 2026 deductions"
            className="w-full rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 py-2 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-border)] resize-none"
          />
        </div>

        <div
          onDragOver={(e) => {
            if (!canDrop) return
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            if (canDrop) handleFilePick(e.dataTransfer.files)
          }}
          className={cn(
            'flex flex-col items-center justify-center text-center px-6 py-10 rounded-[var(--radius-lg)] border border-dashed transition-colors',
            !documentType && 'border-[var(--border-light)] bg-[var(--bg-subtle)]/20 opacity-60',
            documentType && !dragOver && 'border-[var(--border-light)] bg-[var(--bg-subtle)]/30',
            dragOver && canDrop && 'bg-[var(--accent-subtle)] border-[var(--accent-border)]',
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
              <p className="text-[14px] font-semibold text-[var(--text-primary)]">
                {documentType ? 'Drop file(s) or browse' : 'Select a document type first'}
              </p>
              <p className="text-[12px] text-[var(--text-tertiary)] mt-1">
                {selectedType
                  ? `${selectedType.accept.replace(/\./g, '').split(',').join(' · ').toUpperCase()} — select multiple files at once`
                  : 'Choose bank, employer, spreadsheet, or image'}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-4"
                disabled={!documentType}
                onClick={() => inputRef.current?.click()}
              >
                <FileSpreadsheet className="h-4 w-4" />
                Browse files
              </Button>
              <p className="text-[10px] text-[var(--text-tertiary)] mt-3 flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> AI mapping for non-standard formats and scans
              </p>
            </>
          )}
        </div>
      </div>
      ) : (
    <div className="flex flex-col">
      {/* File bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]/30">
        <div className="flex items-center gap-2.5 min-w-0">
          <Check className="h-4 w-4 text-[var(--success)] shrink-0" />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">{fileName}</p>
            <p className="text-[11px] text-[var(--text-tertiary)]">
              {multiFile
                ? `${okBatch.length} files · ${creditCount} transactions · ${ready} ready to import`
                : isEmployerDoc
                  ? `${creditCount} deductions`
                  : isBankDoc
                    ? `${creditCount} credits`
                    : `${preview.length} rows`}
              {parseMethod === 'ai' && ' · AI'}
            </p>
          </div>
          {isEmployerDoc && <Badge variant="posted" className="text-[10px]">Employer</Badge>}
          {isBankDoc && <Badge variant="posted" className="text-[10px]">Bank</Badge>}
          {parseMethod === 'image' || (documentType === 'image' && parseMethod === 'ai') ? (
            <Badge variant="posted" className="text-[10px]">Image</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8" onClick={onAddMoreFiles} disabled={parsing || importing}>
            <Upload className="h-3.5 w-3.5" /> Add files
          </Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={reset}>
            <X className="h-3.5 w-3.5" /> Clear all
          </Button>
          <Button size="sm" className="h-8" disabled={importing || !ready || parsing} onClick={confirmImport}>
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {multiFile ? `Import all ${ready} rows` : `Import ${ready} rows`}
          </Button>
        </div>
      </div>

      {multiFile && (
        <div className="px-6 py-3 border-b border-[var(--border-light)] bg-[var(--bg-card)] space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Files in queue</p>
          <div className="flex flex-col gap-2">
            {okBatch.map((f) => (
              <div
                key={f.parseId}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--border-light)] px-3 py-2 bg-[var(--bg-subtle)]/30"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-[var(--text-primary)] truncate">{f.fileName}</p>
                  <p className="text-[11px] text-[var(--text-tertiary)]">
                    {f.readyCount} ready · {f.duplicateCount} duplicate{f.duplicateCount === 1 ? '' : 's'} skipped
                  </p>
                </div>
                <Badge variant="posted" className="text-[10px] shrink-0">Parsed</Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  aria-label={`Remove ${f.fileName}`}
                  onClick={() => onRemoveBatchFile(f.parseId)}
                  disabled={importing}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {(batchFiles || []).filter((f) => !f.ok).map((f) => (
              <div
                key={f.fileName}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--danger-border)] px-3 py-2 bg-[var(--danger-bg)]/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium text-[var(--text-primary)] truncate">{f.fileName}</p>
                  <p className="text-[11px] text-[var(--danger)]">{f.error || 'Failed to parse'}</p>
                </div>
                <Badge variant="pending" className="text-[10px] shrink-0">Failed</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {duplicates > 0 && (
        <p className="px-6 py-2.5 text-[12px] text-[var(--warning)] bg-[var(--warning-bg)] border-b border-[var(--warning-border)]">
          {duplicates} duplicate{duplicates === 1 ? '' : 's'} will be skipped across all files
        </p>
      )}

      {parsing && (
        <div className="px-6 py-3 flex items-center gap-2 text-[12px] text-[var(--text-secondary)] border-b border-[var(--border-light)]">
          <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
          Processing additional files…
        </div>
      )}

      {/* Preview table */}
      <div className="overflow-x-auto px-2 pb-2">
        {isPdfDoc && !multiFile ? (
          <PreviewTable
            rows={displayCreditRows.slice(0, 12).map((r) => {
              const parsed = parsePipeParticulars(r.particulars || r.description)
              return {
                ...r,
                description: r.transactionDescription || parsed.description,
                name: r.name || parsed.borrowerName,
              }
            })}
            columns={tableColumns}
            isPdf
          />
        ) : (
          <PreviewTable
            rows={preview.slice(0, 12).map((r) => {
              const parsed = parsePipeParticulars(r.description)
              return {
                file: r._fileName,
                date: formatDate(r.date),
                description: r.transactionDescription || parsed.description || r.description,
                name: r.payer || parsed.borrowerName,
                creditAmount: formatCurrency(r.amount),
                _dim: r._duplicate,
              }
            })}
            columns={[
              ...(multiFile ? [{ key: 'file', label: 'File' }] : []),
              { key: 'date', label: 'Date' },
              { key: 'description', label: 'Description' },
              { key: 'name', label: 'Name' },
              { key: 'creditAmount', label: 'Amount', align: 'right' },
            ]}
          />
        )}
        {preview.length > 12 && (
          <p className="px-4 py-2.5 text-[11px] text-[var(--text-tertiary)] border-t border-[var(--border-light)]">
            +{preview.length - 12} more rows across {multiFile ? okBatch.length : 1} file{multiFile ? 's' : ''}
          </p>
        )}
      </div>
    </div>
      )}
    </>
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