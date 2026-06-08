import { LineChart, Line, ResponsiveContainer } from 'recharts'
import { Card } from './Card'
import { cn } from '@/lib/utils'

export function KPICard({ label, value, trend, trendUp, sparkData = [] }) {
  const data = sparkData.length ? sparkData : [{ v: 1 }, { v: 2 }, { v: 1.5 }, { v: 3 }, { v: 2.5 }, { v: 4 }]

  return (
    <Card className={cn('kpi-card', 'h-[120px] p-5 flex flex-col justify-between relative overflow-hidden')}>
      <p className={cn('label', 'text-xs font-medium text-[var(--text-tertiary)] uppercase tracking-[0.06em]')}>
        {label}
      </p>
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className={cn('value', 'text-[28px] font-bold text-[var(--text-primary)] tracking-[-0.03em] leading-none')}>
            {value}
          </p>
          {trend != null && (
            <p className={cn('trend', 'text-xs mt-2 flex items-center gap-2')}>
              <span className={cn(trendUp ? 'text-[var(--success)]' : 'text-[var(--danger)]')}>
                {trendUp ? '↑' : '↓'} {trend}
              </span>
              <span className="text-[var(--text-tertiary)] ml-1">vs yesterday</span>
            </p>
          )}
        </div>
        <div className="w-[72px] h-9 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <Line type="monotone" dataKey="v" stroke="var(--accent)" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  )
}
