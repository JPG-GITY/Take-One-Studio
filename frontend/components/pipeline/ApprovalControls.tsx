'use client'

import { CheckCircle, RefreshCw, MessageSquare, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface ApprovalControlsProps {
  onApprove: () => void
  onRegenerate: (feedback: string) => void
  canApprove: boolean
  isGenerating: boolean
  approveLabel?: string
  showFeedback?: boolean
  feedback?: string
  onFeedbackChange?: (v: string) => void
  /** P6: QC gate — if false, show warning on approve button (but still allow override) */
  qcPassed?: boolean | null
  /** P6: which persona ran the gate */
  qcPersona?: string
  className?: string
}

export function ApprovalControls({
  onApprove,
  onRegenerate,
  canApprove,
  isGenerating,
  approveLabel = 'Approve',
  showFeedback = true,
  feedback = '',
  onFeedbackChange,
  qcPassed,
  qcPersona,
  className,
}: ApprovalControlsProps) {
  const gateBlocked = qcPassed === false

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* P6: QC gate warning — visible when QC failed, but human can override */}
      {gateBlocked && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-orange/40 bg-orange/5 text-[11px]">
          <AlertTriangle size={13} className="text-orange shrink-0" />
          <span className="text-orange font-semibold">
            {qcPersona ?? 'QC'} flagged issues
          </span>
          <span className="text-text-muted ml-1">— you can override and approve anyway</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Button
          variant="approve"
          size="lg"
          className={cn('w-full', gateBlocked && 'border-orange/40 text-orange hover:border-orange/60')}
          icon={gateBlocked ? <AlertTriangle size={15} /> : <CheckCircle size={15} />}
          disabled={!canApprove || isGenerating}
          onClick={onApprove}
        >
          {gateBlocked ? `Override & ${approveLabel}` : approveLabel}
        </Button>

        <Button
          variant="regenerate"
          size="lg"
          className="w-full"
          icon={<RefreshCw size={15} />}
          loading={isGenerating}
          onClick={() => onRegenerate(feedback)}
          data-testid="regenerate-with-comments"
        >
          Regenerate with Comments
        </Button>
      </div>

      {showFeedback && (
        <div>
          <label className="block text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1.5">
            <MessageSquare size={10} className="inline mr-1" />
            Director Notes
          </label>
          <textarea
            value={feedback}
            onChange={(e) => onFeedbackChange?.(e.target.value)}
            placeholder="Describe changes for regeneration…"
            rows={4}
            className={cn(
              'w-full bg-elevated border border-border rounded px-3 py-2',
              'text-sm text-text-primary placeholder:text-text-dim',
              'focus:outline-none focus:border-cyan/50 focus:ring-1 focus:ring-cyan/20',
              'resize-none transition-colors'
            )}
          />
        </div>
      )}
    </div>
  )
}
