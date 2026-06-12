import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider } from '@/context/AuthContext'
import { MatchingProgressProvider } from '@/context/MatchingProgressContext'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Layout } from '@/components/Layout'
import { Login } from '@/pages/Login'
import { Dashboard } from '@/pages/Dashboard'
import { Ingest } from '@/pages/Ingest'
import { Match } from '@/pages/Match'
import { Exceptions } from '@/pages/Exceptions'
import { Reconcile } from '@/pages/Reconcile'
import { Audit } from '@/pages/Audit'
import { Borrowers } from '@/pages/Borrowers'
import { ActiveLoans } from '@/pages/ActiveLoans'
import { LoanAnalytics } from '@/pages/LoanAnalytics'
import { SettingsSla } from '@/pages/SettingsSla'
import { SettingsRules } from '@/pages/SettingsRules'
import { ReportsDaily } from '@/pages/ReportsDaily'

export default function App() {
  return (
    <AuthProvider>
      <MatchingProgressProvider>
      <HashRouter>
        <Toaster
          position="bottom-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-light)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-sm)',
              fontSize: '13px',
            },
            success: { style: { borderLeft: '3px solid var(--success)' } },
            error: { style: { borderLeft: '3px solid var(--danger)' } },
          }}
        />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Dashboard />} />
            <Route path="ingest" element={<Ingest />} />
            <Route path="match" element={<Match />} />
            <Route path="exceptions" element={<Exceptions />} />
            <Route path="reconcile" element={<Reconcile />} />
            <Route path="audit" element={<Audit />} />
            <Route path="active-loans" element={<ActiveLoans />} />
            <Route path="active-loans/analytics" element={<LoanAnalytics />} />
            <Route path="borrowers" element={<Borrowers />} />
            <Route path="settings/sla" element={<SettingsSla />} />
            <Route path="settings/rules" element={<SettingsRules />} />
            <Route path="reports/daily" element={<ReportsDaily />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
      </MatchingProgressProvider>
    </AuthProvider>
  )
}
