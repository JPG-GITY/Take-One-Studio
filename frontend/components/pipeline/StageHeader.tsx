'use client'

import { AlertTriangle, CheckCircle, Unlock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePipelineStore } from '@/store/pipeline.store'
import { useToast } from '@/components/ui/Toast'
import { StatusBadge } from '@/components/ui/Badge'
import { VersionHistoryDrawer } from './VersionHistoryDrawer'
import type { StageId } from '@/lib/types/pipeline.types'

interface StageHeaderProps {
  stageId: StageId
  label: string
}

export function StageHeader({ stageId, label }: StageHeaderProps) {
  const { stages, projectName, acknowledgeUpstream, setStageStatus } = usePipelineStore()
  const { success } = useToast()
  const stage = stages[stageId]
  const isDirty = stage.isDirty

  // The user reviewed the upstream change and keeps this stage's output as-is.
  // Nothing is regenerated or deleted; the flag clears and the pre-invalidation
  // status is restored. (The old "Re-run" button was a placebo — it only
  // navigated. Regeneration happens through the stage's own controls.)
  const handleKeep = () => {
    acknowledgeUpstream(stageId)
    success('Kept current work', 'Stage marked as reviewed against the upstream change.')
  }

  // Uniform un-approve: reopen ANY approved stage for editing/regeneration without
  // deleting anything. Re-approving cascades staleness downstream (store handles it).
  const handleReopen = () => {
    setStageStatus(stageId, 'pending_review')
    success('Stage reopened', `Stage ${stageId} is editable again — change it and re-approve.`)
  }

  return (
    <div className="flex flex-col gap-0 border-b border-border bg-surface shrink-0">
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* Stage number circle */}
        <div className={cn(
          'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 shrink-0',
          'bg-cyan/10 text-cyan border-cyan/60 shadow-[var(--shadow-neon-cyan)]'
        )}>
          {stageId}
        </div>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
            Stage {stageId}
          </span>
          <span className="text-text-dim">·</span>
          <h1 className="text-sm font-semibold text-text-primary truncate">{label}</h1>
        </div>

        <div className="flex items-center gap-2 ml-auto shrink-0">
          {stage.status === 'approved' && (
            <button
              onClick={handleReopen}
              data-testid={`reopen-stage-${stageId}`}
              title="Reopen this stage to edit/regenerate (nothing is deleted)"
              className="flex items-center gap-1 px-2 py-0.5 rounded border border-border text-[11px] text-text-muted hover:text-cyan hover:border-cyan/50 transition-colors"
            >
              <Unlock size={11} /> Reopen
            </button>
          )}
          <StatusBadge status={stage.status} />
          <VersionHistoryDrawer stageId={stageId} />
          <span className="text-[10px] text-text-muted font-mono hidden lg:block">
            {projectName}
          </span>
        </div>
      </div>

      {isDirty && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-orange/5 border-t border-orange/20 text-orange text-xs"
          data-testid="stale-banner">
          <AlertTriangle size={12} className="shrink-0" />
          <span>
            Upstream changed after this stage&apos;s output was generated — nothing was deleted.
            Regenerate the items you want synced, or keep the current work.
          </span>
          <button
            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-orange/40 text-orange/90 hover:text-orange hover:bg-orange/10 transition-colors font-medium shrink-0"
            onClick={handleKeep}
            data-testid="keep-current-work"
          >
            <CheckCircle size={11} />
            Keep current work
          </button>
        </div>
      )}
    </div>
  )
}
