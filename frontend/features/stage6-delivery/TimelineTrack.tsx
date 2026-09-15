'use client'

/**
 * DaVinci-style multi-track editing timeline for Stage 6. Fixed pixels-per-second
 * scale (zoomable) + horizontal scroll, V1 (video) and A1 (audio) tracks, both
 * editable via TOOLS (mutually exclusive): Select/Move, Trim (drag a clip's half
 * to trim its start/end), Razor (click to split). Delete is keyboard-driven
 * (handled by the parent). Per-clip volume + fade in/out handles show on the
 * selected clip. Presentational — the parent owns the data + callbacks.
 */

import { useRef, useState, useCallback } from 'react'
import { Scissors, MousePointer2, MoveHorizontal, Hand, ZoomIn, ZoomOut, ChevronsUpDown, ChevronsDownUp, Blend, Music, Mic, Plus, Undo2, Redo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GeneratedShot } from '@/lib/types/pipeline.types'

export type TimelineTool = 'select' | 'move' | 'trim' | 'razor'

interface ClipSettings { inPoint: number; outPoint: number | null; transitionIn: { type: string; dur: number } | null; volume: number; fadeIn: number; fadeOut: number }

export interface AudioClip {
  id: string
  path: string
  name: string
  srcDuration: number     // full source duration (s)
  timelineStart: number   // where it sits on the timeline (s)
  inPoint: number
  outPoint: number
  volume: number
  fadeIn: number          // seconds
  fadeOut: number         // seconds
  // Does this clip sidechain-duck under the programme audio (where the dialogue lives)
  // on export? A music bed should; an imported voice-over or a spot effect must NOT —
  // the VO would dip under the very dialogue it is competing with, and a door slam
  // would land at half level. The server has carried this flag since the ducking mix
  // landed, but the export payload never sent it, so EVERY clip force-ducked at the
  // server default (server.py AudioClipSpec.duck) and that escape hatch was unreachable.
  // Set explicitly at both creation sites (DeliveryView); `undefined` only means a clip
  // persisted BEFORE this field existed → the export resolves it to true, the behaviour
  // that project was last mixed with.
  duck?: boolean
}

// 5C: a V2 overlay clip — a re-take (or any clip) mounted ON TOP of V1 as a positioned
// clip (like AudioClip) but carrying video. z-order: V2 > V1 in the player and export.
export interface OverlayClip {
  id: string
  sourceShotId: string    // the V1 shot it overlays (for positioning + provenance)
  shot: GeneratedShot     // the take's media (videoLocalPath/videoUrl/thumbnailUrl)
  timelineStart: number
  inPoint: number
  outPoint: number
  volume: number
  fadeIn: number
  fadeOut: number
}

interface TimelineTrackProps {
  sequence: GeneratedShot[]
  durations: number[]
  totalRuntime: number
  previewId: string | null
  playhead: number
  tool: TimelineTool
  onToolChange: (tool: TimelineTool) => void
  // Timeline undo/redo — state lives in the parent, surfaced here in the tool palette
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
  getSettings: (shotId: string) => ClipSettings
  sourceDuration: (shot: GeneratedShot) => number
  onSelectClip: (shotId: string) => void
  onSeek: (globalSeconds: number) => void
  onReorder: (from: number, to: number) => void
  onRazorAt: (shotId: string, localSeconds: number) => void
  onTrim: (shotId: string, patch: { inPoint?: number; outPoint?: number }) => void
  onToggleTransition: (shotId: string) => void
  onClipVolume: (shotId: string, volume: number) => void
  onClipFade: (shotId: string, patch: { fadeIn?: number; fadeOut?: number }) => void
  // Fired ONCE at the start of a drag gesture (trim/fade/volume/audio) so the parent can
  // checkpoint undo history — a whole drag becomes one undo step, not one-per-pointermove.
  onBeforeGesture?: () => void
  // Audio track
  audioClips: AudioClip[]
  selectedAudioId: string | null
  onAddAudio: () => void
  onSelectAudio: (id: string) => void
  onAudioPatch: (id: string, patch: Partial<AudioClip>) => void
  onAudioRazorAt: (id: string, localSeconds: number) => void
  audioPeaks: Record<string, number[]>   // normalized waveform peaks by clip id
  // 5C: V2 overlay track (mirrors the audio track's gesture model)
  overlayClips: OverlayClip[]
  selectedOverlayId: string | null
  onSelectOverlay: (id: string) => void
  onOverlayPatch: (id: string, patch: Partial<OverlayClip>) => void
  onOverlayRazorAt?: (id: string, localSeconds: number) => void
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const halfEdge = (e: React.PointerEvent): 'l' | 'r' => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return (e.clientX - r.left) < r.width / 2 ? 'l' : 'r'
}

const HEADER_W = 44
const V_H = 72
const A_H = 60

export function TimelineTrack({
  sequence, durations, totalRuntime, previewId, playhead, tool, onToolChange,
  onUndo, onRedo, canUndo, canRedo,
  getSettings, sourceDuration, onSelectClip, onSeek, onReorder, onRazorAt,
  onTrim, onToggleTransition, onClipVolume, onClipFade, onBeforeGesture,
  audioClips, selectedAudioId, onAddAudio, onSelectAudio, onAudioPatch, onAudioRazorAt, audioPeaks,
  overlayClips, selectedOverlayId, onSelectOverlay, onOverlayPatch, onOverlayRazorAt,
}: TimelineTrackProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [pps, setPps] = useState(50)
  // 5J: vertical zoom — scales the track row heights (parallel to the horizontal
  // `pps` time-zoom). The clip's interior scales with the row because its content
  // is relative-positioned and the drag math reads getBoundingClientRect, not the
  // raw constants — so no handle-position recompute is needed.
  const [vZoom, setVZoom] = useState(1)
  const vH = Math.round(V_H * vZoom)
  const aH = Math.round(A_H * vZoom)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const trimRef = useRef<{ shotId: string; edge: 'l' | 'r'; startX: number; inPoint: number; outPoint: number; srcDur: number } | null>(null)
  const volRef = useRef<DOMRect | null>(null)
  const gestureSnappedRef = useRef(false)   // has THIS drag already pushed one undo checkpoint?
  const vfadeRef = useRef<{ shotId: string; side: 'in' | 'out'; startX: number; v0: number; dur: number } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [fadeDragging, setFadeDragging] = useState<string | null>(null)  // `${id}:${side}` being dragged
  // 5E: during a LEFT-edge (head) trim, pin the clip's RIGHT edge and let its LEFT edge
  // track the pointer so the head visibly moves (today `left=offsets[i]*pps` is pinned and
  // only `width` shrinks → a head-trim looked identical to a tail-trim). Mirrors the audio
  // track's timelineStart head-trim. Video clips are packed via `offsets` (no per-clip
  // start), so we freeze the pre-drag geometry for the gesture and repack on pointer-up.
  const [headTrimViz, setHeadTrimViz] = useState<{ index: number; rightSec: number; frozenOffsets: number[] } | null>(null)
  const aGesture = useRef<
    | { kind: 'move'; id: string; startX: number; start0: number }
    | { kind: 'trim'; id: string; edge: 'l' | 'r'; startX: number; inPoint: number; outPoint: number; start0: number; srcDur: number }
    | { kind: 'fade'; id: string; side: 'in' | 'out'; startX: number; v0: number; dur: number }
    | { kind: 'vol'; id: string; rect: DOMRect }
    | null
  >(null)
  // 5C: V2 overlay gesture — identical shape to aGesture, drives onOverlayPatch.
  const oGesture = useRef<
    | { kind: 'move'; id: string; startX: number; start0: number }
    | { kind: 'trim'; id: string; edge: 'l' | 'r'; startX: number; inPoint: number; outPoint: number; start0: number; srcDur: number }
    | { kind: 'fade'; id: string; side: 'in' | 'out'; startX: number; v0: number; dur: number }
    | { kind: 'vol'; id: string; rect: DOMRect }
    | null
  >(null)

  const offsets: number[] = []
  durations.reduce((acc, d, i) => { offsets[i] = acc; return acc + d }, 0)
  const trackWidth = Math.max(200, totalRuntime * pps)
  const cursorClass = tool === 'razor' ? 'cursor-crosshair' : tool === 'trim' ? 'cursor-ew-resize' : tool === 'move' ? 'cursor-grab' : 'cursor-pointer'

  const xToSeconds = useCallback((clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return clamp((clientX - rect.left + el.scrollLeft) / pps, 0, totalRuntime)
  }, [totalRuntime, pps])
  const deltaSeconds = (clientX: number, startX: number) => (clientX - startX) / pps

  const onScrubDown = (e: React.PointerEvent) => {
    if (trimRef.current || aGesture.current || oGesture.current || vfadeRef.current) return
    setScrubbing(true); onSeek(xToSeconds(e.clientX))
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    if (scrubbing) onSeek(xToSeconds(e.clientX))
    const t = trimRef.current
    // Checkpoint undo ONCE per drag, on the first move that actually mutates (a bare click
    // that never moves mutates nothing, so it records no dead step).
    if ((t || vfadeRef.current || aGesture.current || oGesture.current) && !gestureSnappedRef.current) {
      onBeforeGesture?.(); gestureSnappedRef.current = true
    }
    if (t) {
      const d = deltaSeconds(e.clientX, t.startX)
      if (t.edge === 'l') onTrim(t.shotId, { inPoint: clamp(t.inPoint + d, 0, t.outPoint - 0.2) })
      else onTrim(t.shotId, { outPoint: clamp(t.outPoint + d, t.inPoint + 0.2, t.srcDur) })
    }
    const vf = vfadeRef.current
    if (vf) {
      const amt = clamp((vf.side === 'in' ? deltaSeconds(e.clientX, vf.startX) : -deltaSeconds(e.clientX, vf.startX)) + vf.v0, 0, vf.dur)
      onClipFade(vf.shotId, vf.side === 'in' ? { fadeIn: amt } : { fadeOut: amt })
    }
    const g = aGesture.current
    if (g) {
      if (g.kind === 'move') onAudioPatch(g.id, { timelineStart: Math.max(0, g.start0 + deltaSeconds(e.clientX, g.startX)) })
      else if (g.kind === 'trim') {
        const d = deltaSeconds(e.clientX, g.startX)
        if (g.edge === 'l') {
          const inPoint = clamp(g.inPoint + d, 0, g.outPoint - 0.2)
          onAudioPatch(g.id, { inPoint, timelineStart: Math.max(0, g.start0 + (inPoint - g.inPoint)) })
        } else onAudioPatch(g.id, { outPoint: clamp(g.outPoint + d, g.inPoint + 0.2, g.srcDur) })
      } else if (g.kind === 'fade') {
        const amt = clamp((g.side === 'in' ? deltaSeconds(e.clientX, g.startX) : -deltaSeconds(e.clientX, g.startX)) + g.v0, 0, g.dur)
        onAudioPatch(g.id, g.side === 'in' ? { fadeIn: amt } : { fadeOut: amt })
      } else if (g.kind === 'vol') {
        onAudioPatch(g.id, { volume: clamp(1 - (e.clientY - g.rect.top) / g.rect.height, 0, 1) })
      }
    }
    // 5C: V2 overlay gestures — identical math to the audio track, via onOverlayPatch.
    const og = oGesture.current
    if (og) {
      if (og.kind === 'move') onOverlayPatch(og.id, { timelineStart: Math.max(0, og.start0 + deltaSeconds(e.clientX, og.startX)) })
      else if (og.kind === 'trim') {
        const d = deltaSeconds(e.clientX, og.startX)
        if (og.edge === 'l') {
          const inPoint = clamp(og.inPoint + d, 0, og.outPoint - 0.2)
          onOverlayPatch(og.id, { inPoint, timelineStart: Math.max(0, og.start0 + (inPoint - og.inPoint)) })
        } else onOverlayPatch(og.id, { outPoint: clamp(og.outPoint + d, og.inPoint + 0.2, og.srcDur) })
      } else if (og.kind === 'fade') {
        const amt = clamp((og.side === 'in' ? deltaSeconds(e.clientX, og.startX) : -deltaSeconds(e.clientX, og.startX)) + og.v0, 0, og.dur)
        onOverlayPatch(og.id, og.side === 'in' ? { fadeIn: amt } : { fadeOut: amt })
      } else if (og.kind === 'vol') {
        onOverlayPatch(og.id, { volume: clamp(1 - (e.clientY - og.rect.top) / og.rect.height, 0, 1) })
      }
    }
  }
  const onUp = () => { gestureSnappedRef.current = false; setScrubbing(false); trimRef.current = null; aGesture.current = null; oGesture.current = null; vfadeRef.current = null; setFadeDragging(null); setHeadTrimViz(null) }

  // White at rest, cyan/amber while dragging (so you know you're moving the fade,
  // not the clip) + a wide invisible hit area so it's easy to grab.
  const fadeHandle = (key: string, accent: string, side: 'in' | 'out', pct: number, onDown: (e: React.PointerEvent) => void, title: string, testid: string) => (
    <div
      onPointerDown={(e) => { e.stopPropagation(); setFadeDragging(key); onDown(e); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }}
      title={title}
      data-testid={testid}
      className="absolute top-0 z-30 flex items-start justify-center cursor-ew-resize"
      style={{ [side === 'in' ? 'left' : 'right']: `calc(${pct}% - 11px)`, width: 22, height: 22 }}
    >
      <div className={cn('mt-1 w-3.5 h-3.5 rounded-full border-2 shadow transition-colors',
        fadeDragging === key ? `${accent} border-white` : `bg-white ${accent.replace('bg-', 'border-')}`)} />
    </div>
  )

  const playheadX = playhead * pps
  const step = pps < 25 ? 10 : pps < 60 ? 5 : 2
  const ticks: number[] = []
  for (let t = 0; t <= totalRuntime + 0.01; t += step) ticks.push(t)

  const toolBtn = (t: TimelineTool, icon: React.ReactNode, title: string, testid?: string) => (
    <button onClick={() => onToolChange(t)} data-testid={testid} title={title}
      className={cn('p-1 rounded border', tool === t ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>{icon}</button>
  )

  return (
    <div className="select-none flex flex-col gap-1" data-testid="timeline-track">
      {/* Toolbar */}
      <div className="flex items-center gap-1">
        {toolBtn('select', <MousePointer2 size={12} />, 'Select — click a clip (edit its fades/volume), no move')}
        {toolBtn('move', <Hand size={12} />, 'Move — drag a clip to reorder/reposition')}
        {toolBtn('trim', <MoveHorizontal size={12} />, 'Trim — drag a clip’s left/right half to trim its start/end')}
        {toolBtn('razor', <Scissors size={12} />, 'Razor — click a clip to split it', 'razor-toggle')}
        <div className="w-px h-4 bg-border mx-1" />
        <button onClick={() => setPps((p) => Math.max(15, p - 15))} className="p-1 rounded border border-border text-text-muted hover:text-text-primary" title="Zoom out"><ZoomOut size={12} /></button>
        <button onClick={() => setPps((p) => Math.min(160, p + 15))} className="p-1 rounded border border-border text-text-muted hover:text-text-primary" title="Zoom in"><ZoomIn size={12} /></button>
        {/* 5J: vertical zoom — shorter / taller track rows (parallel to the time-zoom pair) */}
        <button onClick={() => setVZoom((z) => Math.max(0.6, +(z - 0.2).toFixed(2)))} className="p-1 rounded border border-border text-text-muted hover:text-text-primary" title="Shorter rows"><ChevronsDownUp size={12} /></button>
        <button onClick={() => setVZoom((z) => Math.min(2, +(z + 0.2).toFixed(2)))} className="p-1 rounded border border-border text-text-muted hover:text-text-primary" title="Taller rows"><ChevronsUpDown size={12} /></button>
        {onUndo && (<>
          <div className="w-px h-4 bg-border mx-1" />
          <button onClick={onUndo} disabled={!canUndo} title="Undo (⌘/Ctrl+Z)" data-testid="tl-undo"
            className="p-1 rounded border border-border text-text-muted hover:text-text-primary disabled:opacity-35 disabled:hover:text-text-muted"><Undo2 size={12} /></button>
          <button onClick={onRedo} disabled={!canRedo} title="Redo (⌘/Ctrl+Shift+Z)" data-testid="tl-redo"
            className="p-1 rounded border border-border text-text-muted hover:text-text-primary disabled:opacity-35 disabled:hover:text-text-muted"><Redo2 size={12} /></button>
        </>)}
        <button onClick={onAddAudio} className="ml-1 flex items-center gap-1 px-1.5 py-1 rounded border border-border text-[9px] text-text-muted hover:text-cyan hover:border-cyan/40" title="Add an audio clip"><Plus size={10} /><Music size={10} /></button>
        <span className="ml-2 text-[8px] text-text-dim hidden sm:inline">Del = remove selected</span>
        <span className="ml-auto text-[9px] text-text-dim font-mono">{fmt(playhead)} / {fmt(totalRuntime)}</span>
      </div>

      <div className="flex">
        {/* Track headers */}
        <div className="shrink-0 flex flex-col" style={{ width: HEADER_W }}>
          <div className="h-4" />
          {/* 5C: V2 overlay header — rendered ABOVE V1 so z-order reads top = V2 */}
          {overlayClips.length > 0 && (
            <div className="flex items-center justify-center text-[9px] font-mono text-violet-400 border border-border rounded-l bg-elevated/60" style={{ height: vH }}>V2</div>
          )}
          <div className="flex items-center justify-center text-[9px] font-mono text-cyan border border-border rounded-l bg-elevated/60" style={{ height: vH }}>V1</div>
          <div className="flex items-center justify-center text-[9px] font-mono text-amber border border-t-0 border-border rounded-l bg-elevated/60" style={{ height: aH }}>A1</div>
        </div>

        {/* Scrollable tracks */}
        <div ref={trackRef} className="relative overflow-x-auto overflow-y-hidden bg-bg/40 rounded-r border border-l-0 border-border flex-1" onPointerMove={onMove} onPointerUp={onUp}>
          <div style={{ width: trackWidth }}>
            {/* Ruler */}
            <div className="relative h-4 text-[8px] text-text-dim font-mono border-b border-border cursor-pointer" onPointerDown={onScrubDown}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0" style={{ left: t * pps }}>
                  <span className="absolute left-0 top-2.5 w-px h-1 bg-border" />
                  <span className="pl-0.5">{fmt(t)}</span>
                </span>
              ))}
            </div>

            {/* 5C: V2 overlay track — re-takes mounted ON TOP of V1 (positioned like an
                audio clip but carrying video). Rendered ABOVE V1 so z-order reads top = V2.
                Same move/trim/fade/vol gesture model as the audio row, via oGesture. */}
            {overlayClips.length > 0 && (
              <div className={cn('relative border-b border-border', cursorClass)} style={{ height: vH }} onPointerDown={onScrubDown}>
                {/* eslint-disable-next-line react-hooks/refs */}
                {overlayClips.map((o) => {
                  const dur = Math.max(0.1, o.outPoint - o.inPoint)
                  const left = o.timelineStart * pps
                  const width = dur * pps
                  const isSel = o.id === selectedOverlayId
                  const srcDur = o.shot.duration || o.outPoint
                  const fadeInPct = clamp(o.fadeIn / dur, 0, 1) * 100
                  const fadeOutPct = clamp(o.fadeOut / dur, 0, 1) * 100
                  return (
                    <div
                      key={o.id}
                      onPointerDown={(e) => {
                        if (oGesture.current) return
                        e.stopPropagation()
                        if (tool === 'razor') { onOverlayRazorAt?.(o.id, clamp(xToSeconds(e.clientX) - o.timelineStart, 0.1, dur - 0.1)); return }
                        onSelectOverlay(o.id)
                        if (tool === 'trim') oGesture.current = { kind: 'trim', id: o.id, edge: halfEdge(e), startX: e.clientX, inPoint: o.inPoint, outPoint: o.outPoint, start0: o.timelineStart, srcDur }
                        else if (tool === 'move') oGesture.current = { kind: 'move', id: o.id, startX: e.clientX, start0: o.timelineStart }
                        if (oGesture.current) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                      }}
                      className={cn('group absolute top-1 bottom-1 rounded overflow-hidden border', isSel ? 'border-violet-400 ring-1 ring-violet-400' : 'border-violet-400/40', tool === 'razor' ? 'cursor-crosshair' : tool === 'trim' ? 'cursor-ew-resize' : tool === 'move' ? 'cursor-grab' : 'cursor-pointer')}
                      style={{ left, width, backgroundImage: o.shot.thumbnailUrl ? `url(${o.shot.thumbnailUrl})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center', backgroundColor: 'rgba(139,92,246,0.15)' }}
                      title={`V2 · ${o.sourceShotId} · ${dur.toFixed(1)}s`}
                      data-testid={`overlay-clip-${o.id}`}
                    >
                      {o.fadeIn > 0 && <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-bg/70 to-transparent pointer-events-none" style={{ width: `${fadeInPct}%` }} />}
                      {o.fadeOut > 0 && <div className="absolute inset-y-0 right-0 bg-gradient-to-l from-bg/70 to-transparent pointer-events-none" style={{ width: `${fadeOutPct}%` }} />}
                      <span className="absolute top-0.5 left-1.5 text-[9px] font-mono text-violet-200 truncate max-w-[90%] pointer-events-none bg-bg/50 px-0.5 rounded">V2 {o.sourceShotId}</span>
                      <span className="absolute bottom-0.5 left-1.5 text-[8px] font-mono text-violet-200/80 pointer-events-none bg-bg/50 px-0.5 rounded">{dur.toFixed(1)}s · {Math.round(o.volume * 100)}%</span>
                      {isSel && (
                        <>
                          {fadeHandle(`${o.id}:in`, 'bg-violet-400', 'in', fadeInPct, (e) => { oGesture.current = { kind: 'fade', id: o.id, side: 'in', startX: e.clientX, v0: o.fadeIn, dur } }, `Fade in ${o.fadeIn.toFixed(1)}s — drag right`, `ofade-in-${o.id}`)}
                          {fadeHandle(`${o.id}:out`, 'bg-violet-400', 'out', fadeOutPct, (e) => { oGesture.current = { kind: 'fade', id: o.id, side: 'out', startX: e.clientX, v0: o.fadeOut, dur } }, `Fade out ${o.fadeOut.toFixed(1)}s — drag left`, `ofade-out-${o.id}`)}
                          <div
                            onPointerDown={(e) => { e.stopPropagation(); oGesture.current = { kind: 'vol', id: o.id, rect: (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect() }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }}
                            title={`Volume ${Math.round(o.volume * 100)}% — drag up/down`}
                            data-testid={`overlay-volume-${o.id}`}
                            className="absolute left-0 right-0 h-4 -translate-y-1/2 z-20 cursor-ns-resize flex items-center"
                            style={{ top: `${(1 - o.volume) * 100}%` }}
                          ><div className="w-full h-[2px] bg-violet-400/90" /></div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Video track */}
            <div className={cn('relative', cursorClass)} style={{ height: vH }} onPointerDown={onScrubDown}>
              {/* The gesture refs (trimRef/aGesture/vfadeRef) are read ONLY inside
                  pointer-event handlers — never during render. react-compiler still
                  taints the whole render-time map over the closures it creates, so
                  this is a documented false positive, not a suppressed bug. */}
              {/* eslint-disable-next-line react-hooks/refs */}
              {sequence.map((shot, i) => {
                const dur = durations[i] ?? 0
                let left = (offsets[i] ?? 0) * pps
                const width = dur * pps
                // 5E: during a head-trim, pin THIS clip's right edge (left follows the
                // shrink) and hold the following clips at their frozen offsets (no ripple
                // mid-drag). Stored in SECONDS so it scales if pps zooms mid-gesture.
                const hv = headTrimViz
                if (hv) {
                  if (i === hv.index) left = hv.rightSec * pps - width           // pin right edge
                  else if (i > hv.index) left = (hv.frozenOffsets[i] ?? offsets[i] ?? 0) * pps
                }
                const isActive = shot.shotId === previewId
                const st = getSettings(shot.shotId)
                const fiPct = clamp((st.fadeIn ?? 0) / Math.max(0.1, dur), 0, 1) * 100
                const foPct = clamp((st.fadeOut ?? 0) / Math.max(0.1, dur), 0, 1) * 100
                return (
                  <div key={shot.shotId}>
                    {i > 0 && (
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onToggleTransition(shot.shotId) }}
                        title={st.transitionIn ? 'Crossfade transition ON — click to remove' : 'Add crossfade transition between these clips'}
                        className={cn('absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 w-5 h-5 rounded-full border flex items-center justify-center transition-colors',
                          st.transitionIn ? 'bg-cyan/40 border-cyan text-cyan' : 'bg-elevated/90 border-border text-text-muted opacity-70 hover:opacity-100 hover:text-cyan hover:border-cyan/50')}
                        style={{ left }}
                      ><Blend size={11} /></button>
                    )}
                    <div
                      draggable={tool === 'move'}
                      onDragStart={() => setDragIndex(i)}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(i) }}
                      onDragEnd={() => { setDragIndex(null); setDragOver(null) }}
                      onDrop={(e) => { e.preventDefault(); if (dragIndex !== null && dragIndex !== i) onReorder(dragIndex, i); setDragIndex(null); setDragOver(null) }}
                      onPointerDown={(e) => {
                        if (trimRef.current || vfadeRef.current || volRef.current) return
                        e.stopPropagation()
                        if (tool === 'razor') { onRazorAt(shot.shotId, clamp(xToSeconds(e.clientX) - (offsets[i] ?? 0), 0.1, dur - 0.1)); return }
                        onSelectClip(shot.shotId)
                        if (tool === 'trim') {
                          const edge = halfEdge(e)
                          trimRef.current = { shotId: shot.shotId, edge, startX: e.clientX, inPoint: st.inPoint, outPoint: st.outPoint ?? sourceDuration(shot), srcDur: sourceDuration(shot) }
                          // 5E: freeze pre-drag geometry so the head-trim pins the right edge
                          // (rightSec) and holds the following clips still until pointer-up.
                          if (edge === 'l') setHeadTrimViz({ index: i, rightSec: (offsets[i] ?? 0) + dur, frozenOffsets: [...offsets] })
                          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                        } else if (tool === 'select') onSeek(xToSeconds(e.clientX))
                        // move: HTML5 drag (above) reorders — pointerdown only selects
                      }}
                      className={cn('group absolute top-1 bottom-1 rounded overflow-hidden border', isActive ? 'border-cyan ring-1 ring-cyan' : 'border-bg/70', dragOver === i ? 'opacity-70' : '', tool === 'move' ? 'cursor-grab' : '')}
                      style={{ left, width, backgroundImage: shot.thumbnailUrl ? `url(${shot.thumbnailUrl})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center' }}
                      title={`${shot.shotId} · ${dur.toFixed(1)}s`}
                    >
                      <div className={cn('absolute inset-0', isActive ? 'bg-cyan/20' : 'bg-bg/45 group-hover:bg-bg/30')} />
                      <span className="absolute top-0.5 left-1 text-[8px] font-mono text-white/90 drop-shadow">{shot.shotId.replace('SHOT_', '')}</span>
                      <span className="absolute bottom-0.5 left-1 text-[8px] font-mono text-white/70 drop-shadow">{dur.toFixed(1)}s</span>
                      {/* Background-render placeholder (Extend continuation still rendering) */}
                      {(shot.status === 'animating' || shot.status === 'generating') && (
                        <div className="absolute inset-0 flex items-center justify-center gap-1 bg-bg/65 z-[6] pointer-events-none">
                          <span className="w-3 h-3 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
                          <span className="text-[8px] text-cyan font-semibold">rendering…</span>
                        </div>
                      )}
                      {/* Fade shading (always shown when set) */}
                      {(st.fadeIn ?? 0) > 0 && <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-black/85 to-transparent pointer-events-none z-[5]" style={{ width: `${fiPct}%` }} />}
                      {(st.fadeOut ?? 0) > 0 && <div className="absolute inset-y-0 right-0 bg-gradient-to-l from-black/85 to-transparent pointer-events-none z-[5]" style={{ width: `${foPct}%` }} />}
                      {/* Volume + fade handles — only on the SELECTED clip (less clutter) */}
                      {isActive && (
                        <>
                          <div
                            onPointerDown={(e) => { e.stopPropagation(); volRef.current = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }}
                            onPointerMove={(e) => { const r = volRef.current; if (!r) return; if (!gestureSnappedRef.current) { onBeforeGesture?.(); gestureSnappedRef.current = true } onClipVolume(shot.shotId, clamp(1 - (e.clientY - r.top) / r.height, 0, 1)) }}
                            onPointerUp={() => { volRef.current = null; gestureSnappedRef.current = false }}
                            title={`Volume ${Math.round((st.volume ?? 1) * 100)}% — drag up/down`}
                            data-testid={`clip-volume-${shot.shotId}`}
                            className="absolute left-0 right-0 h-4 -translate-y-1/2 z-20 cursor-ns-resize flex items-center"
                            style={{ top: `${(1 - (st.volume ?? 1)) * 100}%` }}
                          ><div className="w-full h-[2px] bg-amber/90" /></div>
                          {fadeHandle(`${shot.shotId}:in`, 'bg-cyan', 'in', fiPct, (e) => { vfadeRef.current = { shotId: shot.shotId, side: 'in', startX: e.clientX, v0: st.fadeIn ?? 0, dur } }, `Fade in ${(st.fadeIn ?? 0).toFixed(1)}s — drag right`, `vfade-in-${shot.shotId}`)}
                          {fadeHandle(`${shot.shotId}:out`, 'bg-cyan', 'out', foPct, (e) => { vfadeRef.current = { shotId: shot.shotId, side: 'out', startX: e.clientX, v0: st.fadeOut ?? 0, dur } }, `Fade out ${(st.fadeOut ?? 0).toFixed(1)}s — drag left`, `vfade-out-${shot.shotId}`)}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Audio track (A1) */}
            <div className={cn('relative border-t border-border', cursorClass)} style={{ height: aH }} onPointerDown={onScrubDown}>
              {/* The gesture refs (trimRef/aGesture/vfadeRef) are read ONLY inside
                  pointer-event handlers — never during render. react-compiler still
                  taints the whole render-time map over the closures it creates, so
                  this is a documented false positive, not a suppressed bug. */}
              {/* eslint-disable-next-line react-hooks/refs */}
              {audioClips.map((a) => {
                const dur = Math.max(0.1, a.outPoint - a.inPoint)
                const left = a.timelineStart * pps
                const width = dur * pps
                const isSel = a.id === selectedAudioId
                const fadeInPct = clamp(a.fadeIn / dur, 0, 1) * 100
                const fadeOutPct = clamp(a.fadeOut / dur, 0, 1) * 100
                // undefined = persisted before the flag existed → shown (and exported) as
                // ducking, which is how that project was already mixed. See AudioClip.duck.
                const ducks = a.duck ?? true
                return (
                  <div
                    key={a.id}
                    onPointerDown={(e) => {
                      if (aGesture.current) return
                      e.stopPropagation()
                      if (tool === 'razor') { onAudioRazorAt(a.id, clamp(xToSeconds(e.clientX) - a.timelineStart, 0.1, dur - 0.1)); return }
                      onSelectAudio(a.id)
                      if (tool === 'trim') aGesture.current = { kind: 'trim', id: a.id, edge: halfEdge(e), startX: e.clientX, inPoint: a.inPoint, outPoint: a.outPoint, start0: a.timelineStart, srcDur: a.srcDuration }
                      else if (tool === 'move') aGesture.current = { kind: 'move', id: a.id, startX: e.clientX, start0: a.timelineStart }
                      if (aGesture.current) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                      // select: just select — leaves the fade/volume handles free to grab
                    }}
                    className={cn('group absolute top-1 bottom-1 rounded overflow-hidden border', isSel ? 'border-amber ring-1 ring-amber bg-green/20' : 'border-green/40 bg-green/10', tool === 'razor' ? 'cursor-crosshair' : tool === 'trim' ? 'cursor-ew-resize' : tool === 'move' ? 'cursor-grab' : 'cursor-pointer')}
                    style={{ left, width }}
                    title={`${a.name} · ${dur.toFixed(1)}s`}
                  >
                    {/* Waveform */}
                    {(() => {
                      const pk = audioPeaks[a.id]
                      if (!pk?.length || a.srcDuration <= 0) return null
                      const N = pk.length
                      const i0 = Math.max(0, Math.floor((a.inPoint / a.srcDuration) * N))
                      const i1 = Math.min(N, Math.ceil((a.outPoint / a.srcDuration) * N))
                      const slice = pk.slice(i0, i1)
                      if (slice.length < 2) return null
                      // Amplitude scales with volume → louder = taller (DaVinci-like).
                      const amp = 46 * clamp(a.volume, 0, 1)
                      const top = slice.map((v, x) => `${x},${(50 - v * amp).toFixed(1)}`).join(' ')
                      const bot = slice.map((v, x) => `${slice.length - 1 - x},${(50 + slice[slice.length - 1 - x] * amp).toFixed(1)}`).join(' ')
                      return (
                        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${slice.length - 1} 100`} preserveAspectRatio="none">
                          <polygon points={`${top} ${bot}`} fill="rgba(74,222,128,0.35)" />
                        </svg>
                      )
                    })()}
                    {a.fadeIn > 0 && <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-bg/70 to-transparent pointer-events-none" style={{ width: `${fadeInPct}%` }} />}
                    {a.fadeOut > 0 && <div className="absolute inset-y-0 right-0 bg-gradient-to-l from-bg/70 to-transparent pointer-events-none" style={{ width: `${fadeOutPct}%` }} />}
                    <span className="absolute top-0.5 left-1.5 text-[9px] font-mono text-green truncate max-w-[90%] flex items-center gap-1 pointer-events-none"><Music size={9} /> {a.name}</span>
                    <span className="absolute bottom-0.5 left-1.5 text-[8px] font-mono text-green/70 pointer-events-none">{dur.toFixed(1)}s · {Math.round(a.volume * 100)}%</span>

                    {/* Ducking only happens in the ffmpeg export — the live engine never
                        ducks — so the state has to be readable at a glance ON the clip:
                        otherwise the only way to discover that a spot effect got squashed
                        under someone's dialogue is to render the whole film. Always shown
                        (not selected-only like the fade/volume handles, which are already
                        visible as shading). Bottom-right + z-30 so it wins over the volume
                        line and never sits under the fade-out handle (top-right at 0%). */}
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onBeforeGesture?.(); onAudioPatch(a.id, { duck: !ducks }) }}
                      title={ducks
                        ? 'Ducks under dialogue — drops while someone is speaking (music bed). Click to keep it at full level.'
                        : 'Full level — never drops under dialogue (voice-over, spot effect). Click to duck it under the dialogue.'}
                      data-testid={`audio-duck-${a.id}`}
                      className={cn('absolute bottom-0.5 right-1 z-30 flex items-center gap-0.5 px-1 rounded border text-[8px] font-mono leading-snug',
                        ducks ? 'border-amber/60 bg-amber/20 text-amber' : 'border-border bg-bg/70 text-text-muted hover:text-text-primary')}
                    ><Mic size={8} />duck</button>

                    {/* Volume + fade handles — only on the SELECTED audio clip */}
                    {isSel && (
                      <>
                        {fadeHandle(`${a.id}:in`, 'bg-amber', 'in', fadeInPct, (e) => { aGesture.current = { kind: 'fade', id: a.id, side: 'in', startX: e.clientX, v0: a.fadeIn, dur } }, `Fade in ${a.fadeIn.toFixed(1)}s — drag right`, `afade-in-${a.id}`)}
                        {fadeHandle(`${a.id}:out`, 'bg-amber', 'out', fadeOutPct, (e) => { aGesture.current = { kind: 'fade', id: a.id, side: 'out', startX: e.clientX, v0: a.fadeOut, dur } }, `Fade out ${a.fadeOut.toFixed(1)}s — drag left`, `afade-out-${a.id}`)}
                        <div
                          onPointerDown={(e) => { e.stopPropagation(); aGesture.current = { kind: 'vol', id: a.id, rect: (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect() }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }}
                          title={`Volume ${Math.round(a.volume * 100)}% — drag up/down`}
                          className="absolute left-0 right-0 h-4 -translate-y-1/2 z-20 cursor-ns-resize flex items-center"
                          style={{ top: `${(1 - a.volume) * 100}%` }}
                        ><div className="w-full h-[2px] bg-amber/90" /></div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Playhead (spans both tracks) */}
            <div className="absolute w-px bg-red pointer-events-none z-30" style={{ left: playheadX, top: 16, bottom: 0 }}>
              <div className="absolute -top-0 -translate-x-1/2 w-2 h-2 rotate-45 bg-red" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
