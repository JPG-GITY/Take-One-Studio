import { cn } from '@/lib/utils'

interface CardProps {
  children: React.ReactNode
  className?: string
  glow?: 'cyan' | 'orange' | 'green' | 'none'
  selected?: boolean
}

const GLOW: Record<string, string> = {
  cyan:   'border-cyan/40 shadow-[var(--shadow-neon-cyan)]',
  orange: 'border-orange/40 shadow-[var(--shadow-neon-orange)]',
  green:  'border-green/40 shadow-[var(--shadow-neon-green)]',
  none:   'border-border',
}

export function Card({ children, className, glow = 'none', selected }: CardProps) {
  return (
    <div className={cn(
      'bg-surface rounded-lg border overflow-hidden',
      selected ? GLOW.cyan : GLOW[glow],
      className
    )}>
      {children}
    </div>
  )
}

export function CardHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('px-4 py-3 border-b border-border', className)}>
      {children}
    </div>
  )
}

export function CardBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('p-4', className)}>
      {children}
    </div>
  )
}
