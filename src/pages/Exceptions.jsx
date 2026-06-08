import { useMemo, useState } from 'react'
import { useExceptions } from '@/hooks/useExceptions'
import { useBorrowers } from '@/hooks/useBorrowers'
import { ExceptionDrawer } from '@/components/ExceptionDrawer'
import { PageHeader } from '@/components/PageHeader'
import { DataTable } from '@/components/DataTable'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Badge } from '@/components/Badge'
import { Input } from '@/components/ui/input'
import { formatCurrency } from '@/lib/utils'
import { getSlaBucket, formatAge, aggregateSlaBuckets } from '@/lib/sla'
import { Card } from '@/components/Card'
import { PageLoader } from '@/components/PageLoader'

const TYPE_FILTERS = [
  { value: '', label: 'All' },
  { value: 'unmatched', label: 'Unmatched' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'partial', label: 'Partial' },
  { value: 'suspicious', label: 'Suspicious' },
]

export function Exceptions() {
  const { exceptions, loading, error, refetch } = useExceptions()
  const { borrowers, loans } = useBorrowers()
  const [selected, setSelected] = useState(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')

  const open = exceptions.filter((e) => e.status === 'open')
  const heatmap = aggregateSlaBuckets(open)

  const filtered = useMemo(
    () =>
      exceptions.filter((ex) => {
        if (typeFilter && ex.type !== typeFilter) return false
        if (statusFilter && ex.status !== statusFilter) return false
        if (search) {
          const tx = ex.transactions
          const hay = `${tx?.payer} ${ex.assigned_to}`.toLowerCase()
          if (!hay.includes(search.toLowerCase())) return false
        }
        return true
      }),
    [exceptions, typeFilter, statusFilter, search]
  )

  const columns = [
    { key: 'payer', label: 'Payer', render: (ex) => <span className="font-medium">{ex.transactions?.payer || '—'}</span> },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      render: (ex) => formatCurrency(ex.transactions?.amount),
    },
    { key: 'type', label: 'Type', render: (ex) => <Badge variant="exception">{ex.type}</Badge> },
    { key: 'assigned_to', label: 'Assigned', render: (ex) => ex.assigned_to || '—' },
    { key: 'age', label: 'Age', render: (ex) => <span className="mono text-[13px]">{formatAge(ex.created_at)}</span> },
    {
      key: 'sla',
      label: 'SLA Status',
      render: (ex) => {
        const sla = getSlaBucket(ex.created_at, ex.sla_hours)
        const v = sla.bucket === 'breached' ? 'breached' : sla.bucket === 'at_risk' ? 'at_risk' : 'on_track'
        return <Badge variant={v === 'on_track' ? 'on_track' : v === 'at_risk' ? 'at_risk' : 'breached'}>{sla.label}</Badge>
      },
    },
    {
      key: 'actions',
      label: '',
      render: (ex) => (
        <button
          type="button"
          className="text-[13px] font-medium text-[var(--accent)] hover:text-[var(--accent-hover)]"
          onClick={(e) => {
            e.stopPropagation()
            setSelected(ex)
            setDrawerOpen(true)
          }}
        >
          Review →
        </button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader title="Unmatched Queue" />

      <Card className="flex h-[72px] items-stretch overflow-hidden">
        <SlaMetric label="On Track" value={heatmap.on_track} color="var(--success)" />
        <div className="w-px bg-[var(--border-light)]" />
        <SlaMetric label="At Risk" value={heatmap.at_risk} color="var(--warning)" />
        <div className="w-px bg-[var(--border-light)]" />
        <SlaMetric label="Breached" value={heatmap.breached} color="var(--danger)" />
      </Card>

      <div className="flex flex-wrap items-center gap-2 justify-between">
        <SegmentedControl
          options={TYPE_FILTERS}
          value={typeFilter}
          onChange={setTypeFilter}
        />
        <div className="flex flex-wrap gap-2">
          <select
            className="h-9 rounded-[var(--radius-md)] border border-[var(--border-medium)] px-3 text-[13px] bg-[var(--bg-card)]"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">Status</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
          <Input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-48" />
        </div>
      </div>

      {error && <p className="text-[13px] text-[var(--danger)]">{error}</p>}

      {loading ? (
        <PageLoader label="Loading unmatched queue…" />
      ) : (
        <DataTable
          data={filtered}
          columns={columns}
          onRowClick={(ex) => {
            setSelected(ex)
            setDrawerOpen(true)
          }}
          rowClassName={(ex) => {
            const sla = getSlaBucket(ex.created_at, ex.sla_hours)
            return sla.bucket === 'breached' ? 'bg-[#FFF8F8]' : ''
          }}
          emptyMessage="No exceptions in queue"
          emptyDescription="All items have been resolved"
        />
      )}

      <ExceptionDrawer
        exception={selected}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        borrowers={borrowers}
        loans={loans}
        onResolved={refetch}
      />
    </div>
  )
}

function SlaMetric({ label, value, color }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6">
      <p className="text-2xl font-bold mono" style={{ color }}>
        {value}
      </p>
      <p className="text-xs text-[var(--text-tertiary)] mt-1">{label}</p>
    </div>
  )
}
