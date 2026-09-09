import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import * as api from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { Badge } from '@/components/Badge'
import { DataTable } from '@/components/DataTable'
import { PageLoader } from '@/components/PageLoader'
import { cn } from '@/lib/utils'

const TYPE_OPTIONS = [
  { label: 'Subject', value: 'Subject' },
  { label: 'Contract', value: 'Contract' },
]

const BRANCH_LABELS = {
  '18279': 'Simplified Lending',
  '26281': 'E&S',
  '16209': 'SBDC',
  '36198': 'SL Business loan',
  '51238': 'Test Branch',
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

function branchLabel(code) {
  if (!code) return '—'
  return BRANCH_LABELS[String(code)] || String(code)
}

export function CrifFailedData() {
  const [type, setType] = useState('Subject')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rows, setRows] = useState([])
  const [errorSummary, setErrorSummary] = useState([])
  const [totalCount, setTotalCount] = useState(0)
  const [message, setMessage] = useState(null)
  const [loadedType, setLoadedType] = useState(null)

  const load = useCallback(async (recordType = type) => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.crif.migrationFailedRecords({ type: recordType })
      setRows(data.rows || [])
      setErrorSummary(data.errorSummary || [])
      setTotalCount(data.totalCount || 0)
      setMessage(data.message || null)
      setLoadedType(data.type || recordType)
    } catch (e) {
      setRows([])
      setErrorSummary([])
      setTotalCount(0)
      setMessage(null)
      setError(e.message || 'Failed to load migration failed records')
      toast.error(e.message || 'Failed to load migration failed records')
    } finally {
      setLoading(false)
    }
  }, [type])

  useEffect(() => {
    load('Subject')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleTypeChange(next) {
    setType(next)
    load(next)
  }

  const columns = useMemo(() => {
    const cols = [
      {
        key: 'errorType',
        label: 'Error type',
        sortAccessor: (r) => r.errorType || '',
        render: (r) => (
          <Badge variant="breached" className="whitespace-nowrap">
            {r.errorType || '—'}
          </Badge>
        ),
      },
      {
        key: 'errorCode',
        label: 'Code',
        sortAccessor: (r) => r.errorCode || '',
        render: (r) => (
          <span className="mono text-[12px] font-medium text-[var(--text-primary)]">{r.errorCode || '—'}</span>
        ),
      },
      {
        key: 'errorMessage',
        label: 'Error message',
        sortAccessor: (r) => r.errorMessage || '',
        render: (r) => (
          <span className="text-[13px] text-[var(--text-secondary)] max-w-[320px] block truncate" title={r.errorMessage || ''}>
            {r.errorMessage || '—'}
          </span>
        ),
      },
      {
        key: 'branchCode',
        label: 'Branch',
        sortAccessor: (r) => r.branchCode || '',
        render: (r) => (
          <span className="text-[13px] text-[var(--text-secondary)]">{branchLabel(r.branchCode)}</span>
        ),
      },
      {
        key: 'fiSubjectCode',
        label: 'Subject ID',
        sortAccessor: (r) => r.fiSubjectCode || '',
        render: (r) => (
          <span className="mono font-medium text-[var(--text-primary)]">{r.fiSubjectCode || '—'}</span>
        ),
      },
    ]

    if (loadedType === 'Subject') {
      cols.push(
        {
          key: 'name',
          label: 'Name',
          sortAccessor: (r) => fullName(r),
          render: (r) => <span className="text-[13px] text-[var(--text-primary)]">{fullName(r)}</span>,
        },
        {
          key: 'nibNumber',
          label: 'NIB',
          sortAccessor: (r) => r.nibNumber || '',
          render: (r) => (
            <span className="mono text-[12px] text-[var(--text-secondary)]">{r.nibNumber || '—'}</span>
          ),
        },
        {
          key: 'mobilePhone',
          label: 'Mobile',
          sortAccessor: (r) => r.mobilePhone || '',
          render: (r) => (
            <span className="text-[13px] text-[var(--text-secondary)]">{r.mobilePhone || '—'}</span>
          ),
        }
      )
    } else {
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
          render: (r) => (
            <span className="text-[13px] text-[var(--text-secondary)]">{r.contractPhase || '—'}</span>
          ),
        },
        {
          key: 'outstandingBalance',
          label: 'Outstanding',
          sortAccessor: (r) => Number(r.outstandingBalance) || 0,
          render: (r) => (
            <span className="mono text-[13px] text-[var(--text-primary)]">{r.outstandingBalance ?? '—'}</span>
          ),
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
  }, [loadedType])

  const selectClass =
    'flex h-10 w-full rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-3 text-[13px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]'

  return (
    <div>
      <PageHeader
        eyebrow="CRIF"
        title="Failed Data"
        subtitle="Migration failed records from Get_MigrationFailedRecords (Subject / Contract)."
      />

      <Card>
        <CardHeader title="Filters" subtitle="Switch type to reload failed Subject or Contract rows." />
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5 min-w-[200px]">
              <Label htmlFor="failedType">Type</Label>
              <select
                id="failedType"
                className={selectClass}
                value={type}
                onChange={(e) => handleTypeChange(e.target.value)}
                disabled={loading}
              >
                {TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <Button type="button" variant="secondary" onClick={() => load(type)} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Loading…
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh
                </>
              )}
            </Button>
          </div>
        </CardBody>
      </Card>

      {error && (
        <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--danger)]/30 bg-[var(--danger-bg)] px-3 py-2 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Card>
          <CardBody className="py-4">
            <p className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">Failed records</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{totalCount}</p>
            <p className="text-[12px] text-[var(--text-secondary)]">{loadedType || type}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="py-4">
            <p className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">Error types</p>
            <p className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{errorSummary.length}</p>
            <p className="text-[12px] text-[var(--text-secondary)]">Distinct failure categories</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="py-4">
            <p className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">Top error</p>
            <p className="mt-1 text-[15px] font-semibold text-[var(--text-primary)] truncate">
              {errorSummary[0]?.type || '—'}
            </p>
            <p className="text-[12px] text-[var(--text-secondary)]">
              {errorSummary[0] ? `${errorSummary[0].count} record(s)` : 'No failures loaded'}
            </p>
          </CardBody>
        </Card>
      </div>

      {errorSummary.length > 0 && (
        <Card className="mt-4">
          <CardHeader title="Error summary" subtitle="Counts by ErrorType from the failed records response." />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {errorSummary.map((item) => (
                <span
                  key={item.type}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] px-2.5 py-1.5 text-[12px]'
                  )}
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-[var(--danger)]" />
                  <span className="font-medium text-[var(--text-primary)]">{item.type}</span>
                  <Badge variant="pending">{item.count}</Badge>
                </span>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader
          title={`${loadedType || type} failed records`}
          subtitle={
            message
              ? message
              : `Loaded from CRIF_Operations · Get_MigrationFailedRecords · ${loadedType || type}`
          }
        />
        <CardBody className="p-0">
          {loading && rows.length === 0 ? (
            <div className="p-8">
              <PageLoader label="Loading failed records…" />
            </div>
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              sortable
              emptyMessage={message || `No failed ${loadedType || type} records found.`}
            />
          )}
        </CardBody>
      </Card>
    </div>
  )
}
