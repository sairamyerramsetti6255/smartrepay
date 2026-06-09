import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Upload,
  GitCompare,
  AlertTriangle,
  Scale,
  Users,
  ScrollText,
  Settings,
} from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { canAccessSettings } from '@/lib/roles'
import { cn } from '@/lib/utils'

const groups = [
  {
    label: 'Main',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/ingest', label: 'Upload Documents', icon: Upload },
      { to: '/match', label: 'Match', icon: GitCompare },
    ],
  },
  {
    label: 'Workflow',
    items: [
      { to: '/exceptions', label: 'Unmatched', icon: AlertTriangle },
      { to: '/reconcile', label: 'Reconcile', icon: Scale },
    ],
  },
  {
    label: 'Records',
    items: [
      { to: '/borrowers', label: 'Borrowers', icon: Users },
      { to: '/audit', label: 'Audit Log', icon: ScrollText },
      { to: '/reports/daily', label: 'Daily Report', icon: ScrollText },
    ],
  },
]

function NavItem({ to, label, icon: Icon }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'flex h-9 items-center rounded-[var(--radius-md)] px-2.5 mb-0.5 text-[14px] font-medium transition-colors duration-100',
          isActive
            ? 'bg-[var(--bg-subtle)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={cn('h-4 w-4 mr-2.5 shrink-0', isActive ? 'text-[var(--accent)]' : 'text-current')}
            strokeWidth={1.75}
          />
          {label}
        </>
      )}
    </NavLink>
  )
}

export function Sidebar() {
  const { user, profile, signOut } = useAuth()
  const navigate = useNavigate()
  const showSettings = canAccessSettings(profile?.role)

  const initials = (profile?.full_name || user?.email || 'U')
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const handleLogout = async () => {
    await signOut()
    navigate('/login')
  }

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-[248px] flex-col border-r border-[var(--border-light)] bg-[var(--bg-card)]">
      <div className="h-16 flex flex-col justify-center px-4 border-b border-[var(--border-light)]">
        <span className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight leading-none">
          SmartRepay AI
        </span>
        <span className="text-[13px] text-[var(--text-tertiary)] mt-0.5">Simplified Lending</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mt-6 mb-1.5 px-2 first:mt-2">
              {group.label}
            </p>
            {group.items.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </div>
        ))}
        {showSettings && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mt-6 mb-1.5 px-2">
              Config
            </p>
            <NavItem to="/settings/sla" label="SLA" icon={Settings} />
            <NavItem to="/settings/rules" label="Rules" icon={Settings} />
          </div>
        )}
      </nav>

      <div className="border-t border-[var(--border-light)] p-4 flex items-center gap-3">
        <div className="h-8 w-8 rounded-full bg-[var(--bg-subtle)] flex items-center justify-center text-xs font-semibold text-[var(--text-secondary)] shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">
            {profile?.full_name || user?.email?.split('@')[0]}
          </p>
          <p className="text-xs text-[var(--text-tertiary)] capitalize">{profile?.role?.replace('_', ' ') || 'User'}</p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="text-xs text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors duration-100 shrink-0"
        >
          Logout
        </button>
      </div>
    </aside>
  )
}
