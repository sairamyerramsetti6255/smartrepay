import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  Landmark,
  BarChart3,
  SlidersHorizontal,
  Check,
  LogOut,
} from 'lucide-react'
import logo from '@/assets/simplfied_logo.webp'
import { useAuth } from '@/context/AuthContext'
import { useWorkflow } from '@/context/WorkflowContext'
import { canAccessSettings } from '@/lib/roles'
import { WORKFLOW_STEPS, STEP_STATUS } from '@/lib/workflow'
import { cn } from '@/lib/utils'

function NavItem({ to, label, icon: Icon, end }) {
  return (
    <NavLink
      to={to}
      end={end}
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

function WorkflowNavItem({ step, status }) {
  const done = status === STEP_STATUS.DONE
  const active = status === STEP_STATUS.ACTIVE

  return (
    <NavLink
      to={step.path}
      className={({ isActive }) =>
        cn(
          'flex h-10 items-center rounded-[var(--radius-md)] px-2 mb-0.5 transition-colors duration-100',
          isActive ? 'bg-[var(--bg-subtle)]' : 'hover:bg-[var(--bg-hover)]'
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold mr-2.5',
              done && 'bg-[var(--success)] text-white',
              !done && (active || isActive) && 'bg-[var(--accent)] text-white',
              !done && !active && !isActive && 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)] ring-1 ring-[var(--border-light)]'
            )}
          >
            {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : step.number}
          </span>
          <span
            className={cn(
              'flex-1 text-[14px] font-medium',
              isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
            )}
          >
            {step.label}
          </span>
        </>
      )}
    </NavLink>
  )
}

export function Sidebar() {
  const { user, profile, signOut } = useAuth()
  const { status } = useWorkflow()
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
      <div className="h-16 flex items-center px-4 border-b border-[var(--border-light)]">
        <img src={logo} alt="Simplified Lending" className="h-10 w-auto object-contain" />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mt-2 mb-1.5 px-2">
          Overview
        </p>
        <NavItem to="/" label="Dashboard" icon={LayoutDashboard} end />

        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mt-6 mb-1.5 px-2">
          Reconciliation workflow
        </p>
        {WORKFLOW_STEPS.filter((step) => !['review', 'reconcile'].includes(step.id)).map((step) => (
          <WorkflowNavItem key={step.id} step={step} status={status[step.id]} />
        ))}

        <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mt-6 mb-1.5 px-2">
          Records
        </p>
        <NavItem to="/active-loans" label="Active Loans" icon={Landmark} />
        <NavItem to="/active-loans/analytics" label="Loan Analytics" icon={BarChart3} />

        {showSettings && (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mt-6 mb-1.5 px-2">
              Configuration
            </p>
            <NavItem to="/settings/sla" label="SLA Targets" icon={SlidersHorizontal} />
            <NavItem to="/settings/rules" label="Matching Rules" icon={SlidersHorizontal} />
          </>
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
          title="Logout"
          className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--danger)] transition-colors duration-100 shrink-0"
        >
          <LogOut className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  )
}
