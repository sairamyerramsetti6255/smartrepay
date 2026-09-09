import { useCallback, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { ChevronLeft, ChevronRight, Database, Loader2, RefreshCw, Search } from 'lucide-react'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { PageLoader } from '@/components/PageLoader'
import { cn } from '@/lib/utils'

const BRANCH_OPTIONS = [
  { label: 'All branches', value: '' },
  { label: 'Simplified Lending', value: '18279' },
  { label: 'E&S', value: '26281' },
  { label: 'SBDC', value: '16209' },
  { label: 'SL Business loan', value: '36198' },
]

const TYPE_OPTIONS = [
  { label: 'All (Subject + Contract)', value: 'All' },
  { label: 'Subject only', value: 'Subject' },
  { label: 'Contract only', value: 'Contract' },
]

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

function defaultAccountingDateIso() {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  // last day of previous month as a sensible default for monthly CRIF
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  const yyyy = last.getFullYear()
  const mm = String(last.getMonth() + 1).padStart(2, '0')
  const dd = String(last.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatCrifDate(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 2)}/${raw.slice(2, 4)}/${raw.slice(4, 8)}`
  }
  return raw
}

function fullName(row) {
  return [row.firstName, row.middleName, row.lastName].filter(Boolean).join(' ') || '—'
}

function validateFilters({ accountingDate, pageSize, borrowerId, branch }) {
  if (!accountingDate) return 'Accounting date is required'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(accountingDate)) {
    return 'Choose a valid accounting date'
  }
  const [y, m, d] = accountingDate.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return 'Accounting date is not a valid calendar day'
  }
  if (dt > new Date()) return 'Accounting date cannot be in the future'

  const size = Number(pageSize)
  if (!Number.isInteger(size) || size < 1) return 'Page size must be at least 1'
  if (size > 500) return 'Page size cannot exceed 500'

  if (borrowerId && !/^\d+$/.test(borrowerId.trim())) {
    return 'Borrower ID must contain digits only'
  }
  if (branch && !BRANCH_OPTIONS.some((b) => b.value === branch)) {
    return 'Select a valid branch'
  }
  return null
}

export function CrifNodeData() {
  const [accountingDate, setAccountingDate] = useState(defaultAccountingDateIso)
  const [type, setType] = useState('Subject')
  const [branch, setBranch] = useState('')
  const [borrowerId, setBorrowerId] = useState('')
  const [pageIndex, setPageIndex] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [hasSearched, setHasSearched] = useState(false)

  const load = useCallback(
    async (page = pageIndex) => {
      const validationError = validateFilters({
        accountingDate,
        pageSize,
        borrowerId,
        branch,
      })
      if (validationError) {
        setError(validationError)
        toast.error(validationError)
        return
      }

      setLoading(true)
      setError(null)
      setHasSearched(true)
      try {
        const data = await api.crif.nodeData({
          accountingDate,
          type: type === 'All' ? 'All' : type,
          pageIndex: page,
          pageSize,
          branch: branch || undefined,
          borrowerId: borrowerId.trim() || undefined,
        })
        setResult(data)
        setPageIndex(page)
        if (!data.rows?.length) {
          toast('No CRIF node records matched these filters', { icon: 'ℹ️' })
        }
      } catch (e) {
        setResult(null)
        setError(e.message || 'Failed to load CRIF node data')
        toast.error(e.message || 'Failed to load CRIF node data')
      } finally {
        setLoading(false)
      }
    },
    [accountingDate, type, branch, borrowerId, pageIndex, pageSize]
  )

  function handleSearch(e) {
    e.preventDefault()
    load(1)
  }

  const rows = result?.rows ?? []
  const showSubject = type === 'Subject' || type === 'All' || rows.some((r) => r.kind === 'Subject')
  const showContract = type === 'Contract' || rows.some((r) => r.kind === 'Contract')

  const columns = useMemo(() => {
    const cols = [
      {
        key: 'kind',
        label: 'Type',
        sortAccessor: (r) => r.kind || '',
        render: (r) => (
          <Badge variant={r.kind === 'Contract' ? 'posted' : 'matched'}>{r.kind || '—'}</Badge>
        ),
      },
      {
        key: 'branchCode',
        label: 'Branch',
        sortAccessor: (r) => r.branchCode || '',
        render: (r) => {
          const label = BRANCH_OPTIONS.find((b) => b.value === String(r.branchCode))?.label
          return (
            <span className="text-[13px] text-[var(--text-secondary)]">
              {label || r.branchCode || '—'}
            </span>
          )
        },
      },
      {
        key: 'fiSubjectCode',
        label: 'Borrower',
        sortAccessor: (r) => r.fiSubjectCode || '',
        render: (r) => <span className="mono font-medium text-[var(--text-primary)]">{r.fiSubjectCode || '—'}</span>,
      },
    ]

    if (showSubject && type !== 'Contract') {
      cols.push(
        {
          key: 'name',
          label: 'Name',
          sortAccessor: (r) => fullName(r),
          render: (r) =>
            r.kind === 'Contract' ? (
              <span className="text-[var(--text-tertiary)]">—</span>
            ) : (
              <span className="text-[13px] text-[var(--text-primary)]">{fullName(r)}</span>
            ),
        },
        {
          key: 'nibNumber',
          label: 'NIB',
          sortAccessor: (r) => r.nibNumber || '',
          render: (r) => <span className="mono text-[12px] text-[var(--text-secondary)]">{r.nibNumber || '—'}</span>,
        },
        {
          key: 'gender',
          label: 'Gender',
          sortAccessor: (r) => r.gender || '',
          render: (r) => <span className="text-[13px] text-[var(--text-secondary)]">{r.gender || '—'}</span>,
        },
        {
          key: 'dateOfBirth',
          label: 'DOB',
          sortAccessor: (r) => r.dateOfBirth || '',
          render: (r) => (
            <span className="mono text-[12px] text-[var(--text-secondary)]">{formatCrifDate(r.dateOfBirth)}</span>
          ),
        },
        {
          key: 'mobilePhone',
          label: 'Mobile',
          sortAccessor: (r) => r.mobilePhone || '',
          render: (r) => <span className="text-[13px] text-[var(--text-secondary)]">{r.mobilePhone || '—'}</span>,
        }
      )
    }

    if (showContract && type !== 'Subject') {
      cols.push(
        {
          key: 'fiContractCode',
          label: 'Contract',
          sortAccessor: (r) => r.fiContractCode || '',
          render: (r) => (
            <span className="mono font-medium text-[var(--text-primary)]">{r.fiContractCode || '—'}</span>
          ),
        },
        {
          key: 'contractPhase',
          label: 'Phase',
          sortAccessor: (r) => r.contractPhase || '',
          render: (r) => <span className="text-[13px] text-[var(--text-secondary)]">{r.contractPhase || '—'}</span>,
        },
        {
          key: 'financedAmount',
          label: 'Financed',
          sortAccessor: (r) => Number(r.financedAmount) || 0,
          render: (r) => (
            <span className="mono text-[13px] text-[var(--text-primary)]">{r.financedAmount ?? '—'}</span>
          ),
        },
        {
          key: 'outstandingBalance',
          label: 'Outstanding',
          sortAccessor: (r) => Number(r.outstandingBalance) || 0,
          render: (r) => (
            <span className="mono text-[13px] text-[var(--text-primary)]">{r.outstandingBalance ?? '—'}</span>
          ),
        },
        {
          key: 'daysPastDue',
          label: 'DPD',
          sortAccessor: (r) => Number(r.daysPastDue) || 0,
          render: (r) => <span className="mono text-[13px] text-[var(--text-secondary)]">{r.daysPastDue ?? '—'}</span>,
        }
      )
    }

    cols.push({
      key: 'accountingDate',
      label: 'Acct. date',
      sortAccessor: (r) => r.accountingDate || '',
      render: (r) => (
        <span className="mono text-[12px] text-[var(--text-tertiary)]">{formatCrifDate(r.accountingDate)}</span>
      ),
    })

    return cols
  }, [showSubject, showContract, type])

  const selectClass =
    'flex h-10 w-full rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]'

  return (
    <div>
      <PageHeader
        eyebrow="CRIF"
        title="Node CRIF Data"
        subtitle="Browse Subject and Contract records from Get_NodeCRIFData with pagination and filters."
      />

      <Card>
        <CardHeader title="Filters" subtitle="Accounting date is required for every query." />
        <CardBody>
          <form onSubmit={handleSearch} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="accountingDate">Accounting date</Label>
                <Input
                  id="accountingDate"
                  type="date"
                  value={accountingDate}
                  onChange={(e) => setAccountingDate(e.target.value)}
                  disabled={loading}
                  required
                />
                <p className="text-[11px] text-[var(--text-tertiary)]">Sent to the API as DDMMYYYY.</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="type">Record type</Label>
                <select
                  id="type"
                  className={selectClass}
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  disabled={loading}
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="branch">Branch</Label>
                <select
                  id="branch"
                  className={selectClass}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  disabled={loading}
                >
                  {BRANCH_OPTIONS.map((opt) => (
                    <option key={opt.value || 'all'} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="borrowerId">Borrower ID</Label>
                <Input
                  id="borrowerId"
                  value={borrowerId}
                  onChange={(e) => setBorrowerId(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="e.g. 4098541"
                  disabled={loading}
                  inputMode="numeric"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pageSize">Page size</Label>
                <select
                  id="pageSize"
                  className={selectClass}
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  disabled={loading}
                >
                  {PAGE_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n} per page
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {error && (
              <div className="rounded-[var(--radius-md)] border border-[var(--danger)]/30 bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[var(--danger)]">
                {error}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Loading…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4 mr-2" />
                    Search
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={loading || !hasSearched}
                onClick={() => load(pageIndex)}
              >
                <RefreshCw className={cn('h-4 w-4 mr-2', loading && 'animate-spin')} />
                Refresh
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <div className="mt-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">Results</h2>
            {result && (
              <span className="text-[12px] text-[var(--text-tertiary)]">
                {result.totalCount?.toLocaleString?.() ?? result.totalCount} total · page {result.pageIndex}
                {result.message ? ` · ${result.message}` : ''}
              </span>
            )}
          </div>
          {result && (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading || pageIndex <= 1}
                onClick={() => load(pageIndex - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={loading || !result.nextPage}
                onClick={() => load(pageIndex + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {!hasSearched ? (
          <Card>
            <CardBody>
              <p className="text-[14px] text-[var(--text-tertiary)] py-6 text-center">
                Set an accounting date and click Search to load Node CRIF data.
              </p>
            </CardBody>
          </Card>
        ) : loading && !result ? (
          <PageLoader />
        ) : (
          <DataTable
            data={rows}
            columns={columns}
            sortable
            filterable
            pageSize={Math.max(rows.length, pageSize)}
            emptyMessage="No records found for these filters."
            emptyDescription="Try another accounting date, branch, or borrower ID."
          />
        )}
      </div>
    </div>
  )
}
