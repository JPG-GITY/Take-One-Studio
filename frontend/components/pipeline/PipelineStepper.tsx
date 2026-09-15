'use client'

import { cn } from '@/lib/utils'
import { usePipelineStore } from '@/store/pipeline.store'
import type { StageId, StageStatus } from '@/lib/types/pipeline.types'
import {
  FileText, Layers, Sparkles, Film, Clapperboard, Scissors,
  CheckCircle, AlertTriangle, Clock, Loader2, Zap
} from 'lucide-react'

const STAGES: Array<{ id: StageId; label: string; sublabel: string; Icon: React.ElementType }> = [
  { id: 1, label: 'Script',     sublabel: 'Generate / Load',  Icon: FileText    },
  { id: 2, label: 'Breakdown',  sublabel: 'Assets & Shots',   Icon: Layers      },
  { id: 3, label: 'AG',         sublabel: 'Asset Generation', Icon: Sparkles    },
  { id: 4, label: 'Storyboard', sublabel: 'Scene Boards',     Icon: Film        },
  { id: 5, label: 'SG',         sublabel: 'Shot Generation',  Icon: Clapperboard },
  { id: 6, label: 'Final Cut & Export', sublabel: 'Edit & Render', Icon: Scissors },
]

function StatusIcon({ status, isActive }: { status: StageStatus; isActive: boolean }) {
  if (isActive) return null
  if (status === 'approved')    return <CheckCircle  size={10} className="text-green" />
  if (status === 'generating')  return <Loader2      size={10} className="text-amber animate-spin" />
  if (status === 'pending_review') return <Clock     size={10} className="text-orange" />
  if (status === 'invalidated') return <AlertTriangle size={10} className="text-red" />
  return null
}

export function PipelineStepper({ studioMode, onStudioToggle }: {
  studioMode?: boolean
  onStudioToggle?: () => void
}) {
  const { activeStage, stages, goToStage } = usePipelineStore()

  return (
    <nav className="w-[88px] shrink-0 flex flex-col bg-surface border-r border-border py-3">
      {/* Brand mark */}
      <div className="px-2 mb-4 text-center">
        <div className="w-10 h-10 mx-auto rounded-full bg-cyan/10 border border-cyan/30 flex items-center justify-center shadow-[var(--shadow-neon-cyan)]">
          <span className="text-cyan font-bold text-sm font-mono">A</span>
        </div>
      </div>

      <div className="flex flex-col gap-1 px-2 flex-1">
        {STAGES.map(({ id, label, sublabel, Icon }) => {
          const stage = stages[id]
          const isActive = activeStage === id
          // 4D: a stage stays reachable once its upstream was EVER approved — not
          // only while the upstream is CURRENTLY 'approved'. Re-generating an
          // already-approved upstream commits a fresh (unapproved) version and
          // flips its status back to 'pending_review', which would otherwise
          // strand the user (e.g. blocked from Final Cut while re-rendering one
          // SG shot). The durable per-version `approved` flag survives that.
          // Downstream staleness is still surfaced as 'invalidated', never blocked.
          const prevStage = stages[(id - 1) as StageId]
          const prevEverApproved = prevStage?.status === 'approved' ||
            !!prevStage?.versions?.some((v) => v.approved)
          const isAccessible = id === 1 || prevEverApproved || stage.status !== 'idle'

          return (
            <button
              key={id}
              onClick={() => isAccessible && goToStage(id)}
              disabled={!isAccessible}
              className={cn(
                'relative flex flex-col items-center gap-1 py-2.5 px-1 rounded-lg',
                'transition-all duration-150 text-center',
                'disabled:opacity-30 disabled:cursor-not-allowed',
                isActive
                  ? 'bg-cyan/10 text-cyan border border-cyan/40 shadow-[var(--shadow-neon-cyan)]'
                  : 'text-text-muted hover:bg-elevated hover:text-text-primary border border-transparent'
              )}
            >
              {/* Number badge */}
              <div className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold border',
                isActive
                  ? 'bg-cyan/20 border-cyan/60 text-cyan'
                  : stage.status === 'approved'
                    ? 'bg-green/10 border-green/40 text-green'
                    : stage.status === 'invalidated'
                      ? 'bg-red/10 border-red/40 text-red'
                      : 'bg-border/60 border-border text-text-muted'
              )}>
                <StatusIcon status={stage.status} isActive={isActive} />
                {(isActive || stage.status === 'idle' || stage.status === 'generating') && (
                  <span className={isActive ? 'text-cyan' : ''}>{id}</span>
                )}
              </div>

              <Icon size={14} />
              <span className="text-[9px] font-semibold leading-tight tracking-wide">{label}</span>

              {/* Active indicator dot */}
              {isActive && (
                <span className="absolute right-1 top-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-cyan" />
              )}
            </button>
          )
        })}
      </div>

      {/* Studio tab — P11 */}
      <div className="px-2 py-2 border-t border-border mt-2">
        <button
          onClick={onStudioToggle}
          data-testid="studio-toggle"
          className={cn(
            'w-full flex flex-col items-center gap-1 py-2.5 px-1 rounded-lg',
            'transition-all duration-150 text-center border',
            studioMode
              ? 'bg-amber/10 text-amber border-amber/40 shadow-[var(--shadow-neon-orange)]'
              : 'text-text-muted hover:bg-elevated hover:text-amber border-transparent hover:border-amber/20',
          )}
        >
          <Zap size={14} />
          <span className="text-[9px] font-semibold tracking-wide">Studio</span>
        </button>
      </div>
    </nav>
  )
}
