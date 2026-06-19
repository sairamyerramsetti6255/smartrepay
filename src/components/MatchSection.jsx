import { cn } from '@/lib/utils'

/**
 * Numbered page section — gives each block a clear title and one-line purpose
 * so users always know what they're looking at and what to do next.
 */
export function MatchSection({ step, title, description, action, children, className }) {
  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3.5 min-w-0">
          {step != null && (
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent-subtle)] text-[13px] font-bold text-[var(--accent)]"
              aria-hidden
            >
              {step}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold text-[var(--text-primary)] tracking-[-0.02em] leading-tight">
              {title}
            </h2>
            {description && (
              <p className="text-[13px] text-[var(--text-tertiary)] mt-1 leading-relaxed max-w-2xl">{description}</p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}
