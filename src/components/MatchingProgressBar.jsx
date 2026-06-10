import { Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useMatchingProgress } from '@/context/MatchingProgressContext'

function label(progress, running) {
  if (!running) return null
  if (progress?.phase === 'loading_borrowers') return 'Loading borrowers…'
  if (progress?.phase === 'loading_loans') {
    return `Loading loan EMIs ${progress.loansLoaded ?? 0}/${progress.loansTotal ?? '?'}…`
  }
  if (progress?.phase === 'matching') {
    const pct = progress.percent ?? Math.round(((progress.processed ?? 0) / Math.max(1, progress.total ?? 1)) * 100)
    return `Matching ${progress.processed ?? 0}/${progress.total ?? '?'} · ${progress.matched ?? 0} matched · ${pct}%`
  }
  return 'Matching…'
}

export function MatchingProgressBar() {
  const { running, progress, result } = useMatchingProgress()
  const show = running || (result && progress?.phase === 'done')
  if (!show) return null

  const pct =
    progress?.percent ??
    (progress?.total ? Math.round(((progress.processed ?? 0) / progress.total) * 100) : 0)

  return (
    <Link
      to="/match"
      className="hidden lg:flex items-center gap-3 min-w-[280px] max-w-[420px] px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-subtle)] border border-[var(--border-light)] hover:border-[var(--accent)] transition-colors"
    >
      {running ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)] shrink-0" />
      ) : null}
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-[var(--text-primary)] truncate font-medium">
          {running ? label(progress, running) : `Done — ${result?.matched ?? 0} matched, ${result?.excepted ?? 0} unmatched`}
        </p>
        <div className="h-1.5 mt-1 rounded-full bg-[var(--bg-subtle)] overflow-hidden">
          <div
            className="h-full bg-[var(--accent)] transition-all duration-500"
            style={{ width: `${running ? pct : 100}%` }}
          />
        </div>
      </div>
    </Link>
  )
}
