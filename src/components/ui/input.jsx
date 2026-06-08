import { cn } from '@/lib/utils'

export function Input({ className, type = 'text', error, ...props }) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full rounded-[var(--radius-md)] border border-[var(--border-medium)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] transition-[border,box-shadow] duration-[120ms] focus:border-[var(--border-strong)] focus:outline-none focus:ring-0 focus:shadow-[0_0_0_3px_rgba(29,78,216,0.08)]',
        error && 'border-[var(--danger)] focus:shadow-[0_0_0_3px_rgba(185,28,28,0.08)]',
        className
      )}
      {...props}
    />
  )
}
