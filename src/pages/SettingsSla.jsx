import { useState } from 'react'
import toast from 'react-hot-toast'
import { Navigate } from 'react-router-dom'
import { getSettings, saveSettings } from '@/lib/settings'
import { useAuth } from '@/context/AuthContext'
import { ROLES } from '@/lib/roles'
import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/Card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Toggle } from '@/components/Toggle'

const TYPES = ['unmatched', 'duplicate', 'partial', 'suspicious']
const HOURS = [4, 24, 48, 72]

export function SettingsSla() {
  const { role } = useAuth()
  if (role !== ROLES.system_owner) return <Navigate to="/" replace />

  const [settings, setSettings] = useState(getSettings())

  function save() {
    saveSettings(settings)
    toast.success('SLA settings saved')
  }

  return (
    <div className="space-y-6">
      <PageHeader title="SLA Thresholds" subtitle="Configure response times per exception type" />

      <div className="grid gap-6 md:grid-cols-2">
        {TYPES.map((type) => (
          <Card key={type} className="p-6">
            <h3 className="text-[15px] font-semibold text-[var(--text-primary)] capitalize mb-5">{type}</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <Label>Duration</Label>
                <select
                  className="h-9 rounded-[var(--radius-md)] border border-[var(--border-medium)] px-3 text-[13px] bg-[var(--bg-card)]"
                  value={settings.slaHours[type]}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      slaHours: { ...settings.slaHours, [type]: Number(e.target.value) },
                    })
                  }
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {h}h
                    </option>
                  ))}
                </select>
              </div>
              <Toggle
                id={`escalate-${type}`}
                label="Auto-escalate on breach"
                checked={settings.autoEscalateOnBreach}
                onChange={(v) => setSettings({ ...settings, autoEscalateOnBreach: v })}
              />
            </div>
            <div className="flex justify-end mt-6">
              <Button variant="secondary" size="sm" onClick={save}>
                Save
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-6 max-w-md">
        <Label className="block mb-3">Auto-approve threshold: {settings.autoApproveThreshold}%</Label>
        <input
          type="range"
          min={0}
          max={100}
          value={settings.autoApproveThreshold}
          onChange={(e) => setSettings({ ...settings, autoApproveThreshold: Number(e.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
        <Button className="mt-4" onClick={save}>
          Save configuration
        </Button>
      </Card>
    </div>
  )
}
