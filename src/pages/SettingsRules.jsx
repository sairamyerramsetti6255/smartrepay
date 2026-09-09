import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { Navigate } from 'react-router-dom'
import { FlaskConical, RefreshCw, RotateCcw } from 'lucide-react'
import * as api from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { ROLES } from '@/lib/roles'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Toggle } from '@/components/Toggle'
import { Badge } from '@/components/Badge'
import { Card, CardBody, CardHeader } from '@/components/Card'
import { PageLoader } from '@/components/PageLoader'
import { cn, formatCurrency } from '@/lib/utils'
import { normalizeMatchingRulesCatalog } from '@/lib/matchingRulesCatalog'
import { bucketVariant, confidenceBucket, CONFIDENCE_BUCKET_LABELS } from '@/lib/confidenceBucket'

const PREVIEW_CASES = [
  {
    id: 'typo-full',
    label: 'Typo — full name',
    payerName: 'LINDA ISREAL',
    borrowerName: 'LINDA ISRAEL',
    amount: 500,
    sampleEmi: 500,
  },
  {
    id: 'phonetic',
    label: 'Phonetic assist',
    payerName: 'Sara Conor',
    borrowerName: 'Sarah Connor',
    amount: 350,
    sampleEmi: 350,
  },
  {
    id: 'first-last',
    label: 'First + last typo',
    payerName: 'Jon Smith',
    borrowerName: 'John Smith',
    amount: 400,
    sampleEmi: 400,
  },
  {
    id: 'false-positive',
    label: 'Same surname — reject',
    payerName: 'Wilberson Smith',
    borrowerName: 'Annalisa Deandra Smith',
    amount: 500,
    sampleEmi: 500,
  },
]

function formatThresholdValue(meta, value) {
  if (meta.unit === 'weight') return `${Math.round(value * 100)}%`
  if (meta.unit === 'percent') return `±${Math.round(value * 100)}%`
  if (meta.unit === 'similarity') return `${Math.round(value * 100)}% similar`
  return String(value)
}

function ThresholdSlider({ meta, value, onChange }) {
  return (
    <div className="space-y-2 py-3 border-b border-[var(--border-light)] last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-semibold text-[var(--text-primary)]">{meta.label}</p>
          <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 leading-snug">{meta.hint}</p>
        </div>
        <span className="text-[13px] font-bold mono text-[var(--accent)] shrink-0">
          {formatThresholdValue(meta, value)}
        </span>
      </div>
      <input
        type="range"
        min={meta.min}
        max={meta.max}
        step={meta.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--accent)]"
      />
    </div>
  )
}

function bucketRangeLabel(bucket) {
  if (bucket.min != null && bucket.max != null) return `${bucket.min}–${bucket.max}%`
  if (bucket.min != null) return `≥${bucket.min}%`
  if (bucket.max != null) return `≤${bucket.max}%`
  return '—'
}

export function SettingsRules() {
  const { role } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [defaults, setDefaults] = useState(null)
  const [rules, setRules] = useState(null)
  const [previewCase, setPreviewCase] = useState(PREVIEW_CASES[0].id)
  const [previewResult, setPreviewResult] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.settings.matchingRules.get()
      setCatalog(normalizeMatchingRulesCatalog(data.catalog))
      setDefaults(data.defaults)
      setRules({
        ...data.rules,
        thresholds: data.rules?.thresholds || {},
        signals: data.rules?.signals || {},
        amountComponents: data.rules?.amountComponents || {},
      })
    } catch (e) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const thresholds = rules?.thresholds || {}
  const activePreview = PREVIEW_CASES.find((c) => c.id === previewCase) || PREVIEW_CASES[0]

  const runPreview = useCallback(async () => {
    if (!rules) return
    setPreviewing(true)
    try {
      const result = await api.settings.matchingRules.preview({
        rules,
        sample: activePreview,
      })
      setPreviewResult(result)
    } catch (e) {
      toast.error(e.message)
      setPreviewResult(null)
    } finally {
      setPreviewing(false)
    }
  }, [rules, activePreview])

  useEffect(() => {
    if (!rules) return
    const timer = setTimeout(runPreview, 400)
    return () => clearTimeout(timer)
  }, [rules, previewCase, runPreview])

  const tierSummary = useMemo(() => {
    const nameMin = thresholds.nameMinScore ?? 70
    const nameStrong = thresholds.nameStrongScore ?? 90
    const auto = thresholds.autoMatchConfidence ?? 85
    return { nameMin, nameStrong, auto }
  }, [thresholds])

  if (role !== ROLES.system_owner) return <Navigate to="/" replace />
  if (loading || !rules || !catalog) return <PageLoader label="Loading matching rules…" />

  function updateThreshold(key, value) {
    setRules((r) => ({
      ...r,
      thresholds: { ...r.thresholds, [key]: value },
    }))
  }

  function toggleSignal(key) {
    setRules((r) => ({
      ...r,
      signals: {
        ...r.signals,
        [key]: { ...r.signals[key], enabled: !r.signals[key]?.enabled },
      },
    }))
  }

  function updateAmountComponent(key, value) {
    setRules((r) => ({
      ...r,
      amountComponents: { ...r.amountComponents, [key]: value },
    }))
  }

  async function save() {
    setSaving(true)
    try {
      await api.settings.matchingRules.save(rules)
      toast.success('Matching rules saved — next match run will use these settings')
      await load()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  function resetDefaults() {
    if (!defaults) return
    if (!window.confirm('Reset all matching rules to defaults?')) return
    setRules(defaults)
    toast.success('Defaults restored — click Save to persist')
  }

  const scoreLimits = catalog.scoreLimits ?? []
  const tuning = catalog.tuning ?? []
  const signals = catalog.signals ?? []
  const amountComponents = catalog.amountComponents ?? []
  const nameAlgorithm = catalog.nameAlgorithm
  const confidenceBuckets = catalog.confidenceBuckets ?? []
  const previewBucket = previewResult?.confidenceBucket || (previewResult ? confidenceBucket(previewResult.confidence) : null)

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Matching Rules"
        subtitle="Hybrid name confidence engine — thresholds and signals loaded from the server and applied on every match run."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={resetDefaults}>
              <RotateCcw className="h-4 w-4" /> Reset defaults
            </Button>
            <Button variant="secondary" onClick={load} disabled={loading}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save rules'}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Confidence thresholds"
            subtitle={`Tiered scoring: 0 → no match · ${tierSummary.nameMin}–${tierSummary.nameStrong - 1} → first+last · ${tierSummary.nameStrong}–99 → full name · 100 → full name + EMI`}
          />
          <CardBody className="pt-0 space-y-6">
            <section>
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-1">
                Score limits
              </h3>
              <p className="text-[11px] text-[var(--text-tertiary)] mb-2">
                Cut-off points on a 0–100 scale. Auto-match uses the threshold currently set to{' '}
                <span className="mono font-semibold">{tierSummary.auto}%</span>.
              </p>
              {scoreLimits.map((meta) => (
                <ThresholdSlider
                  key={meta.key}
                  meta={meta}
                  value={thresholds[meta.key] ?? meta.default}
                  onChange={(v) => updateThreshold(meta.key, v)}
                />
              ))}
            </section>

            <section>
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-1">
                Amount & name tuning
              </h3>
              <p className="text-[11px] text-[var(--text-tertiary)] mb-2">
                Typo floor gates each first/last token before tiered name scoring applies.
              </p>
              {tuning.map((meta) => (
                <ThresholdSlider
                  key={meta.key}
                  meta={meta}
                  value={thresholds[meta.key] ?? meta.default}
                  onChange={(v) => updateThreshold(meta.key, v)}
                />
              ))}
            </section>
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Matching signals" subtitle="Enable or disable matching strategies" />
            <CardBody className="pt-0 space-y-1">
              {signals.map((sig) => {
                const on = rules.signals[sig.key]?.enabled !== false
                return (
                  <div
                    key={sig.key}
                    className="flex items-start justify-between gap-3 py-3 border-b border-[var(--border-light)] last:border-0"
                  >
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-[var(--text-primary)]">{sig.label}</p>
                      <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{sig.hint}</p>
                    </div>
                    <Toggle checked={on} onChange={() => toggleSignal(sig.key)} id={`sig-${sig.key}`} />
                  </div>
                )
              })}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Confidence buckets" subtitle="Tag assigned to each matched line item" />
            <CardBody className="pt-0 space-y-2">
              {confidenceBuckets.map((bucket) => (
                <div
                  key={bucket.key}
                  className="flex items-start justify-between gap-2 py-2 border-b border-[var(--border-light)] last:border-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={bucketVariant(bucket.key)}>{bucket.label}</Badge>
                      <span className="text-[10px] mono text-[var(--text-tertiary)]">{bucketRangeLabel(bucket)}</span>
                    </div>
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-1">{bucket.hint}</p>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader
            title={nameAlgorithm?.title || 'Name algorithm'}
            subtitle="Read-only blend weights — both first and last must pass typo floor"
          />
          <CardBody className="pt-0">
            {nameAlgorithm?.description && (
              <p className="text-[12px] text-[var(--text-secondary)] mb-4 leading-relaxed">{nameAlgorithm.description}</p>
            )}
            <div className="space-y-2 mb-4">
              {(nameAlgorithm?.blend || []).map((item) => (
                <div key={item.key} className="flex items-center justify-between text-[12px]">
                  <span className="text-[var(--text-secondary)]">{item.label}</span>
                  <span className="mono font-semibold text-[var(--accent)]">{Math.round(item.weight * 100)}%</span>
                </div>
              ))}
            </div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2">
              Name score tiers
            </h4>
            <div className="space-y-2">
              {(nameAlgorithm?.tiers || []).map((tier) => (
                <div key={tier.range} className="rounded-[var(--radius-md)] border border-[var(--border-light)] px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-[var(--text-primary)]">{tier.label}</span>
                    <span className="mono text-[11px] text-[var(--text-tertiary)]">{tier.range}</span>
                  </div>
                  <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{tier.description}</p>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Live preview"
            subtitle="Test current slider values against sample name pairs (server-side)"
            action={
              <Button size="sm" variant="secondary" onClick={runPreview} disabled={previewing}>
                <FlaskConical className="h-3.5 w-3.5 mr-1" />
                {previewing ? 'Running…' : 'Run'}
              </Button>
            }
          />
          <CardBody className="pt-0 space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {PREVIEW_CASES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setPreviewCase(c.id)}
                  className={cn(
                    'rounded-[var(--radius-full)] px-2.5 py-1 text-[11px] font-medium border transition-colors',
                    previewCase === c.id
                      ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]'
                      : 'border-[var(--border-light)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]'
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] bg-[var(--bg-subtle)]/40 px-3 py-2 text-[12px]">
              <p>
                <span className="text-[var(--text-tertiary)]">Bank:</span>{' '}
                <span className="font-medium">{activePreview.payerName}</span>
              </p>
              <p className="mt-1">
                <span className="text-[var(--text-tertiary)]">Borrower:</span>{' '}
                <span className="font-medium">{activePreview.borrowerName}</span>
              </p>
              <p className="mt-1 mono text-[11px] text-[var(--text-tertiary)]">
                {formatCurrency(activePreview.amount)} vs EMI {formatCurrency(activePreview.sampleEmi)}
              </p>
            </div>

            {previewResult ? (
              <div className="rounded-[var(--radius-md)] border border-[var(--border-light)] divide-y divide-[var(--border-light)]">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-[12px] text-[var(--text-secondary)]">Name score</span>
                  <span className="mono font-bold text-[var(--text-primary)]">{previewResult.nameScore}%</span>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-[12px] text-[var(--text-secondary)]">Confidence</span>
                  <div className="flex items-center gap-2">
                    {previewBucket && (
                      <Badge variant={bucketVariant(previewBucket)}>
                        {CONFIDENCE_BUCKET_LABELS[previewBucket] || previewBucket}
                      </Badge>
                    )}
                    <span className="mono font-bold">{previewResult.confidence}%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-[12px] text-[var(--text-secondary)]">Auto-match</span>
                  <Badge variant={previewResult.wouldAutoMatch ? 'matched' : 'exception'}>
                    {previewResult.wouldAutoMatch ? 'Yes' : 'No'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-[12px] text-[var(--text-secondary)]">Amount</span>
                  <span className="text-[12px] font-medium">{previewResult.amountMatchKind || '—'}</span>
                </div>
                {previewResult.reasoning && (
                  <p className="px-3 py-2 text-[11px] text-[var(--text-tertiary)] leading-snug line-clamp-4">
                    {previewResult.reasoning}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-[var(--text-tertiary)] text-center py-4">
                {previewing ? 'Running preview…' : 'Adjust rules or pick a sample to preview'}
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Amount match scores"
          subtitle="Points awarded per reconciliation type when amount is scored"
        />
        <CardBody className="pt-0">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {amountComponents.map((a) => (
              <div key={a.key}>
                <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                  {a.label}
                </label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  className="mt-1.5"
                  value={rules.amountComponents?.[a.key] ?? a.default}
                  onChange={(e) => updateAmountComponent(a.key, Number(e.target.value))}
                />
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
