import { Loader2 } from 'lucide-react'

export function PageLoader({ label = 'Loading…' }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <Loader2 className="h-8 w-8 text-[var(--accent)] animate-spin" strokeWidth={1.75} />
      <p className="text-[13px] text-[var(--text-tertiary)]">{label}</p>
    </div>
  )
}
