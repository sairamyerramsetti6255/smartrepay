import { Link } from 'react-router-dom'
import { Check, ArrowRight, Lock } from 'lucide-react'
import { WORKFLOW_STEPS, STEP_STATUS } from '@/lib/workflow'
import { useWorkflow } from '@/context/WorkflowContext'
import { cn } from '@/lib/utils'

const COUNT_LABELS = {
  upload: 'documents',
  match: 'to match',
  review: 'unmatched',
  reconcile: 'to post',
}

/**
 * The full 4-step workflow tracker for the dashboard hub.
 * Each card shows status, live counts, and a contextual action.
 */
export function WorkflowTracker() {
  const { status, counters, nextStepId } = useWorkflow()

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {WORKFLOW_STEPS.map((step) => {
        const st = status[step.id]
        const isNext = step.id === nextStepId
        const done = st === STEP_STATUS.DONE
        const active = st === STEP_STATUS.ACTIVE
        const todo = st === STEP_STATUS.TODO
        const count = counters[step.id]
        const Icon = step.icon

        return (
          <Link
            key={step.id}
            to={step.path}
            className={cn(
              'group relative flex flex-col rounded-[var(--radius-lg)] border bg-[var(--bg-card)] p-5 transition-all duration-150',
              isNext
                ? 'border-[var(--accent)] shadow-[var(--shadow-sm)] ring-1 ring-[var(--accent)]'
                : 'border-[var(--border-light)] shadow-[var(--shadow-xs)] hover:border-[var(--border-medium)] hover:shadow-[var(--shadow-sm)]'
            )}
          >
            <div className="flex items-center justify-between mb-4">
              <span
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)]',
                  done && 'bg-[var(--success-bg)] text-[var(--success)]',
                  active && 'bg-[var(--accent-subtle)] text-[var(--accent)]',
                  todo && 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]'
                )}
              >
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
              </span>
              <StatusPill status={st} />
            </div>

            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
              Step {step.number}
            </p>
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)] mt-0.5 tracking-[-0.01em]">
              {step.label}
            </h3>
            <p className="text-[12px] text-[var(--text-tertiary)] mt-1.5 leading-relaxed flex-1">
              {step.description}
            </p>

            <div className="mt-4 flex items-center justify-between">
              {count > 0 && !done ? (
                <span className="text-[13px] text-[var(--text-secondary)]">
                  <span className="mono font-bold text-[var(--text-primary)]">{count}</span>{' '}
                  {COUNT_LABELS[step.id]}
                </span>
              ) : done ? (
                <span className="text-[13px] font-medium text-[var(--success)]">Complete</span>
              ) : (
                <span className="text-[13px] text-[var(--text-tertiary)]">Not started</span>
              )}
              <span
                className={cn(
                  'flex items-center gap-1 text-[13px] font-semibold transition-colors',
                  isNext ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)] group-hover:text-[var(--accent)]'
                )}
              >
                {isNext ? 'Start' : 'Open'}
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
              </span>
            </div>
          </Link>
        )
      })}
    </div>
  )
}

function StatusPill({ status }) {
  if (status === STEP_STATUS.DONE) {
    return (
      <span className="flex items-center gap-1 text-[11px] font-semibold text-[var(--success)]">
        <Check className="h-3.5 w-3.5" strokeWidth={3} /> Done
      </span>
    )
  }
  if (status === STEP_STATUS.ACTIVE) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--accent)]">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
        </span>
        In progress
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium text-[var(--text-disabled)]">
      <Lock className="h-3 w-3" strokeWidth={2} /> Waiting
    </span>
  )
}
