import { cn } from '@/lib/utils'

export function GlassCard({ className, children, hover = true, glow = false, ...props }) {
  return (
    <div
      className={cn(
        'glass rounded-xl',
        hover && 'card-lift',
        glow && 'glow-active',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
