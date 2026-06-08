import { useEffect, useState } from 'react'
import { Bell } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import * as api from '@/lib/api'
import { Button } from '@/components/ui/button'

export function NotificationsBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])

  useEffect(() => {
    async function load() {
      try {
        const data = await api.exceptions.list()
        setItems(data.filter((e) => e.status === 'open').slice(0, 10))
      } catch {
        setItems([])
      }
    }
    load()
    const id = setInterval(load, 60000)
    window.addEventListener('smartrepay:demo-loaded', load)
    return () => {
      clearInterval(id)
      window.removeEventListener('smartrepay:demo-loaded', load)
    }
  }, [])

  const today = items.filter((i) => new Date(i.created_at).toDateString() === new Date().toDateString())
  const earlier = items.filter((i) => new Date(i.created_at).toDateString() !== new Date().toDateString())

  return (
    <div className="relative">
      <Button variant="ghost" size="icon" onClick={() => setOpen(!open)} aria-label="Notifications">
        <Bell className="h-4 w-4 text-[var(--text-secondary)]" strokeWidth={1.75} />
        {items.length > 0 && (
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-[var(--danger)]" />
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            className="absolute right-0 top-full mt-2 z-50 w-[360px] bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-xl)] overflow-hidden"
            style={{ boxShadow: 'var(--shadow-lg)' }}
          >
            <div className="px-5 py-4 border-b border-[var(--border-light)]">
              <span className="text-[15px] font-semibold text-[var(--text-primary)]">Notifications</span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {items.length === 0 ? (
                <p className="py-12 text-[13px] text-[var(--text-tertiary)] text-center">
                  All caught up · No new notifications
                </p>
              ) : (
                <>
                  <Group label="Today" items={today} />
                  <Group label="Earlier" items={earlier} />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Group({ label, items }) {
  if (!items.length) return null
  return (
    <div>
      <p className="px-5 py-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
        {label}
      </p>
      {items.map((item) => (
        <div key={item.id} className="flex gap-3 h-14 px-5 items-center hover:bg-[var(--bg-hover)] transition-colors duration-100">
          <span className="h-8 w-8 rounded-full bg-[var(--warning-bg)] flex items-center justify-center shrink-0">
            <Bell className="h-4 w-4 text-[var(--warning)]" strokeWidth={1.75} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] text-[var(--text-primary)]">Unmatched: {item.type}</p>
            <p className="text-xs text-[var(--text-tertiary)]">
              {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
