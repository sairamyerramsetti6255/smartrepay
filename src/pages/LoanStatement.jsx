import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { ArrowLeft, FileSpreadsheet, RefreshCw } from 'lucide-react'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { DataTable } from '@/components/DataTable'
import { Button } from '@/components/ui/button'
import { PageLoader } from '@/components/PageLoader'
import { LoanStatementHeader, buildRepaymentColumns } from '@/components/loan/LoanStatementHeader'
import { exportLoanStatement } from '@/lib/loanStatementExport'
import { cn } from '@/lib/utils'

export function LoanStatement() {
  const { loanNumber } = useParams()
  const navigate = useNavigate()
  const [loan, setLoan] = useState(null)
  const [repayments, setRepayments] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!loanNumber) return
    setLoading(true)
    setError(null)
    try {
      const [loanRes, repayRes] = await Promise.all([
        api.activeLoans.get(loanNumber),
        api.loans.repayments(loanNumber),
      ])
      setLoan(loanRes.loan || null)
      setRepayments(Array.isArray(repayRes.rows) ? repayRes.rows : [])
      setSummary(repayRes.summary || null)
    } catch (e) {
      setError(e.message)
      setLoan(null)
      setRepayments([])
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [loanNumber])

  useEffect(() => {
    load()
  }, [load])

  const columns = useMemo(
    () =>
      buildRepaymentColumns({
        onDownload: (r) =>
          api.documents.download(r.receiptDocumentId, r.receiptFileName).catch((e) => toast.error(e.message)),
      }),
    []
  )

  function handleExport() {
    const ok = exportLoanStatement(repayments, loanNumber)
    if (!ok) toast.error('No repayments to export')
    else toast.success('Statement exported')
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Loan Statement"
        subtitle={loanNumber ? `Loan ${loanNumber}` : 'Repayment ledger'}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => navigate('/active-loans')}>
              <ArrowLeft className="h-4 w-4" /> Active loans
            </Button>
            <Button variant="secondary" onClick={load} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
            </Button>
            <Button onClick={handleExport} disabled={!repayments.length}>
              <FileSpreadsheet className="h-4 w-4" /> Export Excel
            </Button>
          </div>
        }
      />

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader label="Loading loan statement…" />
      ) : !loan ? (
        <p className="text-[13px] text-[var(--text-tertiary)]">
          Loan not found.{' '}
          <Link to="/active-loans" className="text-[var(--accent)] hover:underline">
            Back to active loans
          </Link>
        </p>
      ) : (
        <>
          <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] p-5 shadow-[var(--shadow-xs)]">
            <LoanStatementHeader loan={loan} summary={summary} />
          </div>

          <div>
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">
              EMI / repayment history ({repayments.length})
            </h2>
            <DataTable
              data={repayments}
              columns={columns}
              pageSize={20}
              sortable
              filterable
              emptyMessage="No repayments recorded for this loan"
            />
          </div>
        </>
      )}
    </div>
  )
}
