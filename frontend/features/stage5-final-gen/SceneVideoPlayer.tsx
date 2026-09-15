'use client'

import { useRef, useState, useCallback } from 'react'
import {
  Play, Pause, SkipBack, SkipForward,
  Rewind, FastForward, Maximize2, Volume2, VolumeX, X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatTimecode, previewSrc } from '@/lib/utils'
import { RenderTimer } from './RenderTimer'
import type { GeneratedShot, Shot } from '@/lib/types/pipeline.types'



interface SceneFilterChip {
  label: string
  active?: boolean
  onRemove?: () => void
}

function FilterChip({ label, active, onRemove }: SceneFilterChip) {
  return (
    <span className={cn(
      'flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border',
      active
        ? 'bg-cyan/10 text-cyan border-cyan/40'
        : 'bg-border/40 text-text-muted border-border'
    )}>
      {label}
      {onRemove && (
        <button onClick={onRemove} className="opacity-60 hover:opacity-100 transition-opacity">
          <X size={9} />
        </button>
      )}
    </span>
  )
}

interface Props {
  shot: GeneratedShot | null
  shotMeta?: Shot
}

export function SceneVideoPlayer({ shot, shotMeta }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)

  const toggle = useCallback(() => {
    if (!videoRef.current) return
    if (playing) {
      videoRef.current.pause()
    } else {
      videoRef.current.play()
    }
    setPlaying(!playing)
  }, [playing])

  const onTimeUpdate = () => {
    if (!videoRef.current) return
    const d = videoRef.current.duration || 1
    setCurrentTime(videoRef.current.currentTime)
    setProgress(videoRef.current.currentTime / d)
  }

  const onLoadedMetadata = () => {
    if (videoRef.current) setDuration(videoRef.current.duration)
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!videoRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    videoRef.current.currentTime = ratio * (videoRef.current.duration || 0)
  }

  const skipSeconds = (sec: number) => {
    if (!videoRef.current) return
    videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime + sec)
  }

  return (
    <div className="flex flex-col flex-1 bg-surface rounded-lg border border-border overflow-hidden min-h-0">
      {/* Video area */}
      <div className="relative flex-1 min-h-0 bg-black">
        {shot && previewSrc(shot) ? (
          <>
            {/* key forces a REMOUNT when the selected shot changes — HTML video
                elements do not reload on a bare src swap, which froze the panel
                on the previously selected clip */}
            <video
              key={`${shot.shotId}-${previewSrc(shot)}`}
              ref={videoRef}
              src={previewSrc(shot)}
              className="w-full h-full object-contain"
              muted={muted}
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMetadata}
              onEnded={() => setPlaying(false)}
              onClick={toggle}
            />
            {/* Final render — clean resolution indicator (no more draft tier) */}
            {shot.renderedResolution && (
              <span className="absolute top-2 right-2 px-2 py-0.5 rounded bg-surface/80 border border-border text-text-muted text-[9px] font-bold uppercase tracking-wider pointer-events-none">
                {shot.renderedResolution}
              </span>
            )}
            {/* Retake/HD in flight over an existing clip — live progress banner */}
            {shot.status === 'animating' && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1 rounded-full bg-bg/80 border border-orange/50 text-orange text-[10px] font-semibold pointer-events-none">
                <span className="w-3 h-3 border-2 border-orange border-t-transparent rounded-full animate-spin" />
                <RenderTimer startedAt={shot.renderStartedAt} resolution={shot.renderingResolution} />
              </div>
            )}
          </>
        ) : shot?.thumbnailUrl ? (
          /* Still preview (e.g. a board frame) shown while the clip renders */
          <div className="relative w-full h-full">
            <img src={shot.thumbnailUrl} alt="Shot preview" className="w-full h-full object-contain" />
            {shot.status === 'animating' && (
              <div className="absolute inset-0 bg-bg/60 flex items-center justify-center">
                <div className="flex flex-col items-center gap-2 text-orange">
                  <span className="w-8 h-8 border-2 border-orange border-t-transparent rounded-full animate-spin" />
                  <span className="text-[10px] font-semibold">Animating with Seedance…</span>
                  <span className="text-[10px] text-text-muted">
                    <RenderTimer startedAt={shot.renderStartedAt} resolution={shot.renderingResolution} />
                  </span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3 p-6 text-center">
            <div className="w-16 h-16 rounded-full bg-elevated border border-border flex items-center justify-center shrink-0">
              <Play size={24} className="text-text-dim ml-1" />
            </div>
            {shotMeta ? (
              <div className="flex flex-col gap-1 max-w-xs">
                <p className="text-[11px] font-semibold text-cyan font-mono">{shotMeta.id} · {shotMeta.cameraAngle}</p>
                <p className="text-[11px] text-text-muted leading-relaxed">{shotMeta.action}</p>
              </div>
            ) : (
              <p className="text-sm">Select a shot to preview</p>
            )}
          </div>
        )}

        {/* Center play overlay (shown when paused) */}
        {shot && previewSrc(shot) && !playing && (
          <button
            onClick={toggle}
            className="absolute inset-0 flex items-center justify-center bg-transparent group"
          >
            <div className="w-14 h-14 rounded-full bg-cyan/10 border border-cyan/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-[var(--shadow-neon-cyan)]">
              <Play size={22} className="text-cyan ml-1" />
            </div>
          </button>
        )}
      </div>

      {/* Seek bar */}
      <div
        role="slider"
        aria-valuenow={Math.round(progress * 100)}
        tabIndex={0}
        className="h-1 bg-border cursor-pointer hover:h-1.5 transition-all group relative"
        onClick={seek}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') skipSeconds(5)
          if (e.key === 'ArrowLeft')  skipSeconds(-5)
        }}
      >
        {/* Buffered / played track */}
        <div
          className="h-full bg-gradient-to-r from-cyan to-cyan/50 transition-[width] duration-100"
          style={{ width: `${progress * 100}%` }}
        />
        {/* Scrubber thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-cyan shadow-[var(--shadow-neon-cyan)] opacity-0 group-hover:opacity-100 transition-opacity -translate-x-1/2"
          style={{ left: `${progress * 100}%` }}
        />
      </div>

      {/* Transport bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-elevated border-t border-border shrink-0">
        {/* Controls — explicit buttons: an inline array of closures that read the
            video ref trips react-compiler's refs-during-render rule; plain JSX
            onClick handlers are the sanctioned form (refs read at event time). */}
        <div className="flex items-center gap-0.5">
          <button title="-10s" onClick={() => skipSeconds(-10)} className="p-1.5 rounded transition-all text-text-muted hover:text-text-primary hover:bg-border">
            <Rewind size={13} />
          </button>
          <button title="-5s" onClick={() => skipSeconds(-5)} className="p-1.5 rounded transition-all text-text-muted hover:text-text-primary hover:bg-border">
            <SkipBack size={13} />
          </button>
          <button title="Play/Pause" onClick={toggle} className="p-1.5 rounded transition-all bg-cyan/10 text-cyan hover:bg-cyan/20 hover:shadow-[var(--shadow-neon-cyan)]">
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <button title="+5s" onClick={() => skipSeconds(5)} className="p-1.5 rounded transition-all text-text-muted hover:text-text-primary hover:bg-border">
            <SkipForward size={13} />
          </button>
          <button title="+10s" onClick={() => skipSeconds(10)} className="p-1.5 rounded transition-all text-text-muted hover:text-text-primary hover:bg-border">
            <FastForward size={13} />
          </button>
        </div>

        {/* Timecode */}
        <span className="text-[10px] font-mono text-text-muted ml-1">
          {formatTimecode(currentTime)} / {formatTimecode(duration)}
        </span>

        {/* Shot chip. 4G: the two "SCENES:"/"SCENE:" chips were hardcoded demo
            leftovers ("S109:S28" / "0201:307") that never bound to breakdown data
            — removed so the bar shows only the real, live shot id. */}
        <div className="flex items-center gap-1 ml-3">
          <FilterChip label={`SHOT: ${shot?.shotId ?? '—'}`} active />
        </div>

        {/* Right controls */}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setMuted(!muted)}
            className="p-1.5 text-text-muted hover:text-text-primary rounded hover:bg-border transition-colors"
          >
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
          <button
            onClick={() => { const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null; if (v?.requestFullscreen) v.requestFullscreen().catch(() => {}); else v?.webkitEnterFullscreen?.() }}
            title="Fullscreen"
            className="p-1.5 text-text-muted hover:text-text-primary rounded hover:bg-border transition-colors"
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
