import { Link } from 'react-router-dom'

export function PageHeader({ title, subtitle, actions, breadcrumb, children }) {
  if (breadcrumb) {
    return (
      <div className="mb-8 flex items-center justify-between gap-4">
        <nav className="text-[13px] text-[var(--text-tertiary)]" aria-label="Breadcrumb">
          {breadcrumb.map((item, i) => (
            <span key={item.label}>
              {i > 0 && <span className="mx-2">/</span>}
              {item.to ? (
                <Link to={item.to} className="hover:text-[var(--text-secondary)] transition-colors duration-100">
                  {item.label}
                </Link>
              ) : (
                <span className="text-[var(--text-primary)] font-medium">{item.label}</span>
              )}
            </span>
          ))}
        </nav>
        {actions}
      </div>
    )
  }

  return (
    <div className="mb-8 flex items-start justify-between gap-4">
      <div>
        {title && (
          <h1 className="text-2xl font-semibold text-[var(--text-primary)] tracking-[-0.025em] leading-[28px]">
            {title}
          </h1>
        )}
        {subtitle && (
          <div className="text-[15px] text-[var(--text-tertiary)] mt-1 leading-[24px]">{subtitle}</div>
        )}
        {children}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}
