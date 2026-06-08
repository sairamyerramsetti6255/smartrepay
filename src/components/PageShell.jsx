export function PageShell({ children, actions }) {
  return (
    <div className="space-y-6">
      {actions && <div className="flex justify-end gap-2 -mt-2">{actions}</div>}
      {children}
    </div>
  )
}
