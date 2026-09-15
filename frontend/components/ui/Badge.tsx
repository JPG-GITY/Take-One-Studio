import { cn } from '@/lib/utils'
import type { StageStatus } from '@/lib/types/pipeline.types'

type Color = 'cyan' | 'orange' | 'green' | 'red' | 'amber' | 'muted'

interface BadgeProps {
  label: string
  color?: Color
  pulse?: boolean
  className?: string
}

const COLORS: Record<Color, string> = {
  cyan:   'bg-cyan/10   text-cyan   border-cyan/30',
  orange: 'bg-orange/10 text-orange border-orange/30',
  green:  'bg-green/10  text-green  border-green/30',
  red:    'bg-red/10    text-red    border-red/30',
  amber:  'bg-amber/10  text-amber  border-amber/30',
  muted:  'bg-border/60 text-text-muted border-border',
}

export function Badge({ label, color = 'muted', pulse, className }: BadgeProps) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-semibold border font-mono uppercase tracking-wider',
      COLORS[color],
      className
    )}>
      {pulse && (
        <span className={cn('w-1.5 h-1.5 rounded-full', {
          'bg-cyan  animate-pulse': color === 'cyan',
          'bg-orange animate-pulse': color === 'orange',
          'bg-green  animate-pulse': color === 'green',
          'bg-red    animate-pulse': color === 'red',
          'bg-amber  animate-pulse': color === 'amber',
          'bg-text-muted': color === 'muted',
        })} />
      )}
      {label}
    </span>
  )
}

export function StatusBadge({ status }: { status: StageStatus }) {
  const MAP: Record<StageStatus, { label: string; color: Color; pulse?: boolean }> = {
    idle:          { label: 'Idle',          color: 'muted' },
    generating:    { label: 'Generating',    color: 'amber', pulse: true },
    pending_review:{ label: 'Review',        color: 'orange', pulse: true },
    approved:      { label: 'Approved',      color: 'green' },
    invalidated:   { label: 'Stale',         color: 'red', pulse: true },
  }
  const { label, color, pulse } = MAP[status]
  return <Badge label={label} color={color} pulse={pulse} />
}
