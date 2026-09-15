'use client'

import { useState } from 'react'
import { History, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/utils'
import { usePipelineStore } from '@/store/pipeline.store'
import { useToast } from '@/components/ui/Toast'
import type { StageId } from '@/lib/types/pipeline.types'

const STAGE_LABELS: Record<StageId, string> = {
  1: 'Script', 2: 'Breakdown', 3: 'Assets',
  4: 'Scene Breakdown', 5: 'Final Gen', 6: 'Delivery',
}

interface Props {
  stageId: StageId
}

export function VersionHistoryDrawer({ stageId }: Props) {
  const [open, setOpen] = useState(false)
  const { stages, rollbackToVersion } = usePipelineStore()
  const { warning } = useToast()
  const stage = stages[stageId]

  const versions = [...stage.versions].reverse() // newest first

  const handleRollback = (versionId: string, index: number) => {
    const isActive = stage.activeVersionId === versionId
    if (isActive) return
    rollbackToVersion(stageId, versionId)
    warning(
      `Rolled back to v${versions.length - index}`,
      'Downstream stages have been marked stale — review and re-approve.'
    )
    setOpen(false)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-text-muted hover:text-cyan rounded hover:bg-cyan/5 transition-all border border-transparent hover:border-cyan/20"
        title="Version history"
      >
        <History size={12} />
        <span className="hidden sm:block">History</span>
        {versions.length > 0 && (
          <span className="px-1 py-0.5 rounded bg-border text-[9px] font-mono">{versions.length}</span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex">
          {/* Backdrop */}
          <div className="flex-1 bg-bg/60 backdrop-blur-sm" onClick={() => setOpen(false)} />

          {/* Drawer */}
          <div className="w-80 bg-surface border-l border-border flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <History size={14} className="text-cyan" />
                <h2 className="text-sm font-semibold text-text-primary">
                  Stage {stageId} — {STAGE_LABELS[stageId]} History
                </h2>
              </div>
              <button onClick={() => setOpen(false)} className="text-text-muted hover:text-text-primary transition-colors">
                <X size={16} />
              </button>
            </div>

            {versions.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
                No versions yet
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
                {versions.map((v, i) => {
                  const isActive = v.id === stage.activeVersionId
                  const vNum = versions.length - i
                  return (
                    <div
                      key={v.id}
                      className={cn(
                        'rounded-lg border p-3 flex flex-col gap-1.5 transition-all',
                        isActive
                          ? 'border-cyan/50 bg-cyan/5 shadow-[var(--shadow-neon-cyan)]'
                          : 'border-border bg-elevated hover:border-border/80'
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            'text-[10px] font-bold font-mono',
                            isActive ? 'text-cyan' : 'text-text-muted'
                          )}>
                            v{vNum}
                          </span>
                          {isActive && (
                            <span className="text-[9px] font-semibold text-cyan bg-cyan/10 px-1.5 py-0.5 rounded border border-cyan/30">
                              ACTIVE
                            </span>
                          )}
                          {v.approvalNotes && (
                            <span className="text-[9px] font-semibold text-green bg-green/10 px-1.5 py-0.5 rounded border border-green/30">
                              APPROVED
                            </span>
                          )}
                        </div>
                        <span className="text-[9px] text-text-dim font-mono">
                          {formatRelativeTime(v.createdAt)}
                        </span>
                      </div>

                      {v.qcResult && (
                        <div className="flex items-center gap-1.5 text-[10px]">
                          <span className={cn(
                            'w-1.5 h-1.5 rounded-full',
                            v.qcResult.checks.every((c) => c.passed) ? 'bg-green' : 'bg-orange'
                          )} />
                          <span className="text-text-muted truncate">{v.qcResult.summary}</span>
                        </div>
                      )}

                      {v.approvalNotes && (
                        <p className="text-[10px] text-text-muted italic truncate">
                          &ldquo;{v.approvalNotes}&rdquo;
                        </p>
                      )}

                      {!isActive && (
                        <button
                          onClick={() => handleRollback(v.id, i)}
                          className="flex items-center gap-1.5 text-[10px] text-orange hover:text-orange font-semibold mt-1 self-start"
                        >
                          <RotateCcw size={11} />
                          Restore this version
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
