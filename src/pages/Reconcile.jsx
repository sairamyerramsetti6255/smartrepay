import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Download } from 'lucide-react'
import { format } from 'date-fns'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { canPost } from '@/lib/roles'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { LoanDiskPreviewModal } from '@/components/LoanDiskPreviewModal'
import { DataTable } from '@/components/DataTable'
import { PageLoader } from '@/components/PageLoader'
import { WorkflowStepper } from '@/components/WorkflowStepper'
import { formatCurrency, formatDate, cn } from '@/lib/utils'

function groupByDate(rows) {
  const groups = {}
  for (const tx of rows) {
    const d = tx.date || 'Unknown'
    if (!groups[d]) groups[d] = []
    groups[d].push(tx)
  }
  return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a))
}

export function Reconcile() {
  const { user, role } = useAuth()
  const [transactions, setTransactions] = useState([])
  const [borrowerMap, setBorrowerMap] = useState({})
  const [loanMap, setLoanMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [postingId, setPostingId] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [statementDate, setStatementDate] = useState(format(new Date(), 'yyyy-MM-dd'))

  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [txList, bList, lList] = await Promise.all([
        api.transactions.list({ date: statementDate }),
        api.borrowers.list(),
        api.loans.list(),
      ])
      setTransactions(txList)
      setBorrowerMap(Object.fromEntries(bList.map((b) => [b.id, b])))
      setLoanMap(Object.fromEntries(lList.map((l) => [l.id, l])))
    } catch (e) {
      setError(e.message)
      setTransactions([])
    } finally {
      setLoading(false)
    }
  }, [statementDate])

  useEffect(() => {
    load()
    window.addEventListener('smartrepay:demo-loaded', load)
    return () => window.removeEventListener('smartrepay:demo-loaded', load)
  }, [load])

  const enriched = useMemo(
    () =>
      transactions.map((t) => ({
        ...t,
        borrowers: t.matched_borrower_id ? borrowerMap[t.matched_borrower_id] : null,
        loans: t.loan_id ? loanMap[t.loan_id] : null,
      })),
    [transactions, borrowerMap, loanMap]
  )

  const bankTotal = enriched.reduce((s, t) => s + Number(t.amount), 0)
  const postedTotal = enriched.filter((t) => t.status === 'posted').reduce((s, t) => s + Number(t.amount), 0)
  const diff = bankTotal - postedTotal
  const balanced = Math.abs(diff) < 0.01
  const unreconciled = enriched.filter((t) => t.status !== 'posted')
  const matchedAwaiting = enriched.filter((t) => t.status === 'matched')
  const postedRows = enriched.filter((t) => t.status === 'posted')

  async function approvePost(tx) {
    if (!canPost(role)) return toast.error('Insufficient permissions')
    setPostingId(tx.id)
    try {
      await api.transactions.update(tx.id, { status: 'posted', action: 'human_post_approved' })
      setTransactions((p) => p.map((t) => (t.id === tx.id ? { ...t, status: 'posted' } : t)))
      toast.success('Posted')
    } catch (e) {
      toast.error(e.message)
    } finally {
      setPostingId(null)
    }
  }

  if (loading) return <PageLoader label="Loading reconciliation data…" />

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-5 py-3.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}
      <WorkflowStepper current="reconcile" />

      <PageHeader
        eyebrow="Step 4 of 4"
        title="Reconciliation"
        subtitle="Approve matched payments and export them to LoanDisk."
        actions={
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={statementDate}
              onChange={(e) => setStatementDate(e.target.value)}
              className="h-9 rounded-[var(--radius-md)] border border-[var(--border-medium)] px-3 text-[13px] bg-[var(--bg-card)]"
            />
            <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
              <Download className="h-4 w-4" /> Export LoanDisk CSV
            </Button>
            <Button variant="secondary" onClick={() => toast('QuickBooks export — connect integration')}>
              Export QuickBooks
            </Button>
          </div>
        }
      />

      <div
        className={cn(
          'rounded-[var(--radius-md)] px-4 py-3 text-[13px] font-medium border',
          balanced
            ? 'bg-[var(--success-bg)] border-[var(--success-border)] text-[var(--success)]'
            : 'bg-[var(--danger-bg)] border-[var(--danger-border)] text-[var(--danger)]'
        )}
      >
        {balanced ? (
          <>✓ Fully reconciled · {formatCurrency(postedTotal)} matched</>
        ) : (
          <>⚠ {formatCurrency(Math.abs(diff))} unaccounted for across {unreconciled.length} transactions</>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <StatementColumn title="Bank Statement" rows={enriched} total={bankTotal} />
        <StatementColumn
          title="Posted Payments"
          rows={postedRows}
          total={postedTotal}
          highlightUnmatched={(tx) => tx.status === 'matched'}
          nameFn={(tx) => tx.borrowers?.full_name || tx.payer}
        />
      </div>

      {matchedAwaiting.length > 0 && (
        <Card>
          <CardHeader title="Awaiting approval" />
          <CardBody className="pt-0 space-y-0">
            {matchedAwaiting.map((tx, i) => (
              <div
                key={tx.id}
                className={cn('flex justify-between items-center py-3', i > 0 && 'border-t border-[var(--border-light)]')}
              >
                <span className="text-[13px]">
                  {tx.borrowers?.full_name} — <span className="mono font-medium">{formatCurrency(tx.amount)}</span>
                </span>
                {canPost(role) && (
                  <Button size="sm" disabled={postingId === tx.id} onClick={() => approvePost(tx)}>
                    Approve post
                  </Button>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {!balanced && unreconciled.length > 0 && (
        <Card>
          <CardHeader title="Unreconciled Transactions" />
          <CardBody className="p-0 pt-0">
            <DataTable
              data={unreconciled}
              columns={[
                { key: 'payer', label: 'Payer' },
                { key: 'amount', label: 'Amount', align: 'right', render: (tx) => formatCurrency(tx.amount) },
                { key: 'status', label: 'Status' },
                {
                  key: 'action',
                  label: '',
                  render: (tx) =>
                    tx.status === 'matched' && canPost(role) ? (
                      <button
                        type="button"
                        className="text-[13px] font-medium text-[var(--accent)]"
                        onClick={() => approvePost(tx)}
                      >
                        Assign →
                      </button>
                    ) : null,
                },
              ]}
              pageSize={10}
            />
          </CardBody>
        </Card>
      )}

      <LoanDiskPreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        rows={postedRows.length ? postedRows : matchedAwaiting}
      />
    </div>
  )
}

function StatementColumn({ title, rows, total, highlightUnmatched, nameFn }) {
  const groups = groupByDate(rows)
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} />
      <CardBody className="pt-0 max-h-[400px] overflow-y-auto p-0">
        {groups.length === 0 ? (
          <p className="px-6 py-8 text-[13px] text-[var(--text-tertiary)]">No transactions</p>
        ) : (
          groups.map(([date, items]) => (
            <div key={date}>
              <p className="px-6 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] bg-[var(--bg-subtle)] sticky top-0">
                {formatDate(date)}
              </p>
              {items.map((tx, i) => (
                <div
                  key={tx.id}
                  className={cn(
                    'flex justify-between gap-4 px-6 py-3 border-b border-[var(--border-light)]',
                    highlightUnmatched?.(tx) && 'bg-[var(--warning-bg)]'
                  )}
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium truncate">{nameFn ? nameFn(tx) : tx.payer}</p>
                    <p className="text-xs text-[var(--text-tertiary)] truncate">{tx.description}</p>
                  </div>
                  <span className="mono text-[13px] font-medium shrink-0">{formatCurrency(tx.amount)}</span>
                </div>
              ))}
            </div>
          ))
        )}
        <div className="px-6 py-4 border-t border-[var(--border-light)] flex justify-between">
          <span className="text-[13px] font-semibold">Total</span>
          <span className="mono text-[13px] font-semibold">{formatCurrency(total)}</span>
        </div>
      </CardBody>
    </Card>
  )
}
