import { createContext, useContext, useEffect, useState } from 'react'
import * as api from '@/lib/api'
import { resetBorrowerSyncSession } from '@/lib/borrowerBackgroundSync'
import { loadSettingsFromApi } from '@/lib/settings'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!api.getToken()) {
      setLoading(false)
      return
    }
    api.auth
      .me()
      .then(({ user: u }) => {
        setUser({ id: u.id, email: u.email })
        setProfile({ full_name: u.full_name, role: u.role })
        loadSettingsFromApi()
      })
      .catch(() => api.setToken(null))
      .finally(() => setLoading(false))
  }, [])

  const role = profile?.role || 'collections'

  const signIn = async (email, password) => {
    const { token, user: u } = await api.auth.signIn(email, password)
    api.setToken(token)
    setUser({ id: u.id, email: u.email })
    setProfile({ full_name: u.full_name, role: u.role })
    loadSettingsFromApi()
  }

  const signUp = async (email, password, role = 'collections') => {
    const { token, user: u } = await api.auth.signUp(email, password, role)
    api.setToken(token)
    setUser({ id: u.id, email: u.email })
    setProfile({ full_name: u.full_name, role: u.role })
    loadSettingsFromApi()
  }

  const signOut = async () => {
    api.setToken(null)
    setUser(null)
    setProfile(null)
    resetBorrowerSyncSession()
  }

  return (
    <AuthContext.Provider value={{ user, profile, role, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
