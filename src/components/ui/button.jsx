import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-medium transition-all duration-[120ms] ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] active:duration-80',
  {
    variants: {
      variant: {
        default: 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] rounded-[var(--radius-md)] text-sm h-9 px-4',
        secondary: 'bg-[var(--bg-card)] border border-[var(--border-medium)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] hover:border-[var(--border-strong)] rounded-[var(--radius-md)] text-sm h-9 px-4',
        danger: 'bg-[var(--danger)] text-white hover:opacity-90 rounded-[var(--radius-md)] text-sm h-9 px-4',
        success: 'bg-[var(--success)] text-white hover:opacity-90 rounded-[var(--radius-md)] text-sm h-9 px-4',
        ghost: 'bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] rounded-[var(--radius-md)] text-sm h-9 px-3',
        link: 'bg-transparent text-[var(--accent)] hover:text-[var(--accent-hover)] h-auto px-0 text-[13px] font-medium',
      },
      size: {
        default: 'h-9',
        sm: 'h-8 text-xs px-3',
        lg: 'h-10 px-5 text-sm',
        icon: 'h-8 w-8 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export function Button({ className, variant, size, asChild = false, ...props }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />
}
