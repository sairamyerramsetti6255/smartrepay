import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react'
import * as api from '@/lib/api'
import { Badge } from '@/components/Badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { DataTable } from '@/components/DataTable'
import { PageLoader } from '@/components/PageLoader'
import { cn, formatDateTime } from '@/lib/utils'

const ERROR_TYPE_META = {
  MISSING_STAGING_DATA: { label: 'Missing staging', variant: 'exception' },
  MANDATORY_FIELD_MISSING: { label: 'Mandatory fields', variant: 'breached' },
  INVALID_NIB_NUMBER: { label: 'Invalid NIB', variant: 'breached' },
  DEPENDENCY_FAILURE: { label: 'Dependency skip', variant: 'pending' },
}

const STATUS_META = {
  SUCCESS: { label: 'Success', variant: 'matched' },
  PARTIAL_SUCCESS: { label: 'Partial success', variant: 'exception' },
  FAILED: { label: 'Failed', variant: 'breached' },
}

function formatErrorType(type) {
  if (!type) return '—'
  return ERROR_TYPE_META[type]?.label || type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
}

function errorVariant(type) {
  return ERROR_TYPE_META[type]?.variant || 'pending'
}

function statusVariant(status) {
  return STATUS_META[status]?.variant || 'pending'
}

function statusLabel(status) {
  return STATUS_META[status]?.label || status || 'Unknown'
}

function ResultStat({ label, value, tone, hint }) {
  const toneClass =
    tone === 'success'
      ? 'text-[var(--success)]'
      : tone === 'danger'
        ? 'text-[var(--danger)]'
        : tone === 'accent'
          ? 'text-[var(--accent)]'
          : 'text-[var(--text-primary)]'

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-4 py-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">{label}</p>
      <p className={cn('mt-1.5 text-[28px] font-bold tracking-[-0.03em] leading-none mono', toneClass)}>{value}</p>
      {hint && <p className="mt-2 text-[11px] text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  )
}

export function CrifMigrationLogs({
  refreshKey = 0,
  autoSelectLatest = false,
  onAutoSelectDone,
  highlightBorrowerIds,
}) {
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [runs, setRuns] = useState([])
  const [pageIndex, setPageIndex] = useState(1)
  const [pageSize] = useState(10)
  const [totalCount, setTotalCount] = useState(0)
  const [nextPage, setNextPage] = useState(false)
  const [selectedRun, setSelectedRun] = useState(null)
  const [detail, setDetail] = useState(null)
  const [borrowerFilter, setBorrowerFilter] = useState('')
  const [activeBorrowerFilter, setActiveBorrowerFilter] = useState('')

  const loadRuns = useCallback(async (page = pageIndex) => {
    setLoadingRuns(true)
    try {
      const data = await api.crif.migrationLogs({
        viewType: 'Summary',
        pageIndex: page,
        pageSize,
      })
      const nextRuns = data.runs ?? []
      setRuns(nextRuns)
      setTotalCount(data.totalCount ?? nextRuns.length)
      setNextPage(Boolean(data.nextPage))
      return nextRuns
    } catch (e) {
      toast.error(e.message || 'Could not load migration logs')
      setRuns([])
      return []
    } finally {
      setLoadingRuns(false)
    }
  }, [pageIndex, pageSize])

  const loadDetail = useCallback(async (run, borrowerId = '') => {
    if (!run?.id) return
    setLoadingDetail(true)
    setSelectedRun(run)
    try {
      const params = { id: run.id }
      if (borrowerId) params.borrowerId = borrowerId
      const data = await api.crif.migrationLogs(params)
      setDetail(data)
      setActiveBorrowerFilter(borrowerId)
    } catch (e) {
      toast.error(e.message || 'Could not load migration details')
      setDetail(null)
    } finally {
      setLoadingDetail(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const nextRuns = await loadRuns(pageIndex)
      if (cancelled) return
      if (autoSelectLatest && nextRuns[0]) {
        await loadDetail(nextRuns[0])
        onAutoSelectDone?.()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshKey, pageIndex, autoSelectLatest, loadRuns, loadDetail])

  const runColumns = useMemo(
    () => [
      {
        key: 'migrationDate',
        label: 'Run date',
        sortAccessor: (r) => r.migrationDate || '',
        render: (r) => (
          <span className="text-[13px] text-[var(--text-primary)]">{formatDateTime(r.migrationDate)}</span>
        ),
      },
      {
        key: 'status',
        label: 'Status',
        sortAccessor: (r) => r.status || '',
        render: (r) => <Badge variant={statusVariant(r.status)}>{statusLabel(r.status)}</Badge>,
      },
      {
        key: 'totalFound',
        label: 'Found',
        sortAccessor: (r) => r.totalFound ?? 0,
        render: (r) => <span className="mono text-[var(--text-primary)]">{r.totalFound ?? 0}</span>,
      },
      {
        key: 'totalMoved',
        label: 'Moved',
        sortAccessor: (r) => r.totalMoved ?? 0,
        render: (r) => <span className="mono text-[var(--success)]">{r.totalMoved ?? 0}</span>,
      },
      {
        key: 'totalFailed',
        label: 'Failed',
        sortAccessor: (r) => r.totalFailed ?? 0,
        render: (r) => <span className="mono text-[var(--danger)]">{r.totalFailed ?? 0}</span>,
      },
      {
        key: 'errorCodes',
        label: 'Error codes',
        sortAccessor: (r) => r.errorCodes || '',
        render: (r) => (
          <span className="text-[12px] text-[var(--text-secondary)] truncate max-w-[220px] block" title={r.errorCodes || ''}>
            {r.errorCodes || '—'}
          </span>
        ),
      },
    ],
    []
  )

  const detailColumns = useMemo(
    () => [
      {
        key: 'borrowerId',
        label: 'Borrower',
        sortAccessor: (r) => r.borrowerId || '',
        render: (r) => <span className="mono font-medium text-[var(--text-primary)]">{r.borrowerId || '—'}</span>,
      },
      {
        key: 'borrowerName',
        label: 'Name',
        sortAccessor: (r) => r.borrowerName || '',
        render: (r) => <span className="text-[13px] text-[var(--text-secondary)]">{r.borrowerName || '—'}</span>,
      },
      {
        key: 'contractId',
        label: 'Contract',
        sortAccessor: (r) => r.contractId || '',
        render: (r) => <span className="mono text-[var(--text-secondary)]">{r.contractId || '—'}</span>,
      },
      {
        key: 'errorType',
        label: 'Issue type',
        sortAccessor: (r) => r.errorType || '',
        render: (r) =>
          r.errorType ? (
            <Badge variant={errorVariant(r.errorType)}>{formatErrorType(r.errorType)}</Badge>
          ) : (
            <span className="text-[var(--text-tertiary)]">—</span>
          ),
      },
      {
        key: 'errorCode',
        label: 'Code',
        sortAccessor: (r) => r.errorCode || '',
        render: (r) => <span className="mono text-[12px] text-[var(--text-secondary)]">{r.errorCode || '—'}</span>,
      },
      {
        key: 'errorMessage',
        label: 'Message',
        sortAccessor: (r) => r.errorMessage || '',
        render: (r) => (
          <span className="text-[13px] text-[var(--text-secondary)] leading-snug">{r.errorMessage || '—'}</span>
        ),
      },
    ],
    []
  )

  const highlightIdSet = useMemo(
    () =>
      highlightBorrowerIds?.length
        ? new Set(highlightBorrowerIds.map((id) => String(id).trim()).filter(Boolean))
        : null,
    [highlightBorrowerIds]
  )

  const detailRows = useMemo(() => {
    const rows = detail?.rows ?? []
    if (!highlightIdSet?.size) return rows
    return rows.filter((row) => highlightIdSet.has(String(row.borrowerId ?? '')))
  }, [detail?.rows, highlightIdSet])
  const successRate =
    selectedRun?.totalFound > 0 ? Math.round((selectedRun.totalMoved / selectedRun.totalFound) * 100) : 0

  async function handleRefresh() {
    await loadRuns(pageIndex)
    if (selectedRun) await loadDetail(selectedRun, activeBorrowerFilter)
  }

  function handleBorrowerSearch(e) {
    e.preventDefault()
    if (!selectedRun) return toast.error('Select a migration run first')
    loadDetail(selectedRun, borrowerFilter.trim())
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)] tracking-[-0.02em]">Migration logs</h2>
          <p className="text-[13px] text-[var(--text-tertiary)] mt-0.5">
            Loaded from CRIF_Operations · Get_MigrationLogs
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={handleRefresh} disabled={loadingRuns || loadingDetail}>
          <RefreshCw className={cn('h-4 w-4 mr-2', (loadingRuns || loadingDetail) && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader title="Migration runs" subtitle={`${totalCount} total runs`} />
        <CardBody className="pt-2">
          {loadingRuns ? (
            <PageLoader />
          ) : (
            <>
              <DataTable
                data={runs}
                columns={runColumns}
                sortable
                pageSize={pageSize}
                onRowClick={(run) => loadDetail(run, '')}
                rowClassName={(run) =>
                  selectedRun?.id === run.id ? 'bg-[var(--accent-subtle)]/40' : undefined
                }
                emptyMessage="No migration runs found."
              />
              <div className="mt-4 flex items-center justify-between">
                <p className="text-[12px] text-[var(--text-tertiary)]">Page {pageIndex}</p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pageIndex <= 1 || loadingRuns}
                    onClick={() => setPageIndex((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!nextPage || loadingRuns}
                    onClick={() => setPageIndex((p) => p + 1)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {selectedRun && (
        <Card>
          <CardHeader
            title={`Run #${selectedRun.id}`}
            subtitle={formatDateTime(selectedRun.migrationDate)}
            action={<Badge variant={statusVariant(selectedRun.status)}>{statusLabel(selectedRun.status)}</Badge>}
          />
          <CardBody className="space-y-5 pt-2">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <ResultStat label="Found in staging" value={selectedRun.totalFound ?? 0} tone="accent" />
              <ResultStat label="Moved" value={selectedRun.totalMoved ?? 0} tone="success" hint={`${successRate}% of found`} />
              <ResultStat label="Failed" value={selectedRun.totalFailed ?? 0} tone="danger" />
              <ResultStat
                label="Detail entries"
                value={loadingDetail ? '…' : detailRows.length}
                hint={
                  highlightIdSet?.size
                    ? `From upload (${highlightIdSet.size} borrowers)`
                    : activeBorrowerFilter
                      ? `Filtered: ${activeBorrowerFilter}`
                      : 'All failures for this run'
                }
              />
            </div>

            {selectedRun.totalFound > 0 && (
              <div>
                <div className="mb-2 flex items-center justify-between text-[12px]">
                  <span className="text-[var(--text-tertiary)]">Migration progress</span>
                  <span className="font-medium text-[var(--text-secondary)]">
                    {selectedRun.totalMoved} moved · {selectedRun.totalFailed} failed
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-[var(--radius-full)] bg-[var(--bg-subtle)]">
                  <div className="flex h-full">
                    <div
                      className="bg-[var(--success)] transition-all duration-300"
                      style={{ width: `${(selectedRun.totalMoved / selectedRun.totalFound) * 100}%` }}
                    />
                    <div
                      className="bg-[var(--danger)] transition-all duration-300"
                      style={{ width: `${(selectedRun.totalFailed / selectedRun.totalFound) * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

            <form onSubmit={handleBorrowerSearch} className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[200px] space-y-1.5">
                <label className="text-[12px] font-medium text-[var(--text-secondary)]">Filter by borrower ID</label>
                <Input
                  value={borrowerFilter}
                  onChange={(e) => setBorrowerFilter(e.target.value)}
                  placeholder="e.g. 5148116"
                />
              </div>
              <Button type="submit" variant="secondary" disabled={loadingDetail}>
                <Search className="h-4 w-4 mr-2" />
                Filter
              </Button>
              {activeBorrowerFilter && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={loadingDetail}
                  onClick={() => {
                    setBorrowerFilter('')
                    loadDetail(selectedRun, '')
                  }}
                >
                  Clear filter
                </Button>
              )}
            </form>

            {detail?.errorSummary?.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.errorSummary.map((item) => (
                  <div
                    key={item.type}
                    className="inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] px-3 py-2"
                  >
                    <Badge variant={errorVariant(item.type)}>{formatErrorType(item.type)}</Badge>
                    <span className="text-[13px] font-semibold mono text-[var(--text-primary)]">{item.count}</span>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {selectedRun && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            {loadingDetail ? (
              <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
            ) : detailRows.length > 0 ? (
              <AlertCircle className="h-4 w-4 text-[var(--warning)]" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
            )}
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">Failure details</h3>
            <span className="text-[12px] text-[var(--text-tertiary)]">
              ({detailRows.length} {detailRows.length === 1 ? 'entry' : 'entries'})
            </span>
          </div>
          {loadingDetail ? (
            <PageLoader />
          ) : detailRows.length > 0 ? (
            <DataTable
              data={detailRows}
              columns={detailColumns}
              sortable
              filterable
              pageSize={10}
              emptyMessage="No failure details for this run."
            />
          ) : (
            <Card>
              <CardBody>
                <div className="flex items-center gap-3 py-2">
                  <CheckCircle2 className="h-5 w-5 text-[var(--success)] shrink-0" />
                  <p className="text-[14px] text-[var(--text-secondary)]">
                    No failure details returned for this run
                    {activeBorrowerFilter ? ` and borrower ${activeBorrowerFilter}` : ''}.
                  </p>
                </div>
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
