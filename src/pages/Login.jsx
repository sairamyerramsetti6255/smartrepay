import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ROLES } from '@/lib/roles'
import { checkApiConnection } from '@/lib/api'
import logo from '@/assets/simplfied_logo.webp'

export function Login() {
  const { user, signIn, signUp, loading } = useAuth()
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('demo@smartrepay.local')
  const [password, setPassword] = useState('demo1234')
  const [role, setRole] = useState(ROLES.system_owner)
  const [submitting, setSubmitting] = useState(false)
  const [conn, setConn] = useState({ checking: true, ok: null, error: null })

  useEffect(() => {
    let cancelled = false
    checkApiConnection().then((result) => {
      if (!cancelled) setConn({ checking: false, ok: result.ok, error: result.error })
    })
    return () => { cancelled = true }
  }, [])

  if (!loading && user) return <Navigate to="/" replace />

  async function handleSubmit(e) {
    e.preventDefault()
    if (conn.ok === false) return toast.error(conn.error || 'API not reachable')

    setSubmitting(true)
    try {
      if (mode === 'signin') await signIn(email, password)
      else await signUp(email, password, role)
      toast.success(mode === 'signin' ? 'Welcome back' : 'Account created')
    } catch (err) {
      toast.error(err.message || 'Auth failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[var(--bg-app)] grid lg:grid-cols-2">
      {/* Brand panel */}
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

        <div className="relative max-w-sm">
          <h2 className="text-[26px] font-bold tracking-[-0.02em] leading-snug">
            Reconcile loan repayments in four guided steps.
          </h2>
          <ul className="mt-7 space-y-3.5">
            {[
              { n: '1', t: 'Upload statement', d: 'Bank or employer files in seconds' },
              { n: '2', t: 'Run matching', d: 'Payments matched to borrowers automatically' },
              { n: '3', t: 'Review unmatched', d: 'Resolve exceptions with full context' },
              { n: '4', t: 'Reconcile & post', d: 'Approve and export to LoanDisk' },
            ].map((s) => (
              <li key={s.n} className="flex items-start gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/15 text-[13px] font-bold">
                  {s.n}
                </span>
                <div>
                  <p className="text-[14px] font-semibold leading-tight">{s.t}</p>
                  <p className="text-[12px] text-white/70 mt-0.5">{s.d}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[12px] text-white/60">© {new Date().getFullYear()} Simplified Lending</p>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center p-8 sm:p-12">
      <div className="card w-full max-w-md p-10">
        <header className="mb-8">
          <div className="flex items-center lg:hidden mb-6">
            <img src={logo} alt="Simplified Lending" className="h-10 w-auto object-contain" />
          </div>
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight">
            {mode === 'signin' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="text-[13px] text-[var(--text-tertiary)] mt-1">
            {mode === 'signin' ? 'Sign in to continue to your dashboard.' : 'Set up access to SmartRepay AI.'}
          </p>
        </header>

        {!conn.checking && conn.ok === false && (
          <div className="mb-5 rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-bg)] p-4 text-[13px] text-[var(--danger)] space-y-2">
            <p className="font-medium">Backend API not running</p>
            <p className="text-[var(--text-secondary)]">{conn.error}</p>
            <p className="text-[12px] text-[var(--text-tertiary)]">Run <code className="mono">npm run dev</code> from the project root (starts API + frontend).</p>
          </div>
        )}

        {conn.ok && (
          <p className="mb-5 text-[12px] text-[var(--text-tertiary)]">
            Demo: demo@smartrepay.local / demo1234
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <Label className="mb-1.5 block">Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label className="mb-1.5 block">Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {mode === 'signup' && (
            <div>
              <Label className="mb-1.5 block">Role</Label>
              <select
                className="flex h-9 w-full rounded-[var(--radius-md)] border border-[var(--border-medium)] bg-[var(--bg-card)] px-3 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                {Object.values(ROLES).map((r) => (
                  <option key={r} value={r}>{r.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
          )}
          <Button type="submit" className="w-full" size="lg" disabled={submitting || conn.checking || conn.ok === false}>
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
        <button
          type="button"
          className="mt-6 w-full text-center text-[13px] text-[var(--accent)] font-medium"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        >
          {mode === 'signin' ? 'Create an account' : 'Sign in instead'}
        </button>
      </div>
      </div>
    </div>
  )
}
