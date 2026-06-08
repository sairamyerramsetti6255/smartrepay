import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function Drawer({ open, onClose, title, subtitle, footer, children, width = 460 }) {
  useEffect(() => {
    if (!open) return
    const onEsc = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEsc)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onEsc)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[60] bg-[rgba(26,25,22,0.24)]"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="drawer-panel fixed inset-y-0 right-0 z-[60] flex h-dvh flex-col bg-[var(--bg-card)] border-l border-[var(--border-light)]"
        style={{ width, boxShadow: '-8px 0 40px rgba(26,25,22,0.08)' }}
        role="dialog"
        aria-modal
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-light)] px-6">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)] tracking-[-0.01em]">{title}</h2>
            {subtitle && <p className="text-[13px] text-[var(--text-tertiary)]">{subtitle}</p>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" strokeWidth={1.75} />
          </Button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">{children}</div>
        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-light)] px-6 py-4">
            {footer}
          </footer>
        )}
      </aside>
    </>,
    document.body
  )
}
