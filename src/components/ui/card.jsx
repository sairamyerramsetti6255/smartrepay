import { cn } from '@/lib/utils'

export function Card({ className, ...props }) {
  return <div className={cn('card', className)} {...props} />
}

export function CardHeader({ className, ...props }) {
  return <div className={cn('card-header', className)} {...props} />
}

export function CardTitle({ className, ...props }) {
  return <h3 className={cn('text-[15px] font-semibold text-[var(--text-primary)]', className)} {...props} />
}

export function CardDescription({ className, ...props }) {
  return <p className={cn('text-[13px] text-[var(--text-muted)] mt-1', className)} {...props} />
}

export function CardDivider() {
  return <div className="card-divider" />
}

export function CardContent({ className, ...props }) {
  return <div className={cn('card-body', className)} {...props} />
}
