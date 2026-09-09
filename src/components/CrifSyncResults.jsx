import { useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, FileSpreadsheet } from 'lucide-react'
import { Badge } from '@/components/Badge'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { DataTable } from '@/components/DataTable'
import { cn } from '@/lib/utils'

const ERROR_TYPE_META = {
  MISSING_STAGING_DATA: { label: 'Missing staging', variant: 'exception' },
  MANDATORY_FIELD_MISSING: { label: 'Mandatory fields', variant: 'breached' },
  INVALID_NIB_NUMBER: { label: 'Invalid NIB', variant: 'breached' },
  DEPENDENCY_FAILURE: { label: 'Dependency skip', variant: 'pending' },
}

function formatErrorType(type) {
  if (!type) return '—'
  return ERROR_TYPE_META[type]?.label || type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
}

function errorVariant(type) {
  return ERROR_TYPE_META[type]?.variant || 'pending'
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

export function CrifSyncResults({ result, fileName, borrowers = [], mode = 'targeted' }) {
  const [activeTab, setActiveTab] = useState('synced')

  const syncResult = result?.syncResult
  const summary = syncResult?.summary ?? {}
  const nameById = useMemo(
    () => new Map((borrowers || []).map((row) => [String(row.borrowerId), row.name || null])),
    [borrowers]
  )

  const syncedRows = useMemo(() => {
    const ids = syncResult?.movedBorrowerIds ?? []
    return ids.map((borrowerId) => ({
      borrowerId: String(borrowerId),
      name: nameById.get(String(borrowerId)) || null,
    }))
  }, [syncResult?.movedBorrowerIds, nameById])

  const failedRows = syncResult?.failedBorrowers ?? []
  const requestedCount =
    mode === 'targeted'
      ? borrowers.length || result?.borrowerCount || summary.totalFound || 0
      : summary.totalFound || 0

  const syncedColumns = useMemo(
    () => [
      {
        key: 'borrowerId',
        label: 'Borrower ID',
        sortAccessor: (r) => r.borrowerId,
        render: (r) => <span className="mono font-medium text-[var(--text-primary)]">{r.borrowerId}</span>,
      },
      {
        key: 'name',
        label: 'Name',
        sortAccessor: (r) => r.name || '',
        render: (r) => <span className="text-[13px] text-[var(--text-secondary)]">{r.name || '—'}</span>,
      },
      {
        key: 'status',
        label: 'Status',
        render: () => (
          <Badge variant="matched">
            <CheckCircle2 className="h-3 w-3 mr-1 inline" />
            Synced
          </Badge>
        ),
      },
    ],
    []
  )

  const failedColumns = useMemo(
    () => [
      {
        key: 'borrowerId',
        label: 'Borrower ID',
        sortAccessor: (r) => r.borrowerId,
        render: (r) => <span className="mono font-medium text-[var(--text-primary)]">{r.borrowerId}</span>,
      },
      {
        key: 'name',
        label: 'Name',
        sortAccessor: (r) => nameById.get(String(r.borrowerId)) || '',
        render: (r) => (
          <span className="text-[13px] text-[var(--text-secondary)]">{nameById.get(String(r.borrowerId)) || '—'}</span>
        ),
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
      {
        key: 'issueCount',
        label: 'Issues',
        sortAccessor: (r) => r.issueCount ?? 0,
        render: (r) =>
          (r.issueCount ?? 0) > 1 ? (
            <span className="mono text-[12px] text-[var(--text-tertiary)]">{r.issueCount}</span>
          ) : (
            <span className="text-[var(--text-tertiary)]">—</span>
          ),
      },
    ],
    [nameById]
  )

  if (!syncResult) return null

  const hasFailures = failedRows.length > 0
  const allSynced = requestedCount > 0 && syncedRows.length === requestedCount && !hasFailures

  return (
    <Card className="mt-6">
      <CardHeader
        title="Sync results"
        subtitle={
          mode === 'targeted'
            ? fileName
              ? `LoanDisk → NodeCRIF from ${fileName}`
              : 'LoanDisk → NodeCRIF_SubjectData / NodeCRIF_ContractData'
            : 'Latest universal sync outcome'
        }
      />
      <CardBody className="space-y-5">
        {fileName && mode === 'targeted' && (
          <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] px-3 py-2 text-[12px] text-[var(--text-secondary)]">
            <FileSpreadsheet className="h-4 w-4 shrink-0 text-[var(--accent)]" />
            <span className="truncate">{fileName}</span>
            <span className="text-[var(--text-tertiary)]">·</span>
            <span>{requestedCount} requested</span>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <ResultStat
            label={mode === 'targeted' ? 'Requested' : 'Found'}
            value={requestedCount}
            tone="accent"
            hint={mode === 'targeted' ? 'Borrowers in upload' : 'Borrowers processed'}
          />
          <ResultStat
            label="Synced"
            value={summary.totalMoved ?? syncedRows.length}
            tone="success"
            hint="Moved into Node CRIF tables"
          />
          <ResultStat
            label="Failed"
            value={summary.totalFailed ?? failedRows.length}
            tone="danger"
            hint="Could not be migrated"
          />
        </div>

        {allSynced ? (
          <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--success)]/30 bg-[var(--success)]/5 px-4 py-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--success)] mt-0.5" />
            <div>
              <p className="text-[14px] font-medium text-[var(--text-primary)]">All borrowers synced successfully</p>
              <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
                {syncedRows.length} borrower{syncedRows.length === 1 ? '' : 's'} moved to Node CRIF tables.
              </p>
            </div>
          </div>
        ) : hasFailures ? (
          <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-4 py-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-[var(--danger)] mt-0.5" />
            <div>
              <p className="text-[14px] font-medium text-[var(--text-primary)]">Some borrowers could not be synced</p>
              <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">
                {syncedRows.length} synced · {failedRows.length} failed — review the failed list below.
              </p>
            </div>
          </div>
        ) : null}

        {(syncedRows.length > 0 || failedRows.length > 0) && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 border-b border-[var(--border-light)] pb-2">
              <button
                type="button"
                onClick={() => setActiveTab('synced')}
                className={cn(
                  'rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium transition-colors',
                  activeTab === 'synced'
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                Synced ({syncedRows.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('failed')}
                className={cn(
                  'rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium transition-colors',
                  activeTab === 'failed'
                    ? 'bg-[var(--danger)]/10 text-[var(--danger)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
                )}
              >
                Failed ({failedRows.length})
              </button>
            </div>

            {activeTab === 'synced' ? (
              <DataTable
                data={syncedRows}
                columns={syncedColumns}
                sortable
                pageSize={10}
                emptyMessage="No borrowers were synced in this run."
              />
            ) : (
              <DataTable
                data={failedRows}
                columns={failedColumns}
                sortable
                pageSize={10}
                emptyMessage="No failed borrowers in this run."
              />
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
