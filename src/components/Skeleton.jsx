import { cn } from '@/lib/utils'

export function Skeleton({ className }) {
  return <div className={cn('skeleton', className)} />
}

export function CardSkeleton() {
  return (
    <div className="card p-5 space-y-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-16" />
    </div>
  )
}

export function TableSkeleton({ rows = 5 }) {
  return (
    <div className="card overflow-hidden">
      <Skeleton className="h-11 w-full rounded-none" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-[52px] w-full rounded-none border-t border-[var(--border)]" />
      ))}
    </div>
  )
}
