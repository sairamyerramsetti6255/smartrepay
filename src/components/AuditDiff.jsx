export function AuditDiff({ prior, next }) {
  const priorKeys = prior ? Object.keys(prior) : []
  const nextKeys = next ? Object.keys(next) : []
  const allKeys = [...new Set([...priorKeys, ...nextKeys])].filter((key) => {
    return JSON.stringify(prior?.[key]) !== JSON.stringify(next?.[key])
  })

  if (!allKeys.length) return <p className="text-[13px] text-[var(--text-tertiary)]">No field changes</p>

  return (
    <div className="grid md:grid-cols-2 gap-4 text-xs mono">
      <div className="rounded-[var(--radius-md)] bg-[var(--bg-card)] p-4 border border-[var(--border-light)]">
        <p className="text-[10px] uppercase tracking-[0.06em] text-[var(--text-tertiary)] mb-3 font-sans font-semibold">Before</p>
        {allKeys.map((key) => (
          <div key={key} className="py-1 line-through text-[var(--text-tertiary)]">
            <span className="font-sans text-[var(--text-secondary)]">{key}: </span>
            {formatVal(prior?.[key])}
          </div>
        ))}
      </div>
      <div className="rounded-[var(--radius-md)] bg-[var(--bg-card)] p-4 border border-[var(--border-light)]">
        <p className="text-[10px] uppercase tracking-[0.06em] text-[var(--success)] mb-3 font-sans font-semibold">After</p>
        {allKeys.map((key) => (
          <div key={key} className="py-1 text-[var(--success)]">
            <span className="font-sans text-[var(--text-secondary)]">{key}: </span>
            {formatVal(next?.[key])}
          </div>
        ))}
      </div>
    </div>
  )
}

function formatVal(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
