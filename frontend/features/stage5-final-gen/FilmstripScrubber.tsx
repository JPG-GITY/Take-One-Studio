'use client'

import { cn } from '@/lib/utils'
import { formatTimecode } from '@/lib/utils'
import type { GeneratedShot } from '@/lib/types/pipeline.types'

interface Props {
  shots: GeneratedShot[]
  activeShotId: string | null
  onSelectShot: (id: string) => void
}

export function FilmstripScrubber({ shots, activeShotId, onSelectShot }: Props) {
  if (shots.length === 0) return null

  return (
    <div className="h-[92px] bg-elevated rounded-lg border border-border flex items-stretch gap-1 px-2 py-1.5 overflow-x-auto shrink-0"
      style={{ scrollbarWidth: 'thin' }}
    >
      {shots.map((shot, i) => {
        const isActive = shot.shotId === activeShotId
        // A take whose length was never measured adds nothing to the running timecode —
        // the label is then a lower bound, which is the only honest thing it can be.
        const timecode = formatTimecode(
          shots.slice(0, i).reduce((acc, s) => acc + (s.duration ?? 0), 0)
        )

        return (
          <button
            key={shot.shotId}
            onClick={() => onSelectShot(shot.shotId)}
            className={cn(
              'relative shrink-0 h-full rounded overflow-hidden border-2 transition-all duration-150',
              'focus:outline-none',
              isActive
                ? 'border-cyan shadow-[var(--shadow-neon-cyan)] scale-[1.04]'
                : 'border-border hover:border-cyan/50'
            )}
            style={{ aspectRatio: '16/9' }}
          >
            {shot.thumbnailUrl ? (
              <img
                src={shot.thumbnailUrl}
                alt={timecode}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full bg-surface flex items-center justify-center">
                <span className="text-[8px] font-mono text-text-dim">
                  S{String(i + 1).padStart(3, '0')}
                </span>
              </div>
            )}

            {/* Timecode overlay */}
            <div className="absolute bottom-0 left-0 right-0 bg-bg/75 px-1 py-0.5">
              <span className="text-[8px] font-mono text-text-muted block text-center">
                {timecode}
              </span>
            </div>

            {/* Active highlight */}
            {isActive && (
              <div className="absolute inset-0 ring-2 ring-inset ring-cyan/70 pointer-events-none rounded" />
            )}
          </button>
        )
      })}
    </div>
  )
}
