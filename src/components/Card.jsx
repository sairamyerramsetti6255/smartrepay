import { cn } from '@/lib/utils'

export function Card({ className, clickable, children, ...props }) {
  return (
    <div
      className={cn(
        'bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] shadow-[var(--shadow-xs)]',
        clickable && 'cursor-pointer transition-all duration-150 hover:shadow-[var(--shadow-sm)] hover:border-[var(--border-medium)]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function CardHeader({ title, subtitle, action, className }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-6 pt-6', className)}>
      <div>
        {title && (
          <h3 className="text-[15px] font-semibold text-[var(--text-primary)] tracking-[-0.01em]">{title}</h3>
        )}
        {subtitle && <p className="text-[13px] text-[var(--text-tertiary)] mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function CardDivider() {
  return <div className="mx-6 border-t border-[var(--border-light)]" />
}

export function CardBody({ className, children }) {
  return <div className={cn('px-6 py-5', className)}>{children}</div>
}
