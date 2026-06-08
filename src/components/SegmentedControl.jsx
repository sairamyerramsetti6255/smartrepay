import { cn } from '@/lib/utils'

export function SegmentedControl({ options, value, onChange }) {
  return (
    <div className="inline-flex rounded-[var(--radius-md)] bg-[var(--bg-subtle)] p-[3px] transition-all duration-150">
      {options.map((opt) => {
        const id = typeof opt === 'string' ? opt : opt.value
        const label = typeof opt === 'string' ? opt : opt.label
        const active = value === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={cn(
              'h-8 px-3 rounded-[var(--radius-sm)] text-[13px] font-medium capitalize transition-all duration-150',
              active
                ? 'bg-[var(--bg-card)] text-[var(--text-primary)] shadow-[var(--shadow-xs)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
