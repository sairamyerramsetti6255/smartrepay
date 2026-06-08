import { cn } from '@/lib/utils'

const styles = {
  matched: 'bg-[var(--success-bg)] text-[var(--success)]',
  pending: 'bg-[var(--bg-subtle)] text-[var(--text-secondary)]',
  exception: 'bg-[var(--warning-bg)] text-[var(--warning)]',
  breached: 'bg-[var(--danger-bg)] text-[var(--danger)]',
  posted: 'bg-[var(--accent-subtle)] text-[var(--accent)]',
  on_track: 'bg-[var(--success-bg)] text-[var(--success)]',
  at_risk: 'bg-[var(--warning-bg)] text-[var(--warning)]',
}

export function Badge({ variant = 'pending', className, children }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center rounded-[var(--radius-full)] px-2.5 text-xs font-medium',
        styles[variant] || styles.pending,
        className
      )}
    >
      {children}
    </span>
  )
}
