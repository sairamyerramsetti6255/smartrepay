export function Toggle({ checked, onChange, label, id }) {
  return (
    <label htmlFor={id} className="inline-flex items-center gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-[var(--radius-full)] transition-colors duration-[120ms] ${
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-subtle)]'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-[var(--shadow-xs)] transition-transform duration-[120ms] ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
      {label && <span className="text-[13px] font-medium text-[var(--text-secondary)]">{label}</span>}
    </label>
  )
}
