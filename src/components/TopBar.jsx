import { useLocation, Link } from 'react-router-dom'
import { MatchingProgressBar } from './MatchingProgressBar'
import { useAuth } from '@/context/AuthContext'

const routeLabels = {
  '/': 'Dashboard',
  '/ingest': 'Upload Documents',
  '/match': 'Match',
  '/exceptions': 'Unmatched',
  '/reconcile': 'Reconcile',
  '/borrowers': 'Borrowers',
  '/audit': 'Audit Log',
  '/settings/sla': 'Settings',
  '/settings/rules': 'Matching Rules',
  '/reports/daily': 'Daily Report',
  '/receipts': 'Manual Receipts',
  '/repayments': 'Repayments',
  '/active-loans': 'Active Loans',
  '/loans': 'Loan Statement',
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
        <MatchingProgressBar />
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
