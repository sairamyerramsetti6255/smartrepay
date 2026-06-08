import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSortableTable } from '@/hooks/useSortableTable'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/EmptyState'

export function DataTable({
  data,
  columns,
  pageSize = 20,
  onRowClick,
  emptyMessage = 'No records found.',
  emptyDescription,
  emptyAction,
  rowClassName,
}) {
  const { paginated, page, setPage, totalPages, total } = useSortableTable(data, pageSize)

  if (!data.length) {
    return (
      <div className="bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] shadow-[var(--shadow-xs)] overflow-hidden">
        <EmptyState title={emptyMessage} description={emptyDescription} action={emptyAction} />
      </div>
    )
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] shadow-[var(--shadow-xs)] overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="bg-[#FAFAF8] border-b border-[var(--border-light)]">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'h-10 px-5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]',
                  col.align === 'right' && 'text-right'
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paginated.map((row, i) => (
            <tr
              key={row.id || i}
              className={cn(
                'h-14 border-b border-[var(--border-light)] last:border-b-0 transition-colors duration-100',
                onRowClick && 'cursor-pointer hover:bg-[var(--bg-hover)]',
                rowClassName?.(row)
              )}
              onClick={() => onRowClick?.(row)}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    'px-5 text-[13px] text-[var(--text-primary)]',
                    col.align === 'right' && 'text-right mono font-medium'
                  )}
                >
                  {col.render ? col.render(row, i) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {total > pageSize && (
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--border-light)]">
          <span className="text-[13px] text-[var(--text-tertiary)]">
            Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total} results
          </span>
          <div className="flex gap-1">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-3.5 w-3.5" /> Previous
            </Button>
            <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
