'use client'

import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'approve' | 'regenerate'
type Size    = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: React.ReactNode
}

const VARIANTS: Record<Variant, string> = {
  primary:    'bg-cyan/10 text-cyan border-cyan/40 hover:bg-cyan/20 hover:shadow-[var(--shadow-neon-cyan)]',
  secondary:  'bg-border/60 text-text-primary border-border hover:bg-elevated hover:border-text-dim',
  ghost:      'bg-transparent text-text-muted border-transparent hover:text-text-primary hover:bg-elevated',
  danger:     'bg-red/10 text-red border-red/40 hover:bg-red/20 hover:shadow-[var(--shadow-neon-red)]',
  approve:    'bg-green/10 text-green border-green/40 hover:bg-green/20 hover:shadow-[var(--shadow-neon-green)]',
  regenerate: 'bg-orange/10 text-orange border-orange/40 hover:bg-orange/20 hover:shadow-[var(--shadow-neon-orange)]',
}

const SIZES: Record<Size, string> = {
  sm: 'h-7  px-3 text-xs  gap-1.5',
  md: 'h-9  px-4 text-sm  gap-2',
  lg: 'h-11 px-5 text-sm  gap-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, icon, children, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-semibold rounded border',
        'transition-all duration-150 cursor-pointer select-none',
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none',
        'focus:outline-none focus:ring-1 focus:ring-cyan/40',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    >
      {loading ? (
        <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : icon}
      {children}
    </button>
  )
)
Button.displayName = 'Button'
