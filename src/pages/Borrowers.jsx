import { useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Loader2, Plus, Pencil, RefreshCw, X, User, CreditCard } from 'lucide-react'
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

function DetailRow({ label, value, mono }) {
  if (value == null || value === '') return null
  return (
    <div className="flex justify-between gap-4 py-2 border-b border-[var(--border-light)] text-[13px]">
      <span className="text-[var(--text-tertiary)] shrink-0">{label}</span>
      <span className={mono ? 'mono text-right text-[var(--text-primary)]' : 'text-right text-[var(--text-primary)]'}>
        {value}
      </span>
    </div>
  )
}

export function Borrowers() {
  const { borrowers, loans, loading, syncing, error, refetch, syncFromLoanDisk } = useBorrowers()
  const [search, setSearch] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailBorrower, setDetailBorrower] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailData, setDetailData] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState({ full_name: '', employer: '' })
  const [aliasTags, setAliasTags] = useState([])
  const [aliasInput, setAliasInput] = useState('')
  const detailLoadRef = useRef(0)

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return borrowers.filter(
      (b) =>
        !q ||
        b.full_name.toLowerCase().includes(q) ||
        b.employer?.toLowerCase().includes(q) ||
        b.loandisk_id?.toString().includes(q) ||
        b.branch_name?.toLowerCase().includes(q)
    )
  }, [borrowers, search])

  const confidenceTrend = [72, 78, 85, 88, 90, 92, 94].map((v, i) => ({ i, v }))

  const detailLoans = detailData?.loans?.length
    ? detailData.loans
    : detailBorrower
      ? loans.filter((l) => l.borrower_id === detailBorrower.id)
      : []

  const totalEmi = useMemo(
    () => detailLoans.reduce((s, l) => s + (Number(l.emi) || 0), 0),
    [detailLoans]
  )

  const totalBalance = useMemo(
    () => detailLoans.reduce((s, l) => s + (Number(l.outstanding_balance) || 0), 0),
    [detailLoans]
  )

  const displayBorrower = detailData?.borrower || detailBorrower

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

  async function loadBorrowerDetail(b, { silent = false, refresh = false } = {}) {
    const loandiskId = b.loandisk_id || b.id
    const loadToken = ++detailLoadRef.current

    if (!loandiskId) {
      setDetailData({ status: 'ready', borrower: b, loans: loans.filter((l) => l.borrower_id === b.id) })
      if (!silent) toast.error('No LoanDisk ID — showing cached loans only')
      return
    }

    setDetailLoading(true)
    setDetailData({
      status: 'loading',
      borrower: b,
      loans: loans.filter((l) => l.borrower_id === b.id),
      message: 'Connecting to LoanDisk — this may take 1–2 minutes…',
    })

    try {
      const data = await api.loandisk.pollUntilReady(
        loandiskId,
        (snap) => {
          if (loadToken !== detailLoadRef.current) return
          setDetailData(snap)
        },
        { refresh, maxMinutes: 6 }
      )
      if (loadToken !== detailLoadRef.current) return
      setDetailData(data)
      refetch()
      if (!silent && data.status === 'ready') toast.success('Loan & EMI data loaded')
    } catch (err) {
      if (loadToken !== detailLoadRef.current) return
      if (!silent) toast.error(err.message)
      setDetailData((prev) => ({
        status: 'failed',
        borrower: prev?.borrower || b,
        loans: prev?.loans?.length ? prev.loans : loans.filter((l) => l.borrower_id === b.id),
        error: err.message,
      }))
    } finally {
      if (loadToken === detailLoadRef.current) setDetailLoading(false)
    }
  }

  function openDetail(b) {
    setDetailBorrower(b)
    setDetailData(null)
    setDetailOpen(true)
    loadBorrowerDetail(b)
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
      key: 'loandisk_id',
      label: 'LoanDisk ID',
      render: (b) => (b.loandisk_id ? <span className="mono text-[12px]">{b.loandisk_id}</span> : '—'),
    },
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
            {list.slice(0, 2).map((a) => (
              <span
                key={a}
                className="text-[11px] px-2 h-[22px] inline-flex items-center rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
              >
                {a}
              </span>
            ))}
            {list.length > 2 && <span className="text-[11px] text-[var(--text-tertiary)]">+{list.length - 2}</span>}
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
        <Button
          variant="ghost"
          size="icon"
          aria-label="Edit borrower"
          onClick={(e) => {
            e.stopPropagation()
            openEdit(b)
          }}
        >
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
            <Button
              variant="secondary"
              onClick={async () => {
                try {
                  const r = await syncFromLoanDisk()
                  toast.success(`Synced ${r.synced} borrowers from ${r.branches || 5} branches`)
                } catch (e) {
                  toast.error(e.message)
                }
              }}
              disabled={syncing}
            >
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
        placeholder="Search name, LoanDisk ID, branch…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-[320px]"
      />

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-5 py-3.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {loading ? (
        <PageLoader label="Loading borrowers…" />
      ) : (
        <DataTable data={filtered} columns={columns} onRowClick={openDetail} emptyMessage="No borrowers yet" />
      )}

      <Drawer
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false)
          setDetailBorrower(null)
          setDetailData(null)
        }}
        title="Borrower Details"
        footer={
          <div className="flex gap-2 w-full">
            <Button
              variant="secondary"
              onClick={() => detailBorrower && loadBorrowerDetail(detailBorrower, { refresh: true })}
              disabled={detailLoading}
            >
              {detailLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh from LoanDisk
            </Button>
            <Button
              onClick={() => {
                if (detailBorrower) openEdit(detailBorrower)
              }}
            >
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          </div>
        }
      >
        {detailBorrower ? (
          <div className="space-y-6">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-full bg-[var(--accent-subtle)] flex items-center justify-center shrink-0">
                <User className="h-5 w-5 text-[var(--accent)]" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">
                  {displayBorrower?.full_name || detailBorrower.full_name}
                </h3>
                <p className="text-[12px] text-[var(--text-tertiary)] mt-0.5">
                  {[displayBorrower?.branch_name, displayBorrower?.employer].filter(Boolean).join(' · ') || '—'}
                </p>
              </div>
            </div>

            <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] px-4">
              <DetailRow label="LoanDisk ID" value={displayBorrower?.loandisk_id} mono />
              <DetailRow label="Unique No." value={displayBorrower?.unique_number} mono />
              <DetailRow label="First / Last" value={`${displayBorrower?.first_name || '—'} ${displayBorrower?.last_name || ''}`.trim()} />
              <DetailRow label="Email" value={displayBorrower?.email} />
              <DetailRow label="Mobile" value={displayBorrower?.mobile} />
              <DetailRow label="Branch" value={displayBorrower?.branch_name} />
              {displayBorrower?.loan_amount != null && (
                <DetailRow label="Principal (API)" value={formatCurrency(displayBorrower.loan_amount)} mono />
              )}
              {displayBorrower?.emi != null && (
                <DetailRow label="EMI (profile)" value={formatCurrency(displayBorrower.emi)} mono />
              )}
            </div>

            {detailData?.status === 'loading' || detailLoading ? (
              <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--accent-subtle)] px-4 py-4 space-y-2">
                <div className="flex items-center gap-2 text-[13px] text-[var(--text-primary)] font-medium">
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
                  Loading from LoanDisk…
                </div>
                <p className="text-[12px] text-[var(--text-secondary)]">
                  {detailData?.message || 'Fetching loan & EMI — the API can take 1–2 minutes. You can keep browsing; data will appear when ready.'}
                </p>
                {detailLoans.length > 0 && (
                  <p className="text-[12px] text-[var(--text-tertiary)]">Showing cached loans while live data loads…</p>
                )}
              </div>
            ) : null}

            {detailData?.status === 'failed' && (
              <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-[13px] text-[var(--danger)]">
                {detailData.error || 'Could not load from LoanDisk'} — tap Refresh to retry.
              </div>
            )}

            {(detailLoans.length > 0 || detailData?.status === 'ready' || (!detailLoading && detailData?.status !== 'loading')) ? (
              <>
                {detailLoans.length > 1 && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-3">
                      <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wide">Total EMI</p>
                      <p className="text-[18px] font-semibold mono mt-1">{formatCurrency(totalEmi)}</p>
                    </div>
                    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] p-3">
                      <p className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wide">Total Balance</p>
                      <p className="text-[18px] font-semibold mono mt-1">{formatCurrency(totalBalance)}</p>
                    </div>
                  </div>
                )}

                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <CreditCard className="h-4 w-4 text-[var(--text-tertiary)]" />
                    <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                      Loans & EMI ({detailLoans.length})
                    </p>
                  </div>

                  {detailLoans.length ? (
                    <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] overflow-hidden">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="bg-[var(--bg-subtle)] text-[var(--text-tertiary)] text-left">
                            <th className="px-3 py-2 font-medium">Loan #</th>
                            <th className="px-3 py-2 font-medium text-right">EMI</th>
                            <th className="px-3 py-2 font-medium text-right">Balance</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailLoans.map((l) => (
                            <tr key={l.id || l.loan_number} className="border-t border-[var(--border-light)]">
                              <td className="px-3 py-2.5 mono">{l.loan_number || '—'}</td>
                              <td className="px-3 py-2.5 mono text-right font-medium">
                                {l.emi != null ? formatCurrency(l.emi) : '—'}
                              </td>
                              <td className="px-3 py-2.5 mono text-right text-[var(--text-secondary)]">
                                {l.outstanding_balance != null ? formatCurrency(l.outstanding_balance) : '—'}
                              </td>
                              <td className="px-3 py-2.5">
                                <Badge variant={l.status === 'active' ? 'on_track' : 'pending'}>{l.status || 'active'}</Badge>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-[13px] text-[var(--text-tertiary)] py-4 text-center border border-dashed border-[var(--border-light)] rounded-[var(--radius-md)]">
                      No loans found for this borrower
                    </p>
                  )}
                </div>

                {(displayBorrower?.aliases?.length || detailBorrower.aliases?.length) ? (
                  <div>
                    <p className="text-[13px] font-medium text-[var(--text-secondary)] mb-2">Aliases</p>
                    <div className="flex flex-wrap gap-2">
                      {(displayBorrower?.aliases || detailBorrower.aliases || []).map((a) => (
                        <span
                          key={a}
                          className="text-[11px] px-2 h-[22px] inline-flex items-center rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)]"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </Drawer>

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
                <p className="text-[13px] font-semibold text-[var(--text-primary)] mb-3">Linked Loans (cached)</p>
                {loans
                  .filter((l) => l.borrower_id === editingId)
                  .map((l) => (
                    <div key={l.id} className="flex justify-between py-3 border-b border-[var(--border-light)] text-[13px]">
                      <span className="mono">{l.loan_number}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant={l.status === 'active' ? 'on_track' : 'pending'}>{l.status}</Badge>
                        {l.emi != null && <span className="mono text-[var(--text-secondary)]">EMI {formatCurrency(l.emi)}</span>}
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
