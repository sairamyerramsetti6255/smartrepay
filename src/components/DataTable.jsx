import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, ArrowUp, ArrowDown, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSortableTable } from '@/hooks/useSortableTable'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/EmptyState'

function SortIcon({ active, dir }) {
  if (!active) return <ChevronsUpDown className="h-3 w-3 opacity-40" />
  return dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
}

export function DataTable({
  data,
  columns,
  pageSize = 20,
  onRowClick,
  emptyMessage = 'No records found.',
  emptyDescription,
  emptyAction,
  rowClassName,
  sortable = false,
  filterable = false,
}) {
  const [filters, setFilters] = useState({})

  const isFilterable = (col) => filterable && col.filterable !== false && col.key !== 'actions'
  const isSortable = (col) => sortable && col.sortable !== false && col.key !== 'actions'

  const filtered = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v && v.trim())
    if (!active.length) return data
    return data.filter((row) =>
      active.every(([key, val]) => {
        const col = columns.find((c) => c.key === key)
        const raw = col?.filterAccessor ? col.filterAccessor(row) : row[key]
        return String(raw ?? '').toLowerCase().includes(val.trim().toLowerCase())
      })
    )
  }, [data, filters, columns])

  const { paginated, page, setPage, totalPages, total, sortKey, sortDir, toggleSort } = useSortableTable(
    filtered,
    pageSize
  )

  if (!data.length) {
    return (
      <div className="bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] shadow-[var(--shadow-xs)] overflow-hidden">
        <EmptyState title={emptyMessage} description={emptyDescription} action={emptyAction} />
      </div>
    )
  }

  function updateFilter(key, value) {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border-light)] rounded-[var(--radius-lg)] shadow-[var(--shadow-xs)] overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="bg-[#FAFAF8] border-b border-[var(--border-light)]">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'h-10 px-5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)] whitespace-nowrap',
                  col.align === 'right' && 'text-right'
                )}
              >
                {isSortable(col) ? (
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      'inline-flex items-center gap-1 uppercase tracking-[0.06em] hover:text-[var(--text-primary)] transition-colors',
                      col.align === 'right' && 'flex-row-reverse',
                      sortKey === col.key && 'text-[var(--text-primary)]'
                    )}
                  >
                    {col.label}
                    <SortIcon active={sortKey === col.key} dir={sortDir} />
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
          {filterable && (
            <tr className="bg-[#FAFAF8] border-b border-[var(--border-light)]">
              {columns.map((col) => (
                <th key={col.key} className="px-3 pb-2 pt-0 align-top">
                  {isFilterable(col) ? (
                    <input
                      value={filters[col.key] || ''}
                      onChange={(e) => updateFilter(col.key, e.target.value)}
                      placeholder="Filter…"
                      className={cn(
                        'w-full h-7 rounded-[var(--radius-sm)] border border-[var(--border-light)] bg-[var(--bg-card)] px-2 text-[12px] font-normal normal-case tracking-normal text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]',
                        col.align === 'right' && 'text-right'
                      )}
                    />
                  ) : null}
                </th>
              ))}
            </tr>
          )}
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
          {!paginated.length && (
            <tr>
              <td colSpan={columns.length} className="px-5 py-10 text-center text-[13px] text-[var(--text-tertiary)]">
                No rows match the current filters.
              </td>
            </tr>
          )}
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
