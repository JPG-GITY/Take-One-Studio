'use client'

import { cn, previewSrc } from '@/lib/utils'
import { Loader2, CheckCircle, XCircle, Image, RefreshCw, CheckSquare, Square } from 'lucide-react'
import { RenderTimer } from './RenderTimer'
import type { GeneratedShot, Shot } from '@/lib/types/pipeline.types'
import { TIER_FIXED_RESOLUTION, videoCostPer5s, tierRank } from '@/lib/types/pipeline.types'
import { usePipelineStore } from '@/store/pipeline.store'

interface Props {
  shots: GeneratedShot[]
  activeShotId: string | null
  onSelectShot: (id: string) => void
  shotMeta?: Record<string, Shot>
  /** 3-bug1c: shotIds whose storyboard board advanced past the version the clip was rendered from. */
  staleBoardShots?: Set<string>
  /** Item 4C: "Chain Selected" multi-select — optional so the default single-select caller is unaffected. */
  selectable?: boolean
  selectedShotIds?: string[]
  onToggleSelect?: (id: string) => void
}

function ShotStatusOverlay({ status }: { status: GeneratedShot['status'] }) {
  if (status === 'generating' || status === 'animating') return (
    <div className="absolute inset-0 bg-bg/70 flex items-center justify-center">
      <Loader2 size={18} className="text-orange animate-spin" />
    </div>
  )
  if (status === 'keyframe_ready') return (
    <div className="absolute top-1 right-1">
      <Image size={11} className="text-cyan drop-shadow" />
    </div>
  )
  if (status === 'approved') return (
    <div className="absolute top-1 right-1">
      <CheckCircle size={12} className="text-green drop-shadow" />
    </div>
  )
  if (status === 'rejected') return (
    <div className="absolute top-1 right-1">
      <XCircle size={12} className="text-red drop-shadow" />
    </div>
  )
  return null
}

const STATUS_BORDER: Record<GeneratedShot['status'], string> = {
  queued:          'border-border',
  generating:      'border-orange animate-pulse',
  keyframe_ready:  'border-cyan/60',
  animating:       'border-orange animate-pulse',
  ready:           'border-border',
  approved:        'border-green/60',
  rejected:        'border-red/60',
}

export function ShotGenerationStrip({ shots, activeShotId, onSelectShot, shotMeta = {}, staleBoardShots = new Set(), selectable = false, selectedShotIds = [], onToggleSelect }: Props) {
  // The price a clip is labelled with depends on the model it was rendered on, and 2.5
  // costs 52 % more per token than 2.0. Settings' pick rides with every shot render.
  const videoModel = usePipelineStore((s) => s.videoModel)
  return (
    <aside className="w-[188px] shrink-0 flex flex-col bg-surface rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <p className="text-[10px] font-semibold tracking-widest text-text-muted uppercase">
          Generations
        </p>
        <p className="text-[9px] text-cyan mt-0.5 font-mono">By Bytedance Seedance 2.0</p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan animate-pulse" />
          <span className="text-[9px] text-text-muted">{shots.length} shots</span>
        </div>
      </div>

      {/* Shot list */}
      <div className="flex flex-col gap-1 p-1.5 overflow-y-auto flex-1">
        {shots.length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-[11px] text-text-muted p-4 text-center">
            No generations yet.<br />Click Generate to start.
          </div>
        ) : (
          shots.map((shot, i) => {
            const isSelected = selectedShotIds.includes(shot.shotId)
            return (
            // Item 4C: wrapper so the select checkbox is a SIBLING of the item button
            // (nested buttons are invalid HTML).
            <div key={shot.shotId} className="relative">
            <button
              onClick={() => onSelectShot(shot.shotId)}
              data-testid={`strip-shot-${shot.shotId}`}
              className={cn(
                'relative w-full rounded overflow-hidden border-2 transition-all duration-150',
                'focus:outline-none',
                shot.shotId === activeShotId
                  ? 'border-cyan shadow-[var(--shadow-neon-cyan)] scale-[1.02]'
                  : STATUS_BORDER[shot.status],
                selectable && isSelected && 'border-orange',
                'hover:border-cyan/50'
              )}
            >
              {/* Thumbnail */}
              <div className="aspect-video bg-elevated">
                {previewSrc(shot) ? (
                  // preload="none": with 60 shots the strip fired 60 video downloads on
                  // mount — the poster (thumbnail/last frame) paints instantly instead.
                  <video src={previewSrc(shot)} className="w-full h-full object-cover"
                    muted preload="none" poster={shot.thumbnailUrl || shot.lastFrameUrl || undefined} />
                ) : shot.thumbnailUrl ? (
                  <img src={shot.thumbnailUrl} alt={`Shot ${i + 1}`} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-text-dim gap-0.5 px-1">
                    <span className="text-[9px] font-mono font-bold">{shot.shotId}</span>
                    {shotMeta[shot.shotId]?.cameraAngle && (
                      <span className="text-[8px] text-text-dim text-center leading-tight line-clamp-1">
                        {shotMeta[shot.shotId].cameraAngle}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <ShotStatusOverlay status={shot.status} />

              {/* Live elapsed timer while this shot renders */}
              {shot.status === 'animating' && shot.renderStartedAt && (
                <span className="absolute bottom-1 right-1 px-1 py-0.5 rounded text-[8px] font-mono font-bold bg-orange/20 text-orange border border-orange/40">
                  <RenderTimer startedAt={shot.renderStartedAt} compact />
                </span>
              )}

              {/* Which rung of the cost ladder this clip sits on, and what it cost.
                  The user has to be able to tell a $0.35 preview from a $3.89 master
                  at a glance — otherwise a timeline of mixed tiers is unreadable and
                  they cannot tell which shots still need promoting. Amber for the
                  cheap rungs, green once mastered. Falls back to the bare resolution
                  for clips rendered before the ladder existed. */}
              {shot.videoUrl && (shot.tier || shot.renderedResolution) && (() => {
                const res = shot.renderedResolution
                  ?? TIER_FIXED_RESOLUTION[shot.tier ?? 'master'] ?? ''
                const rate = videoCostPer5s(videoModel, res)
                // What this take COST is priced off how long it actually is. A take
                // whose length was never measured (reopened project) shows its tier
                // with no price rather than the price of a five-second clip.
                const cost = rate && shot.duration ? rate * (shot.duration / 5) : 0
                const spend = cost ? ` · $${cost.toFixed(2)}` : ''
                const mastered = tierRank(shot.tier) >= tierRank('master')
                const tone = mastered
                  ? 'bg-green/20 text-green border-green/40'
                  : 'bg-amber/20 text-amber border-amber/40'
                return (
                  <span className={`absolute bottom-1 left-1 px-1 py-0.5 rounded text-[8px] font-mono font-bold border ${tone}`}
                    title={mastered
                      ? `Mastered at ${res}${spend && ` — about $${cost.toFixed(2)}`}`
                      : `${shot.tier} tier at ${res} — promote it to render at the project's output size`}>
                    {shot.tier ? `${shot.tier.toUpperCase()} · ` : ''}{res.toUpperCase()}{spend}
                  </span>
                )
              })()}

              {/* 3-bug1c: board changed since this clip was rendered — regenerate to sync */}
              {staleBoardShots.has(shot.shotId) && (
                <span className="absolute top-1 left-1 flex items-center gap-0.5 px-1 py-0.5 rounded text-[8px] font-mono font-bold bg-orange/20 text-orange border border-orange/40"
                  title="Storyboard changed since this clip was rendered — regenerate to sync">
                  <RefreshCw size={8} /> BOARD
                </span>
              )}

              {/* Active ring */}
              {shot.shotId === activeShotId && (
                <div className="absolute inset-0 ring-2 ring-inset ring-cyan/60 rounded pointer-events-none" />
              )}
            </button>
            {/* Item 4C: select checkbox — sibling of the item button. Sits above the
                content (z-10); in select mode it's what the user clicks to tick a shot. */}
            {selectable && (
              <button
                onClick={() => onToggleSelect?.(shot.shotId)}
                data-testid={`strip-select-${shot.shotId}`}
                aria-pressed={isSelected}
                className="absolute top-1 left-1 z-10 rounded bg-bg/70 p-0.5"
              >
                {isSelected ? <CheckSquare size={13} className="text-orange" /> : <Square size={13} className="text-text-muted" />}
              </button>
            )}
            </div>
          ) })
        )}
      </div>
    </aside>
  )
}
