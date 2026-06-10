import { Loader2, Users } from 'lucide-react'
import { useBorrowerSync } from '@/context/BorrowerSyncContext'

export function BorrowerSyncBar() {
  const { syncing, ready, borrowerCount, error } = useBorrowerSync()

  if (!syncing && !error) return null

  return (
    <div
      className="hidden lg:flex items-center gap-2 min-w-[200px] max-w-[320px] px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--bg-subtle)] border border-[var(--border-light)]"
      title={error || undefined}
    >
      {syncing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)] shrink-0" />
      ) : (
        <Users className="h-3.5 w-3.5 text-[var(--text-tertiary)] shrink-0" />
      )}
      <p className="text-[11px] text-[var(--text-primary)] truncate font-medium">
        {syncing
          ? `Loading borrowers from LoanDisk…${borrowerCount ? ` (${borrowerCount} cached)` : ''}`
          : error
            ? `Borrower sync issue — ${error}`
            : ready
              ? `${borrowerCount} borrowers ready`
              : null}
      </p>
    </div>
  )
}
