'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  Scissors, GripVertical, Download, CheckCircle,
  ShieldCheck, Film, ChevronUp, ChevronDown, Trash2,
  Blend, Clapperboard, Sparkles, Save, Upload, X,
  Play, Pause, SkipBack, SkipForward, ChevronFirst, Volume2, VolumeX, Maximize2,
  RotateCcw, Wand2
} from 'lucide-react'
import { StageHeader } from '@/components/pipeline/StageHeader'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { QCResultBadge } from '@/components/agent/QCResultBadge'
import { QCActionCard } from '@/components/agent/QCActionCard'
import { usePipelineStore } from '@/store/pipeline.store'
import { useProjectGuard } from '@/lib/useProjectGuard'
import { sanitizeShotMedia } from '@/lib/sanitizeMedia'
import { useAgentsStore } from '@/store/agents.store'
import { useToast } from '@/components/ui/Toast'
import { pipelineApi, type QCResponse } from '@/lib/api/pipeline.api'
import { apiClient } from '@/lib/api/client'
import { UPSCALE_RES, UPSCALE_TIERS, UPSCALE_STYLES, type UpRes, type UpTier, type UpStyle, type UpscaleQuote } from '@/lib/upscale'
import { cn } from '@/lib/utils'
import { formatTimecode, playableUrl } from '@/lib/utils'
import { registerAutopilotRunner, type AutopilotResult } from '@/lib/autopilotRegistry'
import { TimelineTrack, type AudioClip, type OverlayClip } from './TimelineTrack'
import { AudioEngine, type EngineClip } from './audioEngine'
import { SequencePlayer, type SequencePlayerHandle, type SeqClip, type OverlaySeqClip } from './SequencePlayer'
import type { GeneratedShot, Segment } from '@/lib/types/pipeline.types'

// ── EDL types ─────────────────────────────────────────────────────────────────

interface EDLTransition {
  type: 'crossfade'
  dur: number
}
interface ClipSettings {
  inPoint: number
  outPoint: number | null  // null = use full clip
  transitionIn: EDLTransition | null
  volume: number           // per-clip audio gain (0 = mute, 1 = unity)
  fadeIn: number           // seconds — video fades from black + audio fades in
  fadeOut: number          // seconds — video fades to black + audio fades out
}
interface EDLClip extends ClipSettings {
  shotId: string
  videoUrl: string
}
interface EDL {
  fps: number
  clips: EDLClip[]
}
// What POST /api/edit/render answers with. Shared by BOTH export paths: the autopilot
// declared its own `{output_path, filename}` and therefore could not even see the
// warnings the render returns — it approved the cut without reading them.
interface RenderResponse {
  output_path: string
  filename: string
  resolution?: string   // what was rendered — '4k' is native Seedance 4K, above MediaKit's 2K input ceiling
  loudness?: { applied?: boolean; measured_lufs?: number | null; target_lufs?: number | null; reason?: string; silent?: boolean }
  // The .srt the render writes beside the film. It had no reader anywhere in the
  // frontend, so the file existed and the feature did not.
  subtitles_path?: string; subtitles_cues?: number; subtitles_note?: string
  // Non-empty when the finished film has no audible programme at all.
  audio_note?: string
}
// One undo/redo checkpoint of the whole timeline editing surface.
interface TlSnap {
  sequence: GeneratedShot[]
  clipSettings: Record<string, ClipSettings>
  audioClips: AudioClip[]
  overlayClips: OverlayClip[]   // 5C: V2 must be in the undo snapshot or edits get wiped
}

// ── Constants ─────────────────────────────────────────────────────────────────

// The export resolution comes from the project's "Final output size" (Settings).
// 4K is native 10-bit HEVC from Seedance 2.0 (no upscale) — the old AI-MediaKit
// super-resolution path was removed (it needed a separate console key).
type OutRes = '720p' | '1080p' | '4k'
const RES_INFO: Record<OutRes, { label: string; format: string; desc: string }> = {
  '720p':  { label: '720p H.264',       format: 'mp4', desc: 'MP4 · HD 1280×720' },
  '1080p': { label: '1080p H.264',      format: 'mp4', desc: 'MP4 · FHD 1920×1080' },
  '4k':    { label: '4K · 10-bit HEVC', format: 'mp4', desc: 'UHD 3840×2160 · Seedance 2.0 native' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
// The disk path behind a served media URL (the inverse of playableUrl), or '' for a
// CDN url — which has no local file the backend could probe.
const servedPath = (url: string): string => {
  const q = url.indexOf('path=')
  return url.startsWith(API_BASE) && q >= 0 ? decodeURIComponent(url.slice(q + 5)) : ''
}

const CLIP_DEFAULTS: ClipSettings = { inPoint: 0, outPoint: null, transitionIn: null, volume: 1, fadeIn: 0, fadeOut: 0 }

/** A clip's runtime, or null when its source length was never measured (a project
 *  reopened from disk whose take would not probe). Anything a GATE reads must use this
 *  and pass the null on — the phase-6 QC refuses to score a clip whose length it does
 *  not know, and a number substituted here defeats that. */
function clipSeconds(shot: GeneratedShot, settings: ClipSettings): number | null {
  const out = settings.outPoint ?? shot.duration
  return out === undefined ? null : Math.max(0, out - settings.inPoint)
}

/** The LAYOUT length: what the timeline draws with. A clip of unknown length measures
 *  0 here because there is no honest width for it — it cannot be sized against a
 *  timeline it has no length on. */
function clipDuration(shot: GeneratedShot, settings: ClipSettings): number {
  return clipSeconds(shot, settings) ?? 0
}

export function DeliveryView() {
  const { stages, commitVersion, approveVersion, goToStage, projectName, localFolderRoot, gateMode, outputResolution, setFinalCutEdit, style, aspectRatio, addShotVersion, targetDurationSecs } = usePipelineStore()
  const exportInfo = RES_INFO[outputResolution]
  const { success, error: toastError } = useToast()
  const isCurrentProject = useProjectGuard()
  const { updateAgent } = useAgentsStore()
  const stage5 = stages[5]

  // A timeline clip is one Seedance CALL, and a call may hold several shots the model
  // cut between. The cut needs to know that: pacing is a property of shots, so reading
  // clip totals would report an even 9.5s average on a segment whose real rhythm is
  // 1.5/5/3 — passing the cut on the exact axis it should fail. A migrated segment
  // inherits the shot's id, so on existing projects this map is 1:1 and changes nothing.
  const segmentMap = useMemo<Record<string, Segment>>(() => {
    const s2 = stages[2]
    const v = s2.versions.find((x) => x.id === s2.activeVersionId)
    const segs = ((v?.data as { segments?: Segment[] })?.segments) ?? []
    return Object.fromEntries(segs.map((sg) => [sg.id, sg]))
  }, [stages])
  const segmentOf = useCallback((id: string) => segmentMap[id], [segmentMap])

  const allStage5Shots = useMemo<GeneratedShot[]>(() => {
    const v = stage5.versions.find((v) => v.id === stage5.activeVersionId)
    const stored = ((v?.data as { shots?: GeneratedShot[] })?.shots) ?? []
    // Heal cross-project contamination at hydration (see sanitizeMedia).
    return stored.map((s) => sanitizeShotMedia(s, localFolderRoot))
  }, [stage5.activeVersionId, stage5.versions, localFolderRoot])

  // Item 8: only shots WITH a rendered video go on the timeline; approved-but-
  // unrendered shots are surfaced in a warning instead of silently exported.
  const stage5Shots = useMemo(
    () => allStage5Shots.filter((s) => s.videoUrl || s.videoLocalPath),
    [allStage5Shots])
  const strandedShots = useMemo(
    () => allStage5Shots.filter((s) => s.status === 'approved' && !s.videoUrl && !s.videoLocalPath),
    [allStage5Shots])

  // Restore the persisted edit (order / clip settings / audio) so going back to a
  // previous stage and returning doesn't wipe the timeline (esp. the audio clips).
  const [sequence, setSequence] = useState<GeneratedShot[]>(() => {
    const saved = usePipelineStore.getState().finalCutEdit
    if (saved?.order?.length) {
      // Include persisted extraClips (Extend continuations) so they survive a reload —
      // their id isn't in the canonical SG shot list.
      const byId = new Map<string, GeneratedShot>(stage5Shots.map((s) => [s.shotId, s]))
      for (const c of (saved.extraClips ?? [])) byId.set(c.shotId, c)
      const ordered = saved.order.map((id) => byId.get(id)).filter((x): x is GeneratedShot => !!x)
      // A replace-in-place Edit removes its source SG id from `order` (the `<srcId>-EDIT-n` clip
      // took its slot while the ORIGINAL shot still lives in stage5Shots). Without this guard the
      // `extra` clause treats that source id as an unplaced SG shot and re-appends the stale,
      // un-edited original at the end — a duplicate that then bakes into `order` and the export.
      // Strip transitively so a nested/chained id (…-EDIT-1-EDIT-2, …-EXT-1-EDIT-2) resolves to
      // its ROOT SG id — otherwise the true original would still be re-appended as a duplicate.
      const editedBases = new Set<string>()
      for (const id of saved.order) {
        let base = id
        let m = /^(.*)-(?:EXT|EDIT|RETAKE)-\d+$/i.exec(base)
        while (m) { base = m[1]; m = /^(.*)-(?:EXT|EDIT|RETAKE)-\d+$/i.exec(base) }
        if (base !== id) editedBases.add(base)
      }
      const extra = stage5Shots.filter((s) => !saved.order.includes(s.shotId) && !editedBases.has(s.shotId))
      return ordered.length ? [...ordered, ...extra] : stage5Shots
    }
    return stage5Shots
  })
  const [clipSettings, setClipSettings] = useState<Record<string, ClipSettings>>(
    () => (usePipelineStore.getState().finalCutEdit?.clips as Record<string, ClipSettings>) ?? {})
  const [previewId, setPreviewId] = useState<string | null>(stage5Shots[0]?.shotId ?? null)
  const [qcResult, setQcResult] = useState<QCResponse | null>(null)
  const [isQcRunning, setIsQcRunning] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  // output_path is what lets the Final Director SEE the cut; loudness is measured during
  // the same render and was already being thrown away.
  const [exportResult, setExportResult] = useState<RenderResponse | null>(null)
  // ── Upscale master (AI MediaKit) — see the block in the export card. Defaults: 4K on
  //    Standard, style Natural, which is the vendor's own advice for AI-generated people.
  //    The quote and the result carry the export they belong to (`forPath`), so a new
  //    render simply stops matching them — no reset to forget on any of the export paths.
  const [upRes, setUpRes] = useState<UpRes>('4k')
  const [upTier, setUpTier] = useState<UpTier>('standard')
  const [upStyle, setUpStyle] = useState<UpStyle>('natural')
  const [upQuoteRaw, setUpQuote] = useState<(UpscaleQuote & { forPath: string }) | null>(null)
  const [upBusy, setUpBusy] = useState(false)
  const [upElapsed, setUpElapsed] = useState(0)   // seconds, as the server counts them
  const [upError, setUpError] = useState<string | null>(null)
  const [upResultRaw, setUpResult] = useState<{ forPath: string; output_path: string; filename: string; resolution: string; tier: string; seconds: number; usd: number } | null>(null)
  const exportPath = exportResult?.output_path
  const upQuote = upQuoteRaw && upQuoteRaw.forPath === exportPath ? upQuoteRaw : null
  const upResult = upResultRaw && upResultRaw.forPath === exportPath ? upResultRaw : null

  // The price and the input check come from the server, which measures the export
  // itself: its length for the figure, its size against the vendor's 2K input ceiling.
  // The vendor bills output minutes × a published coefficient and the output is as long
  // as the input, so this is the exact figure, not an estimate.
  useEffect(() => {
    if (!exportPath) return
    let alive = true
    void (async () => {
      try {
        const { data } = await apiClient.post<UpscaleQuote>('/api/studio/upscale/quote', { resolution: upRes, tier: upTier, path: exportPath, fps: 24 })
        if (alive) setUpQuote({ ...data, forPath: exportPath })
      } catch { if (alive) setUpQuote({ usd: -1, seconds: 0, forPath: exportPath }) }
    })()
    return () => { alive = false }
  }, [exportPath, upRes, upTier])

  // One task on the EXPORT: only the programme's minutes are paid, the ffmpeg pipeline
  // keeps working at 1080p, and the master lands next to the export with the export's
  // own audio remuxed over the upscaled picture (the vendor resamples it otherwise).
  const runMasterUpscale = useCallback(async () => {
    if (!exportPath) return
    setUpBusy(true); setUpError(null); setUpElapsed(0)
    updateAgent('seedance', { status: 'active', detail: `AI MediaKit upscaling the master to ${upRes.toUpperCase()}…`, progress: 5 })
    type Poll = { status: string; output_path?: string; filename?: string; resolution?: string; tier?: string; seconds?: number; usd?: number; elapsed?: number; error?: string }
    try {
      const { data } = await apiClient.post<{ task_id?: string }>(
        '/api/edit/upscale',
        { project_name: projectName, project_path: localFolderRoot ?? '', render_path: exportPath,
          resolution: upRes, tier: upTier, style: upStyle, scene: 'aigc' },
        { timeout: 600_000 },   // the export is hosted before the task is accepted — minutes for a long film
      )
      if (!data.task_id) throw new Error('No task id returned')
      // The SERVER owns the wait (it polls the vendor and writes the master itself); this
      // loop only asks how it is going, with no deadline of its own short of the server's
      // 6 h — a client that gave up at 60 minutes was leaving a billed master unclaimed.
      // Professional at 8K is slow: large-model restoration over the whole programme.
      const ceiling = Date.now() + 6 * 60 * 60_000
      let done: Poll | null = null
      while (Date.now() < ceiling) {
        await new Promise((r) => setTimeout(r, 5000))
        try {
          const { data: s } = await apiClient.get<Poll>(`/api/edit/upscale/${data.task_id}`)
          if (s.status === 'completed' || s.status === 'failed') { done = s; break }
          if (typeof s.elapsed === 'number') setUpElapsed(s.elapsed)
        } catch { /* transient — keep polling */ }
      }
      if (!done || done.status !== 'completed' || !done.output_path) throw new Error(done?.error || 'Upscale still running after 6 hours — check the backend log')
      const filename = done.filename || done.output_path.split('/').pop() || ''
      setUpResult({ forPath: exportPath, output_path: done.output_path, filename, resolution: done.resolution || upRes, tier: done.tier || upTier, seconds: done.seconds ?? 0, usd: done.usd ?? 0 })
      updateAgent('seedance', { status: 'completed', detail: `Master ready: ${filename}`, progress: 100 })
      success('Master ready', done.output_path)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Upscale failed'
      setUpError(msg)
      updateAgent('seedance', { status: 'error', detail: msg })
    } finally {
      setUpBusy(false)
    }
  }, [exportPath, upRes, upTier, upStyle, projectName, localFolderRoot, updateAgent, success])
  const [audioClips, setAudioClips] = useState<AudioClip[]>(
    () => (usePipelineStore.getState().finalCutEdit?.audio as AudioClip[]) ?? [])
  const [selectedAudioId, setSelectedAudioId] = useState<string | null>(null)
  // 5C: V2 overlay track — re-takes mounted ON TOP of V1 (not replacing it). Seeded
  // from the persisted edit; positioned/edited like an audio clip but carrying video.
  const [overlayClips, setOverlayClips] = useState<OverlayClip[]>(
    () => (usePipelineStore.getState().finalCutEdit?.overlays as OverlayClip[]) ?? [])
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null)
  const overlayCounterRef = useRef(0)
  // 5K: global master/bus volume — multiplied into every clip (video + audio) in
  // the live player AND baked into the ffmpeg export. Seeded from the persisted edit.
  const [masterVolume, setMasterVolume] = useState<number>(
    () => usePipelineStore.getState().finalCutEdit?.master ?? 1)
  const [uploadingMusic, setUploadingMusic] = useState(false)
  const audioFileRef = useRef<HTMLInputElement>(null)
  // Soundtrack (instrumental music, Seed Audio 1.0) — user writes the prompt + length.
  const [musicPrompt, setMusicPrompt] = useState('')
  const [musicSeconds, setMusicSeconds] = useState(0)   // 0 = default to the film length
  const [generatingMusic, setGeneratingMusic] = useState(false)
  // Extend clip (Seedance continuation → inserted right after the selected clip).
  const [extendOpen, setExtendOpen] = useState(false)
  const [extendPrompt, setExtendPrompt] = useState('')
  const [extendSecs, setExtendSecs] = useState(5)
  const [extendEnhancing, setExtendEnhancing] = useState(false)
  const extendCounterRef = useRef(0)                            // unique, clean continuation ids
  // Edit clip (v2v VFX transform — add ships, an explosion, relight…). Replaces the source
  // clip in place with the transformed take (non-destructive: a new versioned file on disk).
  const [editOpen, setEditOpen] = useState(false)
  const [editPrompt, setEditPrompt] = useState('')
  const [editEnhancing, setEditEnhancing] = useState(false)
  const [editRefs, setEditRefs] = useState<string[]>([])
  const editCounterRef = useRef(0)
  // Re-take clip (5B): full re-animate of the shot from its keyframe, directed by a fresh
  // user prompt; the ORIGINAL assembled prompt rides read-only as context. Reuses Stage-5's
  // promptOverride path over /api/video/create (verbatim) — no new backend. Replace-in-place
  // (the source shot stays versioned on disk).
  const [retakeOpen, setRetakeOpen] = useState(false)
  const [retakePrompt, setRetakePrompt] = useState('')
  const [retakeEnhancing, setRetakeEnhancing] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  // Editor tool (mutually exclusive): move/select, trim (drag clip halves), razor.
  const [tool, setTool] = useState<'select' | 'move' | 'trim' | 'razor'>('select')
  const razorActive = tool === 'razor'   // derived, for the legacy hidden list + header button
  // Last-clicked clip (video or audio) — Delete/Backspace removes it.
  const [lastSelected, setLastSelected] = useState<{ kind: 'video' | 'audio' | 'overlay'; id: string } | null>(null)

  // ── Undo / redo for the timeline (sequence + clip settings + audio) ──────────
  // IMPERATIVE command-boundary history: each discrete command calls pushHistory() at its
  // START (capturing the PRE-command state); a drag gesture pushes once on its first move
  // (onBeforeGesture). One command == one undo step, decoupled from async Extend/Edit renders.
  // (Replaces the old reactive effect, which had to skip 'animating' states and so bundled a
  // render's completion with any edits made during it into ONE entry — the 5F bug.) Declared
  // above the effects because the Delete-key handler below calls pushHistory().
  const pastRef = useRef<TlSnap[]>([])
  const futureRef = useRef<TlSnap[]>([])
  const snapRef = useRef<TlSnap>({ sequence, clipSettings, audioClips, overlayClips })
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  useEffect(() => { snapRef.current = { sequence, clipSettings, audioClips, overlayClips } })   // mirror current state each render
  const pushHistory = useCallback(() => {
    const snap = snapRef.current
    const last = pastRef.current[pastRef.current.length - 1]
    if (last && JSON.stringify(last) === JSON.stringify(snap)) return   // a no-op command adds no step
    pastRef.current = [...pastRef.current.slice(-49), snap]             // cap history at 50
    futureRef.current = []                                             // a fresh command clears redo
    setCanUndo(true); setCanRedo(false)
  }, [])
  const applySnap = useCallback((s: TlSnap) => {
    // Heal forward: a snapshot taken WHILE an Extend/Edit was rendering froze that clip as an
    // 'animating' placeholder with empty media. If the render has since completed, the live state
    // holds the finished clip — adopt it, so undo/redo reverts the EDIT (order/trim/existence) but
    // never resurrects a dead spinner or drops a completed take (the 5F review defect). Render
    // state is forward-only; only the edit is undoable.
    const live = new Map(snapRef.current.sequence.map((c) => [c.shotId, c]))
    const sequence = s.sequence.map((c) => {
      if (c.status === 'animating') { const l = live.get(c.shotId); if (l && l.status !== 'animating') return l }
      return c
    })
    // 5C: heal V2 overlays forward the same way — a re-take that finished rendering
    // since the snapshot must not be reverted to its 'animating' placeholder.
    const liveOv = new Map(snapRef.current.overlayClips.map((o) => [o.id, o]))
    const overlayClips = s.overlayClips.map((o) => {
      if (o.shot.status === 'animating') { const l = liveOv.get(o.id); if (l && l.shot.status !== 'animating') return l }
      return o
    })
    const healed: TlSnap = { sequence, clipSettings: s.clipSettings, audioClips: s.audioClips, overlayClips }
    snapRef.current = healed   // sync immediately so a rapid second undo/redo reads the applied state
    setSequence(sequence); setClipSettings(s.clipSettings); setAudioClips(s.audioClips); setOverlayClips(overlayClips)
  }, [])
  const undo = useCallback(() => {
    if (!pastRef.current.length) return
    futureRef.current = [snapRef.current, ...futureRef.current].slice(0, 50)
    const prev = pastRef.current[pastRef.current.length - 1]
    pastRef.current = pastRef.current.slice(0, -1)
    applySnap(prev)
    setCanUndo(pastRef.current.length > 0); setCanRedo(true)
  }, [applySnap])
  const redo = useCallback(() => {
    if (!futureRef.current.length) return
    const [next, ...rest] = futureRef.current
    futureRef.current = rest
    pastRef.current = [...pastRef.current, snapRef.current].slice(-50)
    applySnap(next)
    setCanUndo(true); setCanRedo(futureRef.current.length > 0)
  }, [applySnap])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      if (e.shiftKey) redo(); else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // Newer Stage-5 takes for clips ALREADY on this timeline. They used to be swapped in
  // SILENTLY, which replaced Final-Cut clips underneath the user (a Stage-5 re-render
  // clobbered the cut and forced re-work here — the reason Re-take was removed from
  // Stage 5, 2026-07-27). Now they queue as an OFFER the user accepts or dismisses.
  const [pendingTakeUpdates, setPendingTakeUpdates] = useState<GeneratedShot[]>([])

  useEffect(() => {
    // Defer one microtask so the hydration sync isn't a synchronous setState in the effect
    void Promise.resolve().then(() => {
      // First build only: an empty timeline adopts the SG shots. NEVER auto-replace an
      // existing clip's media — that is what the banner below is for.
      setSequence((prev) => (prev.length === 0 ? stage5Shots : prev))
      setPreviewId((prev) => prev ?? stage5Shots[0]?.shotId ?? null)
      // Detect (don't apply) clips whose SG shot now has a different rendered take.
      const cur = snapRef.current.sequence
      if (!cur.length) return
      const placed = new Map(cur.map((c) => [c.shotId, c]))
      setPendingTakeUpdates(stage5Shots.filter((s) => {
        const c = placed.get(s.shotId)
        return !!c && !!s.videoLocalPath && s.videoLocalPath !== c.videoLocalPath
      }))
    })
  }, [stage5Shots])

  // Accept the offer: swap the queued clips to their latest SG take. pushHistory first so
  // it is ONE undo step (store setters stay outside the setState updater).
  const applyTakeUpdates = useCallback(() => {
    const fresh = pendingTakeUpdates
    if (!fresh.length) return
    pushHistory()
    const byId = new Map(fresh.map((s) => [s.shotId, s]))
    setSequence((prev) => prev.map((c) => byId.get(c.shotId) ?? c))
    setPendingTakeUpdates([])
    success('Timeline updated', `${byId.size} clip(s) now use the latest take from SG`)
  }, [pendingTakeUpdates, pushHistory, success])

  // Init clip settings from shots
  useEffect(() => {
    // Deferred: not a synchronous setState in the effect (react-compiler rule)
    void Promise.resolve().then(() => setClipSettings((prev) => {
      const next = { ...prev }
      let changed = false
      for (const shot of stage5Shots) {
        if (!next[shot.shotId]) {
          next[shot.shotId] = { inPoint: 0, outPoint: null, transitionIn: null, volume: 1, fadeIn: 0, fadeOut: 0 }
          changed = true
        }
      }
      return changed ? next : prev   // same ref when unchanged → no spurious re-render/undo entry
    }))
  }, [stage5Shots])

  // Persist the edit (order / clip settings / audio / extend continuations) to the
  // store so it survives navigating away from Stage 6 and back, or a reload.
  useEffect(() => {
    const stage5Ids = new Set(stage5Shots.map((s) => s.shotId))
    const extraClips = sequence.filter((s) => !stage5Ids.has(s.shotId))   // Extend continuations
    setFinalCutEdit({ order: sequence.map((s) => s.shotId), extraClips, clips: clipSettings, audio: audioClips, master: masterVolume, overlays: overlayClips })
  }, [sequence, clipSettings, audioClips, masterVolume, overlayClips, stage5Shots, setFinalCutEdit])

  // Delete/Backspace removes the last-clicked clip (no on-clip delete button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (!lastSelected) return
      e.preventDefault()
      pushHistory()   // one undo step for the delete
      if (lastSelected.kind === 'video') setSequence((prev) => prev.filter((s) => s.shotId !== lastSelected.id))
      else if (lastSelected.kind === 'overlay') setOverlayClips((prev) => prev.filter((c) => c.id !== lastSelected.id))   // 5C
      else setAudioClips((prev) => prev.filter((c) => c.id !== lastSelected.id))
      setLastSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lastSelected, pushHistory])

  // Recover (or resolve) stranded Extend/Edit placeholders on mount. If the tab reloaded or
  // navigated away mid-render, the async completion handler was orphaned and its 'animating'
  // placeholder is stuck forever with a spinner (and it persists). The render usually FINISHED
  // server-side, so ask the backend for the saved take and heal the clip WITHOUT re-rendering.
  // If nothing was saved: an EXT placeholder (an insertion) is dropped; an EDIT placeholder (a
  // replacement) restores the ORIGINAL shot from SG so the clip is never lost.
  const activeRendersRef = useRef<Set<string>>(new Set())   // pendingIds with a LIVE Extend/Edit handler
  const recoveringRef = useRef<Set<string>>(new Set())      // shotIds a recovery pass is already handling
  useEffect(() => {
    // Recover (or resolve) STRANDED 'animating' placeholders — a reload/nav orphaned the async
    // handler, OR undo/redo restored a placeholder whose render has since finished (5F). A
    // placeholder with a LIVE handler (activeRendersRef) is skipped: it will complete on its own.
    const stranded = sequence.filter((c) => c.status === 'animating'
      && !activeRendersRef.current.has(c.shotId) && !recoveringRef.current.has(c.shotId))
    if (!stranded.length) return
    void (async () => {
      for (const ph of stranded) {
        recoveringRef.current.add(ph.shotId)
        const m = ph.shotId.match(/^(.*)-(EXT|EDIT|RETAKE)-\d+$/i)   // SHOT_029-EXT-2 / -EDIT-1 / -RETAKE-1
        const srcId = m ? m[1] : ph.shotId
        // 5B: a re-take is a replace (like Edit) — restore the source, never drop, if orphaned.
        const kind = m && /edit|retake/i.test(m[2]) ? 'edit' : 'ext'
        const resolveUnrecovered = () => setSequence((prev) => {
          if (kind !== 'edit') return prev.filter((c) => c.shotId !== ph.shotId)   // ext insertion → drop
          const orig = stage5Shots.find((s) => s.shotId === srcId)                 // edit → restore source
          return prev.map((c) => c.shotId === ph.shotId
            ? (orig ?? { ...c, status: 'ready' as const })   // SG original, or the placeholder's retained media
            : c)
        })
        try {
          const data = await pipelineApi.recoverExtend({
            projectName, projectPath: localFolderRoot ?? '', clipId: `${srcId}-${kind}`,
          })
          if (!isCurrentProject()) return
          if (data?.video_path) {
            const served = `${API_BASE}/api/asset/serve?path=${encodeURIComponent(data.video_path)}`
            const thumb = data.thumbnail_path
              ? `${API_BASE}/api/asset/serve?path=${encodeURIComponent(data.thumbnail_path)}` : ''
            setSequence((prev) => prev.map((c) => c.shotId === ph.shotId
              ? { ...c, videoUrl: served, videoLocalPath: data.video_path, thumbnailUrl: thumb,
                  previewUrl: '', duration: data.duration || c.duration, status: 'ready' }
              : c))
            success(kind === 'edit' ? 'Edit recovered' : 'Extend recovered',
              kind === 'edit' ? `Restored the edited ${srcId}` : `Restored the +${data.added_seconds}s continuation after ${srcId}`)
          } else {
            resolveUnrecovered()
          }
        } catch {
          if (isCurrentProject()) resolveUnrecovered()
        } finally {
          recoveringRef.current.delete(ph.shotId)
        }
      }
    })()
  }, [sequence])   // eslint-disable-line react-hooks/exhaustive-deps -- runs on any stranded placeholder; refs guard re-entry

  // Reset the timeline to the approved SG shots in canonical order — clears razor
  // splits, reorders and duplicates (nothing in SG is touched; soundtrack is kept).
  const handleResetTimeline = () => {
    if (sequence.length && typeof window !== 'undefined' && !window.confirm(
      'Reset the timeline to the approved shots from SG, in order? This drops manual splits, ' +
      'reorders, extend continuations and V2 overlays (nothing in SG is deleted; your soundtrack is kept).'
    )) return
    pushHistory()
    setSequence(stage5Shots)
    setOverlayClips([])   // 5C: reset drops V2 overlays (re-takes)
    setClipSettings(() => {
      const next: Record<string, ClipSettings> = {}
      for (const s of stage5Shots) next[s.shotId] = { ...CLIP_DEFAULTS }
      return next
    })
    setLastSelected(null)
    // A shorter canonical timeline would otherwise leave the scrubber — and the audio
    // engine's start position on the next Play — past the new end until the user seeks.
    seekGlobal(0)
  }

  // Always merge over the defaults so settings persisted before a field existed
  // (e.g. fadeIn/fadeOut) never read as undefined.
  const getSettings = (shotId: string): ClipSettings => ({ ...CLIP_DEFAULTS, ...clipSettings[shotId] })

  const updateSettings = (shotId: string, patch: Partial<ClipSettings>) =>
    setClipSettings((prev) => ({
      ...prev,
      [shotId]: { ...getSettings(shotId), ...patch },
    }))

  const totalRuntime = sequence.reduce((acc, s) => acc + clipDuration(s, getSettings(s.shotId)), 0)

  // ── EDL generation ────────────────────────────────────────────────────────

  const buildEDL = useCallback((): EDL => ({
    fps: 24,
    clips: sequence.map((shot) => ({
      shotId: shot.shotId,
      // Local saved copy preferred — signed CDN URLs 403 after ~24h
      videoUrl: shot.videoLocalPath || shot.videoUrl,
      ...getSettings(shot.shotId),
    })),
  }), [sequence, clipSettings]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drag-to-reorder ───────────────────────────────────────────────────────

  const handleDragStart = (i: number) => setDragIndex(i)
  const handleDragOver = (e: React.DragEvent, i: number) => { e.preventDefault(); setDragOver(i) }
  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) { setDragIndex(null); setDragOver(null); return }
    pushHistory()
    const next = [...sequence]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(targetIndex, 0, moved)
    setSequence(next)
    setDragIndex(null); setDragOver(null)
  }

  const moveShot = (index: number, dir: -1 | 1) => {
    const next = [...sequence]
    const target = index + dir
    if (target < 0 || target >= next.length) return
    pushHistory()
    ;[next[index], next[target]] = [next[target], next[index]]
    setSequence(next)
  }

  const removeShot = (shotId: string) => { pushHistory(); setSequence((prev) => prev.filter((s) => s.shotId !== shotId)) }

  // ── DaVinci timeline: playhead, scrub/seek, auto-advance, razor-at-playhead ──

  const [playhead, setPlayhead] = useState(0)   // global seconds across the sequence
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const playerRef = useRef<SequencePlayerHandle>(null)

  const durations = sequence.map((s) => clipDuration(s, getSettings(s.shotId)))
  const offsets: number[] = []
  durations.reduce((acc, d, i) => { offsets[i] = acc; return acc + d }, 0)

  // Double-buffered playback (seamless cuts): one clip plays while the next
  // preloads. The player owns playback + reports the playhead/active clip.
  const seqClips: SeqClip[] = sequence.map((s, i) => {
    const st = getSettings(s.shotId)
    return {
      shotId: s.shotId, url: playableUrl(s), inPoint: st.inPoint,
      duration: durations[i] ?? 0, volume: st.volume ?? 1,
      fadeIn: st.fadeIn ?? 0, fadeOut: st.fadeOut ?? 0,
    }
  })
  // 5C: parallel overlay clips for the player's V2 layer.
  const overlaySeqClips: OverlaySeqClip[] = overlayClips.map((o) => ({
    shotId: o.id, url: playableUrl(o.shot), timelineStart: o.timelineStart,
    inPoint: o.inPoint, duration: Math.max(0, o.outPoint - o.inPoint),
    volume: o.volume, fadeIn: o.fadeIn, fadeOut: o.fadeOut,
  }))
  // Web Audio engine (Fase 3): smooth fades + multiple clips in sync. Schedules
  // on the AudioContext clock instead of ramping <audio>.volume at ~4 Hz.
  const engineRef = useRef<AudioEngine | null>(null)
  useEffect(() => {
    engineRef.current = new AudioEngine()
    return () => { engineRef.current?.dispose(); engineRef.current = null }
  }, [])
  const [audioPeaks, setAudioPeaks] = useState<Record<string, number[]>>({})
  const engineClips = (): EngineClip[] => audioClips.map((c) => ({
    id: c.id, url: `${API_BASE}/api/asset/serve?path=${encodeURIComponent(c.path)}`,
    timelineStart: c.timelineStart, inPoint: c.inPoint, outPoint: c.outPoint,
    volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
  }))
  const playheadRef = useRef(0)
  // Decode + peaks whenever the audio set changes; (re)schedule if playing.
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return
    const clips = engineClips()
    eng.preload(clips, (id, pk) => setAudioPeaks((p) => ({ ...p, [id]: pk })))
      .then(() => { if (playing) eng.play(clips, playheadRef.current) })
  }, [audioClips]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const eng = engineRef.current; if (!eng) return
    if (playing) eng.play(engineClips(), playheadRef.current)
    else eng.stop()
  }, [playing]) // eslint-disable-line react-hooks/exhaustive-deps
  // 5K: apply the master/bus fader to the audio engine live (the video track's
  // master is applied in SequencePlayer via the masterVolume prop).
  useEffect(() => { engineRef.current?.setMasterVolume(masterVolume) }, [masterVolume])

  const seekGlobal = (g: number) => {
    setPlayhead(g); playheadRef.current = g
    playerRef.current?.seek(g)
    if (playing) engineRef.current?.play(engineClips(), g)
  }

  // #4: split at the PLAYHEAD position (not the midpoint), with a visible cut.
  const handleRazorAt = (shotId: string, localSeconds: number) => {
    const shot = sequence.find((s) => s.shotId === shotId)
    if (!shot) return
    pushHistory()
    const settings = getSettings(shotId)
    const cutAt = settings.inPoint + localSeconds
    const idx = sequence.findIndex((s) => s.shotId === shotId)

    // The two halves must not collide with an id that already exists. clipSettings is
    // keyed by shotId, so two clips sharing one would share ONE settings entry —
    // trimming one would silently trim the other, and the timeline would look correct
    // while exporting something else. Suffixing blind (_A, _B, then _A_A…) has no
    // guard at all; this walks past any id already in use.
    const taken = new Set([...sequence.map((s) => s.shotId), ...Object.keys(clipSettings)])
    const freeId = (base: string, tag: string) => {
      let id = `${base}_${tag}`
      for (let n = 2; taken.has(id); n++) id = `${base}_${tag}${n}`
      taken.add(id)
      return id
    }
    const idA = freeId(shot.shotId, 'A')
    const idB = freeId(shot.shotId, 'B')

    const firstHalf: GeneratedShot = { ...shot, shotId: idA }
    const secondHalf: GeneratedShot = { ...shot, shotId: idB }
    const next = [...sequence]
    next.splice(idx, 1, firstHalf, secondHalf)
    setSequence(next)
    setClipSettings((prev) => ({
      ...prev,
      [idA]: { ...settings, outPoint: cutAt },
      [idB]: { ...settings, inPoint: cutAt, transitionIn: null },
    }))
    setTool('select')
  }

  const handleReorder = (from: number, to: number) => {
    pushHistory()
    const next = [...sequence]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setSequence(next)
  }

  // ── QC ────────────────────────────────────────────────────────────────────

  const handleRunQC = async () => {
    setIsQcRunning(true)
    updateAgent('qc', { status: 'active', detail: 'Film Director reviewing final cut…' })
    try {
      const qc = await pipelineApi.qcFinalCut(
        sequence.map((s) => s.shotId),
        sequence.map((s) => ({
          shotId: s.shotId,
          // null, not a number, when this clip's length was never measured: the gate
          // reads a missing duration as UNKNOWN and refuses to score it, and the whole
          // point is that it can tell that from a clip it really did measure at 5s.
          duration: clipSeconds(s, getSettings(s.shotId)),
          // The shots INSIDE this clip. Pacing is a property of SHOTS; reading the
          // clip total would report a 9.5s average on a segment whose real rhythm is
          // 1.5/5/3, i.e. call the cut even at exactly the moment it is not.
          // Rescaled to the clip's REAL length: the timeline's in/out points are what
          // the audience sees, and sending the breakdown's estimates made the two
          // deterministic pacing checks judge the plan instead of the cut.
          sub_durations: (() => {
            const subs = (segmentOf(s.shotId)?.shots ?? []).map((x) => Number(x.durationSecs) || 0)
            const planned = subs.reduce((n, x) => n + x, 0)
            const real = clipDuration(s, getSettings(s.shotId))
            if (!subs.length || planned <= 0 || !real) return []
            return subs.map((x) => Math.round((x * real / planned) * 100) / 100)
          })(),
          // Dialogue is counted per SHOT too — the metric said 0/n on every film because
          // the only caller never sent any, and the LLM was told that as a fact.
          sub_dialogue: (segmentOf(s.shotId)?.shots ?? [])
            .map((x) => (x.dialogue ?? []).length),
        })),
        {
          // Only present once the cut has actually been rendered — before that the QC
          // still runs, on numbers alone, and says plainly that it could not look.
          render_path: exportResult?.output_path || '',
          target_secs: targetDurationSecs || 0,
          loudness: exportResult?.loudness,
        },
      )
      setQcResult(qc)
      updateAgent('qc', { status: qc.passed ? 'completed' : 'active', detail: qc.summary })
    } catch (e: unknown) {
      // Item 8: never a silent QC death — surface the real error
      const msg = e instanceof Error ? e.message : 'QC failed'
      updateAgent('qc', { status: 'error', detail: msg })
      setQcResult({
        passed: false,
        checks: [{ label: 'QC call', passed: false, notes: msg }],
        summary: `Final Cut QC failed: ${msg}`,
        regen_prompt: null,
      })
    }
    finally { setIsQcRunning(false) }
  }

  // ── Save EDL ──────────────────────────────────────────────────────────────

  const handleSaveEDL = async () => {
    try {
      const { data } = await apiClient.post<{ path: string }>('/api/edit/save-edl', {
        project_name: projectName,
        project_path: localFolderRoot ?? '',
        edl: buildEDL(),
      })
      success('EDL saved', data.path)
    } catch (e: unknown) {
      success('EDL (JSON)', 'Downloading locally…')
      const blob = new Blob([JSON.stringify(buildEDL(), null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'TakeOne_Edit.edl.json'; a.click()
      URL.revokeObjectURL(url)
    }
  }

  // ── ffmpeg Render (P10) ───────────────────────────────────────────────────

  const onAddAudio = () => audioFileRef.current?.click()
  // Generate an INSTRUMENTAL soundtrack with Seed Audio 1.0 (music, prompt + length).
  const handleGenerateMusic = async () => {
    if (!musicPrompt.trim() || generatingMusic) return
    // Default to the film length; the model can't be timed exactly, so we loop a
    // phrase to fit (backend). Cap 10 min.
    const target = Math.min(600, Math.round(musicSeconds > 0 ? musicSeconds : (totalRuntime || 15)))
    setGeneratingMusic(true)
    try {
      const data = await pipelineApi.generateSoundtrackMusic({
        projectName, projectPath: localFolderRoot ?? '', prompt: musicPrompt.trim(), targetSeconds: target,
      })
      // `data.duration > 0 ? data.duration : target` stood here, and the substitution was
      // the requested length — the one number that is guaranteed not to be the file's, since
      // the whole reason the backend probes is that Seed Audio's chunks get dropped by the
      // content audit and the bed comes back short. `dur` becomes outPoint, which IS the
      // atrim end in the export: a bed declared longer than it is runs out and the film goes
      // to digital silence from there. Same failure the upload path was fixed for, same fix —
      // measure the saved file with the export's own ffprobe, and refuse rather than guess.
      const dur = data.duration > 0 ? data.duration
        : (await pipelineApi.mediaDuration(data.path).catch(() => null)) ?? 0
      if (dur <= 0) {
        toastError('Length unknown',
          `${data.name} is saved in the project but its length cannot be measured, and a bed placed at a guessed length is cut to that guess in the mix. Add it from the file picker, or generate it again.`)
        return
      }
      const clip: AudioClip = {
        // id from the unique saved path (microsecond-stamped) — no impure Date.now()
        id: `music_${data.path}`, path: data.path, name: data.name, srcDuration: dur,
        timelineStart: 0, inPoint: 0, outPoint: dur, volume: 0.6, fadeIn: 0, fadeOut: 1.5,
        // Unambiguous: Seed Audio just wrote an INSTRUMENTAL bed for the whole film, so
        // this is exactly the clip sidechain ducking exists for — it has to breathe under
        // the dialogue instead of fighting every line at one flat gain.
        duck: true,
      }
      pushHistory()
      setAudioClips((prev) => [...prev, clip])
      setSelectedAudioId(clip.id)
      success('Soundtrack added', `${data.name} · ${dur.toFixed(0)}s`)
    } catch (e: unknown) {
      toastError('Soundtrack failed', e instanceof Error ? e.message : 'blocked by the content filter — try a different description')
    } finally {
      setGeneratingMusic(false)
    }
  }

  // ── Extend clip — animate a continuation from the selected clip's last frame and
  // INSERT it as a new clip right after (Seedance i2v; the shot's screen time grows). ──
  const selectedVideoClip = lastSelected?.kind === 'video'
    ? sequence.find((s) => s.shotId === lastSelected.id) ?? null : null
  const enhanceExtend = async () => {
    if (!extendPrompt.trim() || extendEnhancing) return
    setExtendEnhancing(true)
    try {
      const out = await pipelineApi.enhanceText('continuation direction for the next beat of a video shot', extendPrompt.trim())
      if (out) setExtendPrompt(out)
    } catch { /* enhance is best-effort */ } finally { setExtendEnhancing(false) }
  }
  // Approved character/environment assets (Stage 3) — pickable as continuation references.
  const approvedRefAssets = useMemo(() => {
    const s2 = stages[2], s3 = stages[3]
    const d3 = s3.versions.find((v) => v.id === s3.activeVersionId)?.data as
      { assetStates?: Record<string, { selectedUrl?: string; localPath?: string; status?: string }> } | undefined
    const assets = ((s2.versions.find((v) => v.id === s2.activeVersionId)?.data as
      { assets?: Array<{ id: string; name: string; type: string }> } | undefined)?.assets) ?? []
    const out: Array<{ id: string; name: string; path: string }> = []
    for (const a of assets) {
      const st = d3?.assetStates?.[a.id]
      const path = st?.localPath || st?.selectedUrl
      if (st?.status === 'approved' && path) out.push({ id: a.id, name: a.name, path })
    }
    return out
  }, [stages])
  const enhanceEdit = async () => {
    if (!editPrompt.trim() || editEnhancing) return
    setEditEnhancing(true)
    try {
      const out = await pipelineApi.enhanceText('a VFX change to apply to an existing video shot — what to add or transform', editPrompt.trim())
      if (out) setEditPrompt(out)
    } catch { /* enhance is best-effort */ } finally { setEditEnhancing(false) }
  }
  const enhanceRetake = async () => {
    if (!retakePrompt.trim() || retakeEnhancing) return
    setRetakeEnhancing(true)
    try {
      const out = await pipelineApi.enhanceText('a new directorial take for a video shot — how to re-perform the action, camera or mood', retakePrompt.trim())
      if (out) setRetakePrompt(out)
    } catch { /* enhance is best-effort */ } finally { setRetakeEnhancing(false) }
  }
  const toggleEditRef = (path: string) =>
    setEditRefs((prev) => prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path].slice(0, 9))
  const handleEditRefUpload = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => { const d = reader.result; if (typeof d === 'string') setEditRefs((prev) => [...prev, d].slice(0, 9)) }
    reader.readAsDataURL(file)
  }

  // Non-blocking: insert a "rendering" placeholder right after the source, close the
  // modal, and finish in the background — so you can keep editing / extend other clips.
  const handleExtendClip = () => {
    const clip = selectedVideoClip
    const src = clip?.videoLocalPath || clip?.videoUrl
    if (!clip || !src) { toastError('Select a clip', 'Click a video clip on the timeline first.'); return }
    const srcId = clip.shotId
    extendCounterRef.current += 1
    const pendingId = `${srcId}-EXT-${extendCounterRef.current}`   // short, clean timeline label
    const secs = extendSecs
    const note = extendPrompt.trim()

    const placeholder: GeneratedShot = {
      ...clip, shotId: pendingId, status: 'animating', duration: secs,
      videoUrl: '', videoLocalPath: '', previewUrl: '', lastFrameUrl: '',
    }
    pushHistory()   // one undo step for the whole Extend (the async completion adds none)
    activeRendersRef.current.add(pendingId)   // this placeholder has a LIVE handler → not stranded
    setSequence((prev) => {
      const i = prev.findIndex((s) => s.shotId === srcId)
      return i < 0 ? [...prev, placeholder] : [...prev.slice(0, i + 1), placeholder, ...prev.slice(i + 1)]
    })
    setExtendOpen(false); setExtendPrompt('')
    success('Extending…', `Rendering a +${secs}s continuation after ${srcId} — keep working.`)

    void (async () => {
      try {
        const data = await pipelineApi.extendShot({
          shotId: srcId, videoPath: src, extraSeconds: secs, note,
          projectName, projectPath: localFolderRoot ?? '',
          style, ratio: aspectRatio, resolution: outputResolution,
          concat: false, clipId: `${srcId}-ext`,
          // TRUSTED first_frame (raw last-frame > 24h CDN url) — avoids the re-encode that
          // nullifies Seedance's biometric trust (video-seedance §7). The CDN url goes
          // separately so the backend can pass it BY URL, verbatim (the Trusted-Output fix);
          // the local raw PNG is only a fallback for when that url has expired.
          lastFrame: clip.lastFrameLocalPath || '',
          lastFrameUrl: clip.lastFrameUrl || '',
        })
        if (!isCurrentProject()) return   // project switched mid-render — never write cross-project
        const served = `${API_BASE}/api/asset/serve?path=${encodeURIComponent(data.video_path)}`
        const thumb = data.thumbnail_path
          ? `${API_BASE}/api/asset/serve?path=${encodeURIComponent(data.thumbnail_path)}` : ''
        setSequence((prev) => prev.map((c) => c.shotId === pendingId
          ? { ...c, videoUrl: served, videoLocalPath: data.video_path, thumbnailUrl: thumb,
              previewUrl: '', duration: data.duration || secs, status: 'ready',
              // This continuation's OWN trusted last-frame (5I) — so extend-of-extend continues
              // from the right frame instead of inheriting the source clip's via spread.
              lastFrameUrl: data.last_frame_url, lastFrameLocalPath: data.last_frame_local_path }
          : c))
        // Don't announce success if the placeholder was undone away mid-render (the map no-op'd).
        if (snapRef.current.sequence.some((c) => c.shotId === pendingId))
          success('Clip extended', `+${data.added_seconds}s after ${srcId}`)
      } catch (e: unknown) {
        if (!isCurrentProject()) return
        setSequence((prev) => prev.filter((c) => c.shotId !== pendingId))   // drop the placeholder
        toastError('Extend failed', e instanceof Error ? e.message : 'error')
      } finally {
        activeRendersRef.current.delete(pendingId)   // handler done → a restored placeholder is now recoverable
      }
    })()
  }

  // How long to make a PAID re-render of this clip — measured, never invented — or null,
  // and then nothing is sent and nothing is charged.
  //
  // `Math.max(4, Math.min(15, Math.round(clipDuration(clip, …)) || clip.duration || 5))`
  // stood at both call sites (Edit and Re-take). clipDuration is 0 for a clip whose take
  // never probed — a reconstructed legacy project — 0 is falsy, and the whole chain
  // collapsed to 5: a 12s shot came back 5s and the cut lost 7s AFTER the render was paid
  // for. The same `||` fires on any clip under half a second too: a 0.4s razor fragment
  // re-rendered at its SOURCE length (12s), i.e. 30× the footage asked for.
  // So an unknown length is MEASURED off the file here, by the same ffprobe the export
  // trims and times subtitles with; a file that will not probe there will not render here
  // either, so the re-render is refused rather than guessed. Seedance's 4-15s window still
  // clamps, but a clamp that changes the cut is said out loud instead of silently applied.
  const renderLengthFor = async (clip: GeneratedShot): Promise<{ secs: number; srcDuration?: number; note: string } | null> => {
    const settings = getSettings(clip.shotId)
    let real = clipSeconds(clip, settings)
    let srcDuration = clip.duration
    // Unmeasured is `null` (a take that would not probe) AND a recorded 0 — both mean the
    // file's length was never established. A trim (outPoint) is a length the USER set, so
    // it is taken as given and never re-measured.
    if (settings.outPoint === null && (real === null || real <= 0)) {
      const path = clip.videoLocalPath || servedPath(clip.videoUrl || '')
      const probed = path ? await pipelineApi.mediaDuration(path).catch(() => null) : null
      if (probed && probed > 0) {
        srcDuration = probed
        real = Math.max(0, probed - settings.inPoint)
        // Keep the measurement: this clip was drawn 0 wide on the timeline and reached the
        // phase-6 gate as "not measured", and it has just been measured by the export's probe.
        setSequence((prev) => prev.map((c) => c.shotId === clip.shotId ? { ...c, duration: probed } : c))
      }
    }
    if (real === null || real <= 0) {
      toastError('Length unknown',
        `${clip.shotId}'s source will not probe, so a re-render would have to guess how long to make it — and the guess is footage you pay for. Re-render the shot in SG (the export refuses this clip too).`)
      return null
    }
    const secs = Math.max(4, Math.min(15, Math.round(real)))
    return {
      secs, srcDuration,
      note: Math.abs(secs - real) < 0.5 ? ''
        : `Its ${real.toFixed(1)}s is outside Seedance's 4-15s window, so the take comes back ${secs}s.`,
    }
  }

  // Non-blocking v2v EDIT: replace the selected clip in place with a "rendering" placeholder,
  // close the modal, and finish in the background. On failure the ORIGINAL clip is restored
  // (an edit is a swap, not an insertion), so a failed edit never loses the shot.
  const handleEditClip = async () => {
    const clip = selectedVideoClip
    if (!clip || !(clip.videoLocalPath || clip.videoUrl)) { toastError('Select a clip', 'Click a video clip on the timeline first.'); return }
    const note = editPrompt.trim()
    if (!note) { toastError('Describe the change', 'Say what to add or transform (e.g. "three ships on the horizon").'); return }
    const len = await renderLengthFor(clip)
    if (!len) return              // unmeasurable — refused before anything is submitted
    const secs = len.secs
    const srcId = clip.shotId
    editCounterRef.current += 1
    const pendingId = `${srcId}-EDIT-${editCounterRef.current}`
    const refs = [...editRefs]
    const original = clip   // restore this exact clip if the edit fails

    // Keep the ORIGINAL media on the placeholder (the animating overlay covers it) so a mid-render
    // reload persists real media — otherwise a stranded edit on a non-SG clip (razor-split / a
    // continuation / a prior edit) would have nothing to restore and the clip would be lost.
    const placeholder: GeneratedShot = {
      // srcDuration carries a length renderLengthFor had to measure, so replacing the clip
      // with this placeholder doesn't drop the measurement back to unknown.
      ...clip, shotId: pendingId, status: 'animating', previewUrl: '', lastFrameUrl: '',
      duration: len.srcDuration,
    }
    pushHistory()   // one undo step for the whole Edit (the async completion adds none)
    activeRendersRef.current.add(pendingId)   // this placeholder has a LIVE handler → not stranded
    setSequence((prev) => prev.map((c) => c.shotId === srcId ? placeholder : c))   // replace in place
    setEditOpen(false); setEditPrompt(''); setEditRefs([])
    success('Editing…', `Applying the change to ${srcId} — keep working.${len.note ? ` ${len.note}` : ''}`)

    void (async () => {
      try {
        const data = await pipelineApi.editShot({
          shotId: srcId, videoPath: clip.videoLocalPath || '', videoUrl: clip.videoUrl || '',
          note, duration: secs, projectName, projectPath: localFolderRoot ?? '',
          style, ratio: aspectRatio, resolution: outputResolution,
          clipId: `${srcId}-edit`, referenceImages: refs, generateAudio: true,
        })
        if (!isCurrentProject()) return
        const served = `${API_BASE}/api/asset/serve?path=${encodeURIComponent(data.video_path)}`
        const thumb = data.thumbnail_path
          ? `${API_BASE}/api/asset/serve?path=${encodeURIComponent(data.thumbnail_path)}` : ''
        setSequence((prev) => prev.map((c) => c.shotId === pendingId
          ? { ...c, videoUrl: served, videoLocalPath: data.video_path, thumbnailUrl: thumb,
              previewUrl: '', duration: data.duration || secs, status: 'ready',
              // The EDITED clip's OWN trusted last-frame (5I) — so a later Extend continues from
              // the edited frame, not the source clip's (which it would inherit via spread).
              lastFrameUrl: data.last_frame_url, lastFrameLocalPath: data.last_frame_local_path }
          : c))
        // Record the edit in the SHARED take history (under the source shot id) so it's visible
        // + selectable from Stage 5 too — same unification as the re-take above (2026-07-23).
        addShotVersion(srcId, {
          videoLocalPath: data.video_path,
          resolution: outputResolution,
          lastFrameUrl: data.last_frame_url,
          notes: `Stage-6 edit: ${note}`,
          status: 'draft',
        })
        // Don't announce success if the placeholder was undone away mid-render (the map no-op'd).
        if (snapRef.current.sequence.some((c) => c.shotId === pendingId))
          success('Shot edited', `Applied the change to ${srcId}`)
      } catch (e: unknown) {
        if (!isCurrentProject()) return
        setSequence((prev) => prev.map((c) => c.shotId === pendingId ? original : c))   // restore original
        toastError('Edit failed', e instanceof Error ? e.message : 'error')
      } finally {
        activeRendersRef.current.delete(pendingId)   // handler done → a restored placeholder is now recoverable
      }
    })()
  }

  // Re-take (5B): re-animate the shot i2v from its keyframe with a fresh user direction sent
  // VERBATIM as promptOverride via the Stage-5 /api/video/create path — zero new backend.
  // createVideoTask is task-based, so it runs the same create→poll→save dance as
  // FinalGenView.animateShot. Replace-in-place; the source shot stays versioned on disk.
  const handleRetakeClip = async () => {
    const clip = selectedVideoClip
    if (!clip) { toastError('Select a clip', 'Click a video clip on the timeline first.'); return }
    const note = retakePrompt.trim()
    if (!note) { toastError('Describe the take', 'Say how to re-perform this shot (action, camera, mood).'); return }
    const len = await renderLengthFor(clip)
    if (!len) return              // unmeasurable — refused before anything is submitted
    const secs = len.secs
    const srcId = clip.shotId
    overlayCounterRef.current += 1
    const overlayId = `${srcId}-RETAKE-${overlayCounterRef.current}`
    // i2v first_frame ANCHOR: prefer the never-expiring keyframe, else the clip's OWN trusted
    // last-frame (5I — a byte-exact Seedance output that passes the filter), else its thumbnail.
    // Storyboard-mode shots have NO keyframe, so without the last-frame fallback imageUrl was
    // EMPTY → Seedance ran t2v from the bare note and HALLUCINATED an unrelated scene (a kitchen
    // for a "lengthen the blue character's appearance" note, 2026-07-23). The anchor keeps the
    // re-take inside THIS shot's scene.
    const imageUrl = clip.keyframeLocalPath
      ? `${API_BASE}/api/asset/serve?path=${encodeURIComponent(clip.keyframeLocalPath)}`
      : clip.lastFrameLocalPath
      ? `${API_BASE}/api/asset/serve?path=${encodeURIComponent(clip.lastFrameLocalPath)}`
      : (clip.thumbnailUrl || '')
    const autoPrompt = clip.assembledPrompt ?? ''
    // 5C: mount the take on the V2 layer at V1's position for this shot (does NOT replace
    // V1 — the original stays underneath). offsets is the packed timeline start of each clip.
    const srcIdx = sequence.findIndex((s) => s.shotId === srcId)
    const timelineStart = srcIdx >= 0 ? (offsets[srcIdx] ?? 0) : 0

    setRetakeOpen(false); setRetakePrompt('')
    success('Re-taking…', `Re-animating ${srcId} onto a V2 layer — keep working.${len.note ? ` ${len.note}` : ''}`)

    void (async () => {
      try {
        // 1) create the task — promptOverride rides VERBATIM (server.py promptOverride branch).
        const task = await pipelineApi.createVideoTask({
          shotId: srcId, imageUrl,
          prompt: autoPrompt || srcId,   // fallback only; overridden by promptOverride
          // Re-take = re-perform THIS shot with a directorial change, NOT a fresh scene. Send the
          // shot's OWN assembled prompt as the base + the note as the change, so Seedance keeps
          // the scene/characters/wardrobe (the bare note alone hallucinated an unrelated scene).
          promptOverride: autoPrompt
            ? `${autoPrompt}\n\nRE-TAKE DIRECTION (apply this change; keep the SAME shot, scene, characters and wardrobe): ${note}`
            : note,
          durationSecs: secs, style, ratio: aspectRatio, resolution: outputResolution,
          generateAudio: true, projectName, projectPath: localFolderRoot ?? '',
        })
        const taskId = task.task_id
        if (!taskId) throw new Error((task as { error?: string }).error || 'No task ID returned')
        const assembled = task.assembled_prompt ?? note
        // 2) poll until the render finishes (renders run minutes; mirror pollUntilDone).
        let done: { video_url?: string; seed?: number; last_frame_url?: string; resolution?: string } | null = null
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 5000))
          const res = await pipelineApi.pollVideoTask(taskId) as {
            status?: string; video_url?: string; seed?: number; last_frame_url?: string; resolution?: string; error?: string }
          if (res.status === 'completed' && res.video_url) { done = res; break }
          if (res.status === 'failed') throw new Error(res.error || 'Seedance render failed')
        }
        if (!done?.video_url) throw new Error('Re-take still running after 10 minutes — reload to recover')
        if (!isCurrentProject()) return   // project switched mid-render — never write cross-project
        // 3) persist to disk (CDN url 403s in ~24h); saved as a NEW version of the source shot.
        const saved = await pipelineApi.saveShotVideo(srcId, done.video_url, projectName, localFolderRoot ?? '', {
          seed: done.seed, resolution: done.resolution, prompt: assembled,
          autoPrompt, promptOverride: note, taskId, lastFrameUrl: done.last_frame_url,
        })
        if (!isCurrentProject()) return
        const served = `${API_BASE}/api/asset/serve?path=${encodeURIComponent(saved.local_path)}`
        const preview = saved.preview_path
          ? `${API_BASE}/api/asset/serve?path=${encodeURIComponent(saved.preview_path)}` : ''
        const overlayShot: GeneratedShot = {
          ...clip, shotId: overlayId, videoUrl: served, videoLocalPath: saved.local_path,
          previewUrl: preview, thumbnailUrl: clip.thumbnailUrl, duration: secs, status: 'ready',
          assembledPrompt: assembled, lastFrameLocalPath: saved.last_frame_local_path || '',
        }
        // 5C: mount on V2. pushHistory HERE (not at start) so the mount is one clean undo
        // step that removes just the overlay; store setters run OUTSIDE any setState updater.
        pushHistory()
        setOverlayClips((prev) => [...prev, {
          id: overlayId, sourceShotId: srcId, shot: overlayShot,
          timelineStart, inPoint: 0, outPoint: secs, volume: 1, fadeIn: 0, fadeOut: 0,
        }])
        setSelectedOverlayId(overlayId); setLastSelected({ kind: 'overlay', id: overlayId })
        // Record the re-take in the SHARED take history (under the SOURCE shot id) so it shows
        // up + is selectable in Stage 5's take list too — a Stage-6 re-take used to live only on
        // the V2 overlay, so from Stage 5 there was "no way to know it existed" (2026-07-23).
        addShotVersion(srcId, {
          videoLocalPath: saved.local_path,
          videoUrl: done.video_url,
          previewUrl: preview || undefined,
          seedanceTaskId: taskId,
          resolution: done.resolution,
          lastFrameUrl: done.last_frame_url,
          assembledPrompt: assembled,
          notes: `Stage-6 re-take: ${note}`,
          status: 'draft',
        })
        success('Re-take on V2', `Mounted the ${srcId} re-take on the V2 layer (V1 kept)`)
      } catch (e: unknown) {
        if (!isCurrentProject()) return
        toastError('Re-take failed', e instanceof Error ? e.message : 'error')
      }
    })()
  }

  const handleAudioFile = async (file: File) => {
    setUploadingMusic(true)
    try {
      // Read the source duration locally (for the clip's out-point) + base64 upload.
      const objUrl = URL.createObjectURL(file)
      const srcDuration = await new Promise<number>((resolve) => {
        const a = new Audio(); a.preload = 'metadata'
        a.onloadedmetadata = () => resolve(isFinite(a.duration) ? a.duration : 0)
        a.onerror = () => resolve(0)
        a.src = objUrl
      })
      URL.revokeObjectURL(objUrl)
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = () => reject(new Error('read failed')); r.readAsDataURL(file)
      })
      const data = await pipelineApi.uploadSoundtrack({ projectName, projectPath: localFolderRoot ?? '', filename: file.name, dataB64: dataUrl })
      // `srcDuration > 0 ? srcDuration : 30` stood here, and the 30 was not a placeholder
      // the mix later corrected: outPoint IS the atrim end in the export, so a bed the
      // browser could not decode was CUT at 30s. Measured on a real export — a 44.4s film
      // with a 60s bed went to digital silence (-91 dB) from t=30 to the end. The file is
      // on disk now, so measure it with the export's own ffprobe instead of naming a number.
      const dur = srcDuration > 0 ? srcDuration
        : (await pipelineApi.mediaDuration(data.path).catch(() => null)) ?? 0
      if (dur <= 0) {
        toastError('Length unknown',
          `${data.name} is saved in the project but neither the browser nor ffprobe can measure it, and a bed placed at a guessed length is cut to that guess in the mix. Convert it (WAV or MP3) and add it again.`)
        return
      }
      const clip: AudioClip = {
        id: `aud_${Date.now()}`, path: data.path, name: data.name, srcDuration: dur,
        timelineStart: 0, inPoint: 0, outPoint: dur, volume: 0.7, fadeIn: 0, fadeOut: 0,
        // An upload is accept="audio/*" — it can be a bed, a voice-over or a door slam,
        // and nothing here says which (the filename is a guess, not a signal). Default to
        // NOT ducking, because the two failures are not symmetric: a bed that doesn't duck
        // is a LEVEL, audible in the preview and fixable with the fader; a VO or an effect
        // that ducks is squashed by a compressor keyed on someone else's dialogue, and
        // ducking never happens in the live preview — so that one is only discovered after
        // a full render. The clip's `duck` pill turns it on in one click for a bed.
        duck: false,
      }
      pushHistory()
      setAudioClips((prev) => [...prev, clip])
      setSelectedAudioId(clip.id)
      success('Audio added', data.name)
    } catch (e: unknown) {
      toastError('Audio upload failed', e instanceof Error ? e.message : 'error')
    } finally {
      setUploadingMusic(false)
    }
  }
  const patchAudio = (id: string, patch: Partial<AudioClip>) =>
    setAudioClips((prev) => prev.map((c) => c.id === id ? { ...c, ...patch } : c))
  const razorAudio = (id: string, local: number) => {
    pushHistory()
    setAudioClips((prev) => {
      const c = prev.find((x) => x.id === id); if (!c) return prev
      const cutAt = c.inPoint + local
      const a: AudioClip = { ...c, id: `${c.id}_a`, outPoint: cutAt, fadeOut: 0 }
      const b: AudioClip = { ...c, id: `${c.id}_b`, inPoint: cutAt, timelineStart: c.timelineStart + local, fadeIn: 0 }
      return prev.flatMap((x) => x.id === id ? [a, b] : [x])
    })
  }

  // The body POST /api/edit/render takes — built HERE, once, for BOTH export paths.
  // The autopilot used to assemble its own copy of this object and it had drifted: it
  // omitted `audio_clips` entirely, and RenderRequest defaults that to [], so every
  // auto-gated export shipped with no music and no imported audio — silently, and then
  // auto-approved. Anything the render needs goes in this function, never at a call site.
  const buildRenderPayload = useCallback(() => ({
    project_name: projectName,
    project_path: localFolderRoot ?? '',
    edl: buildEDL(),
    output_format: exportInfo.format,
    resolution: outputResolution,
    audio_clips: audioClips.map((c) => ({
      path: c.path, timeline_start: c.timelineStart, in_point: c.inPoint,
      out_point: c.outPoint, volume: c.volume, fade_in: c.fadeIn, fade_out: c.fadeOut,
      // This was never sent, so every clip took the server default (True) and
      // force-ducked: an imported voice-over dipped under the programme's own
      // dialogue and a gunshot landed at half level, with no way to say otherwise.
      // `?? true` only catches clips persisted before the flag existed — those were
      // mixed ducked, and silently un-ducking an old project's bed is its own bug.
      duck: c.duck ?? true,
    })),
    master_volume: masterVolume,   // 5K: baked into every clip's audio in the export
    overlay_clips: overlayClips.map((o) => ({   // 5C: V2 overlays composited on top
      path: o.shot.videoLocalPath || o.shot.videoUrl || '', timeline_start: o.timelineStart,
      in_point: o.inPoint, out_point: o.outPoint, volume: o.volume, fade_in: o.fadeIn, fade_out: o.fadeOut,
    })),
  }), [projectName, localFolderRoot, buildEDL, exportInfo, outputResolution, audioClips, masterVolume, overlayClips])

  const handleRender = async () => {
    setIsExporting(true)
    updateAgent('seedance', { status: 'active', detail: 'ffmpeg rendering…', progress: 5 })
    try {
      const { data } = await apiClient.post<RenderResponse>(
        '/api/edit/render',
        buildRenderPayload(),
        { timeout: 600_000 }  // 10 min timeout for long renders
      )
      setExportResult(data)
      const versionId = commitVersion(6, {
        sequence: sequence.map((s) => s.shotId),
        exportFormats: [exportInfo.label],
        exportUrl: data.output_path,
      })
      approveVersion(6, versionId)
      updateAgent('seedance', { status: 'completed', detail: `Render complete: ${data.filename}`, progress: 100 })
      success('Render complete', data.output_path)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Render failed'
      updateAgent('seedance', { status: 'error', detail: msg })
    } finally {
      setIsExporting(false)
    }
  }

  // P5c.5: Autopilot runner — assemble + export the final cut. The sequence is
  // the approved, rendered shots in order (the stage's default). Gate: auto →
  // ffmpeg-render the cut with the default format, commit, and approve only when
  // nothing is missing from it (done) — else commit unapproved and hand over (paused);
  // manual → leave delivery to the user to arrange/preview/export (paused).
  // QC is advisory and skipped here. Export writes only to the project's local
  // folder (no external publish), so auto-export is safe under the auto gate.
  const autopilotStage6 = useCallback(async (): Promise<AutopilotResult> => {
    if (!sequence.length) return 'error'
    if (gateMode !== 'auto') return 'paused'  // human finishes the delivery
    setIsExporting(true)
    updateAgent('seedance', { status: 'active', detail: 'Autopilot: rendering final cut…', progress: 5 })
    try {
      // Same payload as the manual export, from the same builder — this path used to
      // build its own and had silently lost the whole audio track (see buildRenderPayload).
      const { data } = await apiClient.post<RenderResponse>(
        '/api/edit/render',
        buildRenderPayload(),
        { timeout: 600_000 },
      )
      setExportResult(data)
      const versionId = commitVersion(6, {
        sequence: sequence.map((s) => s.shotId),
        exportFormats: [exportInfo.label],
        exportUrl: data.output_path,
      })
      // COMMIT always — the file is on disk and the version is how it is found again.
      // APPROVE only a cut nothing is missing from. Blocking vs advisory, the same split
      // the breakdown's gate makes in AutopilotController: `audio_note` means the finished
      // film measures as digital silence, and stranded shots mean footage the director
      // approved never reached the timeline. Auto-approving either is how a deliverable
      // with a whole layer missing gets signed off unattended — which is exactly what the
      // missing audio_clips produced. A subtitle gap is advisory: the film itself is
      // complete, so it is said out loud and the run carries on.
      const missing = data.audio_note
        || (strandedShots.length
          ? `${strandedShots.length} approved shot(s) never rendered and are not in this cut: `
            + strandedShots.map((s) => s.shotId).join(', ')
          : '')
      if (missing) {
        updateAgent('seedance', {
          status: 'completed', progress: 100,
          detail: `Rendered ${data.filename} — NOT approved: ${missing}`,
        })
        toastError('Export not approved', missing)
        return 'paused'
      }
      if (data.subtitles_note) toastError('Subtitle notes', data.subtitles_note)
      approveVersion(6, versionId)
      updateAgent('seedance', { status: 'completed', detail: `Render complete: ${data.filename}`, progress: 100 })
      return 'done'
    } catch (e: unknown) {
      updateAgent('seedance', { status: 'error', detail: e instanceof Error ? e.message : 'Render failed' })
      return 'error'
    } finally {
      setIsExporting(false)
    }
  }, [sequence, gateMode, exportInfo, strandedShots, buildRenderPayload, commitVersion, approveVersion, updateAgent, toastError])
  useEffect(() => registerAutopilotRunner(6, autopilotStage6), [autopilotStage6])

  if (stage5.status !== 'approved') {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <StageHeader stageId={6} label="Final Cut & Export" />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-text-muted">
            <Scissors size={32} className="mx-auto mb-3 text-cyan/30" />
            <p className="text-sm">Approve Final Scene Gen in Stage 5 first.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StageHeader stageId={6} label="Final Cut & Export" />

      {/* Item 8: approved-but-unrendered shots are flagged, never silently exported */}
      {strandedShots.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-amber/10 border-b border-amber/30 shrink-0 flex-wrap"
          data-testid="stranded-shots-warning">
          <span className="text-[12px] text-amber font-semibold">
            {strandedShots.length} approved shot(s) have no rendered video and are NOT on the timeline:
            {' '}{strandedShots.map((s) => s.shotId).join(', ')}
          </span>
          <button
            onClick={() => goToStage(5)}
            className="px-2 py-1 rounded border border-amber/50 bg-amber/15 text-amber text-[11px] font-semibold hover:bg-amber/25 transition-colors"
            data-testid="back-to-sg"
          >
            ← Back to SG
          </button>
        </div>
      )}

      {/* A newer SG take exists for clip(s) on this timeline — OFFER it, never swap the
          cut underneath the user (that used to wipe Final-Cut work silently). */}
      {pendingTakeUpdates.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-cyan/10 border-b border-cyan/30 shrink-0 flex-wrap"
          data-testid="new-take-banner">
          <span className="text-[12px] text-cyan font-semibold">
            {pendingTakeUpdates.length === 1
              ? `${pendingTakeUpdates[0].shotId} has a new take from SG — update this clip?`
              : `${pendingTakeUpdates.length} shots have a new take from SG — update these clips?`}
          </span>
          <span className="text-[11px] text-text-muted">
            Your cut stays as-is until you choose. Updating is undoable (⌘Z).
          </span>
          <button
            onClick={applyTakeUpdates}
            className="ml-auto px-2 py-1 rounded border border-cyan/50 bg-cyan/15 text-cyan text-[11px] font-semibold hover:bg-cyan/25 transition-colors"
            data-testid="apply-new-takes"
          >
            Update {pendingTakeUpdates.length > 1 ? `all (${pendingTakeUpdates.length})` : 'clip'}
          </button>
          <button
            onClick={() => setPendingTakeUpdates([])}
            className="px-2 py-1 rounded border border-border text-text-muted text-[11px] font-semibold hover:text-text-primary hover:border-text-dim transition-colors"
            data-testid="dismiss-new-takes"
          >
            Keep current
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-elevated border-b border-border shrink-0 flex-wrap gap-y-2">
        <Button variant="primary" size="sm" icon={<ShieldCheck size={13} />}
          loading={isQcRunning} onClick={handleRunQC}>
          Film Director QC
        </Button>

        <div className="h-4 w-px bg-border" />

        {/* Razor now lives in the timeline tool palette below (bottom bar), not here */}
        <Button variant="ghost" size="sm" icon={<Save size={11} />} onClick={handleSaveEDL}>
          Save EDL
        </Button>

        <div className="h-4 w-px bg-border" />

        {/* Extend the selected clip — animate a continuation, inserted right after */}
        <Button variant="secondary" size="sm" icon={<Film size={12} />}
          disabled={!selectedVideoClip}
          onClick={() => { setExtendOpen(true) }}
          title={selectedVideoClip ? `Extend ${selectedVideoClip.shotId}` : 'Select a clip on the timeline first'}
          data-testid="extend-clip">
          Extend clip
        </Button>

        {/* Edit the selected clip — v2v VFX transform (add ships, explosion, relight), in place */}
        <Button variant="secondary" size="sm" icon={<Wand2 size={12} />}
          disabled={!selectedVideoClip}
          onClick={() => { setEditOpen(true) }}
          title={selectedVideoClip ? `Edit ${selectedVideoClip.shotId} (add VFX / transform)` : 'Select a clip on the timeline first'}
          data-testid="edit-clip">
          Edit clip
        </Button>

        {/* Re-take the selected clip — re-animate from its keyframe with a fresh direction, in place */}
        <Button variant="secondary" size="sm" icon={<Clapperboard size={12} />}
          disabled={!selectedVideoClip}
          onClick={() => { setRetakeOpen(true) }}
          title={selectedVideoClip ? `Re-take ${selectedVideoClip.shotId} (re-animate with a new direction)` : 'Select a clip on the timeline first'}
          data-testid="retake-clip">
          Re-take
        </Button>

        {/* Reset the timeline to the approved SG shots in order (clears splits/dupes) */}
        <Button variant="ghost" size="sm" icon={<RotateCcw size={12} />}
          onClick={handleResetTimeline}
          title="Reset the timeline to the approved SG shots, in order"
          data-testid="reset-timeline">
          Reset timeline
        </Button>

        <div className="h-4 w-px bg-border" />

        <span className="text-[11px] text-text-muted font-mono">
          {sequence.length} clips · {formatTimecode(totalRuntime)}
        </span>

        {exportResult && (
          <span className="flex items-center gap-1.5 text-green text-[11px] font-semibold ml-2">
            <CheckCircle size={12} /> {exportResult.filename}
          </span>
        )}
      </div>

      {/* Main layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Left clip list removed — the bottom timeline is now the editor (trim,
            razor, move, delete, transitions all live there). JSX hidden for now;
            deleted in a follow-up cleanup. */}
        <div className="hidden">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between shrink-0">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Sequence</p>
            <span className="text-[10px] text-cyan font-mono">{sequence.length} clips</span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            {sequence.map((shot, i) => {
              const isActive = shot.shotId === previewId
              const settings = getSettings(shot.shotId)
              const dur = clipDuration(shot, settings)

              return (
                <div key={shot.shotId} className="flex flex-col gap-1">
                  {/* Crossfade badge between clips */}
                  {i > 0 && (
                    <button
                      onClick={() => {
                        const current = getSettings(shot.shotId).transitionIn
                        updateSettings(shot.shotId, {
                          transitionIn: current ? null : { type: 'crossfade', dur: 0.5 },
                        })
                      }}
                      className={cn(
                        'flex items-center gap-1 mx-auto px-2 py-0.5 rounded text-[9px] font-semibold border transition-all',
                        settings.transitionIn
                          ? 'text-cyan border-cyan/40 bg-cyan/10'
                          : 'text-text-dim border-border/50 hover:border-border hover:text-text-muted',
                      )}
                    >
                      <Blend size={9} />
                      {settings.transitionIn ? `Fade ${settings.transitionIn.dur}s` : '| Cut'}
                    </button>
                  )}

                  {/* Clip row */}
                  <div
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => handleDragOver(e, i)}
                    onDrop={() => handleDrop(i)}
                    onDragEnd={() => { setDragIndex(null); setDragOver(null) }}
                    onClick={() => {
                      if (razorActive) {
                        // split at the playhead if it's inside this clip, else midpoint
                        const off = offsets[i] ?? 0
                        const d = durations[i] ?? 1
                        const fromPh = playhead - off
                        handleRazorAt(shot.shotId, (fromPh > 0.1 && fromPh < d - 0.1) ? fromPh : d / 2)
                      } else setPreviewId(shot.shotId)
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-lg px-2 py-2 border transition-all',
                      razorActive ? 'cursor-crosshair' : 'cursor-pointer',
                      isActive
                        ? 'bg-cyan/10 border-cyan/40 shadow-[var(--shadow-neon-cyan)]'
                        : 'bg-elevated border-border hover:border-cyan/30',
                      dragOver === i && 'border-orange/60 bg-orange/5',
                      dragIndex === i && 'opacity-40',
                    )}
                  >
                    <GripVertical size={12} className="text-text-dim shrink-0 cursor-grab" />

                    <div className="w-12 h-7 rounded overflow-hidden bg-bg shrink-0 border border-border">
                      {shot.videoUrl ? (
                        <video src={shot.videoUrl} className="w-full h-full object-cover" muted />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-text-dim text-[7px] font-mono">
                          {shot.shotId}
                        </div>
                      )}
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-mono text-text-primary truncate">{shot.shotId}</p>
                      <p className="text-[9px] text-text-muted font-mono">{dur.toFixed(1)}s</p>
                    </div>

                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button onClick={(e) => { e.stopPropagation(); moveShot(i, -1) }} disabled={i === 0}
                        className="text-text-dim hover:text-text-primary disabled:opacity-20 transition-colors">
                        <ChevronUp size={11} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); moveShot(i, 1) }} disabled={i === sequence.length - 1}
                        className="text-text-dim hover:text-text-primary disabled:opacity-20 transition-colors">
                        <ChevronDown size={11} />
                      </button>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeShot(shot.shotId) }}
                      className="text-text-dim hover:text-red transition-colors shrink-0 p-0.5">
                      <Trash2 size={11} />
                    </button>
                  </div>

                  {/* Trim controls (expanded only for active clip) */}
                  {isActive && (
                    <div className="bg-elevated/60 rounded border border-border p-2 flex flex-col gap-2 ml-2 mr-1">
                      <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Trim</p>
                      {shot.duration === undefined ? (
                        // No measured source length, so there is nothing to trim AGAINST —
                        // both sliders would be scaled to a made-up maximum. Say so.
                        <p className="text-[9px] text-amber">Source length not measured — re-render this shot to trim it.</p>
                      ) : (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <label className="text-[9px] text-text-muted w-6">In</label>
                          <input
                            type="range"
                            min={0}
                            max={shot.duration}
                            step={0.1}
                            value={settings.inPoint}
                            onChange={(e) => updateSettings(shot.shotId, { inPoint: parseFloat(e.target.value) })}
                            className="flex-1 h-1"
                          />
                          <span className="text-[9px] font-mono text-cyan w-8 text-right">
                            {settings.inPoint.toFixed(1)}s
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-[9px] text-text-muted w-6">Out</label>
                          <input
                            type="range"
                            min={0}
                            max={shot.duration}
                            step={0.1}
                            value={settings.outPoint ?? shot.duration}
                            onChange={(e) => updateSettings(shot.shotId, { outPoint: parseFloat(e.target.value) })}
                            className="flex-1 h-1"
                          />
                          <span className="text-[9px] font-mono text-cyan w-8 text-right">
                            {(settings.outPoint ?? shot.duration).toFixed(1)}s
                          </span>
                        </div>
                      </div>
                      )}

                      {settings.transitionIn && (
                        <div className="flex items-center gap-2">
                          <label className="text-[9px] text-text-muted w-12">Fade in</label>
                          <input
                            type="range"
                            min={0.1}
                            max={2.0}
                            step={0.1}
                            value={settings.transitionIn.dur}
                            onChange={(e) => updateSettings(shot.shotId, {
                              transitionIn: { type: 'crossfade', dur: parseFloat(e.target.value) },
                            })}
                            className="flex-1 h-1"
                          />
                          <span className="text-[9px] font-mono text-cyan w-8 text-right">
                            {settings.transitionIn.dur.toFixed(1)}s
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Timeline ruler */}
          <div className="border-t border-border px-3 py-2 shrink-0">
            <div className="relative h-5 bg-elevated rounded overflow-hidden">
              {sequence.map((shot, i) => {
                const dur = clipDuration(shot, getSettings(shot.shotId))
                const pct = totalRuntime > 0 ? (dur / totalRuntime) * 100 : 0
                const offset = totalRuntime > 0
                  ? (sequence.slice(0, i).reduce((a, s) => a + clipDuration(s, getSettings(s.shotId)), 0) / totalRuntime) * 100
                  : 0
                return (
                  <div
                    key={shot.shotId}
                    onClick={() => setPreviewId(shot.shotId)}
                    className={cn(
                      'absolute top-0 h-full border-r border-bg/50 transition-all cursor-pointer',
                      shot.shotId === previewId ? 'bg-cyan/50' : 'bg-cyan/15 hover:bg-cyan/25',
                    )}
                    style={{ left: `${offset}%`, width: `${pct}%` }}
                    title={`${shot.shotId} · ${dur.toFixed(1)}s`}
                  />
                )
              })}
            </div>
            <div className="flex justify-between text-[9px] text-text-dim font-mono mt-0.5">
              <span>00:00:00</span>
              <span>{formatTimecode(totalRuntime)}</span>
            </div>
          </div>
        </div>

        {/* Center: preview player */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <div className="flex-1 bg-black flex items-center justify-center relative min-h-0">
            {seqClips.length > 0 ? (
              <SequencePlayer
                ref={playerRef}
                clips={seqClips}
                offsets={offsets}
                onTime={(g) => { setPlayhead(g); playheadRef.current = g }}
                onActiveIndexChange={(i) => { const s = sequence[i]; if (s) setPreviewId(s.shotId) }}
                onPlayingChange={setPlaying}
                masterVolume={masterVolume}
                overlays={overlaySeqClips}
              />
            ) : (
              <div className="flex flex-col items-center gap-3 text-text-muted">
                <Film size={36} className="text-cyan/30" />
                <p className="text-sm">Select a clip to preview</p>
              </div>
            )}
            {/* Hidden picker for "Add audio" on the timeline toolbar */}
            <input
              ref={audioFileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              data-testid="audio-input"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAudioFile(f); e.target.value = '' }}
            />
          </div>

          {/* QC banner */}
          {qcResult && (
            <div className="border-t border-border">
              <QCActionCard
                qcResult={qcResult}
                context="Final Cut"
                isRunning={isQcRunning}
                onRegenerate={() => {}}
              />
            </div>
          )}

          {/* DaVinci-style editing timeline (the primary editor) */}
          {sequence.length > 0 && (
            <div className="border-t border-border bg-surface px-3 py-2 shrink-0">
              {/* Transport: jump-to-start / prev clip / play-pause / next clip */}
              <div className="flex items-center justify-center gap-1.5 mb-1.5">
                <button
                  onClick={() => seekGlobal(0)}
                  title="Jump to start"
                  data-testid="transport-start"
                  className="p-1.5 rounded border border-border text-text-muted hover:text-text-primary hover:border-text-dim"
                ><ChevronFirst size={15} /></button>
                <button
                  onClick={() => { const i = sequence.findIndex((s) => s.shotId === previewId); if (i > 0) seekGlobal(offsets[i - 1]) }}
                  title="Previous clip"
                  data-testid="transport-prev"
                  className="p-1.5 rounded border border-border text-text-muted hover:text-text-primary hover:border-text-dim"
                ><SkipBack size={14} /></button>
                <button
                  onClick={() => {
                    const next = !playing
                    // Replay from the start when parked at the end (else Play no-ops on the last
                    // clip's final frame). seek runs while `playing` is still false → no double audio.
                    if (next && playheadRef.current >= totalRuntime - 0.05) seekGlobal(0)
                    setPlaying(next)                                    // authoritative intent — button can't desync
                    if (next) playerRef.current?.play(); else playerRef.current?.pause()
                  }}
                  title={playing ? 'Pause' : 'Play'}
                  data-testid="transport-play"
                  className="p-1.5 rounded border border-cyan/50 bg-cyan/10 text-cyan hover:bg-cyan/20"
                >{playing ? <Pause size={16} /> : <Play size={16} />}</button>
                <button
                  onClick={() => { const i = sequence.findIndex((s) => s.shotId === previewId); if (i >= 0 && i < sequence.length - 1) seekGlobal(offsets[i + 1]) }}
                  title="Next clip"
                  data-testid="transport-next"
                  className="p-1.5 rounded border border-border text-text-muted hover:text-text-primary hover:border-text-dim"
                ><SkipForward size={14} /></button>
                <div className="w-px h-5 bg-border mx-0.5" />
                <button
                  onClick={() => { const m = !muted; setMuted(m); playerRef.current?.setMuted(m); engineRef.current?.setMuted(m) }}
                  title={muted ? 'Unmute' : 'Mute'}
                  data-testid="transport-mute"
                  className="p-1.5 rounded border border-border text-text-muted hover:text-text-primary hover:border-text-dim"
                >{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
                {/* 5K: master/bus volume — scales the WHOLE mix (video + audio clips)
                    live and bakes into the export. Capped at 100% because HTML
                    <video>.volume can't exceed 1, so a boost would desync the live
                    preview from the render; a master fader only attenuates. */}
                <div className="flex items-center gap-1 pl-0.5 pr-1" title={`Master volume ${Math.round(masterVolume * 100)}%`}>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={masterVolume}
                    onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
                    data-testid="master-volume"
                    aria-label="Master volume"
                    className="w-16 accent-cyan cursor-pointer"
                  />
                  <span className="text-[9px] font-mono text-text-muted w-6 text-right tabular-nums">{Math.round(masterVolume * 100)}</span>
                </div>
                <button
                  onClick={() => playerRef.current?.requestFullscreen()}
                  title="Fullscreen"
                  data-testid="transport-fullscreen"
                  className="p-1.5 rounded border border-border text-text-muted hover:text-text-primary hover:border-text-dim"
                ><Maximize2 size={14} /></button>
              </div>
              {/* Generate an INSTRUMENTAL soundtrack (Seed Audio 1.0) — you write the
                  prompt + length; the clip drops on the audio track. */}
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-[11px] shrink-0" title="Instrumental music via Seed Audio 1.0">🎵</span>
                <input
                  value={musicPrompt}
                  onChange={(e) => setMusicPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleGenerateMusic() }}
                  placeholder="Describe the soundtrack (e.g. tense sci-fi synth, hopeful strings)…"
                  className="flex-1 bg-elevated border border-border rounded px-2 py-1 text-[10px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50"
                  data-testid="music-prompt"
                />
                <input
                  type="number" min={5} max={600}
                  value={musicSeconds || ''}
                  onChange={(e) => setMusicSeconds(Number(e.target.value) || 0)}
                  placeholder={`${Math.round(totalRuntime) || 15}s`}
                  title="Length in seconds (blank = whole film)"
                  className="w-16 bg-elevated border border-border rounded px-2 py-1 text-[10px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50"
                  data-testid="music-seconds"
                />
                <Button variant="ghost" size="sm" loading={generatingMusic} disabled={!musicPrompt.trim()}
                  onClick={handleGenerateMusic} className="text-[10px] shrink-0">
                  Generate soundtrack
                </Button>
              </div>
              <TimelineTrack
                sequence={sequence}
                durations={durations}
                totalRuntime={totalRuntime}
                previewId={previewId}
                playhead={playhead}
                tool={tool}
                onToolChange={setTool}
                onUndo={undo}
                onRedo={redo}
                canUndo={canUndo}
                canRedo={canRedo}
                getSettings={getSettings}
                // Layout, like clipDuration: an unmeasured take gets no width and no
                // trim range on the timeline rather than a fabricated one.
                sourceDuration={(shot) => shot.duration ?? 0}
                onSelectClip={(shotId) => { setLastSelected({ kind: 'video', id: shotId }); const i = sequence.findIndex((s) => s.shotId === shotId); if (i >= 0) seekGlobal(offsets[i]) }}
                onSeek={seekGlobal}
                onReorder={handleReorder}
                onRazorAt={handleRazorAt}
                onTrim={(shotId, patch) => updateSettings(shotId, patch)}
                onBeforeGesture={pushHistory}
                onToggleTransition={(shotId) => {
                  pushHistory()
                  const cur = getSettings(shotId).transitionIn
                  updateSettings(shotId, { transitionIn: cur ? null : { type: 'crossfade', dur: 0.5 } })
                }}
                onClipVolume={(shotId, vol) => updateSettings(shotId, { volume: vol })}
                onClipFade={(shotId, patch) => updateSettings(shotId, patch)}
                audioClips={audioClips}
                selectedAudioId={selectedAudioId}
                onAddAudio={onAddAudio}
                onSelectAudio={(id) => { setSelectedAudioId(id); setLastSelected({ kind: 'audio', id }) }}
                onAudioPatch={patchAudio}
                onAudioRazorAt={razorAudio}
                audioPeaks={audioPeaks}
                overlayClips={overlayClips}
                selectedOverlayId={selectedOverlayId}
                onSelectOverlay={(id) => { setSelectedOverlayId(id); setLastSelected({ kind: 'overlay', id }) }}
                onOverlayPatch={(id, patch) => setOverlayClips((prev) => prev.map((c) => c.id === id ? { ...c, ...patch } : c))}
              />
              {uploadingMusic && <p className="mt-1 text-[9px] text-cyan">Uploading audio…</p>}
            </div>
          )}
        </div>

        {/* Right: export panel */}
        <div className="w-60 shrink-0 border-l border-border flex flex-col bg-surface overflow-y-auto">
          <div className="px-4 py-3 border-b border-border shrink-0">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Export (P10)</p>
          </div>

          <div className="p-3 flex flex-col gap-3">
            {/* Output size — set in Settings (gear) */}
            <div>
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-2">Output size</p>
              <div className="flex items-start gap-2 p-2 rounded-lg border border-cyan/40 bg-cyan/10" data-testid="export-output-size">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-text-primary">{exportInfo.label}</p>
                  <p className="text-[9px] text-text-muted">{exportInfo.desc}</p>
                  <p className="text-[9px] text-text-dim mt-0.5">Change in Settings (⚙) → Final output size</p>
                </div>
              </div>
            </div>

            {/* Summary */}
            <Card>
              <CardBody className="flex flex-col gap-1 text-[11px] text-text-muted p-3">
                {[
                  ['Clips', sequence.length],
                  ['Runtime', formatTimecode(totalRuntime)],
                  ['Size', exportInfo.label],
                  ['QC', qcResult ? (qcResult.passed ? '✓ Pass' : '⚠ Issues') : '—'],
                ].map(([label, val]) => (
                  <div key={String(label)} className="flex justify-between">
                    <span>{label}</span>
                    <span className="text-cyan font-mono">{String(val)}</span>
                  </div>
                ))}
              </CardBody>
            </Card>

            {exportResult ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-green text-[12px] font-semibold">
                  <CheckCircle size={14} /> Render Complete
                </div>
                <p className="text-[10px] text-text-muted font-mono break-all">{exportResult.filename}</p>
                {/* The subtitle file the render writes beside the film — same mono line as
                    the film's own filename, but openable, because a path in a JSON response
                    that nothing renders is a feature the user cannot reach. */}
                {exportResult.subtitles_path && (
                  <a
                    href={`${API_BASE}/api/asset/serve?path=${encodeURIComponent(exportResult.subtitles_path)}`}
                    download={exportResult.subtitles_path.split('/').pop()}
                    className="flex items-center gap-1.5 text-[10px] text-cyan font-mono break-all hover:underline"
                    data-testid="subtitles-link"
                  >
                    <Download size={11} className="shrink-0" />
                    {exportResult.subtitles_path.split('/').pop()}
                    {exportResult.subtitles_cues ? ` · ${exportResult.subtitles_cues} cues` : ''}
                  </a>
                )}
                {/* Cues that stop early used to be announced in the server log ALONE. */}
                {exportResult.subtitles_note && (
                  <p className="text-[10px] text-amber break-words" data-testid="subtitles-note">
                    {exportResult.subtitles_note}
                  </p>
                )}
                {/* A film that came out silent. The export cannot refuse it — the picture is
                    correct and the file is finished — but it is almost always an upstream
                    failure, and silence is the one defect a delivered file never announces. */}
                {exportResult.audio_note && (
                  <p className="text-[10px] text-amber break-words" data-testid="audio-note">
                    {exportResult.audio_note}
                  </p>
                )}
                {/* Upscale master — AI MediaKit re-renders the EXPORT at 2K/4K/8K and writes the
                    master next to it; the export is never replaced. Runs on the export rather
                    than on the shots so one task pays only the programme's minutes and the
                    ffmpeg pipeline stays at 1080p. The vendor takes inputs up to 2K, so a
                    native-4K export shows the server's note instead of the picker. */}
                <div className="rounded-lg border border-border bg-elevated/40 p-2.5 flex flex-col gap-2" data-testid="upscale-master">
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Upscale master · AI MediaKit</p>
                  {upResult ? (
                    <div className="flex flex-col gap-1" data-testid="upscale-master-done">
                      <div className="flex items-center gap-2 text-green text-[11px] font-semibold"><CheckCircle size={12} /> Master ready</div>
                      <a
                        href={`${API_BASE}/api/asset/serve?path=${encodeURIComponent(upResult.output_path)}`}
                        download={upResult.filename}
                        className="flex items-center gap-1.5 text-[10px] text-cyan font-mono break-all hover:underline"
                        data-testid="upscale-master-link"
                      >
                        <Download size={11} className="shrink-0" />{upResult.filename}
                      </a>
                      <p className="text-[10px] text-text-muted font-mono">
                        {upResult.resolution.toUpperCase()} {upResult.tier} · {upResult.seconds.toFixed(1)}s · ${upResult.usd.toFixed(2)}
                      </p>
                      <button onClick={() => setUpResult(null)} className="text-[10px] text-text-dim hover:text-text-primary text-left">
                        Upscale again with other settings
                      </button>
                    </div>
                  ) : upQuote?.input_note ? (
                    <p className="text-[10px] text-amber break-words" data-testid="upscale-master-note">{upQuote.input_note}</p>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-text-muted w-16 shrink-0">Resolution</span>
                        <div className="flex items-center gap-1 flex-wrap">
                          {UPSCALE_RES.map((o) => (
                            <button key={o.id} onClick={() => { setUpRes(o.id); setUpQuote(null) }} data-testid={`upscale-master-res-${o.id}`} aria-pressed={upRes === o.id}
                              className={cn('px-2 py-0.5 rounded border text-[10px]', upRes === o.id ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>{o.label}</button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-text-muted w-16 shrink-0">Tier</span>
                        <div className="flex items-center gap-1 flex-wrap">
                          {UPSCALE_TIERS.map((o) => (
                            <button key={o.id} onClick={() => { setUpTier(o.id); setUpQuote(null) }} data-testid={`upscale-master-tier-${o.id}`} aria-pressed={upTier === o.id}
                              className={cn('px-2 py-0.5 rounded border text-[10px]', upTier === o.id ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>{o.label}</button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-text-muted w-16 shrink-0">Style</span>
                        <div className="flex items-center gap-1 flex-wrap">
                          {UPSCALE_STYLES.map((o) => (
                            <button key={o.id} onClick={() => { setUpStyle(o.id); setUpQuote(null) }} data-testid={`upscale-master-style-${o.id}`} aria-pressed={upStyle === o.id}
                              className={cn('px-2 py-0.5 rounded border text-[10px]', upStyle === o.id ? 'border-cyan/50 bg-cyan/10 text-cyan' : 'border-border text-text-muted hover:text-text-primary')}>{o.label}</button>
                          ))}
                        </div>
                      </div>
                      <p className="text-[10px] text-text-muted" data-testid="upscale-master-quote">
                        {upQuote === null ? 'Pricing…' : upQuote.usd < 0 ? 'Price unavailable'
                          : `${upQuote.seconds.toFixed(1)}s · $${upQuote.usd.toFixed(2)} — output minutes × the published coefficient`}
                      </p>
                      {upTier === 'standard' && upRes === '8k' && (
                        <p className="text-[10px] text-amber">8K from 1080p is a 4× upscale — Professional (large-model restoration) is the tier that holds up at this size.</p>
                      )}
                      {upError && <p className="text-[10px] text-red break-words" data-testid="upscale-master-error">{upError}</p>}
                      <Button
                        variant="primary" size="sm"
                        icon={<Maximize2 size={12} />}
                        loading={upBusy}
                        onClick={() => void runMasterUpscale()}
                        className="w-full"
                        data-testid="upscale-master-run"
                      >
                        {upBusy ? `Upscaling… ${Math.floor(upElapsed / 60)}:${String(upElapsed % 60).padStart(2, '0')}` : `Upscale to ${upRes.toUpperCase()} · ${UPSCALE_TIERS.find((t) => t.id === upTier)!.label}`}
                      </Button>
                    </>
                  )}
                </div>
                <Button
                  variant="primary" size="sm"
                  icon={<Clapperboard size={12} />}
                  onClick={() => setExportResult(null)}
                  className="w-full"
                >
                  New Render
                </Button>
              </div>
            ) : (
              <Button
                variant="approve"
                icon={<Download size={14} />}
                loading={isExporting}
                onClick={handleRender}
                className="w-full"
              >
                {isExporting ? 'Rendering…' : 'Render Final Cut'}
              </Button>
            )}

            <Button
              variant="ghost"
              size="sm"
              icon={<Save size={12} />}
              onClick={handleSaveEDL}
              className="w-full text-[11px]"
            >
              Save EDL JSON
            </Button>
          </div>
        </div>
      </div>

      {/* Extend clip modal — direction (+ Enhance) + reference images + duration.
          Non-blocking: Extend closes the modal and renders in the background. */}
      {extendOpen && selectedVideoClip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setExtendOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-2xl p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Film size={15} className="text-cyan" />
              <span className="text-sm font-semibold text-text-primary">Extend {selectedVideoClip.shotId}</span>
              <button onClick={() => setExtendOpen(false)} className="ml-auto text-text-muted hover:text-text-primary">✕</button>
            </div>
            <p className="text-[11px] text-text-muted">
              Animates a continuation from this clip&apos;s last frame (Seedance {outputResolution}) and inserts it as a new clip right after — the shot&apos;s screen time grows. Renders in the background.
            </p>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Direction</span>
                <button onClick={enhanceExtend} disabled={extendEnhancing || !extendPrompt.trim()}
                  className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-cyan/40 text-[10px] text-cyan hover:bg-cyan/10 disabled:opacity-40">
                  {extendEnhancing ? <span className="w-3 h-3 border-2 border-cyan border-t-transparent rounded-full animate-spin" /> : <Sparkles size={11} />} Enhance
                </button>
              </div>
              <textarea value={extendPrompt} onChange={(e) => setExtendPrompt(e.target.value)} rows={3}
                placeholder="What continues? (optional — e.g. the ship keeps falling, camera pushes in, embers scatter)"
                className="w-full text-[12px] rounded border border-border bg-bg px-2 py-1.5 resize-none text-text-primary placeholder:text-text-dim focus:border-cyan focus:outline-none" />
            </div>

            {/* 5G: no reference picker — Extend is i2v and drops all reference media; the
                trusted last-frame already anchors the character's identity. */}

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-muted">Length</span>
              <select value={extendSecs} onChange={(e) => setExtendSecs(Number(e.target.value))}
                className="bg-elevated border border-border rounded px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:border-cyan/50">
                {[4, 5, 7, 10, 15].map((n) => <option key={n} value={n}>+{n}s</option>)}
              </select>
              <Button variant="primary" size="sm" icon={<Film size={12} />}
                onClick={handleExtendClip} className="ml-auto">
                Extend
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Edit clip modal — v2v VFX transform (add ships, explosion, relight), applied in place.
          The source clip is the base (look + motion); only the described change is applied. */}
      {editOpen && selectedVideoClip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setEditOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-2xl p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Wand2 size={15} className="text-cyan" />
              <span className="text-sm font-semibold text-text-primary">Edit {selectedVideoClip.shotId}</span>
              <button onClick={() => setEditOpen(false)} className="ml-auto text-text-muted hover:text-text-primary">✕</button>
            </div>
            <p className="text-[11px] text-text-muted">
              Transforms this clip with Seedance {outputResolution} — keeps the subject, framing and camera move, changes only what you describe. Replaces the clip in place (the original is versioned on disk). Renders in the background.
            </p>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">The change</span>
                <button onClick={enhanceEdit} disabled={editEnhancing || !editPrompt.trim()}
                  className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-cyan/40 text-[10px] text-cyan hover:bg-cyan/10 disabled:opacity-40">
                  {editEnhancing ? <span className="w-3 h-3 border-2 border-cyan border-t-transparent rounded-full animate-spin" /> : <Sparkles size={11} />} Enhance
                </button>
              </div>
              <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} rows={3}
                placeholder="What to add or change? (e.g. three ships on the horizon, an explosion in the background, relight to dusk)"
                className="w-full text-[12px] rounded border border-border bg-bg px-2 py-1.5 resize-none text-text-primary placeholder:text-text-dim focus:border-cyan focus:outline-none" />
            </div>

            {/* Reference images — approved assets (identity-safe) or an external upload */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Reference {editRefs.length ? `(${editRefs.length}/9)` : ''}</span>
                <label className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-border text-[10px] text-text-muted hover:border-cyan/40 cursor-pointer">
                  <Upload size={11} /> Upload
                  <input type="file" accept="image/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleEditRefUpload(f); e.target.value = '' }} />
                </label>
              </div>
              {(approvedRefAssets.length > 0 || editRefs.length > 0) ? (
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {approvedRefAssets.map((a) => (
                    <button key={a.id} title={a.name} onClick={() => toggleEditRef(a.path)}
                      className={cn('relative shrink-0 w-12 h-12 rounded overflow-hidden border-2',
                        editRefs.includes(a.path) ? 'border-cyan' : 'border-border hover:border-cyan/50')}>
                      <img src={`${API_BASE}/api/asset/serve?path=${encodeURIComponent(a.path)}`} alt={a.name} className="w-full h-full object-cover" />
                      {editRefs.includes(a.path) && <span className="absolute top-0.5 right-0.5"><CheckCircle size={12} className="text-cyan" /></span>}
                    </button>
                  ))}
                  {editRefs.filter((r) => r.startsWith('data:')).map((r, i) => (
                    <div key={`up${i}`} className="relative shrink-0 w-12 h-12 rounded overflow-hidden border-2 border-cyan">
                      <img src={r} alt="upload" className="w-full h-full object-cover" />
                      <button onClick={() => setEditRefs((prev) => prev.filter((p) => p !== r))}
                        className="absolute top-0 right-0 bg-black/70 text-white p-0.5"><X size={9} /></button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[9px] text-text-dim">Optional — a real texture/face the model keeps faking (fur, a specific prop), or an added element on-model.</p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-dim">Keeps the clip&apos;s length &amp; camera move.</span>
              <Button variant="primary" size="sm" icon={<Wand2 size={12} />}
                onClick={handleEditClip} disabled={!editPrompt.trim()} className="ml-auto">
                Apply edit
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Re-take clip modal (5B) — full re-animate from the keyframe with a fresh direction.
          The ORIGINAL assembled prompt rides read-only as context. No reference picker: i2v
          drops refs and identity lives in the keyframe (same reasoning as Extend). In place. */}
      {retakeOpen && selectedVideoClip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setRetakeOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-border bg-surface shadow-2xl p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <Clapperboard size={15} className="text-cyan" />
              <span className="text-sm font-semibold text-text-primary">Re-take {selectedVideoClip.shotId}</span>
              <button onClick={() => setRetakeOpen(false)} className="ml-auto text-text-muted hover:text-text-primary">✕</button>
            </div>
            <p className="text-[11px] text-text-muted">
              Re-animates this shot from its keyframe with Seedance {outputResolution}, directed by your note below. Replaces the clip in place (the original is versioned on disk). Renders in the background.
            </p>

            {/* Read-only original prompt (context) — the load-bearing new UI vs. Edit */}
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Original prompt (context)</span>
              <div className="max-h-28 overflow-y-auto text-[11px] rounded border border-border bg-bg px-2 py-1.5 text-text-muted whitespace-pre-wrap">
                {selectedVideoClip.assembledPrompt || 'No stored prompt for this clip.'}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">New direction</span>
                <button onClick={enhanceRetake} disabled={retakeEnhancing || !retakePrompt.trim()}
                  className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-cyan/40 text-[10px] text-cyan hover:bg-cyan/10 disabled:opacity-40">
                  {retakeEnhancing ? <span className="w-3 h-3 border-2 border-cyan border-t-transparent rounded-full animate-spin" /> : <Sparkles size={11} />} Enhance
                </button>
              </div>
              <textarea value={retakePrompt} onChange={(e) => setRetakePrompt(e.target.value)} rows={3}
                placeholder="How to re-perform this shot? (e.g. slower push-in, colder mood, the actor turns away at the end)"
                className="w-full text-[12px] rounded border border-border bg-bg px-2 py-1.5 resize-none text-text-primary placeholder:text-text-dim focus:border-cyan focus:outline-none" />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] text-text-dim">Identity rides on the keyframe.</span>
              <Button variant="primary" size="sm" icon={<Clapperboard size={12} />}
                onClick={handleRetakeClip} disabled={!retakePrompt.trim()} className="ml-auto">
                Re-take
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
