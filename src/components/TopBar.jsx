import { useLocation, Link } from 'react-router-dom'
import { Search, Bell } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { NotificationsBell } from './NotificationsBell'
import { useAuth } from '@/context/AuthContext'

const routeLabels = {
  '/': 'Dashboard',
  '/ingest': 'Ingest',
  '/match': 'Match',
  '/exceptions': 'Unmatched',
  '/reconcile': 'Reconcile',
  '/borrowers': 'Borrowers',
  '/audit': 'Audit Log',
  '/settings/sla': 'Settings',
  '/settings/rules': 'Matching Rules',
  '/reports/daily': 'Daily Report',
}

export function TopBar() {
  const { pathname } = useLocation()
  const { user, profile } = useAuth()
  const page = routeLabels[pathname] || pathname.split('/').filter(Boolean).pop() || 'Page'

  const initials = (profile?.full_name || user?.email || 'U')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <header className="fixed left-[248px] right-0 top-0 z-30 flex h-14 items-center justify-between border-b border-[var(--border-light)] bg-[var(--bg-card)] px-8">
      <nav className="text-[13px] text-[var(--text-tertiary)]" aria-label="Breadcrumb">
        <Link to="/" className="hover:text-[var(--text-secondary)] transition-colors duration-100">
          SmartRepay
        </Link>
        <span className="mx-2">/</span>
        <span className="text-[var(--text-primary)] font-medium">{page}</span>
      </nav>

      <div className="flex items-center gap-3">
        <div className="relative hidden md:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" strokeWidth={1.75} />
          <Input className="w-52 pl-9 h-8 text-[13px]" placeholder="Search..." />
        </div>
        <NotificationsBell />
        <div
          className="h-8 w-8 rounded-full bg-[var(--bg-subtle)] flex items-center justify-center text-xs font-semibold text-[var(--text-secondary)]"
          title={user?.email}
        >
          {initials}
        </div>
      </div>
    </header>
  )
}
