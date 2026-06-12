import { Link } from 'react-router-dom'
import { ArrowRight, CheckCircle2, Loader2 } from 'lucide-react'
import { getStep } from '@/lib/workflow'
import { useWorkflow } from '@/context/WorkflowContext'

/**
 * The single most important "do this next" card on the dashboard.
 * Always tells the user exactly what to do, or celebrates when done.
 */
export function NextStepHero() {
  const { nextStepId, prerequisite, allComplete, counters } = useWorkflow()

  if (allComplete) {
    return (
      <section className="rounded-[var(--radius-xl)] border border-[var(--success-border)] bg-[var(--success-bg)] p-6 flex items-center gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--success)]/15 shrink-0">
          <CheckCircle2 className="h-6 w-6 text-[var(--success)]" strokeWidth={2} />
        </span>
        <div className="flex-1">
          <h2 className="text-[17px] font-semibold text-[var(--text-primary)]">You're all caught up</h2>
          <p className="text-[13px] text-[var(--text-secondary)] mt-0.5">
            Every payment has been matched and reconciled. Upload a new statement when you're ready.
          </p>
        </div>
        <Link
          to="/ingest"
          className="hidden sm:flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--bg-card)] border border-[var(--border-medium)] px-4 h-10 text-[14px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          Upload new statement
          <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
        </Link>
      </section>
    )
  }

  const step = getStep(nextStepId)
  if (!step) return null

  const Icon = step.icon
  const count = counters[step.id]

  return (
    <section className="relative overflow-hidden rounded-[var(--radius-xl)] border border-[var(--accent-border)] bg-gradient-to-br from-[var(--accent-subtle)] to-[var(--bg-card)] p-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-5">
        <span className="flex h-14 w-14 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--accent)] text-white shrink-0 shadow-[var(--shadow-sm)]">
          <Icon className="h-7 w-7" strokeWidth={1.75} />
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--accent)]">
              Your next step · Step {step.number} of 4
            </span>
          </div>
          <h2 className="text-[20px] font-bold text-[var(--text-primary)] tracking-[-0.02em] mt-1">
            {step.label}
          </h2>
          <p className="text-[14px] text-[var(--text-secondary)] mt-1 leading-relaxed max-w-xl">
            {step.description}
            {count > 0 && step.id !== 'upload' && (
              <>
                {' '}
                <span className="font-semibold text-[var(--text-primary)]">{count}</span> waiting.
              </>
            )}
          </p>

          {prerequisite && !prerequisite.ready && (
            <p className="mt-3 inline-flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--bg-card)]/70 border border-[var(--border-light)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)]">
              {prerequisite.syncing && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />}
              {prerequisite.message}
            </p>
          )}
        </div>

        <Link
          to={step.path}
          className="flex items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--accent)] px-5 h-11 text-[14px] font-semibold text-white hover:bg-[var(--accent-hover)] transition-colors shrink-0 shadow-[var(--shadow-sm)]"
        >
          {step.cta}
          <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
        </Link>
      </div>
    </section>
  )
}
