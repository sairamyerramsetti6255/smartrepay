import { useEffect, useState, useMemo } from 'react'
import { Download, FileCode, CheckCircle, AlertCircle, RefreshCw, Copy, Check, ArrowRight } from 'lucide-react'
import { quickbooks } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { canExportQB } from '@/lib/roles'
import { cn } from '@/lib/utils'
import toast from 'react-hot-toast'

function formatPreviewPayload(payload, format) {
  if (!payload) return '// No approved transactions ready for export'

  if (format === 'json') {
    return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  }

  if (format === 'csv') {
    const rows = [
      ['Transaction Type', 'Txn Date', 'Reference Number', 'Customer / Payee', 'Deposit To / Bank Account', 'Amount', 'Line Account', 'Line Amount', 'Line Memo'],
    ]
    ;(payload.emi_receipts || []).forEach((r) => {
      if (r.line_items && r.line_items.length) {
        r.line_items.forEach((l) => {
          rows.push([
            'EMI Receipt',
            r.Txn_Date,
            r.Ref_Number,
            r.Customer_Name,
            r.Deposit_To,
            r.Total_Deposit_Amount,
            l.Line_Account,
            l.Line_Amount,
            l.Line_Memo,
          ])
        })
      } else {
        rows.push([
          'EMI Receipt',
          r.Txn_Date,
          r.Ref_Number,
          r.Customer_Name,
          r.Deposit_To,
          r.Total_Deposit_Amount,
          'Loans Receivable',
          r.Total_Deposit_Amount,
          'Repayment',
        ])
      }
    })
    ;(payload.payments_disbursed || []).forEach((p) => {
      rows.push([
        'Payment Disbursed',
        p.Txn_Date,
        p.Ref_Number,
        p.Payee_Name,
        p.Bank_Account,
        p.Total_Amount,
        p.Line_Account || 'Loans Receivable',
        p.Total_Amount,
        p.Line_Memo || 'Disbursement',
      ])
    })
    ;(payload.accounts_to_create || []).forEach((a) => {
      rows.push([
        'Account To Create',
        new Date().toISOString().slice(0, 10),
        a.Account_Number || '—',
        a.Account_Name,
        a.Sub_Account_Of || '—',
        0,
        a.Account_Type,
        0,
        a.Description || 'New Account Proposal',
      ])
    })
    return rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
  }

  if (format === 'iif') {
    const lines = [
      '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR',
      '!SPL\tSPLID\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR',
      '!ENDTRNS',
    ]
    ;(payload.emi_receipts || []).forEach((r) => {
      lines.push(`TRNS\tDEPOSIT\t${r.Txn_Date}\t${r.Deposit_To}\t${r.Customer_Name}\t${r.Total_Deposit_Amount}\t${r.Ref_Number}\tCustomer Repayment\tN`)
      ;(r.line_items || []).forEach((l, idx) => {
        lines.push(`SPL\t${idx + 1}\tDEPOSIT\t${r.Txn_Date}\t${l.Line_Account}\t${r.Customer_Name}\t-${l.Line_Amount}\t${r.Ref_Number}\t${l.Line_Memo}\tN`)
      })
      lines.push('ENDTRNS')
    })
    ;(payload.payments_disbursed || []).forEach((p) => {
      lines.push(`TRNS\tCHECK\t${p.Txn_Date}\t${p.Bank_Account}\t${p.Payee_Name}\t-${p.Total_Amount}\t${p.Ref_Number}\t${p.Line_Memo}\tN`)
      lines.push(`SPL\t1\tCHECK\t${p.Txn_Date}\t${p.Line_Account || 'Loans Receivable'}\t${p.Payee_Name}\t${p.Total_Amount}\t${p.Ref_Number}\t${p.Line_Memo}\tN`)
      lines.push('ENDTRNS')
    })
    return lines.join('\n')
  }

  return JSON.stringify(payload, null, 2)
}

export function QBPreview({ onNavigate }) {
  const { profile } = useAuth()
  const canExport = canExportQB(profile?.role)
  const [previewData, setPreviewData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [format, setFormat] = useState('json')
  const [copied, setCopied] = useState(false)

  const loadPreview = async () => {
    try {
      setLoading(true)
      const data = await quickbooks.preview()
      setPreviewData(data)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPreview()
  }, [])

  const formattedContent = useMemo(() => {
    if (!previewData?.sample_payload) return '// No approved transactions ready for export'
    return formatPreviewPayload(previewData.sample_payload, format)
  }, [previewData, format])

  const handleCopy = () => {
    if (!formattedContent || formattedContent.startsWith('//')) return
    navigator.clipboard.writeText(formattedContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success(`Preview copied to clipboard as ${format.toUpperCase()}`)
  }

  const handleExport = async () => {
    if (!canExport) {
      toast.error('Only accounting or system_owner can export QuickBooks batches')
      return
    }

    try {
      setExporting(true)
      const res = await quickbooks.export(format)
      toast.success(res.message || `Exported ${res.record_count} records successfully`)

      // Trigger client-side file download of formatted content
      const content = formatPreviewPayload(res.payload || previewData?.sample_payload, format)
      const mimeMap = {
        json: 'application/json',
        csv: 'text/csv',
        iif: 'text/plain',
      }
      const extMap = {
        json: 'json',
        csv: 'csv',
        iif: 'iif',
      }
      const blob = new Blob([content], { type: mimeMap[format] || 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `qb_export_${new Date().toISOString().slice(0, 10)}_${res.export_id?.slice(0, 8) || 'batch'}.${extMap[format] || 'txt'}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      await loadPreview()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setExporting(false)
    }
  }

  const approvedCount = previewData?.approved_count ?? (
    (previewData?.emi_receipts?.length || 0) +
    (previewData?.payments_disbursed?.length || 0) +
    (previewData?.accounts_to_create?.length || 0)
  )
  const totalAmount = previewData?.total_amount || 0
  const emiCount = previewData?.emi_receipts_count ?? (previewData?.emi_receipts?.length || 0)
  const paymentsCount = previewData?.payments_count ?? (previewData?.payments_disbursed?.length || 0)
  const accountsCount = previewData?.accounts_count ?? (previewData?.accounts_to_create?.length || 0)

  return (
    <div className="space-y-6">
      {/* Top Banner & Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
          <p className="text-[12px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide mb-1">
            Approved For Export
          </p>
          <p className="text-[28px] font-bold text-[var(--success)]">{approvedCount}</p>
          <p className="text-[12px] text-[var(--text-tertiary)] mt-1">Ready for QuickBooks Desktop</p>
        </div>

        <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
          <p className="text-[12px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide mb-1">
            Total Export Value
          </p>
          <p className="text-[28px] font-bold text-[var(--text-primary)]">
            ${Number(totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="text-[12px] text-[var(--text-tertiary)] mt-1">Sum of approved line items</p>
        </div>

        <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
          <p className="text-[12px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide mb-1">
            EMI Receipts
          </p>
          <p className="text-[28px] font-bold text-[var(--accent)]">{emiCount}</p>
          <p className="text-[12px] text-[var(--text-tertiary)] mt-1">Customer loan repayments</p>
        </div>

        <div className="p-5 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
          <p className="text-[12px] font-medium text-[var(--text-tertiary)] uppercase tracking-wide mb-1">
            Payments / Accounts
          </p>
          <p className="text-[28px] font-bold text-[var(--text-primary)]">
            {paymentsCount + accountsCount}
          </p>
          <p className="text-[12px] text-[var(--text-tertiary)] mt-1">Disbursements & Accounts to Create</p>
        </div>
      </div>

      {/* Export Action Card */}
      <div className="p-6 rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)]">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">
              QuickBooks Desktop Export Engine
            </h3>
            <p className="text-[13px] text-[var(--text-secondary)] mt-0.5">
              Select output interchange format and export all currently approved transactions into a standardized package.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex rounded-[var(--radius-md)] border border-[var(--border-light)] p-0.5 bg-[var(--bg-subtle)]">
              {['json', 'csv', 'iif'].map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setFormat(fmt)}
                  className={cn(
                    'px-3 py-1.5 text-[12px] font-medium rounded-[var(--radius-sm)] uppercase transition-colors',
                    format === fmt
                      ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-xs'
                      : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                  )}
                >
                  {fmt}
                </button>
              ))}
            </div>

            <button
              onClick={handleExport}
              disabled={exporting || approvedCount === 0 || !canExport}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-[var(--radius-md)] bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors shadow-xs"
            >
              {exporting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {exporting ? 'Exporting…' : `Export ${approvedCount} Records (${format.toUpperCase()})`}
            </button>
          </div>
        </div>

        {!canExport && (
          <p className="text-[12px] text-[var(--warning)] mt-3">
            * Note: Your role does not have export permissions. Only <strong>accounting</strong> or <strong>system_owner</strong> roles can generate export packages.
          </p>
        )}

        {approvedCount === 0 && (
          <div className="mt-4 p-3.5 rounded-[var(--radius-md)] bg-[var(--warning-bg)]/40 border border-[var(--warning)]/30 text-[13px] text-[var(--warning)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>No transactions are currently in <strong>Approved</strong> status. Go to <strong>EMI Receipts</strong> or <strong>Transaction Library</strong> to review and approve transactions first.</span>
            </div>
            <button
              onClick={() => onNavigate?.('emi')}
              className="inline-flex items-center gap-1 font-semibold underline text-[12px] shrink-0 hover:opacity-80"
            >
              Go to EMI Receipts <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Live Preview Box */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]">
          <div className="flex items-center gap-2">
            <FileCode className="h-4 w-4 text-[var(--accent)]" />
            <span className="text-[13px] font-semibold text-[var(--text-primary)]">
              Payload Preview ({format.toUpperCase()}) — {approvedCount} record{approvedCount !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              disabled={approvedCount === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={loadPreview}
              disabled={loading}
              className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        <div className="p-4 bg-[var(--bg-card)]">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2">
              <RefreshCw className="h-5 w-5 animate-spin text-[var(--accent)]" />
              <p className="text-[13px] text-[var(--text-tertiary)]">Generating preview...</p>
            </div>
          ) : (
            <pre className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] text-[12px] font-mono text-[var(--text-primary)] overflow-x-auto max-h-[450px] leading-relaxed">
              {formattedContent}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
