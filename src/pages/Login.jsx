import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Lock, Mail, Eye, EyeOff, LogIn, Shield, Users, DollarSign, CheckCircle2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '@/context/AuthContext'
import { checkApiConnection } from '@/lib/api'
import { isMicrosoftLoginEnabled } from '@/lib/msal'
import logo from '@/assets/simplfied_logo.webp'
import { cn } from '@/lib/utils'

const ALLOWED_DOMAIN = 'slendingbahamas.com'

const DEMO_ACCOUNTS = [
  {
    role: 'Admin / System Owner',
    email: 'admin@pbshope.com',
    password: 'pbs2026',
    icon: Shield,
    badge: 'Full Access',
    desc: 'Rules, SLA, QB Approvals & Export',
  },
  {
    role: 'Accounting Officer',
    email: 'accounting@pbshope.com',
    password: 'pbs2026',
    icon: DollarSign,
    badge: 'QB & Reconcile',
    desc: 'QuickBooks approvals, export, reconciliation',
  },
  {
    role: 'Collections Officer',
    email: 'collections@pbshope.com',
    password: 'pbs2026',
    icon: Users,
    badge: 'Operations',
    desc: 'Ingest, matching & receipts',
  },
]

function MicrosoftLogo({ className }) {
  return (
    <svg className={className} viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  )
}

export function Login() {
  const { user, signIn, signInWithMicrosoft, loading } = useAuth()
  const [email, setEmail] = useState('admin@pbshope.com')
  const [password, setPassword] = useState('pbs2026')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [microsoftSubmitting, setMicrosoftSubmitting] = useState(false)
  const [conn, setConn] = useState({ checking: true, ok: null, error: null })
  const microsoftEnabled = isMicrosoftLoginEnabled()

  useEffect(() => {
    let cancelled = false
    checkApiConnection().then((result) => {
      if (!cancelled) setConn({ checking: false, ok: result.ok, error: result.error })
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!loading && user) return <Navigate to="/" replace />

  const handlePasswordSignIn = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password) {
      return toast.error('Please enter your email and password')
    }
    if (conn.ok === false) {
      return toast.error(conn.error || 'API backend is not reachable')
    }

    setSubmitting(true)
    try {
      await signIn(email.trim(), password)
      toast.success('Signed in successfully')
    } catch (err) {
      toast.error(err.message || 'Invalid email or password')
    } finally {
      setSubmitting(false)
    }
  }

  const handleMicrosoftSignIn = async () => {
    if (conn.ok === false) return toast.error(conn.error || 'API not reachable')
    if (!microsoftEnabled) return toast.error('Microsoft sign-in is not configured')

    setMicrosoftSubmitting(true)
    try {
      await signInWithMicrosoft()
      toast.success('Signed in with Microsoft')
    } catch (err) {
      toast.error(err.message || 'Microsoft sign-in failed')
    } finally {
      setMicrosoftSubmitting(false)
    }
  }

  const handleSelectDemoAccount = (acc) => {
    setEmail(acc.email)
    setPassword(acc.password)
    toast.success(`Selected ${acc.role}`)
  }

  return (
    <div className="min-h-screen bg-[var(--bg-app)] grid lg:grid-cols-2">
      {/* Left hero panel */}
      <div className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-[var(--accent)] p-12 text-white">
        <div
          className="absolute inset-0 opacity-30"
          style={{ background: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.25), transparent 55%)' }}
        />
        <div className="relative flex items-center">
          <div className="rounded-[var(--radius-md)] bg-white px-3 py-2 shadow-sm">
            <img src={logo} alt="Simplified Lending" className="h-10 w-auto object-contain" />
          </div>
        </div>

        <div className="relative max-w-md">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/15 text-[12px] font-semibold text-white mb-4">
            <CheckCircle2 className="h-3.5 w-3.5" />
            SmartRepay AI Platform
          </span>
          <h2 className="text-[26px] font-bold tracking-[-0.02em] leading-snug">
            Intelligent loan repayment reconciliation & QuickBooks preparation.
          </h2>
          <ul className="mt-7 space-y-3.5">
            {[
              { n: '1', t: 'Multi-Source Ingestion', d: 'Bank feeds, employers, receipts, PDF/OCR statements' },
              { n: '2', t: 'AI & Deterministic Matcher', d: 'Confidence-weighted repayment matching engine' },
              { n: '3', t: 'QuickBooks Integration', d: 'Standardized EMI receipts, disbursements & COA export' },
              { n: '4', t: 'CRIF Credit Bureau Sync', d: 'Automated subject and contract monthly reporting' },
            ].map((s) => (
              <li key={s.n} className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/15 text-[13px] font-bold">
                  {s.n}
                </span>
                <div>
                  <p className="text-[14px] font-semibold leading-tight">{s.t}</p>
                  <p className="text-[12px] text-white/75 mt-0.5">{s.d}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center justify-between text-[12px] text-white/60">
          <p>© {new Date().getFullYear()} Simplified Lending</p>
          <p>Version 1.8.0</p>
        </div>
      </div>

      {/* Right Login Form */}
      <div className="flex items-center justify-center p-6 sm:p-12 overflow-y-auto">
        <div className="w-full max-w-md p-8 sm:p-10 shadow-xl border border-[var(--border-light)] bg-white rounded-2xl">
          <header className="mb-6 text-center">
            <div className="flex items-center justify-center lg:hidden mb-4">
              <img src={logo} alt="Simplified Lending" className="h-10 w-auto object-contain" />
            </div>
            <h1 className="text-[22px] font-bold text-[var(--text-primary)] tracking-tight">
              Sign In to SmartRepay
            </h1>
            <p className="text-[13px] text-[var(--text-tertiary)] mt-1">
              Enter your credentials to access the financial reconciliation workspace.
            </p>
          </header>

          {/* Backend offline warning */}
          {!conn.checking && conn.ok === false && (
            <div className="mb-5 rounded-[var(--radius-md)] border border-[var(--danger)]/30 bg-[var(--danger-bg)]/20 p-3.5 text-[13px] text-[var(--danger)] space-y-1">
              <p className="font-semibold">Backend server offline</p>
              <p className="text-[12px] text-[var(--text-secondary)]">{conn.error}</p>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handlePasswordSignIn} className="space-y-4">
            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-primary)] mb-1">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@pbshope.com"
                  className="w-full h-10 pl-9 pr-3 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-white text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]"
                />
              </div>
            </div>

            <div>
              <label className="block text-[12px] font-semibold text-[var(--text-primary)] mb-1">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-tertiary)]" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full h-10 pl-9 pr-10 rounded-[var(--radius-md)] border border-[var(--border-light)] bg-white text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting || conn.ok === false}
              className="w-full flex items-center justify-center gap-2 h-10 rounded-[var(--radius-md)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[14px] font-semibold transition-colors disabled:opacity-60 shadow-sm mt-2"
            >
              <LogIn className="h-4 w-4" />
              {submitting ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          {/* Quick Demo Accounts Selection */}
          <div className="mt-6 pt-5 border-t border-[var(--border-light)]">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2.5 text-center">
              Quick-Fill Demo Credentials
            </p>
            <div className="space-y-1.5">
              {DEMO_ACCOUNTS.map((acc) => {
                const isSelected = email === acc.email
                const Icon = acc.icon
                return (
                  <button
                    key={acc.email}
                    type="button"
                    onClick={() => handleSelectDemoAccount(acc)}
                    className={cn(
                      'w-full flex items-center justify-between p-2.5 rounded-[var(--radius-md)] text-left transition-all border text-[12px]',
                      isSelected
                        ? 'border-[var(--accent)] bg-[var(--accent)]/5 text-[var(--text-primary)] shadow-xs'
                        : 'border-[var(--border-light)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={cn('p-1.5 rounded-[var(--radius-sm)]', isSelected ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]')}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="truncate">
                        <p className="font-semibold text-[12px] text-[var(--text-primary)] leading-tight">{acc.role}</p>
                        <p className="text-[11px] font-mono text-[var(--text-tertiary)]">{acc.email}</p>
                      </div>
                    </div>
                    <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[var(--bg-subtle)] text-[var(--text-secondary)]">
                      {acc.badge}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)] text-center mt-2">
              Default password: <code className="font-mono font-bold text-[var(--text-primary)]">pbs2026</code>
            </p>
          </div>

          {/* Optional Microsoft SSO */}
          {microsoftEnabled && (
            <div className="mt-6 pt-5 border-t border-[var(--border-light)]">
              <button
                type="button"
                disabled={microsoftSubmitting || conn.ok === false}
                onClick={handleMicrosoftSignIn}
                className="flex w-full items-center justify-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--border-medium)] bg-white px-4 py-2.5 text-[13px] font-medium text-[#323130] shadow-xs hover:bg-[#f9f9f9] transition-colors disabled:opacity-50"
              >
                <MicrosoftLogo className="h-4 w-4 shrink-0" />
                <span>
                  {microsoftSubmitting ? 'Connecting Microsoft…' : `Sign in with Microsoft (@${ALLOWED_DOMAIN})`}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
