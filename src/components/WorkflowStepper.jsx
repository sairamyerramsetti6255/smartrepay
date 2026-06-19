import { Link } from 'react-router-dom'
import { Check, ChevronRight, ArrowRight } from 'lucide-react'
import { WORKFLOW_STEPS, STEP_STATUS } from '@/lib/workflow'
import { useWorkflow } from '@/context/WorkflowContext'
import { cn } from '@/lib/utils'

/** Steps that cannot be opened from the stepper — use in-page actions instead (e.g. file → Match). */
const STEPPER_DISABLED = new Set(['match'])

/**
 * Compact, guided stepper shown at the top of each workflow page.
 * Highlights the current step and links the rest (except disabled steps).
 */
export function WorkflowStepper({ current, className }) {
  const { status, nextStepId } = useWorkflow()

  return (
    <nav
      aria-label="Reconciliation workflow"
      className={cn(
        'flex flex-wrap items-center gap-1 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-card)] px-2.5 py-2 shadow-[var(--shadow-xs)]',
        className
      )}
    >
      {WORKFLOW_STEPS.map((step, i) => {
        const st = status[step.id]
        const isCurrent = step.id === current
        const done = st === STEP_STATUS.DONE
        const disabled = STEPPER_DISABLED.has(step.id)

        const inner = (
          <>
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
                done && 'bg-[var(--success)] text-white',
                !done && isCurrent && 'bg-[var(--accent)] text-white',
                !done && !isCurrent && 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]',
                disabled && !isCurrent && 'opacity-60'
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : step.number}
            </span>
            <span
              className={cn(
                'text-[13px] font-medium whitespace-nowrap',
                isCurrent ? 'text-[var(--accent)]' : done ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                disabled && !isCurrent && 'opacity-60'
              )}
            >
              {step.short}
            </span>
          </>
        )

        return (
          <div key={step.id} className="flex items-center gap-1.5">
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 text-[var(--text-disabled)] shrink-0" strokeWidth={2} />
            )}
            {disabled ? (
              <span
                className={cn(
                  'flex items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 cursor-default select-none',
                  isCurrent ? 'bg-[var(--accent-subtle)]' : ''
                )}
                aria-current={isCurrent ? 'step' : undefined}
                title={step.id === 'match' ? 'Select a file on Upload to open matching' : undefined}
              >
                {inner}
              </span>
            ) : (
              <Link
                to={step.path}
                className={cn(
                  'group flex items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 transition-colors',
                  isCurrent
                    ? 'bg-[var(--accent-subtle)]'
                    : 'hover:bg-[var(--bg-hover)]'
                )}
                aria-current={isCurrent ? 'step' : undefined}
              >
                {inner}
              </Link>
            )}
          </div>
        )
      })}

      {nextStepId && nextStepId !== current && !STEPPER_DISABLED.has(nextStepId) && (
        <NextHint nextStepId={nextStepId} />
      )}
    </nav>
  )
}

function NextHint({ nextStepId }) {
  const step = WORKFLOW_STEPS.find((s) => s.id === nextStepId)
  if (!step) return null
  return (
    <Link
      to={step.path}
      className="ml-auto hidden md:flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--accent)] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[var(--accent-hover)] transition-colors"
    >
      Next: {step.short}
      <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
    </Link>
  )
}
