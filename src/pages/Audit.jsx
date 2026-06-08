import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Download } from 'lucide-react'
import { format, subDays } from 'date-fns'
import { useAuditLog } from '@/hooks/useAuditLog'
import { AuditDiff } from '@/components/AuditDiff'
import { PageHeader } from '@/components/PageHeader'
import { PageLoader } from '@/components/PageLoader'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/Badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDateTime } from '@/lib/utils'

const actionVariant = {
  confirm: 'matched',
  approve: 'posted',
  reject: 'breached',
  edit: 'exception',
}

export function Audit() {
  const { entries, loading } = useAuditLog(200)
  const [search, setSearch] = useState('')
  const [actorFilter, setActorFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [dateFrom, setDateFrom] = useState(format(subDays(new Date(), 7), 'yyyy-MM-dd'))
  const [expandedId, setExpandedId] = useState(null)

  const actors = [...new Set(entries.map((e) => e.actor).filter(Boolean))]
  const actions = [...new Set(entries.map((e) => e.action).filter(Boolean))]

  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (actorFilter && e.actor !== actorFilter) return false
        if (actionFilter && e.action !== actionFilter) return false
        if (dateFrom && e.created_at < dateFrom) return false
        if (search) {
          const hay = `${e.actor} ${e.action} ${e.entity} ${e.entity_id}`.toLowerCase()
          if (!hay.includes(search.toLowerCase())) return false
        }
        return true
      }),
    [entries, search, actorFilter, actionFilter, dateFrom]
  )

  function exportCsv() {
    const headers = ['timestamp', 'actor', 'action', 'entity', 'entity_id', 'prior_value', 'new_value']
    const rows = filtered.map((e) => [
      e.created_at,
      e.actor,
      e.action,
      e.entity,
      e.entity_id,
      JSON.stringify(e.prior_value),
      JSON.stringify(e.new_value),
    ])
    const csv = [headers.join(','), ...rows.map((r) => r.map(escapeCsv).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-${format(new Date(), 'yyyy-MM-dd')}.csv`
    a.click()
    toast.success('Exported')
  }

  const columns = [
    {
      key: 'created_at',
      label: 'Timestamp',
      render: (r) => <span className="text-[var(--text-tertiary)] mono text-[13px]">{formatDateTime(r.created_at)}</span>,
    },
    {
      key: 'actor',
      label: 'Actor',
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="h-6 w-6 rounded-full bg-[var(--bg-subtle)] flex items-center justify-center text-[10px] font-semibold text-[var(--text-secondary)]">
            {(r.actor || 'S').slice(0, 2).toUpperCase()}
          </span>
          <span>{r.actor || 'system'}</span>
        </div>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      render: (r) => {
        const key = Object.keys(actionVariant).find((k) => r.action?.includes(k))
        return <Badge variant={actionVariant[key] || 'pending'}>{r.action}</Badge>
      },
    },
    { key: 'entity', label: 'Entity' },
    {
      key: 'change',
      label: 'Change',
      render: (r) => (
        <button
          type="button"
          className="text-[13px] font-medium text-[var(--accent)]"
          onClick={(e) => {
            e.stopPropagation()
            setExpandedId(expandedId === r.id ? null : r.id)
          }}
        >
          View →
        </button>
      ),
    },
  ]

  const expanded = filtered.find((e) => e.id === expandedId)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit Log"
        actions={
          <Button variant="secondary" onClick={exportCsv}>
            <Download className="h-4 w-4" /> Export CSV →
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
        <select
          className="h-9 rounded-[var(--radius-md)] border border-[var(--border-medium)] px-3 text-[13px] bg-[var(--bg-card)]"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
        >
          <option value="">Actor</option>
          {actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-[var(--radius-md)] border border-[var(--border-medium)] px-3 text-[13px] bg-[var(--bg-card)]"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
        >
          <option value="">Action</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <Input placeholder="Entity search" value={search} onChange={(e) => setSearch(e.target.value)} className="w-52" />
      </div>

      {loading ? (
        <PageLoader label="Loading audit log…" />
      ) : (
        <>
          <DataTable data={filtered} columns={columns} pageSize={20} />
          {expanded && (
            <div className="rounded-[var(--radius-lg)] bg-[var(--bg-subtle)] border border-[var(--border-light)] p-5 border-l-[3px] border-l-[var(--accent-border)]">
              <AuditDiff prior={expanded.prior_value} next={expanded.new_value} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function escapeCsv(val) {
  const s = String(val ?? '')
  return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s
}
