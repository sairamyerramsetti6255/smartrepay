import { useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2, Plus, Pencil, RefreshCw, X } from 'lucide-react'
import { LineChart, Line, ResponsiveContainer } from 'recharts'
import * as api from '@/lib/api'
import { useBorrowers } from '@/hooks/useBorrowers'
import { PageHeader } from '@/components/PageHeader'
import { DataTable } from '@/components/DataTable'
import { Drawer } from '@/components/Drawer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/Badge'
import { PageLoader } from '@/components/PageLoader'
import { formatCurrency, formatDate } from '@/lib/utils'

export function Borrowers() {
  const { borrowers, loans, loading, syncing, error, refetch, syncFromLoanDisk } = useBorrowers()
  const [search, setSearch] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ full_name: '', employer: '' })
  const [aliasTags, setAliasTags] = useState([])
  const [aliasInput, setAliasInput] = useState('')

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return borrowers.filter(
      (b) => !q || b.full_name.toLowerCase().includes(q) || b.employer?.toLowerCase().includes(q)
    )
  }, [borrowers, search])

  const confidenceTrend = [72, 78, 85, 88, 90, 92, 94].map((v, i) => ({ i, v }))

  function openNew() {
    setForm({ full_name: '', employer: '' })
    setAliasTags([])
    setEditingId(null)
    setPanelOpen(true)
  }

  function openEdit(b) {
    setForm({ full_name: b.full_name, employer: b.employer || '' })
    setAliasTags(b.aliases || [])
    setEditingId(b.id)
    setPanelOpen(true)
  }

  async function save(e) {
    e.preventDefault()
    if (!form.full_name.trim()) return toast.error('Name required')
    const payload = { full_name: form.full_name, employer: form.employer || null, aliases: aliasTags }
    try {
      if (editingId) {
        await api.borrowers.update(editingId, payload)
      } else {
        await api.borrowers.create(payload)
      }
      toast.success('Saved')
      setPanelOpen(false)
      refetch()
    } catch (err) {
      toast.error(err.message)
    }
  }

  const columns = [
    { key: 'full_name', label: 'Name', render: (b) => <span className="font-medium">{b.full_name}</span> },
    {
      key: 'first_name',
      label: 'First / Last',
      render: (b) => (
        <span className="text-[13px]">
          {b.first_name || '—'} {b.last_name || ''}
        </span>
      ),
    },
    { key: 'employer', label: 'Employer', render: (b) => b.employer || '—' },
    { key: 'branch_name', label: 'Branch', render: (b) => b.branch_name || '—' },
    {
      key: 'aliases',
      label: 'Aliases',
      render: (b) => {
        const list = b.aliases || []
        return (
          <span className="flex flex-wrap gap-1">
            {list.slice(0, 3).map((a) => (
              <span key={a} className="text-[11px] px-2 h-[22px] inline-flex items-center rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)]">
                {a}
              </span>
            ))}
            {list.length > 3 && <span className="text-[11px] text-[var(--text-tertiary)]">+{list.length - 3} more</span>}
          </span>
        )
      },
    },
    {
      key: 'loans',
      label: 'Loans',
      render: (b) => {
        const count = loans.filter((l) => l.borrower_id === b.id).length
        return count ? <Badge variant="posted">{count}</Badge> : '—'
      },
    },
    { key: 'created_at', label: 'Added', render: (b) => formatDate(b.created_at) },
    {
      key: 'actions',
      label: '',
      render: (b) => (
        <Button variant="ghost" size="icon" aria-label="Edit borrower" onClick={(e) => { e.stopPropagation(); openEdit(b) }}>
          <Pencil className="h-4 w-4" strokeWidth={1.75} />
        </Button>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Borrowers"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={async () => { try { const r = await syncFromLoanDisk(); toast.success(`Synced ${r.synced} borrowers from ${r.branches || 5} branches`) } catch (e) { toast.error(e.message) } }} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync LoanDisk
            </Button>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" strokeWidth={1.75} /> Add Borrower
            </Button>
          </div>
        }
      />

      <Input
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-[280px]"
      />

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-5 py-3.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader label="Loading borrowers…" />
      ) : (
        <DataTable data={filtered} columns={columns} onRowClick={openEdit} emptyMessage="No borrowers yet" />
      )}

      <Drawer
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title={editingId ? 'Edit Borrower' : 'Add Borrower'}
        footer={<Button type="submit" form="borrower-form">Save</Button>}
      >
        <form id="borrower-form" onSubmit={save} className="space-y-5">
          <div>
            <Label className="mb-1.5 block">Full Name</Label>
            <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} required />
          </div>
          <div>
            <Label className="mb-1.5 block">Employer</Label>
            <Input value={form.employer} onChange={(e) => setForm({ ...form, employer: e.target.value })} />
          </div>
          <div>
            <Label className="mb-1.5 block">Aliases</Label>
            <Input
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (aliasInput.trim()) {
                    setAliasTags([...aliasTags, aliasInput.trim()])
                    setAliasInput('')
                  }
                }
              }}
              placeholder="Type + Enter"
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {aliasTags.map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center gap-1 h-[22px] text-xs px-2 rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
                >
                  {t}
                  <button type="button" onClick={() => setAliasTags(aliasTags.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          </div>

          {editingId && (
            <>
              <div>
                <p className="text-[13px] font-medium text-[var(--text-secondary)] mb-2">Match Confidence Trend</p>
                <div className="h-[72px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={confidenceTrend}>
                      <Line type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={1.5} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div>
                <p className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Linked Loans</p>
                {loans
                  .filter((l) => l.borrower_id === editingId)
                  .map((l) => (
                    <div key={l.id} className="flex justify-between py-3 border-b border-[var(--border-light)] text-[13px]">
                      <span className="mono">{l.loan_number}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant={l.status === 'active' ? 'on_track' : 'pending'}>{l.status}</Badge>
                        {l.outstanding_balance != null && (
                          <span className="mono text-[var(--text-secondary)]">{formatCurrency(l.outstanding_balance)}</span>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </>
          )}
        </form>
      </Drawer>
    </div>
  )
}
