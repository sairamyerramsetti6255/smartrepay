import { Link } from 'react-router-dom'
import { Loader2, Sparkles } from 'lucide-react'
import { useMatchingProgress } from '@/context/MatchingProgressContext'

const BATCH = 25

function describe(progress) {
  const p = progress || {}
  if (p.phase === 'starting') return 'Starting matcher…'
  if (p.phase === 'loaded') return `Loaded ${p.bankTx ?? 0} txns · ${p.loans ?? 0} loans — classifying…`
  if (p.phase === 'classified') {
    const tally = p.matched != null ? ` · ${p.matched} matched / ${p.unmatched ?? 0} unmatched` : ''
    return `Classified ${p.bankTx ?? 0} txns${p.total ? ` · refining ${p.total} with AI` : ''}${tally}`
  }
  if (p.phase === 'ai') {
    const total = p.total ?? 0
    const done = p.done ?? 0
    const batches = Math.max(1, Math.ceil(total / BATCH))
    const batch = Math.min(batches, Math.max(1, Math.ceil(done / BATCH)))
    const pct = total ? Math.round((done / total) * 100) : 0
    return `AI matching ${done}/${total} · batch ${batch}/${batches} · ${pct}%`
  }
  if (p.phase === 'done') return 'Finishing up…'
  return 'Matching…'
}

function percent(progress) {
  const p = progress || {}
  if (p.phase === 'ai' && p.total) return Math.round((p.done / p.total) * 100)
  if (p.phase === 'classified') return p.total ? 12 : 95
  if (p.phase === 'loaded') return 8
  if (p.phase === 'done') return 100
  return 3
}

export function MatchingProgressBar() {
  const { running, progress, scope } = useMatchingProgress()
  if (!running) return null

  const pct = percent(progress)
  const scopeLabel = scope?.fileCount ? `${scope.fileCount} file${scope.fileCount === 1 ? '' : 's'} · ` : ''

  return (
    <Link
      to="/match"
      className="hidden lg:flex items-center gap-3 min-w-[300px] max-w-[440px] px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-subtle)] border border-[var(--border-light)] hover:border-[var(--accent)] transition-colors"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)] shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-[var(--text-primary)] truncate font-medium flex items-center gap-1">
          <Sparkles className="h-3 w-3 text-[var(--accent)]" />
          {scopeLabel}
          {describe(progress)}
        </p>
        <div className="h-1.5 mt-1 rounded-full bg-[var(--bg-subtle)] overflow-hidden">
          <div className="h-full bg-[var(--accent)] transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </Link>
  )
}
