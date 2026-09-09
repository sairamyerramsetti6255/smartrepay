import { useState, useCallback } from 'react'
import { Upload, FileText, Mail, BookOpen, Loader, ArrowRight, CheckCircle2, AlertTriangle, Layers } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'

const SOURCES = [
  { id: 'files',       label: 'Upload Files',       icon: Upload,   accepts: '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.csv,.txt' },
  { id: 'text',        label: 'Paste Text',          icon: FileText, accepts: null },
  { id: 'email',       label: 'Email / EML',         icon: Mail,     accepts: '.eml,.txt' },
  { id: 'smartrepay',  label: 'SmartRepay Txns',     icon: BookOpen, accepts: null },
]

const TRANSACTION_TYPES = [
  {
    id: 'emi_receipt',
    label: 'EMI Receipt',
    subtitle: 'Customer Loan Repayment',
    targetPage: 'emi',
    targetPageLabel: 'EMI Receipts',
    description: 'Generates customer repayment receipts mapped to Loans Receivable and Interest Income accounts.',
  },
  {
    id: 'payment_disbursed',
    label: 'Payment Disbursed',
    subtitle: 'Disbursement / Vendor Payment',
    targetPage: 'payments',
    targetPageLabel: 'Payments',
    description: 'Generates disbursement payments / checks drawn against the operating bank account.',
  },
]

function FileRow({ file, status }) {
  const statusColor = {
    ready: 'text-[var(--text-secondary)]',
    processing: 'text-[var(--accent)]',
    extracted: 'text-[var(--success)]',
    error: 'text-[var(--danger)]',
  }
  return (
    <div className="flex items-center justify-between py-2 text-[13px] border-b border-[var(--border-light)] last:border-0">
      <span className="text-[var(--text-primary)] font-medium truncate max-w-[200px]">{file.name}</span>
      <span className="text-[var(--text-tertiary)] mx-4">{file.type || '—'}</span>
      <span className="text-[var(--text-tertiary)] mx-4">{(file.size / 1024).toFixed(0)} KB</span>
      <span className={cn('font-medium capitalize', statusColor[status] || statusColor.ready)}>{status || 'ready'}</span>
    </div>
  )
}

export function QBImport({ onNavigate }) {
  const [activeSource, setActiveSource] = useState('files')
  const [templateType, setTemplateType] = useState('emi_receipt')
  const [files, setFiles] = useState([])
  const [fileStatuses, setFileStatuses] = useState({})
  const [freeText, setFreeText] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [emailSender, setEmailSender] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [result, setResult] = useState(null)

  const selectedTypeConfig = TRANSACTION_TYPES.find((t) => t.id === templateType) || TRANSACTION_TYPES[0]

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files)
    setFiles((prev) => [...prev, ...dropped])
    const newStatuses = {}
    dropped.forEach((f) => { newStatuses[f.name] = 'ready' })
    setFileStatuses((prev) => ({ ...prev, ...newStatuses }))
  }, [])

  const handleFileInput = (e) => {
    const selected = Array.from(e.target.files)
    setFiles((prev) => [...prev, ...selected])
    const newStatuses = {}
    selected.forEach((f) => { newStatuses[f.name] = 'ready' })
    setFileStatuses((prev) => ({ ...prev, ...newStatuses }))
  }

  const processFiles = async () => {
    if (!files.length) return toast.error('No files selected')
    setLoading(true)
    setResult(null)
    try {
      const res = await quickbooks.importFiles(files, { templateType })
      setResult({ ...res, importedAs: templateType })
      const newStatuses = {}
      res.results?.forEach((r) => { newStatuses[r.file] = r.status })
      setFileStatuses((prev) => ({ ...prev, ...newStatuses }))
      toast.success(`Processed ${res.results?.length || 0} files as ${selectedTypeConfig.label}`)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  const processText = async () => {
    const text = activeSource === 'email' ? emailBody : freeText
    if (!text.trim()) return toast.error('Please enter some text')
    setLoading(true)
    setResult(null)
    try {
      const res = await quickbooks.importText(text, {
        sourceType: activeSource === 'email' ? 'email' : 'free_text',
        templateType,
        emailSender: emailSender || undefined,
        emailSubject: emailSubject || undefined,
      })
      setResult({ ...res, importedAs: templateType })
      toast.success(`Extraction complete — status: ${res.validation_status || 'processed'}`)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  const importFromSmartRepay = async () => {
    setLoading(true)
    setResult(null)
    try {
      const res = await quickbooks.importSmartRepay(1000)
      setResult({ ...res, importedAs: 'emi_receipt' })
      toast.success(res.message || `Imported ${res.valid} EMI receipts`)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Source Selector */}
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
          1. Select Ingestion Source
        </label>
        <div className="flex gap-2 flex-wrap">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              onClick={() => { setActiveSource(s.id); setResult(null) }}
              className={cn(
                'flex items-center gap-2 h-9 px-4 rounded-[var(--radius-md)] text-[13px] font-medium border transition-colors',
                activeSource === s.id
                  ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                  : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              )}
            >
              <s.icon className="h-3.5 w-3.5" />
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Target Transaction Type Selector (for files, text, and email) */}
      {activeSource !== 'smartrepay' && (
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
            2. Target Transaction Type
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl">
            {TRANSACTION_TYPES.map((t) => {
              const isSelected = templateType === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateType(t.id)}
                  className={cn(
                    'p-4 rounded-[var(--radius-lg)] border text-left transition-all relative',
                    isSelected
                      ? 'border-[var(--accent)] bg-[var(--accent-subtle)]/40 ring-1 ring-[var(--accent)] shadow-xs'
                      : 'border-[var(--border-light)] bg-[var(--bg-card)] hover:border-[var(--border-medium)] hover:bg-[var(--bg-hover)]'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] font-semibold text-[var(--text-primary)]">{t.label}</span>
                    <span className={cn(
                      'text-[11px] px-2 py-0.5 rounded-full font-medium',
                      isSelected ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]'
                    )}>
                      Routes to {t.targetPageLabel}
                    </span>
                  </div>
                  <p className="text-[12px] font-medium text-[var(--accent)] mt-0.5">{t.subtitle}</p>
                  <p className="text-[12px] text-[var(--text-tertiary)] mt-1.5 leading-relaxed">{t.description}</p>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Main Ingestion Panel */}
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
          {activeSource === 'smartrepay' ? '2. Run SmartRepay Import' : '3. Provide Data & Process'}
        </label>

        {/* File Upload */}
        {(activeSource === 'files' || activeSource === 'email') && (
          <div className="space-y-4">
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={cn(
                'relative rounded-[var(--radius-lg)] border-2 border-dashed p-10 text-center transition-colors bg-[var(--bg-card)]',
                dragOver ? 'border-[var(--accent)] bg-[var(--accent-subtle)]' : 'border-[var(--border-light)] hover:border-[var(--border-medium)]'
              )}
            >
              <Upload className="mx-auto h-8 w-8 text-[var(--text-tertiary)] mb-3" />
              <p className="text-[14px] text-[var(--text-primary)] font-medium mb-1">
                Drop files here or click to browse for <strong className="text-[var(--accent)]">{selectedTypeConfig.label}</strong>
              </p>
              <p className="text-[12px] text-[var(--text-tertiary)] mb-4">
                Supported formats: PDF, Images (PNG, JPG, WEBP), Excel (.xlsx, .xls), CSV, TXT, EML
              </p>
              <label className="inline-flex items-center gap-2 h-8 px-4 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[13px] font-medium text-[var(--text-primary)] cursor-pointer hover:bg-[var(--bg-hover)] transition-colors">
                <Upload className="h-3.5 w-3.5" />
                Browse Files
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  accept={SOURCES.find((s) => s.id === activeSource)?.accepts}
                  onChange={handleFileInput}
                />
              </label>
            </div>

            {files.length > 0 && (
              <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
                <div className="px-5 py-3 border-b border-[var(--border-light)] flex items-center justify-between">
                  <p className="text-[13px] font-semibold text-[var(--text-primary)]">{files.length} file{files.length !== 1 ? 's' : ''} queued for {selectedTypeConfig.label}</p>
                  <button onClick={() => { setFiles([]); setFileStatuses({}) }} className="text-[12px] text-[var(--danger)] hover:underline">Clear all</button>
                </div>
                <div className="px-5">
                  {files.map((f) => <FileRow key={f.name} file={f} status={fileStatuses[f.name]} />)}
                </div>
              </div>
            )}

            <button
              onClick={processFiles}
              disabled={loading || !files.length}
              className="inline-flex items-center gap-2 h-9 px-5 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] disabled:opacity-60 transition-colors shadow-xs"
            >
              {loading ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {loading ? `Processing ${selectedTypeConfig.label} with AI…` : `Import as ${selectedTypeConfig.label}`}
            </button>
          </div>
        )}

        {/* Free Text */}
        {activeSource === 'text' && (
          <div className="space-y-4">
            <textarea
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              placeholder={
                templateType === 'payment_disbursed'
                  ? "Paste payment disbursement data here…\n\nExample:\nPaid $15,000 disbursement check to ABC Developers LLC on 14 September 2026 for construction loan tranche #2.\nReference CHK-882109 from Operating Bank Account."
                  : "Paste repayment transaction data here…\n\nExample:\nJohn Doe paid his September EMI of $500 by ACH on 15 September 2026.\nReference EMI-JD-001. $400 principal and $100 interest.\nDeposit into General Bank Account."
              }
              rows={8}
              className="w-full rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-4 py-3 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] resize-none"
            />
            <button
              onClick={processText}
              disabled={loading || !freeText.trim()}
              className="inline-flex items-center gap-2 h-9 px-5 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] disabled:opacity-60 transition-colors shadow-xs"
            >
              {loading ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
              {loading ? `Extracting as ${selectedTypeConfig.label}…` : `Extract as ${selectedTypeConfig.label}`}
            </button>
          </div>
        )}

        {/* SmartRepay Import */}
        {activeSource === 'smartrepay' && (
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-8 text-center max-w-2xl">
            <BookOpen className="mx-auto h-10 w-10 text-[var(--accent)] mb-4" />
            <h3 className="text-[16px] font-semibold text-[var(--text-primary)] mb-2">Import from SmartRepay Engine</h3>
            <p className="text-[13px] text-[var(--text-secondary)] mb-2 max-w-md mx-auto">
              Imports all matched and posted SmartRepay transactions as <strong>EMI Receipts</strong> into QuickBooks with source file traceability.
            </p>
            <p className="text-[12px] text-[var(--text-tertiary)] mb-6">
              Duplicate records are automatically skipped based on SHA-256 transaction fingerprinting.
            </p>
            <button
              onClick={importFromSmartRepay}
              disabled={loading}
              className="inline-flex items-center gap-2 h-9 px-6 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] disabled:opacity-60 transition-colors shadow-xs"
            >
              {loading ? <Loader className="h-3.5 w-3.5 animate-spin" /> : <BookOpen className="h-3.5 w-3.5" />}
              {loading ? 'Importing Matched Transactions…' : 'Import All Matched Transactions'}
            </button>
          </div>
        )}
      </div>

      {/* Result Card with Direct Routing Action */}
      {result && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between border-b border-[var(--border-light)] pb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-[var(--success-bg)] text-[var(--success)]">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div>
                <h4 className="text-[15px] font-semibold text-[var(--text-primary)]">
                  Import Process Completed
                </h4>
                <p className="text-[12px] text-[var(--text-secondary)]">
                  Type: <span className="font-semibold capitalize">{result.importedAs?.replace(/_/g, ' ') || templateType.replace(/_/g, ' ')}</span>
                  {result.valid != null && ` • ${result.valid} Valid Records`}
                </p>
              </div>
            </div>

            {/* Direct Navigation Button to Related Transactions Page */}
            <div className="flex items-center gap-2">
              {result.importedAs === 'payment_disbursed' || templateType === 'payment_disbursed' ? (
                <button
                  onClick={() => onNavigate?.('payments')}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-semibold hover:bg-[var(--accent-hover)] transition-colors shadow-xs"
                >
                  Go to Payments Page <ArrowRight className="h-4 w-4" />
                </button>
              ) : (
                <button
                  onClick={() => onNavigate?.('emi')}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-semibold hover:bg-[var(--accent-hover)] transition-colors shadow-xs"
                >
                  Go to EMI Receipts Page <ArrowRight className="h-4 w-4" />
                </button>
              )}

              <button
                onClick={() => onNavigate?.('library')}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-md)] border border-[var(--border-light)] text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                View Library
              </button>
            </div>
          </div>

          <div className="text-[12px] text-[var(--text-tertiary)] bg-[var(--bg-subtle)] rounded p-3 overflow-x-auto max-h-36 font-mono">
            {JSON.stringify(result, null, 2)}
          </div>
        </div>
      )}
    </div>
  )
}
