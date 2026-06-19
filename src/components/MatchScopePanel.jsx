import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Play,
  RotateCcw,
  Loader2,
  Sparkles,
  FileText,
  FileSpreadsheet,
  CheckCircle2,
  Circle,
  Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDate, cn } from '@/lib/utils'

const SHEET_EXT = ['csv', 'xlsx', 'xls', 'xlsm']

const TABS = [
  { id: 'todo', label: 'To match' },
  { id: 'done', label: 'Completed' },
  { id: 'all', label: 'All files' },
]

function isCompleted(f) {
  return f.total > 0 && f.pending === 0
}
function isUntouched(f) {
  return f.total > 0 && f.matched === 0 && f.exception === 0
}
function inTab(f, tab) {
  if (tab === 'done') return isCompleted(f)
  if (tab === 'todo') return !isCompleted(f)
  return true
}

export function MatchScopePanel({
  files = [],
  loading = false,
  running = false,
  useAi = true,
  onUseAiChange,
  onRun,
  onViewScopeChange,
  tab: controlledTab,
  onTabChange,
  focusFileNames = null,
  hideFileList = false,
}) {
  const [internalTab, setInternalTab] = useState('todo')
  const tab = controlledTab ?? internalTab
  const setTab = (next) => {
    onTabChange?.(next)
    if (controlledTab === undefined) setInternalTab(next)
  }
  const [selected, setSelected] = useState(() => new Set())

  const counts = useMemo(() => {
    let todo = 0
    let done = 0
    for (const f of files) (isCompleted(f) ? (done += 1) : (todo += 1))
    return { todo, done, all: files.length }
  }, [files])

  useEffect(() => {
    if (loading || running) return
    if (tab === 'todo' && counts.todo === 0 && counts.done > 0) setTab('done')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts.todo, counts.done, loading])

  const visible = useMemo(() => files.filter((f) => inTab(f, tab)), [files, tab])

  const filesKey = files.map((f) => f.fileName).join('|')
  const focusKey = focusFileNames?.join('|') ?? ''
  useEffect(() => {
    if (running) return
    if (focusFileNames?.length) {
      setSelected(new Set(focusFileNames))
      const f = files.find((x) => focusFileNames.includes(x.fileName))
      setTab(f && isCompleted(f) ? 'done' : 'todo')
      return
    }
    if (tab === 'done') {
      setSelected(new Set())
      return
    }
    setSelected(new Set(files.filter((f) => !isCompleted(f)).map((f) => f.fileName)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filesKey, focusKey, running])

  const toggle = (name) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const stats = useMemo(() => {
    let rows = 0
    let pending = 0
    for (const f of files) {
      if (!selected.has(f.fileName)) continue
      rows += f.total
      pending += f.pending
    }
    return { files: selected.size, rows, pending }
  }, [files, selected])

  const rematchMode = tab === 'done'
  const canRun = !running && selected.size > 0

  useEffect(() => {
    if (!onViewScopeChange) return
    if (focusFileNames?.length) {
      onViewScopeChange({ tab: 'file', fileNames: [...focusFileNames] })
      return
    }
    if (tab === 'all') {
      onViewScopeChange({ tab: 'all', fileNames: null })
      return
    }
    const names =
      selected.size > 0 ? [...selected] : visible.map((f) => f.fileName)
    onViewScopeChange({ tab, fileNames: names })
  }, [tab, selected, visible, onViewScopeChange, focusFileNames, focusKey])

  function handleRun() {
    if (!canRun) return
    onRun?.([...selected])
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border-light)] bg-[var(--bg-card)] shadow-[var(--shadow-xs)] overflow-hidden flex flex-col min-h-[280px]">
      {/* Tabs + actions — single compact row */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[var(--border-light)] bg-[var(--bg-subtle)]/40">
        <div className="flex flex-wrap items-center gap-1 flex-1 min-w-0">
          {TABS.map((t) => {
            const c = t.id === 'todo' ? counts.todo : t.id === 'done' ? counts.done : counts.all
            const active = tab === t.id
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-md)] text-[12px] font-semibold transition-colors',
                  active
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-card)] border border-transparent hover:border-[var(--border-light)]'
                )}
              >
                {t.label}
                <span
                  className={cn(
                    'mono text-[10px] font-bold px-1.5 py-px rounded-full min-w-[1.1rem] text-center',
                    active ? 'bg-white/25' : 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]'
                  )}
                >
                  {c}
                </span>
              </button>
            )
          })}
        </div>

        {stats.files > 0 && (
          <span className="hidden sm:inline text-[11px] text-[var(--text-tertiary)] whitespace-nowrap">
            {stats.files} selected · {stats.rows} txns
          </span>
        )}

        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-1.5 h-8 px-2.5 rounded-[var(--radius-md)] text-[11px] font-medium text-[var(--text-secondary)] cursor-pointer select-none hover:bg-[var(--bg-card)]">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(e) => onUseAiChange?.(e.target.checked)}
              disabled={running}
              className="h-3 w-3 accent-[var(--accent)]"
            />
            <Sparkles className="h-3 w-3 text-[var(--accent)]" />
            AI
          </label>
          <Button size="sm" className="h-8 px-3 text-[12px]" onClick={handleRun} disabled={!canRun} variant={rematchMode ? 'secondary' : 'default'}>
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : rematchMode ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {running ? 'Running…' : selected.size === 0 ? 'Select files' : rematchMode ? 'Re-match' : 'Run match'}
          </Button>
        </div>
      </div>

      {/* File list — fills remaining space */}
      <div className="flex-1 overflow-y-auto max-h-[min(480px,calc(100vh-420px))] min-h-[160px]">
        {hideFileList ? (
          focusFileNames?.length === 1 ? (
            <div className="px-5 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Focused file</p>
              <p className="text-[13px] font-medium text-[var(--text-primary)] mt-1 truncate" title={focusFileNames[0]}>
                {focusFileNames[0]}
              </p>
            </div>
          ) : null
        ) : loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--text-tertiary)]" />
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            title="No files staged"
            action={
              <Link to="/ingest">
                <Button variant="secondary" size="sm">Upload</Button>
              </Link>
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState title={tab === 'todo' ? 'All files matched' : 'No files in this tab'} />
        ) : (
          <ul className="divide-y divide-[var(--border-light)]">
            {visible.map((f) => (
              <FileRow
                key={f.fileName}
                f={f}
                checked={selected.has(f.fileName)}
                disabled={running}
                onToggle={() => toggle(f.fileName)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function EmptyState({ title, action }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-[13px] font-medium text-[var(--text-secondary)]">{title}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

function FileRow({ f, checked, disabled, onToggle }) {
  const ext = f.fileName?.split('.').pop()?.toLowerCase() || ''
  const isSheet = SHEET_EXT.includes(ext)
  const Icon = isSheet ? FileSpreadsheet : FileText
  const pct = f.total > 0 ? Math.round((f.matched / f.total) * 100) : 0
  const completed = isCompleted(f)
  const untouched = isUntouched(f)

  return (
    <li
      className={cn(
        'flex items-center gap-3 px-4 py-2.5 transition-colors cursor-pointer',
        checked ? 'bg-[var(--accent-subtle)]/45' : 'hover:bg-[var(--bg-subtle)]/50',
        disabled && 'cursor-default opacity-80'
      )}
      onClick={() => !disabled && onToggle()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        className="h-3.5 w-3.5 accent-[var(--accent)] shrink-0"
      />

      <Icon className={cn('h-4 w-4 shrink-0', isSheet ? 'text-[var(--success)]' : 'text-[var(--accent)]')} strokeWidth={1.75} />

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-[var(--text-primary)] truncate" title={f.fileName}>
          {f.fileName}
        </p>
        <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
          {f.matched}/{f.total} matched{f.dateFrom ? ` · ${formatDate(f.dateFrom)}` : ''}
        </p>
      </div>

      <div className="hidden sm:block w-24 shrink-0">
        <div className="h-1.5 rounded-full bg-[var(--bg-subtle)] overflow-hidden">
          <div
            className={cn('h-full rounded-full', completed ? 'bg-[var(--success)]' : 'bg-[var(--accent)]')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="shrink-0 w-[88px] text-right">
        {completed ? (
          <StatusPill tone="success" icon={CheckCircle2} label="Done" />
        ) : untouched ? (
          <StatusPill tone="muted" icon={Circle} label="Not run" />
        ) : (
          <StatusPill tone="warn" icon={Clock} label={`${f.pending} left`} />
        )}
      </div>
    </li>
  )
}

function StatusPill({ tone, icon: Icon, label }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-full)] text-[10px] font-semibold whitespace-nowrap',
        tone === 'success' && 'bg-[var(--success-bg)] text-[var(--success)]',
        tone === 'warn' && 'bg-[var(--warning-bg)] text-[var(--warning)]',
        tone === 'muted' && 'bg-[var(--bg-subtle)] text-[var(--text-tertiary)]'
      )}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
      {label}
    </span>
  )
}
