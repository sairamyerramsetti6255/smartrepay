import { useState } from 'react'
import toast from 'react-hot-toast'
import { Navigate, Link } from 'react-router-dom'
import { getSettings, saveSettings } from '@/lib/settings'
import { useAuth } from '@/context/AuthContext'
import { ROLES } from '@/lib/roles'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Toggle } from '@/components/Toggle'
import { Card } from '@/components/Card'

export function SettingsRules() {
  const { role } = useAuth()
  if (role !== ROLES.system_owner) return <Navigate to="/" replace />

  const [settings, setSettings] = useState(getSettings())
  const [regexTest, setRegexTest] = useState('')
  const [regexInput, setRegexInput] = useState('')

  function save() {
    saveSettings(settings)
    toast.success('Rules saved')
  }

  function toggle(id) {
    setSettings({
      ...settings,
      matchingRules: settings.matchingRules.map((r) => (r.id === id ? { ...r, active: !r.active } : r)),
    })
  }

  let regexMatch = null
  try {
    if (regexInput && regexTest) regexMatch = new RegExp(regexInput, 'i').test(regexTest)
  } catch {
    regexMatch = false
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Matching Rules"
        subtitle={
          <Link to="/settings/sla" className="text-[var(--accent)] text-[13px]">
            ← SLA settings
          </Link>
        }
        actions={<Button onClick={save}>Save All Changes</Button>}
      />

      <div className="card overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-[#FAFAF8] border-b border-[var(--border-light)]">
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                Rule
              </th>
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                Field
              </th>
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                Weight
              </th>
              <th className="px-5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                Active
              </th>
            </tr>
          </thead>
          <tbody>
            {settings.matchingRules.map((rule) => (
              <tr key={rule.id} className="h-14 border-b border-[var(--border-light)] last:border-b-0">
                <td className="px-5 font-medium">{rule.id}</td>
                <td className="px-5 capitalize text-[var(--text-secondary)]">{rule.field.replace('_', ' ')}</td>
                <td className="px-5">
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.1}
                    value={rule.weight}
                    className="w-[60px]"
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        matchingRules: settings.matchingRules.map((r) =>
                          r.id === rule.id ? { ...r, weight: parseFloat(e.target.value) } : r
                        ),
                      })
                    }
                  />
                </td>
                <td className="px-5">
                  <Toggle checked={rule.active} onChange={() => toggle(rule.id)} id={`rule-${rule.id}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Button variant="ghost">Add Rule</Button>

      <Card className="p-6 max-w-md">
        <h3 className="text-[15px] font-semibold mb-4">Alias pattern test</h3>
        <Input placeholder="Regex pattern" value={regexInput} onChange={(e) => setRegexInput(e.target.value)} className="mb-3" />
        <Input placeholder="Test string" value={regexTest} onChange={(e) => setRegexTest(e.target.value)} />
        {regexTest && regexInput && (
          <p className={`mt-3 text-[13px] ${regexMatch ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
            {regexMatch ? 'Pattern matches' : 'No match'}
          </p>
        )}
      </Card>
    </div>
  )
}
