import { cn } from '@/lib/utils'

interface Props {
  label: string
  passed: boolean
}

export function QCResultBadge({ label, passed }: Props) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border font-mono',
      passed
        ? 'bg-green/10 text-green border-green/30'
        : 'bg-red/10   text-red   border-red/30'
    )}>
      {label}
      <span className="ml-1 opacity-70">({passed ? 'Pass' : 'Fail'})</span>
    </span>
  )
}
