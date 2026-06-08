import { useEffect, useMemo, useState } from 'react'

import { Link } from 'react-router-dom'

import toast from 'react-hot-toast'

import { Loader2, RefreshCw, Upload, Users } from 'lucide-react'

import * as api from '@/lib/api'

import { matchTransaction, confidenceVariant, confidenceLabel } from '@/lib/matcher'

import { writeAuditLog } from '@/lib/audit'

import { useAuth } from '@/context/AuthContext'

import { useTransactions } from '@/hooks/useTransactions'

import { useBorrowers } from '@/hooks/useBorrowers'

import { Button } from '@/components/ui/button'

import { PageHeader } from '@/components/PageHeader'

import { SegmentedControl } from '@/components/SegmentedControl'

import { Badge } from '@/components/Badge'

import { EmptyState } from '@/components/EmptyState'

import { PageLoader } from '@/components/PageLoader'

import { formatCurrency, formatDate, cn, toUuidOrNull } from '@/lib/utils'



const FILTERS = [

  { value: 'all', label: 'All' },

  { value: 'pending', label: 'Pending' },

  { value: 'matched', label: 'Matched' },

  { value: 'exception', label: 'Unmatched' },

]



export function Match() {

  const { user } = useAuth()

  const { transactions, loading: txLoading, refreshing: txRefreshing, error: txError, refetch } = useTransactions()

  const { borrowers, loans, loading: brLoading, refreshing: brRefreshing, error: brError, refetch: refetchBorrowers, syncFromLoanDisk } = useBorrowers()

  const [selectedId, setSelectedId] = useState(null)

  const [filter, setFilter] = useState('all')

  const [running, setRunning] = useState(false)

  const [syncing, setSyncing] = useState(false)

  const [ldStatus, setLdStatus] = useState(null)



  const initialLoading = txLoading || brLoading

  const refreshing = txRefreshing || brRefreshing

  const error = txError || brError



  const filtered = useMemo(() => {
    const list = filter === 'all' ? transactions : transactions.filter((t) => t.status === filter)
    const order = { pending: 0, matched: 1, exception: 2, posted: 3 }
    return [...list].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9))
  }, [transactions, filter])

  const visibleList = useMemo(() => filtered.slice(0, 150), [filtered])

  const counts = useMemo(() => ({

    all: transactions.length,

    pending: transactions.filter((t) => t.status === 'pending').length,

    matched: transactions.filter((t) => t.status === 'matched').length,

    exception: transactions.filter((t) => t.status === 'exception').length,

  }), [transactions])



  const selected = filtered.find((t) => t.id === selectedId) || filtered[0]



  const selectedMatch = useMemo(() => {

    if (!selected || !borrowers.length) return { borrower: null, loan: null, score: 0 }

    if (selected.matched_borrower_id) {

      const borrower = borrowers.find((b) => b.id === selected.matched_borrower_id) || null

      const loan = borrower ? loans.find((l) => l.borrower_id === borrower.id) : null

      return { borrower, loan, score: selected.confidence_score || 0 }

    }

    const { borrower, score } = matchTransaction(selected, borrowers)

    const loan = borrower ? loans.find((l) => l.borrower_id === borrower.id) : null

    return { borrower, loan, score }

  }, [selected, borrowers, loans])



  useEffect(() => {

    if (filtered[0] && !selectedId) setSelectedId(filtered[0].id)

  }, [filtered, selectedId])



  useEffect(() => {

    const onLoaded = () => {

      refetch()

      refetchBorrowers()

    }

    window.addEventListener('smartrepay:demo-loaded', onLoaded)

    return () => window.removeEventListener('smartrepay:demo-loaded', onLoaded)

  }, [refetch, refetchBorrowers])



  useEffect(() => {

    api.loandisk.status().then(setLdStatus).catch(() => setLdStatus({ ok: false }))

  }, [])



  async function resetData() {
    if (!window.confirm('Clear all transactions, borrowers, loans, and unmatched items?')) return
    try {
      await api.data.reset()
      toast.success('All data cleared')
      setSelectedId(null)
      refetch()
      refetchBorrowers()
    } catch (e) {
      toast.error(e.message)
    }
  }

  async function syncLoanDisk() {

    setSyncing(true)

    try {

      const result = await syncFromLoanDisk()

      toast.success(`Synced ${result.synced} borrowers via GetAllBorrowers`)

      refetchBorrowers()

      const status = await api.loandisk.status()

      setLdStatus(status)

    } catch (e) {

      toast.error(e.message)

    } finally {

      setSyncing(false)

    }

  }



  async function runMatching() {
    if (!borrowers.length) {
      return toast.error('Borrowers still loading — wait for background sync or click Sync LoanDisk')
    }

    setRunning(true)
    try {
      const result = await api.matching.run()
      if (result.message && result.matched === 0 && result.excepted === 0) {
        toast.error(result.message)
      } else {
        toast.success(`${result.matched} matched, ${result.excepted} unmatched (${result.pending} processed)`)
      }
      refetch()
      refetchBorrowers()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setRunning(false)
    }
  }



  async function confirmOne() {

    if (!selectedMatch.borrower) return toast.error('No borrower match')

    await api.transactions.update(selected.id, {

      status: 'matched',

      confidence_score: selectedMatch.score,

      matched_borrower_id: toUuidOrNull(selectedMatch.borrower.id),

      loan_id: toUuidOrNull(selectedMatch.loan?.id),

      action: 'confirm_match',

    })

    await writeAuditLog({

      entity: 'transaction',

      entityId: selected.id,

      action: 'confirm_match',

      actor: user.email,

      priorValue: null,

      newValue: { borrower: selectedMatch.borrower.id },

    })

    toast.success('Match confirmed')

    refetch()

  }



  async function sendToExceptions() {

    await api.transactions.update(selected.id, { status: 'exception', action: 'send_to_queue' })

    await api.exceptions.create({

      transaction_id: selected.id,

      type: 'unmatched',

      assigned_to: user.email,

    })

    toast.success('Sent to unmatched queue')

    refetch()

  }



  function listScore(tx) {

    if (tx.confidence_score) return tx.confidence_score

    if (tx.id === selected?.id) return selectedMatch.score

    return null

  }



  if (initialLoading) return <PageLoader label="Loading transactions and borrowers…" />



  return (

    <div className="space-y-6 -mx-2">

      <PageHeader

        title="Match Transactions"

        subtitle="Sync all borrowers from LoanDisk GetAllBorrowers, then fuzzy-match imported payments."

        actions={

          <div className="flex items-center gap-2 flex-wrap justify-end">

            {refreshing && <Loader2 className="h-4 w-4 animate-spin text-[var(--text-tertiary)]" />}

            <Button variant="secondary" onClick={resetData} disabled={syncing || running}>
              Reset data
            </Button>

            <Button variant="secondary" onClick={syncLoanDisk} disabled={syncing || running}>

              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}

              Sync LoanDisk

            </Button>

            <Button onClick={runMatching} disabled={running || syncing}>

              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}

              Run Matching

            </Button>

          </div>

        }

      />



      {error && (

        <div className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-5 py-3.5 text-[13px] text-[var(--danger)]">

          {error} — ensure the API is running (<code className="mono text-[12px]">npm run dev</code>)

        </div>

      )}



      <div className="grid sm:grid-cols-4 gap-3">

        <StatCard label="Transactions" value={counts.all} />

        <StatCard label="Pending" value={counts.pending} accent />

        <StatCard label="Borrowers" value={borrowers.length} sub={ldStatus?.ok ? 'LoanDisk connected' : 'Sync LoanDisk'} />

        <StatCard label="Matched" value={counts.matched} />

      </div>



      <div className="flex items-center justify-between gap-4 flex-wrap">

        <SegmentedControl options={FILTERS} value={filter} onChange={setFilter} />

        <p className="text-[12px] text-[var(--text-tertiary)]">

          {visibleList.length}{filtered.length > visibleList.length ? ` of ${filtered.length}` : ''} shown · {counts.pending} pending match

        </p>

      </div>



      <div className="flex min-h-[520px] card overflow-hidden">

        <div className="w-[380px] shrink-0 border-r border-[var(--border-light)] overflow-y-auto">

          {filtered.length === 0 ? (

            <EmptyState

              icon={Upload}

              title={counts.all === 0 ? 'No transactions yet' : 'No transactions in this filter'}

              description={

                counts.all === 0

                  ? 'Import a bank or employer statement, then sync LoanDisk borrowers'

                  : 'Try another filter tab'

              }

              action={

                counts.all === 0 ? (

                  <Link to="/ingest">

                    <Button variant="secondary" size="sm">Go to Ingest →</Button>

                  </Link>

                ) : null

              }

            />

          ) : (

            visibleList.map((tx) => {

              const score = listScore(tx)

              return (

                <button

                  key={tx.id}

                  type="button"

                  onClick={() => setSelectedId(tx.id)}

                  className={cn(

                    'w-full text-left px-4 h-[72px] border-b border-[var(--border-light)] transition-colors duration-100',

                    selected?.id === tx.id && 'bg-[var(--accent-subtle)] border-l-[3px] border-l-[var(--accent)] pl-[13px]'

                  )}

                >

                  <div className="flex justify-between gap-2 pt-3">

                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">{tx.payer || '—'}</p>

                    <p className="mono text-sm font-medium shrink-0">{formatCurrency(tx.amount)}</p>

                  </div>

                  <div className="flex justify-between gap-2 mt-1">

                    <p className="text-xs text-[var(--text-tertiary)] truncate">{tx.description || formatDate(tx.date)}</p>

                    {score != null ? (

                      <Badge variant={confidenceVariant(score)} className="shrink-0 text-[11px]">

                        {score}%

                      </Badge>

                    ) : (

                      <span className="text-[11px] text-[var(--text-tertiary)] shrink-0">—</span>

                    )}

                  </div>

                </button>

              )

            })

          )}

        </div>



        <div className="flex-1 p-8">

          {selected ? (

            <div className="max-w-lg">

              <section>

                <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-4">

                  Imported Payment

                </h3>

                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">

                  <KV label="Date" value={formatDate(selected.date)} />

                  <KV label="Payer" value={selected.payer} />

                  <KV label="Description" value={selected.description} />

                  <KV label="Reference" value={selected.reference} mono />

                  <KV label="Status" value={formatStatus(selected.status)} />

                </dl>

                <p className="mono text-[17px] font-semibold text-[var(--text-primary)] mt-4">

                  {formatCurrency(selected.amount)}

                </p>

              </section>



              <div className="relative py-6 my-2">

                <div className="absolute inset-0 flex items-center">

                  <div className="w-full border-t border-[var(--border-light)]" />

                </div>

                <div className="relative flex justify-center">

                  <span className="bg-[var(--bg-card)] px-3 py-0.5 rounded-full text-[11px] font-medium text-[var(--text-tertiary)] border border-[var(--border-light)]">

                    LoanDisk Match

                  </span>

                </div>

              </div>



              <section>

                <h3 className="text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3">

                  Proposed Borrower

                </h3>

                {brLoading ? (

                  <div className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">

                    <Loader2 className="h-4 w-4 animate-spin" />

                    Loading borrowers…

                  </div>

                ) : selectedMatch.borrower ? (

                  <>

                    <p className="text-[17px] font-semibold text-[var(--text-primary)]">
                      {selectedMatch.borrower.full_name}
                    </p>
                    <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                      {[selectedMatch.borrower.first_name, selectedMatch.borrower.last_name].filter(Boolean).join(' ') || '—'}
                      {selectedMatch.borrower.branch_name ? ` · ${selectedMatch.borrower.branch_name}` : ''}
                    </p>
                    <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                      Employer: {selectedMatch.borrower.employer || '—'}
                    </p>

                    {selectedMatch.borrower.loandisk_id && (

                      <p className="mono text-[11px] text-[var(--text-tertiary)] mt-1">

                        LoanDisk ID {selectedMatch.borrower.loandisk_id}

                      </p>

                    )}

                    <p className="mono text-[13px] text-[var(--text-secondary)] mt-2">

                      Loan {selectedMatch.loan?.loan_number || '—'}

                    </p>

                    <div className="flex items-baseline gap-1 mt-6">
                      <span className="mono text-[36px] font-bold text-[var(--accent)] leading-none">{selectedMatch.score}</span>
                      <span className="text-base text-[var(--text-tertiary)]">/100</span>
                    </div>
                    <p className="text-[12px] text-[var(--text-tertiary)] mt-2">{confidenceLabel(selectedMatch.score)}</p>

                  </>

                ) : (

                  <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)] px-4 py-6 text-center">

                    <Users className="h-8 w-8 mx-auto text-[var(--text-tertiary)] mb-2" />

                    <p className="text-[13px] text-[var(--text-secondary)]">No borrower match found</p>

                    <Button variant="secondary" size="sm" className="mt-3" onClick={syncLoanDisk} disabled={syncing}>

                      Sync LoanDisk borrowers

                    </Button>

                  </div>

                )}

              </section>



              <div className="flex gap-2 pt-6 mt-6 border-t border-[var(--border-light)]">

                <Button onClick={confirmOne} disabled={!selectedMatch.borrower || selected.status !== 'pending'}>

                  Confirm Match

                </Button>

                <Button variant="secondary" onClick={sendToExceptions} disabled={selected.status !== 'pending'}>

                  Send to Queue

                </Button>

              </div>

            </div>

          ) : (

            <EmptyState

              icon={Users}

              title="Select a transaction"

              description="Choose an imported payment from the list to review its LoanDisk match"

            />

          )}

        </div>

      </div>

    </div>

  )

}



function StatCard({ label, value, sub, accent }) {

  return (

    <div className="card px-4 py-3">

      <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>

      <p className={cn('mono text-[22px] font-bold mt-1', accent ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]')}>

        {value}

      </p>

      {sub && <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{sub}</p>}

    </div>

  )

}



function formatStatus(status) {
  return status === 'exception' ? 'unmatched' : status
}

function KV({ label, value, mono }) {

  return (

    <>

      <dt className="text-[var(--text-tertiary)]">{label}</dt>

      <dd className={cn('text-[var(--text-primary)] font-medium', mono && 'mono')}>{value || '—'}</dd>

    </>

  )

}

