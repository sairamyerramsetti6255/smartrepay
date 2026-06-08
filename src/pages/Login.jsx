import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ROLES } from '@/lib/roles'
import { checkApiConnection } from '@/lib/api'

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
    <div className="min-h-screen bg-[var(--bg-app)] flex items-center justify-center p-10">
      <div className="card w-full max-w-md p-10">
        <header className="mb-10">
          <h1 className="text-[22px] font-semibold text-[var(--text-primary)] tracking-tight">SmartRepay AI</h1>
          <p className="text-[13px] text-[var(--text-tertiary)] mt-1">Simplified Lending</p>
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
  )
}
