import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { FileSpreadsheet, Loader2, Play, RefreshCw, Upload, X } from 'lucide-react'
import * as api from '@/lib/api'
import { CRIF_SYNC_BRANCH_OPTIONS } from '@/lib/crifConstants'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { Badge } from '@/components/Badge'
import { Toggle } from '@/components/Toggle'
import { CrifMigrationLogs } from '@/components/CrifMigrationLogs'
import { CrifSyncResults } from '@/components/CrifSyncResults'
import { DataTable } from '@/components/DataTable'
import { PageLoader } from '@/components/PageLoader'
import { cn } from '@/lib/utils'

const ACCEPTED_FILE_TYPES = '.xlsx,.xls,.xlsm,.csv'
const SYNC_MODES = {
  excel: 'excel',
  all: 'all',
}

function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatCrifDate(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 2)}/${raw.slice(2, 4)}/${raw.slice(4, 8)}`
  }
  return raw
}

function migrationStatusVariant(status) {
  const s = String(status ?? '').toUpperCase()
  if (s === 'SUCCESS') return 'matched'
  if (s === 'PARTIAL_SUCCESS') return 'exception'
  if (s === 'FAILED') return 'breached'
  return 'pending'
}

export function Crif() {
  const fileInputRef = useRef(null)
  const [syncMode, setSyncMode] = useState(SYNC_MODES.excel)
  const [syncStatus, setSyncStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [borrowerFile, setBorrowerFile] = useState(null)
  const [borrowerPreview, setBorrowerPreview] = useState(null)
  const [parsingFile, setParsingFile] = useState(false)
  const [performMigration, setPerformMigration] = useState(true)
  const [loading, setLoading] = useState(false)
  const [logsRefreshKey, setLogsRefreshKey] = useState(0)
  const [autoSelectLatest, setAutoSelectLatest] = useState(false)
  const [lastSyncResult, setLastSyncResult] = useState(null)

  const loadSyncStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const data = await api.crif.syncStatus()
      setSyncStatus(data)
    } catch (err) {
      toast.error(err.message || 'Could not load sync status')
    } finally {
      setStatusLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSyncStatus()
  }, [loadSyncStatus])

  async function handleFileSelect(file) {
    if (!file) return

    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!['xlsx', 'xls', 'xlsm', 'csv'].includes(ext)) {
      toast.error('Upload an Excel or CSV file (.xlsx, .xls, .csv)')
      return
    }

    setBorrowerFile(file)
    setBorrowerPreview(null)
    setLastSyncResult(null)
    setParsingFile(true)
    try {
      const parsed = await api.crif.parseBorrowerIds(file)
      setBorrowerPreview(parsed)
      toast.success(`${parsed.count} borrower IDs loaded`)
    } catch (err) {
      setBorrowerFile(null)
      toast.error(err.message || 'Could not read file')
    } finally {
      setParsingFile(false)
    }
  }

  function clearBorrowerFile() {
    setBorrowerFile(null)
    setBorrowerPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function afterSyncSuccess(result, mode) {
    setLastSyncResult({
      ...result,
      mode,
      completedAt: new Date().toISOString(),
    })
    const moved = result?.syncResult?.summary?.totalMoved ?? 0
    const failed = result?.syncResult?.summary?.totalFailed ?? 0
    if (failed > 0) {
      toast.success(`Sync finished — ${moved} synced, ${failed} failed`)
    } else {
      toast.success(`Sync finished — ${moved} borrower${moved === 1 ? '' : 's'} synced`)
    }
    setAutoSelectLatest(true)
    setLogsRefreshKey((k) => k + 1)
    await loadSyncStatus()
  }

  async function handleUniversalSync() {
    setLoading(true)
    setLastSyncResult(null)
    try {
      const result = await api.crif.universalSync({ performMigration })
      await afterSyncSuccess(result, SYNC_MODES.all)
    } catch (err) {
      toast.error(err.message || 'Sync failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleExcelSync(e) {
    e.preventDefault()
    if (!borrowerFile) {
      toast.error('Upload a borrower Excel file first')
      return
    }

    setLoading(true)
    setLastSyncResult(null)
    try {
      const result = await api.crif.syncFromLoandisk({
        branchIDs: CRIF_SYNC_BRANCH_OPTIONS.map((b) => b.id).join(','),
        file: borrowerFile,
      })
      await afterSyncSuccess(
        {
          ...result,
          fileName: result.fileName || borrowerFile.name,
          borrowers: (() => {
            const fromFile = result.borrowers?.length ? result.borrowers : borrowerPreview?.rows ?? []
            const byId = new Map(fromFile.map((r) => [String(r.borrowerId), r]))
            for (const row of result.syncResult?.syncedBorrowers || []) {
              const prev = byId.get(String(row.borrowerId)) || { borrowerId: row.borrowerId }
              byId.set(String(row.borrowerId), { ...prev, name: row.name || prev.name || null })
            }
            return [...byId.values()]
          })(),
        },
        SYNC_MODES.excel
      )
    } catch (err) {
      toast.error(err.message || 'Sync failed')
    } finally {
      setLoading(false)
    }
  }

  const latestMigration = syncStatus?.latestMigration
  const previewColumns = [
    {
      key: 'borrowerId',
      label: 'Borrower ID',
      sortAccessor: (r) => r.borrowerId,
      render: (r) => <span className="mono text-[var(--text-primary)]">{r.borrowerId}</span>,
    },
    {
      key: 'name',
      label: 'Name',
      sortAccessor: (r) => r.name || '',
      render: (r) => <span className="text-[13px] text-[var(--text-secondary)]">{r.name || '—'}</span>,
    },
  ]

  return (
    <div>
      <PageHeader
        eyebrow="CRIF"
        title="Sync"
        subtitle="Pull LoanDisk data into Node CRIF tables for Simplified Lending and E&S."
      />

      <Card className="mb-6">
        <CardHeader
          title="Sync status"
          subtitle="Last updated from NodeCRIF_SubjectData / NodeCRIF_ContractData on SQL."
          action={
            <Button type="button" variant="secondary" size="sm" onClick={loadSyncStatus} disabled={statusLoading}>
              {statusLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          }
        />
        <CardBody className="space-y-4">
          {statusLoading && !syncStatus ? (
            <PageLoader label="Loading sync status…" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] px-4 py-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">Last migration</p>
                  <p className="text-[14px] font-medium text-[var(--text-primary)]">
                    {formatDateTime(syncStatus?.lastUpdated || latestMigration?.migrationDate)}
                  </p>
                </div>
                {latestMigration?.status && (
                  <Badge variant={migrationStatusVariant(latestMigration.status)}>
                    {latestMigration.status.replace(/_/g, ' ')}
                  </Badge>
                )}
                {latestMigration && (
                  <p className="text-[12px] text-[var(--text-secondary)]">
                    {latestMigration.totalMoved ?? 0} moved · {latestMigration.totalFailed ?? 0} failed ·{' '}
                    {latestMigration.totalFound ?? 0} found
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {(syncStatus?.branches ?? CRIF_SYNC_BRANCH_OPTIONS.map((b) => ({ branchId: b.id, label: b.label }))).map(
                  (branch) => (
                    <div
                      key={branch.branchId}
                      className="rounded-[var(--radius-md)] border border-[var(--border-light)] px-4 py-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[14px] font-semibold text-[var(--text-primary)]">{branch.label}</p>
                        <span className="mono text-[11px] text-[var(--text-tertiary)]">{branch.branchId}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[12px]">
                        <div>
                          <p className="text-[var(--text-tertiary)]">Subject rows</p>
                          <p className="font-medium text-[var(--text-primary)]">{branch.subjectCount ?? '—'}</p>
                        </div>
                        <div>
                          <p className="text-[var(--text-tertiary)]">Contract rows</p>
                          <p className="font-medium text-[var(--text-primary)]">{branch.contractCount ?? '—'}</p>
                        </div>
                        <div>
                          <p className="text-[var(--text-tertiary)]">Acct. date</p>
                          <p className="font-medium text-[var(--text-primary)]">
                            {formatCrifDate(branch.accountingDate)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[var(--text-tertiary)]">Last updated</p>
                          <p className="font-medium text-[var(--text-primary)]">{formatDateTime(branch.lastUpdated)}</p>
                        </div>
                      </div>
                    </div>
                  )
                )}
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Run sync"
          subtitle="Upload Excel with borrower IDs — we call LoanDisk and write into NodeCRIF_SubjectData / NodeCRIF_ContractData."
        />
        <CardBody className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSyncMode(SYNC_MODES.excel)}
              className={cn(
                'rounded-[var(--radius-md)] border px-3 py-1.5 text-[13px] font-medium transition-colors',
                syncMode === SYNC_MODES.excel
                  ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]'
                  : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              )}
            >
              From Excel file
            </button>
            <button
              type="button"
              onClick={() => setSyncMode(SYNC_MODES.all)}
              className={cn(
                'rounded-[var(--radius-md)] border px-3 py-1.5 text-[13px] font-medium transition-colors',
                syncMode === SYNC_MODES.all
                  ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]'
                  : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
              )}
            >
              All borrowers
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {CRIF_SYNC_BRANCH_OPTIONS.map((branch) => (
              <span
                key={branch.id}
                className="inline-flex items-center rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)]"
              >
                {branch.label}
              </span>
            ))}
          </div>

          {syncMode === SYNC_MODES.all && (
            <div className="flex items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--border-light)] px-4 py-3">
              <div>
                <p className="text-[13px] font-medium text-[var(--text-primary)]">Perform migration</p>
                <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                  Move validated records into Node CRIF tables after pull.
                </p>
              </div>
              <Toggle checked={performMigration} onChange={setPerformMigration} disabled={loading} />
            </div>
          )}

          {syncMode === SYNC_MODES.excel ? (
            <form onSubmit={handleExcelSync} className="space-y-4">
              <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] px-4 py-3 text-[12px] text-[var(--text-secondary)]">
                Flow: <span className="font-medium text-[var(--text-primary)]">Excel IDs</span> → LoanDisk API →{' '}
                <span className="mono text-[var(--text-primary)]">NodeCRIF_SubjectData</span> +{' '}
                <span className="mono text-[var(--text-primary)]">NodeCRIF_ContractData</span>
              </div>

              <div className="space-y-2">
                <Label>Borrower Excel file</Label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_FILE_TYPES}
                  className="hidden"
                  disabled={loading || parsingFile}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFileSelect(file)
                    e.target.value = ''
                  }}
                />

                {!borrowerFile ? (
                  <button
                    type="button"
                    disabled={loading || parsingFile}
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      'flex w-full flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed px-4 py-8 transition-colors duration-100',
                      'border-[var(--border-light)] bg-[var(--bg-subtle)] hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]',
                      (loading || parsingFile) && 'opacity-60 cursor-not-allowed'
                    )}
                  >
                    {parsingFile ? (
                      <Loader2 className="h-8 w-8 text-[var(--accent)] animate-spin" />
                    ) : (
                      <Upload className="h-8 w-8 text-[var(--text-tertiary)]" />
                    )}
                    <span className="text-[14px] font-medium text-[var(--text-primary)]">
                      {parsingFile ? 'Reading file…' : 'Upload borrower Excel'}
                    </span>
                    <span className="text-[12px] text-[var(--text-tertiary)] text-center max-w-md">
                      Include a <span className="mono">BorrowerId</span> column (or first numeric column). Optional name
                      column for clearer results.
                    </span>
                  </button>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] px-4 py-3">
                      <FileSpreadsheet className="h-5 w-5 shrink-0 text-[var(--accent)]" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">{borrowerFile.name}</p>
                        <p className="text-[12px] text-[var(--text-tertiary)]">
                          {borrowerPreview?.count ?? '—'} borrower IDs ready to sync
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={clearBorrowerFile}
                        disabled={loading || parsingFile}
                        className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"
                        title="Remove file"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    {borrowerPreview?.rows?.length > 0 && (
                      <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] overflow-hidden">
                        <div className="px-4 py-2 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]">
                          <p className="text-[12px] font-medium text-[var(--text-secondary)]">Preview</p>
                        </div>
                        <div className="p-2">
                          <DataTable
                            data={borrowerPreview.rows}
                            columns={previewColumns}
                            sortable
                            pageSize={5}
                            emptyMessage="No rows found."
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <Button type="submit" disabled={loading || parsingFile || !borrowerFile}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Syncing from LoanDisk…
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Sync from Excel
                  </>
                )}
              </Button>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-[13px] text-[var(--text-secondary)]">
                Pulls every borrower from Monthly Bull for Simplified Lending and E&S into Node CRIF tables.
              </p>
              <Button type="button" onClick={handleUniversalSync} disabled={loading || parsingFile}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Syncing all borrowers…
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Sync all borrowers
                  </>
                )}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      {lastSyncResult?.syncResult && (
        <CrifSyncResults
          result={lastSyncResult}
          fileName={lastSyncResult.fileName}
          borrowers={lastSyncResult.borrowers}
          mode={lastSyncResult.mode === SYNC_MODES.all ? 'universal' : 'targeted'}
        />
      )}

      <CrifMigrationLogs
        refreshKey={logsRefreshKey}
        autoSelectLatest={autoSelectLatest}
        onAutoSelectDone={() => setAutoSelectLatest(false)}
        highlightBorrowerIds={
          lastSyncResult?.mode === SYNC_MODES.excel ? lastSyncResult?.borrowers?.map((r) => r.borrowerId) : undefined
        }
      />
    </div>
  )
}
