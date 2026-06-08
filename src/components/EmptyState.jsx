import { Inbox } from 'lucide-react'

export function EmptyState({ icon: Icon = Inbox, title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <Icon className="h-9 w-9 text-[var(--text-tertiary)] mb-3" strokeWidth={1.75} />
      <p className="text-[15px] font-medium text-[var(--text-primary)]">{title}</p>
      {description && (
        <p className="text-[13px] text-[var(--text-tertiary)] mt-1 max-w-[280px]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
