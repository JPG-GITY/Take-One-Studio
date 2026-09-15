'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Clapperboard, CheckCircle, Lock, ShieldAlert, Square, CheckSquare, Link2, FileText, CloudUpload } from 'lucide-react'
import { StageHeader } from '@/components/pipeline/StageHeader'
import { PromptPanel } from '@/components/pipeline/PromptPanel'
import { Button } from '@/components/ui/Button'
import { ShotGenerationStrip } from './ShotGenerationStrip'
import { SceneVideoPlayer } from './SceneVideoPlayer'
import { SceneReviewPanel } from './SceneReviewPanel'
import { FilmstripScrubber } from './FilmstripScrubber'
import { usePipelineStore, type ShotRefMedia } from '@/store/pipeline.store'
import { useAgentsStore } from '@/store/agents.store'
import { useToast } from '@/components/ui/Toast'
import { pipelineApi, toVideoCreateBody } from '@/lib/api/pipeline.api'
import { emptyReferenceMedia, type ReferenceMedia } from '@/components/media/ReferenceMediaPanel'
import { registerAutopilotRunner, type AutopilotResult } from '@/lib/autopilotRegistry'
import { useProjectGuard } from '@/lib/useProjectGuard'
import { sanitizeShotMedia } from '@/lib/sanitizeMedia'
import { segmentMaxSecsFor, boardIds, maxImageRefsFor, refToken } from '@/lib/segments'
import { isAudioFilterBlock, isIdentityFilterBlock } from '@/lib/seedanceFilters'
import type { GeneratedShot, BreakdownData, Shot, Asset, SceneStoryboardState, ShotBoardState, RenderTier, Segment, SegmentShot } from '@/lib/types/pipeline.types'
import { TIER_ORDER, TIER_FIXED_RESOLUTION, videoCostPer5s, tierRank } from '@/lib/types/pipeline.types'
import type { QCResponse, RenderQueueJob, RenderQueueState } from '@/lib/api/pipeline.api'

// ── Helper: poll Seedance task until completed or timeout ────────────────────

interface RenderResult {
  videoUrl: string
  seed?: number
  lastFrameUrl?: string
  resolution?: string
}


// Disk-served URL for a saved render (B2 reconcile) — local paths never expire.
// Seedance concurrent-task caps (enterprise-ops ref §3): enterprise-verified
// accounts run 10 concurrent tasks at ≤1080p (individual tier: 3 — drop this to 3
// if submits start rejecting). 4k is 1 concurrent REGARDLESS of tier; submitting
// 3 just keeps BytePlus' server-side queue fed, so the single 4k runner never idles.
const seedanceChunkSize = (resolution: string) => (resolution === '4k' ? 3 : 10)

/** How a reference is ADDRESSED in the prompt, per model.
 *
 *  2.0 keeps `<Image_N>` — the syntax its own guide documents, and changing it would
 *  rewrite every 2.0 prompt for no reason.
 *
 *  2.5 uses `@Image N`, because the official sd25-pe contract assigns `<>` a DIFFERENT
 *  job: it is the sound-effect delimiter (`{}` dialogue, `()` music, `<>` SFX, `【】`
 *  subtitles), and the contract is explicit — "do not also place subject names in angle
 *  brackets… so one symbol does not perform two roles". On 2.5 our angle brackets were
 *  doing exactly that. */
// Moved to lib/segments as `refToken` so Studio addresses references the same way this
// does — the rule is a model capability, not a Stage-5 detail. Aliased rather than renamed
// at ~40 call sites, which would bury the behaviour change in noise.
const refAddr = refToken

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const serveUrl = (p: string) => `${API_BASE}/api/asset/serve?path=${encodeURIComponent(p)}`

/** Item 0/7c: an assembled prompt awaiting user review before generation. */
interface PendingDirection {
  kind: 'video' | 'keyframe'
  prompt: string
  autoPrompt: string
  negative: string
  refs: Array<{ url: string; label: string; path?: string }>   // `path` is what an exclusion is keyed by
}

// 10 minutes: Seedance renders routinely exceed 2 min (the old cap), which
// marked still-running paid renders as failed. The task is never discarded on
// timeout either — reconcile resumes it on the next mount.
async function pollUntilDone(taskId: string, maxPolls = 120, shouldStop?: () => boolean): Promise<RenderResult> {
  for (let i = 0; i < maxPolls; i++) {
    if (shouldStop?.()) throw new Error('stopped')
    await new Promise((r) => setTimeout(r, 5000))
    if (shouldStop?.()) throw new Error('stopped')
    try {
      const result = await pipelineApi.pollVideoTask(taskId)
      if (result.status === 'completed' && result.video_url) {
        return {
          videoUrl: result.video_url as string,
          seed: result.seed ?? undefined,
          lastFrameUrl: (result.last_frame_url as string) || undefined,
          resolution: (result.resolution as string) || undefined,
        }
      }
      // Surface the REAL upstream failure (e.g. audio content-filter) so the
      // caller can react to it — a generic message hides the retry opportunity.
      if (result.status === 'failed') throw new Error(result.error || 'Seedance render failed')
    } catch (e) {
      if (e instanceof Error && /failed|sensitive/i.test(e.message)) throw e
      if (i === maxPolls - 1) throw e
    }
  }
  throw new Error('Seedance render still running after 10 minutes — it will resume on reload')
}

// ── Map Stage 4 Shot → queued GeneratedShot ──────────────────────────────────

function shotToGenerated(shot: Shot): GeneratedShot {
  return {
    shotId: shot.id,
    thumbnailUrl: '',
    videoUrl: '',
    duration: shot.estimatedDuration,
    status: 'queued',
  }
}

/** What the review panel lists: a sent (or excluded) derived reference, with the key the
 *  exclusion is kept under. */
type SentRefRow = { url: string; label: string; key?: string }
/** The identity of a derived reference for the director's exclusions: the asset folder,
 *  which survives re-approved versions, or the label when the entry has no folder. */
const refKey = (e: { label: string; path?: string }) => e.path ?? e.label

export function FinalGenView() {
  const { stages, commitVersion, approveVersion, setStageStatus, goToStage, style, aspectRatio, outputResolution, videoModel, gateMode, projectName, localFolderRoot, addShotVersion, setSelectedShotVersion, shotVersions, shotSelectedVersion, setShotRefMedia } = usePipelineStore()
  const { updateAgent } = useAgentsStore()
  const { success, error: toastError, warning, info } = useToast()
  // Async closures survive the project-switch remount; never let them write into
  // ANOTHER project's store (see useProjectGuard — the FAIL 7/8 contamination).
  const isCurrentProject = useProjectGuard()

  const stage4 = stages[4]
  const stage5 = stages[5]

  // Asset metadata map (from stage 2 breakdown) — needed to separate character vs env refs
  const assetMap = useMemo<Record<string, Asset>>(() => {
    const v2 = stages[2].versions.find((v) => v.id === stages[2].activeVersionId)
    const bd = v2?.data as BreakdownData | null
    return Object.fromEntries((bd?.assets ?? []).map((a) => [a.id, a]))
  }, [stages])

  // Item 1+2: resolve each Stage 3 asset's APPROVAL + stable image reference.
  // Primary source is assetStates (live per-asset status patched on every change);
  // the lock-time `assets` map is a fallback for projects locked before assetStates
  // was committed. localPath (disk, never expires) is preferred over selectedUrl (CDN ~24h).
  const stage3 = stages[3]
  const assetApproval = useMemo<Record<string, { approved: boolean; url: string | null; headshot: string | null }>>(() => {
    const v3 = stage3.versions.find((v) => v.id === stage3.activeVersionId)
    const d3 = v3?.data as {
      assetStates?: Record<string, { status?: string; selectedUrl?: string | null; localPath?: string | null; headshotLocalPath?: string | null }>
      assets?: Record<string, { selectedUrl?: string | null; localPath?: string | null }>
    } | null
    const out: Record<string, { approved: boolean; url: string | null; headshot: string | null }> = {}
    for (const a of Object.values(assetMap)) {
      const st = d3?.assetStates?.[a.id]
      const lock = d3?.assets?.[a.id]
      const url = st?.localPath ?? st?.selectedUrl ?? lock?.localPath ?? lock?.selectedUrl ?? null
      const approved = st
        ? st.status === 'approved' && !!url
        : stage3.status === 'approved' && !!url   // legacy lock data: lock required all-approved
      out[a.id] = { approved, url, headshot: st?.headshotLocalPath ?? null }
    }
    return out
  }, [stage3, assetMap])

  // Stable ref URL per APPROVED asset only — unapproved assets must never anchor a keyframe
  const approvedAssetUrls = useMemo<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(assetApproval)
        .filter(([, r]) => r.approved && r.url)
        .map(([id, r]) => [id, r.url!])
    ), [assetApproval])

  // Item 1: HARD GATE — every character and environment asset must be approved
  // before any shot generation. This is a real block, not advisory.
  const unapprovedRequired = useMemo<Asset[]>(() =>
    Object.values(assetMap)
      .filter((a) => a.type === 'character' || a.type === 'environment')
      .filter((a) => !assetApproval[a.id]?.approved),
  [assetMap, assetApproval])
  const assetGateLocked = unapprovedRequired.length > 0

  // ── Storyboard gate + per-shot panel map (Stage 4 is now the Storyboard) ────
  const breakdownScenes = useMemo(() => {
    const v2 = stages[2].versions.find((v) => v.id === stages[2].activeVersionId)
    return ((v2?.data as BreakdownData | null)?.scenes) ?? []
  }, [stages])

  const sceneStoryboards = useMemo<Record<string, SceneStoryboardState>>(() => {
    const v4 = stage4.versions.find((v) => v.id === stage4.activeVersionId)
    return ((v4?.data as { sceneStates?: Record<string, SceneStoryboardState> })?.sceneStates) ?? {}
  }, [stage4.activeVersionId, stage4.versions])

  // Second HARD GATE: every shot's board must be approved (per-shot boards) —
  // banner names scenes that still have unapproved boards
  const unapprovedScenes = useMemo(() =>
    breakdownScenes
      // boardIds, never shotIds: a scene's absorbed sub-shots have no board of their
      // own — they are panels inside another segment's — so every one of them read as
      // unapproved and this gate could never open. DryRUN sat here with all 19 boards
      // approved and all 4 scenes listed as pending.
      .filter((sc) => boardIds(sc).length > 0)
      .filter((sc) => {
        const boards = sceneStoryboards[sc.id]?.shotBoards ?? {}
        return !boardIds(sc).every((sid) => boards[sid]?.status === 'approved')
      })
      .map((sc) => sc.id),
  [breakdownScenes, sceneStoryboards])
  const storyboardGateLocked = unapprovedScenes.length > 0

  const generationLocked = assetGateLocked || storyboardGateLocked
  const gateMessage = assetGateLocked
    ? `Approve ${unapprovedRequired.map((a) => a.name).join(' and ')} in AG before generating shots`
    : storyboardGateLocked
      ? `Approve storyboards for ${unapprovedScenes.join(', ')} in the Storyboard stage before generating shots`
      : ''

  // shotId → its OWN storyboard board (per-shot boards; no grid cropping)
  const shotBoardMap = useMemo<Record<string, ShotBoardState>>(() => {
    const out: Record<string, ShotBoardState> = {}
    for (const sc of breakdownScenes) {
      const boards = sceneStoryboards[sc.id]?.shotBoards ?? {}
      for (const [sid, b] of Object.entries(boards)) {
        if (b?.boardLocalPath || b?.boardUrl) out[sid] = b
      }
    }
    return out
  }, [breakdownScenes, sceneStoryboards])

  // Photographic shots default to 'storyboard' (reference) mode so identity rides as
  // IMAGE references — specifically each character's fictional-distinctive FACE ANCHOR,
  // which passes Seedance's real-person filter (the realistic character sheet does
  // NOT — see seedance-identity-filter). Same anchor in every shot = cross-shot face
  // lock. Per-shot mode toggle still overrides. (The isPhotographic branch is
  // gone: identity rides the approved refs in every style now.)
  // Stage 5 = automatic clip generation. Every shot runs Seedance REFERENCE mode
  // (board beats + asset refs → video directly) — the storyboard is the composition
  // approval and the approved assets are the identity, so there is no intermediate
  // keyframe still to approve. The only per-shot variant is motion-reference mode
  // (an attached video drives the motion). The legacy 'keyframe' still-preview mode
  // was removed; any old shot.mode==='keyframe' coerces to 'storyboard'.
  const effectiveModeOf = useCallback((shot: GeneratedShot): 'storyboard' | 'motion_ref' | 'continuity' =>
    shot.mode === 'motion_ref' ? 'motion_ref'
      : shot.mode === 'continuity' ? 'continuity'
      : 'storyboard',
  [])

  /** The frame this shot should open on: the PREVIOUS shot's closing frame.
   *  Prefers the copy on disk — lastFrameUrl is a CDN link that expires in ~24h,
   *  so a project reopened the next day would chain from a dead URL. Returns ''
   *  when the previous shot has not rendered yet, which is what makes the mode
   *  unavailable rather than silently wrong. */
  const chainFrameFor = useCallback((shotId: string): string => {
    const ordered = shotsRef.current
    const idx = ordered.findIndex((s) => s.shotId === shotId)
    if (idx <= 0) return ''
    const prev = ordered[idx - 1]
    if (prev.status !== 'ready' && prev.status !== 'approved') return ''
    return prev.lastFrameLocalPath || prev.lastFrameUrl || ''
  }, [])

  // ── Derive base shots from Stage 4 breakdown ────────────────────────────────

  const stage4Breakdown = useMemo<BreakdownData | null>(() => {
    // Stage 4 stores { approvedShots, shots } — shots come from stage 2 breakdown
    // But the canonical shots are in stage 2. Stage 4 may store them directly.
    const v4 = stage4.versions.find((v) => v.id === stage4.activeVersionId)
    const d4 = v4?.data as { shots?: Shot[]; approvedShots?: string[] } | null
    if (d4?.shots?.length) return { assets: [], shots: d4.shots, scenes: [] }

    // Fall back to reading stage 2 breakdown directly
    const v2 = stages[2].versions.find((v) => v.id === stages[2].activeVersionId)
    return (v2?.data as BreakdownData) ?? null
  }, [stage4.activeVersionId, stage4.versions, stages])

  // Read off STAGE 2, not stage4Breakdown: when stage 4 has stored shots of its own,
  // that memo returns a rebuilt { assets, shots, scenes } and anything else on the
  // breakdown — this field included — is dropped on the way through.
  const dialogueLanguage = useMemo<string>(() => {
    const v2 = stages[2].versions.find((v) => v.id === stages[2].activeVersionId)
    return ((v2?.data as BreakdownData | null)?.dialogueLanguage ?? '').trim()
  }, [stages])

  const stage5StoredShots = useMemo<GeneratedShot[]>(() => {
    const v = stage5.versions.find((v) => v.id === stage5.activeVersionId)
    const stored = ((v?.data as { shots?: GeneratedShot[] })?.shots) ?? []
    // Heal cross-project contamination at hydration: media pointing outside THIS
    // project's folder is dropped (pre-guard saves may carry another project's
    // previews/videos — see sanitizeMedia).
    return stored.map((s) => sanitizeShotMedia(s, localFolderRoot))
  }, [stage5.activeVersionId, stage5.versions, localFolderRoot])

  // Merge: stored shots win (preserve videoUrls), fill gaps from stage4 breakdown
  const baseShots = useMemo<GeneratedShot[]>(() => {
    const breakdown4Shots = stage4Breakdown?.shots ?? []
    if (!breakdown4Shots.length) return stage5StoredShots

    const storedMap = new Map(stage5StoredShots.map((s) => [s.shotId, s]))
    return breakdown4Shots.map((s) => storedMap.get(s.id) ?? shotToGenerated(s))
  }, [stage4Breakdown, stage5StoredShots])

  // ── Local state ──────────────────────────────────────────────────────────────

  const [shots, setShots] = useState<GeneratedShot[]>(baseShots)
  const [activeShotId, setActiveShotId] = useState<string | null>(baseShots[0]?.shotId ?? null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [shotQcResults, setShotQcResults] = useState<Record<string, QCResponse>>({})
  // Del STORE, no de un useState: componer las referencias de un plano y recargar la
  // página las perdía, y unas referencias elegidas a mano son trabajo del director, no
  // estado de una vista. El campo es opcional en el store (para que `migrate()` siga
  // siendo no-op), de ahí el default en lectura.
  // El `?? {}` va DENTRO de un useMemo: sin él la expresión crea un objeto nuevo en cada
  // render y `planShot`, que lo lleva en sus dependencias, se reconstruiría siempre.
  const storedShotRefMedia = usePipelineStore((s) => s.shotRefMedia)
  const shotRefMedia = useMemo(
    () => (storedShotRefMedia ?? {}) as Record<string, ReferenceMedia>, [storedShotRefMedia])
  // P3.15: per-scene continuity chain — shot N's last frame becomes N+1's first
  // frame. ON by default: it is the documented continuity tool, and per-shot
  // dice-rolls with no carry-over were the top source of scene inconsistency.
  // Off by default — it's a deliberate opt-in for the Animate-All batch, and a local
  // useState(true) re-enabled itself every time the user re-entered Stage 5.
  const [chainScene, setChainScene] = useState(false)
  // Which rung the NEXT batch renders at. Session-local on purpose: it is a decision
  // about this pass, not a property of the project, and persisting it would silently
  // master an episode weeks later. Defaults to the cheap rung — an episode costs
  // ~$189 to preview against ~$2,100 to master, so the first look should never be
  // the expensive one. Climbing afterwards is what the tier-pass buttons are for.
  const [passTier, setPassTier] = useState<RenderTier>('preview')
  // Which rung a given shot renders at. A shot that has never rendered follows the
  // pass selector; one that already has a clip KEEPS its own rung, so fixing a single
  // take after a cheap pass does not quietly re-render it at master (one clip costing
  // more than the rest of the reel combined), and re-touching a mastered shot does not
  // silently demote it. Unknown tier ranks as master — same convention as tierRank:
  // disk cannot tell us what a clip was rendered at, and guessing low would hide cost.
  const tierFor = useCallback(
    (s: GeneratedShot): RenderTier => (s.videoUrl ? (s.tier ?? 'master') : passTier),
    [passTier])
  // Item 4C: "Chain Selected" — transient multi-select over the strip. Session-local
  // (never persisted, mirrors activeShotId), so migrate() stays a no-op.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>([])
  // Item 0/7c: per-shot assembled prompts awaiting review (transient)
  const [pendingDirections, setPendingDirections] = useState<Record<string, PendingDirection>>({})
  const [preparingPrompt, setPreparingPrompt] = useState(false)
  // El desajuste board/etapas, POR PLANO y persistente. El toast que ya se muestra dura
  // cuatro segundos; esto se queda en la tarjeta hasta que se re-boardea, que es el
  // tiempo real que pasa entre enterarse y poder actuar.
  const [boardMismatches, setBoardMismatches] = useState<Record<string, string>>({})
  // P3.14: Stop — halts batch loops and cancels the in-flight Seedance task
  const stopRequested = useRef(false)
  const activeTaskId = useRef<string | null>(null)
  // Every task submitted and not yet finished. A batch has up to 10 in flight at
  // once, so Stop has to cancel all of them — cancelling only the most recent left
  // the other nine running and billable.
  const inFlightTaskIds = useRef<Set<string>>(new Set())
  // Shots with a live poll loop in THIS session — the periodic recovery sweep
  // skips them to avoid double polling.
  const activePollers = useRef<Set<string>>(new Set())

  // Sync when baseShots changes after store hydration
  useEffect(() => {
    // Defer one microtask so the hydration sync isn't a synchronous setState in the effect
    void Promise.resolve().then(() => {
      setShots((prev) => (prev.length > 0 ? prev : baseShots))
      setActiveShotId((prev) => prev ?? baseShots[0]?.shotId ?? null)
    })
  }, [baseShots]) // eslint-disable-line react-hooks/exhaustive-deps

  // F1: rollback / restore re-sync. In-place edits patch the SAME version
  // (patchStageData below keeps activeVersionId), so the local `shots` are the
  // source of truth during editing. But a real version switch — rollback,
  // restore, or a fresh commit — changes activeVersionId; without this the local
  // `shots` would keep showing the old take and the rollback would look like a
  // no-op. On a genuine switch we re-read the now-active version's shots.
  const lastVersionRef = useRef(stage5.activeVersionId)
  useEffect(() => {
    if (stage5.activeVersionId === lastVersionRef.current) return
    lastVersionRef.current = stage5.activeVersionId
    setShots(baseShots)
    setActiveShotId((prev) => baseShots.some((s) => s.shotId === prev) ? prev : (baseShots[0]?.shotId ?? null))
  }, [stage5.activeVersionId, baseShots])

  // Mirror for callbacks that need current shot order without re-binding
  const shotsRef = useRef(shots)
  useEffect(() => { shotsRef.current = shots }, [shots])

  // Item 8: persist shot state (keyframes, videos, approvals) into the store on
  // every change so navigating away and back never loses generation progress.
  const { patchStageData } = usePipelineStore()
  useEffect(() => {
    if (shots.length > 0) patchStageData(5, { shots })
  }, [shots, patchStageData])

  const activeShot = shots.find((s) => s.shotId === activeShotId) ?? null
  const activeShotMeta = stage4Breakdown?.shots.find((s) => s.id === activeShotId)
  // Per-shot render lock: a single in-flight render no longer freezes the whole
  // stage — only its own shot's controls (and batch entry points, to respect
  // the documented 3-concurrent-task limit).
  const anyShotBusy = shots.some((s) => s.status === 'animating' || s.status === 'generating')
  const activeShotBusy = !!activeShot && (activeShot.status === 'animating' || activeShot.status === 'generating')
  const shotMetaMap = useMemo<Record<string, Shot>>(() =>
    Object.fromEntries((stage4Breakdown?.shots ?? []).map((s) => [s.id, s])),
  [stage4Breakdown])
  // sceneId → heading ("INT. KITCHEN - DAY"). On projects that predate stable scene
  // ids the sceneId IS the heading, so the lookup misses and falls through to it —
  // which is exactly the old behaviour.
  const sceneHeadingOf = useCallback((sceneId?: string) => {
    if (!sceneId) return ''
    return stage4Breakdown?.scenes?.find((sc) => sc.id === sceneId)?.heading ?? sceneId
  }, [stage4Breakdown])
  // ── Segments: the unit this stage actually renders ──────────────────────────
  // A card in the strip is one Seedance CALL. A migrated segment inherits the shot's
  // id, so on every existing project this map is 1:1 and nothing about the strip
  // changes; a breakdown that grouped its shots renders each group in one take.
  const segmentMap = useMemo<Record<string, Segment>>(() =>
    Object.fromEntries((stage4Breakdown?.segments ?? []).map((sg) => [sg.id, sg])),
  [stage4Breakdown])
  const segmentOf = useCallback((id: string) => segmentMap[id], [segmentMap])
  /**
   * The acting direction for a SEGMENT — from the beats that actually have a performer.
   *
   * `directorNotes` used to carry `shotMeta.performance`, and for a segment `shotMeta` is
   * the flat projection's representative: its FIRST beat. On DRAMA QUEEN 3's SHOT_001
   * (2026-08-14) that beat is an empty table, so its performance reads "No performer
   * present. All objects hold their position without movement." — and it went out as the
   * whole take's `Director's note (must be honored)`, over a second beat in which Joel and
   * Mara are both standing there. The strongest instruction in the prompt told the model
   * there was nobody to act. Eight sampled frames: two motionless people, no performance
   * of any kind.
   *
   * A beat with no character contributes no acting direction — its stillness is already
   * stated in its own [Beat] line, and the backend's own enhance_shots writes "" for a
   * shot whose cast is empty, which is the same rule. Distinct notes, in beat order, so a
   * two-beat take that plays one continuous action does not say it twice.
   */
  const segmentActingOf = useCallback((id: string): string => {
    const sg = segmentMap[id]
    const subs = sg?.shots ?? []
    if (subs.length < 2) return ''          // one beat → the caller's own performance
    const out: string[] = []
    for (const s of subs) {
      const perf = (s.performance ?? '').trim()
      const hasCast = (s.assetsUsed ?? []).some((aid) => assetMap[aid]?.type === 'character')
      if (perf && hasCast && !out.includes(perf)) out.push(perf)
    }
    return out.join(' ')
  }, [segmentMap, assetMap])
  const segmentDurationOf = useCallback((id: string) => {
    const sg = segmentMap[id]
    if (!sg?.shots?.length) return undefined
    return sg.shots.reduce((n: number, s: SegmentShot) => n + (Number(s.durationSecs) || 0), 0)
  }, [segmentMap])
  // The number this card will actually SEND — the same fallback chain buildVideoParams
  // uses, in ONE place, so the over-length check below can never disagree with the
  // request it is guarding. `meta` is passed where the caller already has it, so the
  // value stays byte-identical to what the render used before this existed.
  // Stage 5 must refuse against the ceiling of the model it is about to CALL, not a
  // constant — otherwise choosing 2.5 still rejects the 30 s takes it can render.
  const segMaxSecs = segmentMaxSecsFor(videoModel)
  const plannedDurationOf = useCallback((shotId: string, meta?: Shot) =>
    segmentDurationOf(shotId) ?? meta?.estimatedDuration ?? shotMetaMap[shotId]?.estimatedDuration ?? 5,
  [segmentDurationOf, shotMetaMap])
  // Segments the API cannot render in one call — see segMaxSecs. Freshly planned
  // segments are already grouped under the ceiling; these are the legacy and hand-edited
  // shots that predate the grouping, and until now they only surfaced as a 422 from the
  // backend, one shot at a time, in the middle of a paid batch.
  const overlongShots = useMemo(() =>
    shots
      .map((s) => ({ shotId: s.shotId, secs: plannedDurationOf(s.shotId) }))
      .filter((x) => x.secs > segMaxSecs),
  [shots, plannedDurationOf, segMaxSecs])
  const overlongIds = useMemo(() => new Set(overlongShots.map((x) => x.shotId)), [overlongShots])
  const overlongList = useMemo(() =>
    overlongShots.map((x) => `${x.shotId} (${x.secs.toFixed(1)}s)`).join(', '), [overlongShots])
  // What the segment BEFORE this one ends on, in words. Only within the same scene: a
  // cut to a new location has nothing to carry over, and describing the old one there
  // would pull the render back toward a place it just left.
  const prevSegmentEndOf = useCallback((id: string) => {
    const segs = stage4Breakdown?.segments ?? []
    const i = segs.findIndex((sg) => sg.id === id)
    if (i <= 0) return ''
    const prev = segs[i - 1]
    if (prev.sceneId !== segs[i].sceneId) return ''
    return segs[i].bridge?.plantedInPrev || prev.shots?.[prev.shots.length - 1]?.action || ''
  }, [stage4Breakdown])

  const activeQcResult = activeShotId ? (shotQcResults[activeShotId] ?? null) : null
  const activeRefMedia = activeShotId ? (shotRefMedia[activeShotId] ?? emptyReferenceMedia()) : emptyReferenceMedia()

  const approvedCount = shots.filter((s) => s.status === 'approved').length
  const allReady = shots.length > 0 && shots.every((s) => s.status === 'approved' || s.status === 'ready')
  const allApproved = shots.length > 0 && shots.every((s) => s.status === 'approved')
  const alreadyLocked = stage5.status === 'approved'

  const updateShotRefMedia = useCallback((shotId: string, rm: ReferenceMedia) => {
    // The panel replaces the whole record and knows nothing of exclusions, so they are
    // carried over here: "don't send the jar" must survive attaching an image.
    const cur = usePipelineStore.getState().shotRefMedia?.[shotId]
    setShotRefMedia(shotId, { ...rm, excluded: cur?.excluded ?? [] })
  }, [setShotRefMedia])

  // A DERIVED reference the director does not want sent for this shot. Keyed by the asset
  // folder (or the label when there is none — see refKey), so "not the jar in SHOT_019"
  // holds across re-approved versions of the jar. Persisted with the project like `images`.
  const excludeShotRef = useCallback((shotId: string, key: string) => {
    const cur = usePipelineStore.getState().shotRefMedia?.[shotId] ?? emptyReferenceMedia()
    const excluded = (cur as ShotRefMedia).excluded ?? []
    if (excluded.includes(key)) return
    setShotRefMedia(shotId, { ...cur, excluded: [...excluded, key] })
  }, [setShotRefMedia])
  // The strip's ×. A derived reference (it has an asset folder) is excluded; one the
  // director attached (no folder) is simply detached from the shot's media.
  const removeShotRefAt = useCallback((shotId: string, ref: { url: string; label: string; path?: string }) => {
    if (ref.path) { excludeShotRef(shotId, refKey(ref)); return }
    const cur = usePipelineStore.getState().shotRefMedia?.[shotId]
    if (!cur) return
    setShotRefMedia(shotId, { ...cur, images: cur.images.filter((im) => im.url !== ref.url) })
  }, [excludeShotRef, setShotRefMedia])
  const restoreShotRef = useCallback((shotId: string, key: string) => {
    const cur = usePipelineStore.getState().shotRefMedia?.[shotId]
    if (!cur) return
    setShotRefMedia(shotId, { ...cur, excluded: (cur.excluded ?? []).filter((k) => k !== key) })
  }, [setShotRefMedia])

  // Item 4C: toggle a shot's membership in the "Chain Selected" set / flip select mode.
  // These are LOCAL setters (not store setters) so calling them plainly is fine.
  const toggleShotSelected = useCallback((shotId: string) => {
    setSelectedShotIds((prev) => prev.includes(shotId) ? prev.filter((x) => x !== shotId) : [...prev, shotId])
  }, [])
  const toggleSelectMode = useCallback(() => {
    setSelectMode((v) => !v)
    setSelectedShotIds([])   // clear on every flip so a hidden stale selection can't drive the next run
  }, [])

  // ── Claude QC ────────────────────────────────────────────────────────────────

  // Approve a specific shot by id (used by per-shot QC auto-approve). Reads the
  // live shotsRef so it never races setShots; commits/advances OUTSIDE the
  // updater (never call a store setter inside a setState updater).
  const approveShotById = useCallback((shotId: string) => {
    // QC auto-approve arrives from an async completion — if the user switched
    // projects meanwhile, this closure belongs to the OLD project: never write.
    if (!isCurrentProject()) return
    const updated = shotsRef.current.map((s) => s.shotId === shotId ? { ...s, status: 'approved' as const } : s)
    setShots(updated)
    if (updated.length > 0 && updated.every((s) => s.status === 'approved')) {
      const versionId = commitVersion(5, { shots: updated })
      approveVersion(5, versionId)
      success('All shots approved ✓', 'Moving to Cut & Edit →')
      goToStage(6)
    }
  }, [commitVersion, approveVersion, goToStage, success, isCurrentProject])

  const runClaudeQC = useCallback(async (shot: GeneratedShot, shotMeta?: Shot, characterRefUrl?: string) => {
    if (!shot.videoUrl && !shot.videoLocalPath) return
    // Item 9: QC must receive the real action/description — never the bare shot ID.
    // If metadata can't be resolved (stale stored shots from an older breakdown),
    // fall back to the assembled prompt; skip QC entirely rather than send garbage.
    const description = shotMeta?.action
      ? `${shotMeta.action} — ${shotMeta.visualDescription ?? ''}`
      : shotMeta?.visualDescription || shot.assembledPrompt || ''
    if (!description.trim()) {
      updateAgent('qc', { status: 'idle', detail: `QC skipped: no metadata for ${shot.shotId}` })
      return
    }
    // Item 9: evaluate against the locally saved video (never expires), not the CDN URL
    const videoRef = shot.videoLocalPath || shot.videoUrl
    updateAgent('qc', { status: 'active', detail: `QC: ${shot.shotId}` })
    try {
      // P3.17: pass the approved character ref so QC gets an objective
      // embedding-based identity-drift number for the rendered clip
      const qc = await pipelineApi.qcFinalScene(shot.shotId, videoRef, description, characterRefUrl)
      setShotQcResults((prev) => ({ ...prev, [shot.shotId]: qc }))
      const driftNote = qc.identity_drift != null ? ` (identity drift ${Math.round(qc.identity_drift * 100)}%)` : ''
      updateAgent('qc', { status: qc.passed ? 'completed' : 'active', detail: qc.summary + driftNote })
      // P5b: in auto gate mode, a genuinely-good take (QC pass + acceptable drift)
      // approves itself — no manual click. A fail or high drift still waits for review.
      const driftOk = qc.identity_drift == null || qc.identity_drift < 0.45
      if (gateMode === 'auto' && qc.passed && driftOk) {
        approveShotById(shot.shotId)
        updateAgent('qc', { status: 'completed', detail: `Auto-approved ${shot.shotId} (QC pass)` })
      }
    } catch {
      updateAgent('qc', { status: 'error', detail: 'QC failed' })
    }
  }, [updateAgent, gateMode, approveShotById])

  // ── Shot plan: everything a Seedance call needs, derived ONCE — used by both
  // the dry-run prompt assembly (item 7c) and the real animation so the prompt
  // the user reviews is built from exactly the inputs that will run. ──────────

  // (The fictional face-anchor machinery that lived here is gone: identity now
  // rides the APPROVED assets directly as Seedance reference_images — Seedream
  // 5.0 Pro outputs pass the face filter. The /api/character/face-anchor endpoint
  // remains server-side for cache resets/manual use.)

  const planShot = useCallback((
    shot: GeneratedShot,
    shotMeta: Shot | undefined,
    firstFrameOverride?: string,
  ) => {
    const refMedia = shotRefMedia[shot.shotId] ?? emptyReferenceMedia()

    // i2v sends NO reference_image items (identity lives in the keyframe) —
    // assets are only needed here to derive the prompt's subject/env text.
    const usedAssets = (shotMeta?.assetsUsed ?? [])
      .map((id) => ({ id, url: approvedAssetUrls[id], meta: assetMap[id] }))
      .filter((a) => a.url)

    // Phase-2 (D3): a wardrobe VARIANT is stored as "Eli · Day Clothes", but that is a
    // bookkeeping name — feeding it to the model as the character's NAME put costume words
    // in the identity slot. Prompts always use the BASE name; the outfit rides as wardrobe
    // text on the description instead.
    const baseNameOf = (meta?: Asset): string => {
      if (!meta) return ''
      const parent = meta.parentCharacterId ? assetMap[meta.parentCharacterId] : undefined
      return parent?.name ?? meta.name
    }

    // Derive subject_hint from character names for the formula prompt
    const characterNames = usedAssets
      .filter((a) => a.meta?.type === 'character')
      .map((a) => baseNameOf(a.meta))
      .join(' and ')

    // Environment hint from environment asset names/descriptions
    const envHint = usedAssets
      .filter((a) => a.meta?.type === 'environment')
      .map((a) => a.meta!.visualDescription?.split(' ').slice(0, 8).join(' ') ?? a.meta!.name)
      .join(', ')

    // Item 3: the SAVED keyframe (disk path, never expires) is the first_frame.
    // P3.15: a chain override (previous shot's last frame) takes precedence.
    // Storyboard mode (DEFAULT with a board) sends NO first frame — reference mode.
    const mode = effectiveModeOf(shot)
    const sbMode = mode === 'storyboard'
    // Motion-reference mode: Seedance reference mode (no first frame) so the
    // attached reference video drives the motion. i2v drops all reference media,
    // so this is the only mode where a motion video is actually used.
    const motionMode = mode === 'motion_ref'
    // Continuity mode: open on the previous shot's closing frame so the cut matches
    // exactly. Seedance's modes are mutually exclusive — a first frame cannot be
    // combined with reference_image — so this deliberately drops the character
    // sheets and the board, and the shot leans on the incoming frame for identity.
    // That is the whole trade, and it is why this is per-shot and opt-in rather
    // than a global "Chain All".
    const chainMode = mode === 'continuity'
    const chainFrame = chainMode ? (firstFrameOverride || chainFrameFor(shot.shotId)) : ''
    const keyframeUrl = chainMode ? chainFrame : (sbMode || motionMode) ? '' : (
      firstFrameOverride || shot.keyframeLocalPath || shot.thumbnailUrl
      || refMedia.images.find((i) => i.role === 'first_frame')?.url || ''
    )

    // Storyboard mode refs: [character sheet, environment, storyboard grid, props]
    // (≤9, reference mode) — explicitly addressed in the prompt with the
    // beat-following instruction. The board steers choreography; assets steer look.
    // (The cropped headshot is NOT a Seedance ref — see the sbMode block below.)
    // Production Video Direction template inputs: the shot's annotated beats,
    // the character's visual signature, and @Image N addressing for refs.
    const board = shotBoardMap[shot.shotId]
    const beats = (board?.panels ?? []).map((p) => ({ ...p })) as Array<Record<string, unknown>>
    const charAsset = usedAssets.find((a) => a.meta?.type === 'character')
    const charName = baseNameOf(charAsset?.meta) || 'the protagonist'
    // The signature carries the look: identity from the base description + THIS scene's
    // outfit, so the prompt states the costume without renaming the character.
    const charSignature = [
      (charAsset?.meta?.visualDescription ?? '').split(/[.;]/)[0].trim(),
      charAsset?.meta?.wardrobe?.trim() ? `wearing ${charAsset.meta.wardrobe.trim()}` : '',
    ].filter(Boolean).join(', ')

    // Disk-FOLDER hint per asset → the backend resolves the PERMANENT versioned copy when the
    // store's url is an expired ~24h CDN link (never-expiring disk file → no mid-render 400).
    const ASSET_DISK_DIR: Record<string, string> = {
      character: 'Assets/Characters', environment: 'Assets/Environments',
      prop: 'Assets/Props', wardrobe: 'Assets/Wardrobe', vfx: 'Assets/FX', fx: 'Assets/FX',
    }
    const assetFolder = (a?: { meta?: { type?: string; name?: string } }) =>
      a?.meta?.name ? `${ASSET_DISK_DIR[a.meta.type ?? ''] ?? 'Assets'}/${a.meta.name}` : ''

    let sbRefs: Array<{ url: string; role: string; path?: string; kind?: string }> = []
    let refAddressing: string[] = []
    let refEntries: Array<{ url: string; label: string; path?: string }> = []
    // Sin recortar — ver el comentario junto al slice. Vacío fuera de storyboard mode,
    // donde no hay lista que recortar.
    let allEntries: Array<{ url: string; label: string; path?: string }> = []
    const subjects: Array<{ name: string; acting: string; addr: number }> = []
    // WHAT THE DIRECTOR TOOK OUT. Applied HERE, at the one place the list is built, so the
    // POST, the @Image numbering, the role lines and the cap all follow — and the asset never
    // appears in [Unused Materials], because it is not attached. `attach` is used instead of
    // entries.push so an excluded character also loses its address (subjects[].addr is read
    // off entries.length at the same moment), which keeps every profile on its own picture.
    const excludedKeys = new Set((refMedia as ShotRefMedia).excluded ?? [])
    const excludedEntries: Array<{ url: string; label: string; path?: string }> = []
    const attach = (list: Array<{ url: string; label: string; path?: string }>, e: { url: string; label: string; path?: string }): boolean => {
      if (excludedKeys.has(refKey(e))) { excludedEntries.push(e); return false }
      list.push(e)
      return true
    }
    // What this SCENE has approved that this take is not showing. Prohibited by name in the
    // prompt (sd25-pe principle 3) so the model cannot walk an established character into a
    // shot they are not in. Scene-scoped, not project-scoped: cross-scene assets do not
    // bleed into a take, and the contract warns against padding a prompt with inactive
    // material. Computed from the SAME `assetsUsed` the attachments are built from, so the
    // two can never disagree about who is in the shot.
    const _sceneId = (shotMeta as unknown as { sceneId?: string } | undefined)?.sceneId
    const _attached = new Set(shotMeta?.assetsUsed ?? [])
    const unusedAssets = _sceneId
      ? Array.from(new Set(
          (stage4Breakdown?.shots ?? [])
            .filter((s) => (s as unknown as { sceneId?: string }).sceneId === _sceneId)
            .flatMap((s) => s.assetsUsed ?? [])))
          .filter((id) => !_attached.has(id) && approvedAssetUrls[id])
          .map((id) => baseNameOf(assetMap[id]) || assetMap[id]?.name || '')
          .filter(Boolean)
      : []
    if (sbMode) {
      // Seedance 2.0 MULTIMODAL (reference mode, NO first_frame): compose + animate
      // straight from the APPROVED assets. Identity, environment AND the storyboard's
      // composition/camera all ride as reference_images. Seedream 5.0 Pro outputs are
      // EXEMPT from Seedance's biometric filter (KYC-HIGH i2i exemption — same account,
      // virtual humans; both 5.0 Pro & Lite are eligible) — but ONLY as VERBATIM platform
      // outputs. The full character SHEET rides byte-exact (via _url_to_data_uri) → exempt.
      // The cropped HEADSHOT is DELIBERATELY EXCLUDED here: _derive_headshot re-encodes it
      // (PIL crop+save = "third-party compression"), which nullifies the platform-output
      // trust → Seedance rejects the whole request (InputImageSensitiveContentDetected.
      // PrivacyInformation, 2026-07-17). The headshot stays a VISION-only ref (QC drift +
      // face-block grounding), never a Seedance ref. Priority (≤9): [sheet, environment,
      // storyboard frame, props]. The prompt addresses each by <Image_N> + subject tags.
      const charAssetsAll = usedAssets.filter((a) => a.meta?.type === 'character')
      const envAsset = usedAssets.find((a) => a.meta?.type === 'environment')
      const extraAssets = usedAssets.filter((a) =>
        a.meta?.type !== 'character' && a.meta?.type !== 'environment')
      const boardRef = board?.boardLocalPath || board?.boardUrl
      const entries: Array<{ url: string; label: string; path?: string }> = []
      for (const ca of charAssetsAll) {
        const nm = baseNameOf(ca.meta) || 'the character'
        const sent = ca.url ? attach(entries, { url: ca.url, label: `${nm}'s face, full appearance, build and wardrobe (approved character sheet) — lock identity EXACTLY to this`, path: assetFolder(ca) }) : false
        // The ACTING MASTER PROFILE rides alongside the picture it describes. `addr` is
        // computed from entries.length in the SAME loop that pushes the reference, because
        // deriving it later — from a second pass over the assets — is exactly how the
        // number and the picture drift apart. Characters are pushed first, so their
        // addresses are 1..N and stay stable when environment/board/props follow.
        if (ca.meta?.acting?.trim()) {
          subjects.push({ name: nm, acting: ca.meta.acting.trim(), addr: sent ? entries.length : 0 })
        }
      }
      if (envAsset?.url) attach(entries, { url: envAsset.url, label: `the ${envAsset.meta?.name ?? 'environment'} setting — place the action in this exact environment`, path: assetFolder(envAsset) })
      // La etiqueta viaja al prompt PEGADA al rol de la referencia ("<rol> — <etiqueta>"),
      // así que las dos frases tienen que decir lo mismo. Ésta decía "match its
      // composition, framing and camera angle" mientras el rol dice que el tablero es un
      // plan de cámara y que la acción y el aspecto salen de otro sitio: dos órdenes
      // distintas sobre el mismo adjunto, en la misma línea. El tablero sirve para la
      // perspectiva de cámara y el movimiento; lo demás lo dicen las otras referencias.
      if (boardRef) attach(entries, { url: boardRef, label: 'the approved storyboard for this shot — its camera perspective and movement', path: `Shots/${shot.shotId}/Storyboard` })
      for (const a of extraAssets) {
        if (a.url) attach(entries, { url: a.url, label: `the ${a.meta?.name ?? 'prop'}`, path: assetFolder(a) })
      }
      // LAS QUE EL USUARIO ADJUNTA, DE VERDAD ENVIADAS. Hasta ahora `refMedia` sólo se
      // leía para el first_frame y para los vídeos, así que una imagen que alguien
      // arrastrara al panel de un plano no llegaba nunca a la petición: la lista era
      // enteramente derivada y no había forma de intervenirla.
      //
      // Van al FINAL y no al principio a propósito. `subjects[].addr` se calcula con
      // `entries.length` dentro del bucle de personajes de arriba, contando con que los
      // personajes ocupan 1..N; anteponer algo correría esos números y cada perfil pasaría
      // a describir la foto de otro. Al final, el direccionamiento existente no se mueve.
      for (const im of refMedia.images) {
        if (im.url && im.role === 'reference_image') {
          entries.push({ url: im.url, label: 'a reference the director attached to this shot' })
        }
      }
      // `allEntries` guarda la lista ANTES del recorte. El slice descarta en silencio al
      // llegar al tope del modelo, y hasta ahora nadie podía ver qué se quedaba fuera de
      // un render que estaba a punto de pagarse; el panel de revisión lo enseña tachado.
      allEntries = entries.slice()
      refEntries = entries.slice(0, maxImageRefsFor(videoModel))
      sbRefs = refEntries.map((e) => ({ url: e.url, role: 'reference_image', path: e.path }))
      refAddressing = refEntries.map((e, i) => `${refAddr(videoModel, i + 1)} = ${e.label}`)
    } else if (motionMode) {
      // Reference mode: identity comes from the character refs, motion from the
      // attached video. Refs = [character sheet, environment], ≤9. The cropped headshot
      // is excluded here too — its PIL re-encode nullifies the Seedance platform-output
      // exemption (see the sbMode block); the byte-exact sheet carries the face.
      const envAsset = usedAssets.find((a) => a.meta?.type === 'environment')
      const entries: Array<{ url: string; label: string; path?: string }> = []
      if (charAsset?.url) attach(entries, { url: charAsset.url, label: `${charName}'s face and full appearance (character reference sheet — lock identity to this)`, path: assetFolder(charAsset) })
      if (envAsset?.url) attach(entries, { url: envAsset.url, label: `the ${envAsset.meta?.name ?? 'environment'} setting`, path: assetFolder(envAsset) })
      refEntries = entries.slice(0, maxImageRefsFor(videoModel))
      sbRefs = refEntries.map((e) => ({ url: e.url, role: 'reference_image', path: e.path }))
      refAddressing = [
        ...refEntries.map((e, i) => `${refAddr(videoModel, i + 1)} = ${e.label}`),
        // One line per drive clip, not one line for all of them: with two attached, a
        // single `@Video 1` sentence named the first and left the second addressed by
        // nothing. Kept in step with SEEDANCE_REF_ROLES — when these two texts drifted
        // apart for the continuity frame, the role was dropped in silence.
        ...refMedia.videos.map((v, i) => `${refAddr(videoModel, i + 1, 'Video')} = ${
          v.motion === 'body'
            ? 'the BODY motion reference — replicate its whole-body performance: posture, gait, gesture and the timing of every move. Take no face, identity, clothing, location or colour from it'
            : v.motion === 'face'
              ? 'the FACIAL motion reference — replicate its expression, eyeline, blinks and mouth timing. Take no identity, hair, clothing, location or colour from it'
              : 'the motion reference — replicate its movement, timing and camera path'}`),
      ]
    } else {
      refAddressing = [`the source first frame already depicts ${charName}; there are no numbered reference images`]
      if (keyframeUrl) refEntries = [{ url: keyframeUrl, label: 'the source first frame (keyframe)' }]
    }

    return {
      refMedia, usedAssets, characterNames, envHint, sbMode, motionMode, keyframeUrl,
      beats, charName, charSignature, sbRefs, refAddressing, refEntries, allEntries, excludedEntries, subjects, unusedAssets, chainMode,
    }
  }, [shotRefMedia, approvedAssetUrls, assetMap, shotBoardMap, effectiveModeOf, chainFrameFor, videoModel, stage4Breakdown?.shots])

  // The full Seedance request params from a plan — ONE source of truth shared by
  // the dry-run (PromptPanel) and the real render, so what the user reviews is
  // what runs.
  const buildVideoParams = useCallback((
    shot: GeneratedShot,
    shotMeta: Shot | undefined,
    plan: ReturnType<typeof planShot>,
    generateAudio: boolean,
    opts?: AnimateShotOpts,
  ) => ({
    shotId: shot.shotId,
    imageUrl: plan.keyframeUrl,
    prompt: shotMeta?.visualDescription ?? shot.shotId,
    // Motion-reference mode: tell Seedance to follow the attached video's motion.
    shotAction: plan.motionMode && plan.refMedia.videos.length
      ? [shotMeta?.action, 'Replicate the movement, timing and camera motion of the reference video'].filter(Boolean).join('. ')
      : (shotMeta?.action ?? ''),
    // The LOCATION, for the prompt ("Scene/location context" server-side) — the scene's
    // heading, not its id. sceneId used to BE the heading string; now that it is a
    // stable code, sending it raw would hand Seedance "SC-001" instead of
    // "INT. KITCHEN - DAY" and throw the location away.
    shotScene: sceneHeadingOf((shotMeta as unknown as { sceneId?: string })?.sceneId),
    cameraAngle: shotMeta?.cameraAngle ?? '',
    subjectHint: plan.characterNames,
    envHint: plan.envHint,
    lightingHint: segmentOf(shot.shotId)?.sceneSettings?.light ?? shotMeta?.lighting ?? '',
    // SEGMENT mode. A card in this strip is one Seedance CALL, and a call may hold
    // several shots the model cuts between. A migrated project has exactly one shot per
    // segment, so this is a no-op there; a breakdown that grouped its shots renders the
    // whole group in one take — which is the only place a sub-4s beat can live, the API
    // floor being 4s per call.
    segmentShots: (segmentOf(shot.shotId)?.shots ?? []).map((s: SegmentShot) => ({
      id: s.id,
      duration_sec: s.durationSecs,
      shot_size: s.shotSize,
      camera_move: s.cameraMove,
      layout: s.layout,
      action: s.action,
      assets_used: s.assetsUsed,
      // The same assets RESOLVED — id, name and type. `assets_used` is ids, and the
      // server's voiceless derivation reads `assets[].type`, so it walked a list that was
      // never sent and every take reported zero bodiless speakers. Measured on
      // BLACKMIRROR 4 SHOT_013: the Electronic Voice — a `voice` asset, created so the
      // kidnapper would have no face — was told "their mouth moves with each word".
      // The browser is the only side holding assetMap, so it is the side that says what
      // each id IS. Additive: assets_used still goes out unchanged.
      assets: (s.assetsUsed ?? []).map((id: string) => ({
        id, name: assetMap[id]?.name ?? id, type: assetMap[id]?.type ?? '',
      })),
      dialogue: (s.dialogue ?? []).map((d: { characterId: string; text: string; emotion?: string }) => ({
        // Names, not ids: the prompt says them out loud, and the voice anchors the
        // server resolves are keyed by character NAME.
        character: assetMap[d.characterId]?.name ?? d.characterId,
        text: d.text,
        emotion: d.emotion,
      })),
    })),
    sceneName: sceneHeadingOf((shotMeta as unknown as { sceneId?: string })?.sceneId),
    // The state the PREVIOUS segment ended on, restated as content — the model keeps no
    // memory across calls, so this is what stops a cut from drifting to a new location.
    prevSegmentEnd: prevSegmentEndOf(shot.shotId),
    // The SUM of the segment's shots. Sending one shot's length here would under-run the
    // take and leave the later beats unrendered. Over segMaxSecs this is a request
    // the backend refuses — the callers below never let one get this far, so it is sent
    // as-is rather than clamped (a clamp here would drop the segment's last shots).
    durationSecs: plannedDurationOf(shot.shotId, shotMeta),
    style,
    // Keyframe mode (i2v): NO reference_image items — the API rejects mixing
    // them with first_frame; identity lives in the keyframe.
    // Storyboard mode (reference): [grid, headshot, full body, environment].
    referenceImages: plan.sbRefs,
    referenceVideos: plan.refMedia.videos.map((v) => v.url),
    referenceVideoKinds: plan.refMedia.videos.map((v) => v.motion ?? ''),
    dialogueLanguage,
    // 3.2: prefer the dialogue clip approved next to the storyboard (Seed Audio 1.0
    // locked voices) → Seedance uses it as the audio reference; else any attached clip.
    // (If neither, the backend renders the dialogue inline at shot time as a fallback.)
    audioUrl: (shotBoardMap[shot.shotId]?.dialogueApproved && shotBoardMap[shot.shotId]?.dialogueClipPath)
      || plan.refMedia.audio?.url,
    generateAudio,
    ratio: aspectRatio,
    // Render tier. 'preview' (480p) and 'edit' (720p) pin their own size server-side
    // and ignore `resolution`; 'master' renders at the project's output size. The
    // ladder exists because a 540-shot episode costs ~$189 to preview and ~$2,100 to
    // master, so timing and blocking get judged cheaply first.
    //
    // Promotion is NOT an upscale: Seedance 2.0 has no seed, so re-rendering at a
    // higher tier is always a FRESH sample that can differ from the take approved
    // below it. The prompt and first_frame are what carry over.
    tier: opts?.tier ?? 'master',
    // Settings' Video model pick rides with EVERY shot render. The backend coerces the
    // resolution down to what the model can do (2.5 tops out at 1080p) rather than dying
    // at the API — the picker already warned about that trade-off.
    modelChoice: videoModel,
    // Continuity chaining opens on the previous shot's exact closing frame; that seam
    // is only invisible if the frame is byte-exact, so such a shot must never be
    // rerouted through 2.5's reference mode (which only approximates it).
    exactFirstFrame: plan.chainMode,
    resolution: opts?.resolution ?? outputResolution,
    seed: opts?.seed,  // forwarded but ignored by Seedance 2.0 (no-op)
    // P3.13: dialogue lines reach the model via the documented {} syntax
    // Scene-mode direction for this take (Claude, stage 2). Empty → per-line concat.
    dialogueScene: shotMeta?.dialogueScene ?? '',
    dialogue: (shotMeta?.dialogue ?? []).map((d) => ({
      character: assetMap[d.characterId]?.name ?? d.characterId,
      text: d.text,
      emotion: d.emotion,
    })),
    // Production Video Direction template — sections 1-6 in storyboard mode,
    // sections 3-6 in keyframe mode; classic assembler when no beats exist.
    // Motion-reference mode always uses the classic assembler so the motion
    // clause in shotAction (and <Video_1> addressing) drives the render.
    useDirection: !plan.motionMode && plan.beats.length > 0,
    directionMode: (plan.sbMode ? 'storyboard' : 'keyframe') as 'storyboard' | 'keyframe',
    beats: plan.beats,
    subjects: plan.subjects,
    unusedAssets: plan.unusedAssets,
    charName: plan.charName,
    charSignature: plan.charSignature,
    refAddressing: plan.refAddressing,
    // Item 7d: per-shot director notes + the acting/performance intent (4.1) are
    // honored by the (vision) prompt so the shot performs as directed.
    directorNotes: (() => {
      // The SEGMENT's acting where the take has several beats, the shot's own where it
      // does not — see segmentActingOf for what the first-beat note was doing to a scene.
      const acting = segmentActingOf(shot.shotId) || (shotMeta?.performance ?? '')
      return [shot.notes, acting ? `Acting direction: ${acting}` : '']
        .filter(Boolean).join('. ')
    })(),
    // B2: identity so the backend can save this render if the tab closes
    projectName,
    projectPath: localFolderRoot ?? '',
  }), [style, aspectRatio, assetMap, projectName, localFolderRoot, outputResolution, videoModel, shotBoardMap,
       sceneHeadingOf, segmentOf, segmentActingOf, plannedDurationOf, prevSegmentEndOf,
       dialogueLanguage])

  // ── 0.5: Animate a shot using the stored keyframe as first_frame ──────────────

  // Auto-fallback: when Seedance blocks a keyframe with its real-person/IP filter
  // we regenerate the keyframe via F1 (photographic → fictional-face text, no face
  // ref) and retry once. planKeyframe + animateShot's own re-entry are reached
  // through refs to dodge the declaration order (both are defined below / self).
  type AnimateShotOpts = {
    resolution?: string; seed?: number; firstFrameOverride?: string
    promptOverride?: string; negativeOverride?: string; autoPrompt?: string
    /** Rung of the cost ladder. The server resolves it to a (model, resolution)
     *  pair and IGNORES `resolution` for preview/edit, so callers never have to
     *  know which size a tier means. Omitted = 'master' (the previous behaviour:
     *  render at the project's output size). */
    tier?: RenderTier
  }
  const regenKeyframeF1Ref = useRef<((shot: GeneratedShot, shotMeta: Shot | undefined) => Promise<string>) | null>(null)
  const animateShotRef = useRef<((shot: GeneratedShot, shotMeta: Shot | undefined, opts?: AnimateShotOpts, identityRetry?: boolean) => Promise<GeneratedShot>) | null>(null)

  const animateShot = useCallback(async (
    shot: GeneratedShot,
    shotMeta: Shot | undefined,
    // Item 0/7c: user-reviewed prompt rides in opts (sent verbatim); autoPrompt
    // rides along so the artifact meta records both versions.
    opts?: AnimateShotOpts,
    identityRetry = false,   // true when this is the post-regeneration retry (no further fallback)
  ) => {
    // Identity now rides the APPROVED assets directly as Seedance reference_images
    // (Seedream 5.0 Pro outputs pass the face filter) — no fictional face-anchor step.
    const plan = planShot(shot, shotMeta, opts?.firstFrameOverride)
    // (prompt-facing fields — beats, charName, hints — ride inside `plan` via
    // buildVideoParams; only the ref-plumbing fields are consumed here)
    const { usedAssets, sbMode, keyframeUrl, sbRefs, refAddressing, refEntries } = plan

    // P2: cut-to-cut continuity — attach the previous shot's closing frame (same
    // scene, already rendered) as an extra reference so adjacent shots share
    // lighting and color grade across the cut. SB mode only; respects the ≤9 cap.
    if (sbMode && sbRefs.length < maxImageRefsFor(videoModel) && shotMeta) {
      const sceneId = (shotMeta as unknown as { sceneId?: string }).sceneId
      const ordered = shotsRef.current
      const idx = ordered.findIndex((s) => s.shotId === shot.shotId)
      for (let i = idx - 1; i >= 0; i--) {
        const prev = ordered[i]
        const prevScene = (shotMetaMap[prev.shotId] as unknown as { sceneId?: string } | undefined)?.sceneId
        if (prevScene !== sceneId) break
        // DISK FIRST. `lastFrameUrl` is a signed CDN link that dies in about 24 hours,
        // and `chainFrameFor` above already prefers the permanent copy for exactly that
        // reason — this reference did not, so a film reopened the next day attached a
        // dead url and the render came back refused. The gate reads the resolved value
        // too: a shot whose link has lapsed but whose frame is on disk was being skipped
        // entirely, losing the continuity reference rather than using the copy it had.
        const prevFrame = prev.lastFrameLocalPath || prev.lastFrameUrl
        if ((prev.status === 'ready' || prev.status === 'approved') && prevFrame) {
          const n = sbRefs.length + 1
          // `kind` outright, because this is the one reference with no disk path to
          // classify it by. The backend used to recover that from the WORDING of the
          // line below, so rewriting the sentence un-classified the ref: the model then
          // received the closing frame under a bare label with no role text telling it
          // what to do with it (BLACK MIRROR V3 SHOT_008/SHOT_014, and the bedroom cut
          // where the actor changed sides of the bed).
          sbRefs.push({ url: prevFrame, role: 'reference_image', kind: 'continuity' })
          // La misma corrección que en SEEDANCE_REF_ROLES, porque este texto es el que
          // llega cuando la dirección la escribe el navegador: acotarlo a "iguala la luz
          // y el color" le prohibía al modelo lo único que sostiene la continuidad
          // espacial. La cámara se mueve; la habitación no.
          refAddressing.push(`${refAddr(videoModel, n)} = the closing frame of the shot immediately before this one — the camera has moved, the world has not: keep every person and object on the same side of the bed, the same chair, the same side of the room as this frame shows, and keep its lighting and colour grade. Do not reuse its framing.`)
          refEntries.push({ url: prevFrame, label: 'previous shot closing frame (continuity)' })
          break
        }
      }
    }

    updateAgent('seedance', {
      status: 'active',
      detail: `Animating ${shot.shotId}…`,
      progress: 0,
    })

    // Visible progress: stamp the render start + target resolution so the
    // player/strip timers tick — a 10-minute 1080p render must never look frozen.
    // The tier decides the size for preview/edit, so the timer has to show the
    // tier's resolution — not the project's — or a 480p preview would advertise
    // itself as a 4k render and its ETA would be wrong by an order of magnitude.
    const renderTier: RenderTier = opts?.tier ?? 'master'
    const targetRes = TIER_FIXED_RESOLUTION[renderTier] ?? opts?.resolution ?? outputResolution
    setShots((prev) => prev.map((s) => s.shotId === shot.shotId
      ? { ...s, renderStartedAt: Date.now(), renderingResolution: targetRes }
      : s))

    // Continuity mode without an incoming frame would silently fall back to t2v with
    // NO references at all — the worst of both trades. Refuse instead, and say why.
    if (plan.chainMode && !keyframeUrl) {
      toastError(`Cannot chain ${shot.shotId}`,
        'The previous shot has no rendered closing frame yet — render it first, or turn continuity off')
      setShots((prev) => prev.map((s) => s.shotId === shot.shotId ? { ...s, status: 'queued' } : s))
      return shot
    }

    // The keyframe IS the consistency channel in keyframe mode — animating
    // without one would silently fall back to t2v and reinvent the character.
    if (!keyframeUrl && !sbMode) {
      toastError(`Cannot animate ${shot.shotId}`, 'No keyframe — generate and approve a keyframe first')
      setShots((prev) => prev.map((s) => s.shotId === shot.shotId ? { ...s, status: 'queued' } : s))
      return shot
    }

    // Over the API ceiling the backend refuses (422) rather than clamp, and it is right
    // to: trimming a 21s segment to 15s drops its LAST SHOTS, which is how dialogue got
    // lost before. So refuse HERE, before a paid submit, and say the number out loud —
    // a legacy shot planned before the 15s grouping otherwise fails with a raw backend
    // error in the middle of a batch, one shot at a time. NOT clamped: this app has no
    // way to choose which beats to sacrifice, and doing it silently is the actual defect.
    const plannedSecs = plannedDurationOf(shot.shotId, shotMeta)
    if (plannedSecs > segMaxSecs) {
      toastError(`Cannot render ${shot.shotId}`,
        `This segment is ${plannedSecs.toFixed(1)}s — Seedance renders at most ${segMaxSecs}s per call. `
        + `Split it into shots of ${segMaxSecs}s or less in the Breakdown stage and re-render; `
        + `rendering it capped would drop its last ${(plannedSecs - segMaxSecs).toFixed(1)}s without saying so.`)
      // A refused RE-render must not destroy the prior take — same rule as the failure
      // path at the end of this function. A shot this long may well have a clip from
      // before the ceiling was enforced (it used to be clamped), and demoting its card
      // to 'queued' would hide a take the user already paid for.
      setShots((prev) => prev.map((s) => s.shotId === shot.shotId
        ? { ...s, status: shot.videoUrl ? 'ready' as const : 'queued' as const } : s))
      return shot
    }

    let render: RenderResult = { videoUrl: '' }
    let assembledPrompt = ''
    // Set when the audio-filter retry below succeeded: the clip is MUTE, so the
    // dialogue has to be put back by TTS after the save (see the rescue below).
    let audioFilterMuted = false
    // Per-invocation, NOT the shared activeTaskId ref — see the note at the submit.
    let myTaskId: string | null = null

    const submitAndPoll = async (generateAudio: boolean): Promise<RenderResult> => {
      const taskResp = await pipelineApi.createVideoTask({
        ...buildVideoParams(shot, shotMeta, plan, generateAudio, opts),
        // Item 0/7c: user-reviewed prompt — verbatim, no Claude rewrite
        promptOverride: opts?.promptOverride,
        negativeOverride: opts?.negativeOverride,
      })
      assembledPrompt = taskResp.assembled_prompt ?? ''
      // THE BOARD DID NOT DESCRIBE THIS CUT. The render still goes out — the prompt is
      // the pre-merge one and is valid — but the phase-4 annotations for those shots are
      // NOT in it, and that is invisible in the prompt itself. Told at submit time, in
      // the same place a failed submit is told, because "re-board this card" is the fix
      // and it is cheapest before the clip is paid for.
      if (taskResp.board_mismatch?.severity === 'warning') {
        warning(`${shot.shotId}: board does not match this segment`,
                taskResp.board_mismatch.summary)
        setBoardMismatches((p) => ({ ...p, [shot.shotId]: taskResp.board_mismatch!.summary }))
      } else {
        setBoardMismatches((p) => (p[shot.shotId] ? { ...p, [shot.shotId]: '' } : p))
      }
      const taskId = taskResp.task_id
      // Surface Seedance's real rejection (e.g. the real-person/IP filter) so the
      // catch can react to it — not the generic "no task id".
      if (!taskId) throw new Error((taskResp as { error?: string }).error || 'No task ID returned — check backend logs')
      // THIS shot's task id. It must stay local: a batch runs up to 10 animateShot
      // calls concurrently and they all shared one `activeTaskId` ref, so the last
      // submit overwrote the rest. The damage was in the bookkeeping — saving shot A's
      // video closed shot J's registry entry, which both left A's task 'running' (the
      // reconciler re-downloaded it as a duplicate take) and marked J's live task done
      // (so a closed tab orphaned J's paid render).
      myTaskId = taskId
      activeTaskId.current = taskId          // most recent submit — Stop's fallback
      inFlightTaskIds.current.add(taskId)
      // Register this shot as actively polled — the periodic recovery sweep
      // must not double-poll it.
      activePollers.current.add(shot.shotId)
      setShots((prev) => prev.map((s) =>
        s.shotId === shot.shotId ? { ...s, seedanceTaskId: taskId } : s
      ))
      return pollUntilDone(taskId, 120, () => stopRequested.current)
    }

    // The two filter tests (real-person on an INPUT image vs. the audio Seedance was
    // about to generate) live in lib/seedanceFilters — shared with Studio, and written
    // together because "copyright" appears in both messages while their remedies are
    // opposite. See that module for the wordings each one answers.

    try {
      render = await submitAndPoll(true)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Seedance error'
      // Seedance's audio content filter false-positives on ordinary shots and
      // fails the whole render — retry once with audio generation off.
      if (isAudioFilterBlock(msg)) {
        updateAgent('seedance', { status: 'active', detail: `${shot.shotId}: audio filter tripped — retrying without audio` })
        try {
          render = await submitAndPoll(false)
          // 4A: the retry disables Seedance's audio track, so this clip renders
          // MUTE (no baked voice). The rescue runs after the save (the dub endpoint
          // needs the file on disk) — it re-speaks the lines with the characters'
          // locked voice anchors, which is the only way the dialogue survives here.
          audioFilterMuted = true
        } catch (e2: unknown) {
          const m2 = e2 instanceof Error ? e2.message : 'Seedance error'
          if (m2 !== 'stopped') toastError(`Animation failed: ${shot.shotId}`, m2)
        }
      } else if (isIdentityFilterBlock(msg) && !identityRetry && !sbMode && regenKeyframeF1Ref.current) {
        // Auto-fallback (F1): regenerate the keyframe as a distinctive fictional
        // face (no image ref) and retry the animation once. Unblocks keyframes
        // that were generated the old way without starting a new project.
        updateAgent('seedream', { status: 'active', detail: `${shot.shotId}: real-person filter — regenerating a fictional-face keyframe…` })
        activePollers.current.delete(shot.shotId)
        try {
          const newKf = await regenKeyframeF1Ref.current(shot, shotMeta)
          if (!newKf) throw new Error('keyframe regeneration returned nothing')
          const retry = animateShotRef.current
          if (retry) return await retry({ ...shot, keyframeLocalPath: newKf }, shotMeta,
            { ...opts, firstFrameOverride: newKf }, true)
        } catch (e3: unknown) {
          const m3 = e3 instanceof Error ? e3.message : 'Seedance error'
          if (m3 !== 'stopped') toastError(`Animation failed: ${shot.shotId}`, m3)
        }
      } else if (msg !== 'stopped') {
        // 'stopped' is an intentional user Stop, not a failure — no scary toast.
        toastError(`Animation failed: ${shot.shotId}`, msg)
      }
    } finally {
      activePollers.current.delete(shot.shotId)
      // No longer in flight — whether it succeeded, failed or was stopped. Leaving it
      // in the set would make a later Stop try to cancel a finished task.
      if (myTaskId) inFlightTaskIds.current.delete(myTaskId)
    }
    const videoUrl = render.videoUrl

    // Item 3: persist the render to disk immediately — the CDN URL 403s in ~24h.
    // Seed + resolution go into the sidecar meta so an HD re-render can replay the take.
    let videoLocalPath = ''
    let videoPreviewUrl = ''
    let lastFrameLocalPath = ''
    if (videoUrl) {
      try {
        const saved = await pipelineApi.saveShotVideo(
          shot.shotId, videoUrl, projectName, localFolderRoot ?? '',
          {
            seed: render.seed, resolution: render.resolution, prompt: assembledPrompt,
            // Item 0: the clip's meta records auto + override + refs as attached
            autoPrompt: opts?.autoPrompt ?? assembledPrompt,
            promptOverride: opts?.promptOverride ?? '',
            negativePrompt: opts?.negativeOverride ?? '',
            references: refEntries,
            taskId: myTaskId ?? undefined,   // B2: mark THIS shot's registry task done
            lastFrameUrl: render.lastFrameUrl,   // persist the raw last frame → trusted Extend
            // What this shot was meant to be, so the save can check what came back.
            durationSecs: shotMeta?.estimatedDuration,
            dialogue: shotMeta?.dialogue ?? [],
          },
        )
        videoLocalPath = saved.local_path
        lastFrameLocalPath = saved.last_frame_local_path ?? ''
        if (saved.preview_path) videoPreviewUrl = serveUrl(saved.preview_path)
        // Render gates are measured server-side now (every save path gets them, not
        // just this one) — surface whichever failed. Was a client-side size check that
        // only ever ran here.
        for (const g of saved.gates ?? []) {
          if (!g.passed) toastError(`${shot.shotId}: ${g.label}`, g.notes)
        }
      } catch {
        // Non-fatal: CDN URL still works for now
      }
    }

    // 4A rescue: the audio-filter retry rendered this clip MUTE, and the dialogue
    // is BAKED into Seedance's audio track — so it went silent with it. Re-speak the
    // lines with each character's LOCKED voice anchor and mix them back on (real
    // sidechain ducking, server-side). This has to run HERE, after saveShotVideo:
    // /api/shot/dialogue reads the clip off disk and 400s when it is not there yet.
    // The dubbed file then rides the normal adoption path below (take history, the
    // shot's videoLocalPath/previewUrl) — no parallel plumbing.
    if (audioFilterMuted && videoUrl) {
      // A segment can hold several shots, and the dialogue lives on each of them; a
      // migrated project is 1:1 so this is the shot's own lines there. Names, not ids —
      // the voice anchors the server resolves are keyed by character NAME.
      const seg = segmentOf(shot.shotId)
      const rawLines = seg?.shots?.length
        ? seg.shots.flatMap((s: SegmentShot) => s.dialogue ?? [])
        : (shotMeta?.dialogue ?? [])
      const dubLines = rawLines
        .filter((d) => (d.text ?? '').trim())
        .map((d) => ({
          character: assetMap[d.characterId]?.name ?? d.characterId,
          text: d.text,
          emotion: d.emotion,
        }))
      if (!dubLines.length) {
        // Nothing spoken in this shot — mute is the correct result, not a loss.
        info(`${shot.shotId}: rendered without audio`, 'Seedance\'s audio filter tripped, so this take has no ambient track. The shot has no dialogue, so nothing was lost.')
      } else if (!videoLocalPath) {
        warning(`${shot.shotId}: rendered without voice`, 'Audio filter tripped and the clip could not be saved locally, so the dialogue could not be re-recorded — re-generate this shot.')
      } else {
        updateAgent('seedance', { status: 'active', detail: `${shot.shotId}: re-recording the dialogue…` })
        try {
          const dub = await pipelineApi.generateShotDialogue({
            shotId: shot.shotId, videoLocalPath, lines: dubLines,
            projectName, projectPath: localFolderRoot ?? '', duck: true,
          })
          videoLocalPath = dub.dub_path || videoLocalPath
          if (dub.preview_path) videoPreviewUrl = serveUrl(dub.preview_path)
          info(`${shot.shotId}: voice re-recorded`, `Audio filter tripped, so the clip came back mute — ${dub.lines} line(s) were re-spoken with the characters' locked voices and mixed back in. Being TTS, they are NOT lip-synced to the picture.`)
          // C1: a rejected voiceprint means a character SOUNDS LIKE SOMEONE ELSE in
          // this shot. That must never be silent — name the shot so it can be found.
          const swapped = dub.voice_fallback_lines ?? []
          if (swapped.length) {
            warning(`${shot.shotId}: a character's voice was substituted`,
              `${swapped.length} of ${dub.lines} line(s) were spoken in a generic voice — Seed Audio rejected the locked reference. Re-record that character's voice reference, then re-generate this shot.`)
          }
        } catch (eDub: unknown) {
          // Only NOW the loud warning: the clip really is voiceless.
          const mDub = eDub instanceof Error ? eDub.message : 'TTS error'
          warning(`${shot.shotId}: rendered without voice`, `Audio filter tripped and re-recording the dialogue failed (${mDub}) — re-generate this shot to try baking the dialogue again.`)
        }
      }
    }

    // A stopped/failed RE-animation must not destroy the prior good take: keep
    // the existing video and stay 'ready'. Only a first-time animation (no prior
    // video) falls back to 'queued' so it can be re-generated.
    const hadPriorVideo = !!shot.videoUrl
    // Item 4F: record this render as a take in the normalized per-shot history so the
    // panel's switcher can restore it later (disk already versioned it as video_vNNN.mp4).
    // Guarded on isCurrentProject — a render landing after a project switch must never
    // write into the new project. The store setter runs OUTSIDE the setShots updater below.
    let selectedTakeId = shot.selectedVersionId
    if (videoUrl && isCurrentProject()) {
      selectedTakeId = addShotVersion(shot.shotId, {
        videoLocalPath: videoLocalPath || undefined,
        videoUrl,
        previewUrl: videoPreviewUrl || undefined,
        seedanceTaskId: myTaskId ?? undefined,
        resolution: render.resolution,
        tier: renderTier,
        lastFrameUrl: render.lastFrameUrl,
        assembledPrompt: assembledPrompt || undefined,
        notes: shot.notes,
        status: 'draft',
        sourceAssetVersions: shot.sourceAssetVersions,
      })
    }
    const updated: GeneratedShot = {
      ...shot,
      selectedVersionId: videoUrl ? selectedTakeId : shot.selectedVersionId,
      status: (videoUrl || hadPriorVideo) ? 'ready' : 'queued',
      videoUrl: videoUrl || shot.videoUrl,
      previewUrl: videoUrl ? (videoPreviewUrl || undefined) : shot.previewUrl,
      videoLocalPath: videoUrl ? (videoLocalPath || shot.videoLocalPath) : shot.videoLocalPath,
      assembledPrompt: videoUrl ? (assembledPrompt || shot.assembledPrompt) : shot.assembledPrompt,
      seed: videoUrl ? (render.seed ?? shot.seed) : shot.seed,
      renderedResolution: videoUrl ? (render.resolution ?? shot.renderedResolution) : shot.renderedResolution,
      // Which rung this clip now sits on. Mirrors the videoUrl guard above so a
      // stopped or failed promotion leaves the shot on the tier it already had —
      // otherwise a cancelled master pass would mark shots as mastered.
      tier: videoUrl ? renderTier : shot.tier,
      lastFrameUrl: videoUrl ? (render.lastFrameUrl ?? shot.lastFrameUrl) : shot.lastFrameUrl,
      lastFrameLocalPath: videoUrl ? (lastFrameLocalPath || shot.lastFrameLocalPath) : shot.lastFrameLocalPath,
      // 3-bug1c: record the board version this take was built from so a later board
      // regen (version bumps monotonically) flags THIS clip stale, per-shot. Keeps the
      // prior value on a stopped/failed re-animation (mirror the videoUrl guard above).
      sourceBoardVersion: videoUrl ? (shotBoardMap[shot.shotId]?.version ?? shot.sourceBoardVersion) : shot.sourceBoardVersion,
    }
    setShots((prev) => prev.map((s) => s.shotId === shot.shotId ? updated : s))
    if (videoUrl) {
      // P3.17: headshot (or full-body) of the shot's first character → identity drift.
      // Fire-and-forget: the clip is watchable immediately, QC lands when ready.
      const firstChar = usedAssets.find((a) => a.meta?.type === 'character')
      const charRef = firstChar ? (assetApproval[firstChar.id]?.headshot ?? firstChar.url) : undefined
      void runClaudeQC(updated, shotMeta, charRef ?? undefined)
    }
    const wasStopped = stopRequested.current && !videoUrl
    updateAgent('seedance', {
      status: videoUrl ? 'completed' : wasStopped ? 'idle' : 'error',
      detail: videoUrl ? `${shot.shotId} rendered`
        : wasStopped ? `${shot.shotId} stopped — kept previous take`
        : `${shot.shotId} failed`,
    })
    return updated
  }, [planShot, buildVideoParams, assetApproval, shotMetaMap, updateAgent, runClaudeQC, toastError, warning, info, shotBoardMap, addShotVersion, isCurrentProject, projectName, localFolderRoot, outputResolution, assetMap, segmentOf, plannedDurationOf, segMaxSecs, videoModel])


  // The keyframe plan: ordered refs + descriptors + hints, derived ONCE — shared
  // by the dry-run keyframe prompt (PromptPanel) and the real generation.
  const planKeyframe = useCallback((shot: GeneratedShot, shotMeta: Shot | undefined) => {
    const usedAssetsSorted = (shotMeta?.assetsUsed ?? [])
      .map((id) => ({ id, url: approvedAssetUrls[id], meta: assetMap[id] }))
      .filter((a) => a.url)
      .sort((a, b) => {
        // 'voice' is unreachable here — a voice asset has no approved image, so the
        // .filter(a => a.url) above already dropped it. It is listed to keep the map
        // total over AssetType, and last so it could never outrank a real reference.
        const order = { character: 0, prop: 2, wardrobe: 2, environment: 1, vfx: 3, fx: 3, voice: 4 }
        return (order[a.meta?.type ?? 'prop'] ?? 2) - (order[b.meta?.type ?? 'prop'] ?? 2)
      })

    // P2.9+P2.10: ordered ref list per the official ID-drift recipe — character
    // HEADSHOT first, then full body, then environment/props — with a human
    // descriptor per ref so the prompt can address them ("image 1 is …").
    // (The old F1 photographic/pure-t2i branch is superseded: Seedream 5.0 Pro
    // outputs pass Seedance's face filter, so approved refs attach directly.)
    const keyframeRefList: Array<{ url: string; desc: string }> = []
    for (const a of usedAssetsSorted) {
      if (a.meta?.type === 'character') {
        const hs = assetApproval[a.id]?.headshot
        if (hs) keyframeRefList.push({ url: hs, desc: `${a.meta.name}'s face — match it exactly` })
        keyframeRefList.push({ url: a.url!, desc: `${a.meta.name}'s full body and wardrobe` })
      } else if (a.meta?.type === 'environment') {
        keyframeRefList.push({ url: a.url!, desc: `the ${a.meta.name} environment` })
      } else {
        keyframeRefList.push({ url: a.url!, desc: `the ${a.meta?.name ?? 'prop'}` })
      }
    }
    // The board steers COMPOSITION as TEXT (the backend's vision-read COMPOSITION
    // LOCK on panel 1) — attaching the multi-panel grid as an image ref made
    // keyframes drift toward collage layouts; identity rides the asset refs above.
    const shotBoard = shotBoardMap[shot.shotId]
    const boardRefUrl = shotBoard?.boardLocalPath || shotBoard?.boardUrl
    // Subject hint carries the FULL character description (wardrobe, hair, features),
    // not just the name — the text channel must reinforce what the image ref anchors,
    // or scene-heavy prompts dilute wardrobe details out of the keyframe.
    const charForKeyframe = usedAssetsSorted
      .filter((a) => a.meta?.type === 'character')
      .map((a) => `${a.meta!.name}: ${a.meta!.visualDescription ?? ''}`.trim().replace(/:$/, ''))
      .join('; ')
    // F1: characters sent to the backend so it can inject + cache each one's
    // distinctive-fictional facial-feature block (used only in photographic mode).
    // headshotUrl vision-grounds the block so the t2i face matches the approved one.
    const characters = usedAssetsSorted
      .filter((a) => a.meta?.type === 'character')
      .map((a) => ({
        name: a.meta!.name,
        description: a.meta!.visualDescription ?? '',
        headshotUrl: assetApproval[a.id]?.headshot || a.url || '',
      }))
    const envForKeyframe = usedAssetsSorted.filter((a) => a.meta?.type === 'environment').map((a) => a.meta!.visualDescription?.split(' ').slice(0,6).join(' ') ?? a.meta!.name).join(', ')

    // User image refs from ReferenceMediaPanel are routed HERE (Seedream), not to
    // Seedance — in i2v mode Seedance drops reference_image items.
    const refMedia = shotRefMedia[shot.shotId] ?? emptyReferenceMedia()
    const userImageRefs = refMedia.images
      .filter((i) => i.role !== 'first_frame')
      .map((i) => i.url)
      .filter(Boolean)
    // IDENTITY BY IMAGE (2026-07-07): the account is I2I-whitelisted — Seedance
    // accepts ref-conditioned keyframes, so the approved asset images ride as
    // Seedream refs for EVERY style (the original design). Pure-t2i survives only
    // as the PrivacyInformation auto-fallback (regenKeyframeF1).
    const allKeyframeRefs = [...keyframeRefList.map((r) => r.url), ...userImageRefs]
    const allRefDescriptors = [
      ...keyframeRefList.map((r) => r.desc),
      ...userImageRefs.map(() => 'a user-provided style reference'),
    ]
    return {
      usedAssetsSorted, allKeyframeRefs, allRefDescriptors, charForKeyframe, envForKeyframe, characters,
      // Photographic: the board can't ride as an image ref (trust chain) — the backend
      // vision-reads panel 1 from this URL and grounds the keyframe composition as text.
      boardUrl: boardRefUrl || '',
      boardRows: shotBoard?.rows ?? 0,
      boardCols: shotBoard?.cols ?? 0,
    }
  }, [approvedAssetUrls, assetMap, assetApproval, shotBoardMap, shotRefMedia])

  // PrivacyInformation auto-fallback: if Seedance rejects a ref-conditioned
  // keyframe (refs from another account / >30 days — trust nullified), regenerate
  // it PURE t2i (zero refs; identity rides the cached face-block text) and retry
  // once. Wired to a ref so animateShot (declared above) can call it.
  const regenKeyframeF1 = useCallback(async (shot: GeneratedShot, shotMeta: Shot | undefined): Promise<string> => {
    const { charForKeyframe, envForKeyframe, characters, boardUrl, boardRows, boardCols } =
      planKeyframe(shot, shotMeta)
    const resp = await pipelineApi.generateShotKeyframe({
      shotId: shot.shotId,
      shotDescription: shotMeta?.visualDescription ?? shot.shotId,
      shotAction: (shotMeta?.action ?? '') + (shot.notes ? `. Director notes: ${shot.notes}` : ''),
      subjectHint: charForKeyframe,
      envHint: envForKeyframe,
      lightingHint: shotMeta?.lighting ?? '',
      approvedAssetUrls: [],   // PURE t2i — the trusted fallback
      refDescriptors: [],
      characters,
      style,
      aspectRatio,
      projectName,
      projectPath: localFolderRoot ?? '',
      boardUrl, boardRows, boardCols,
    })
    setShots((prev) => prev.map((s) => s.shotId === shot.shotId
      ? { ...s, keyframeLocalPath: resp.keyframe_local_path || s.keyframeLocalPath, thumbnailUrl: resp.keyframe_url || s.thumbnailUrl }
      : s))
    return resp.keyframe_local_path || resp.keyframe_url || ''
  }, [planKeyframe, style, aspectRatio, projectName, localFolderRoot])

  // Wire the refs the identity auto-fallback reaches across declaration order.
  useEffect(() => {
    animateShotRef.current = animateShot
    regenKeyframeF1Ref.current = regenKeyframeF1
  }, [animateShot, regenKeyframeF1])

  // ── 0.5: Generate keyframe, then (optionally) auto-animate ───────────────────

  const generateShot = useCallback(async (
    shot: GeneratedShot,
    shotMeta: Shot | undefined,
    feedback = '',
    // Rung for THIS pass. Without it every first render fell through to 'master'
    // (animateShot's default), so the ladder could only ever be climbed AFTER
    // paying the top price once — the cheap first pass was unreachable from the UI.
    opts?: AnimateShotOpts,
  ) => {
    // Item 1: hard gate — no generation while char/env assets are unapproved
    if (generationLocked) {
      toastError('Generation blocked', gateMessage)
      return shot
    }

    setShots((prev) => prev.map((s) => s.shotId === shot.shotId
      ? { ...s, status: 'generating', renderStartedAt: Date.now(), renderingResolution: undefined }
      : s))

    // Item 2: if the breakdown says this shot uses a character/environment but the
    // reference didn't resolve, the keyframe would reinvent it from text — block the shot.
    const unresolved = (shotMeta?.assetsUsed ?? [])
      .filter((id) => !approvedAssetUrls[id])
      .map((id) => assetMap[id])
      .filter((a) => a && (a.type === 'character' || a.type === 'environment'))
    if (unresolved.length > 0) {
      toastError(
        `Cannot generate ${shot.shotId}`,
        `No approved image for: ${unresolved.map((a) => a!.name).join(', ')}`
      )
      setShots((prev) => prev.map((s) => s.shotId === shot.shotId ? { ...s, status: 'queued' } : s))
      return shot
    }

    // Item 7a: SB mode is the DEFAULT with a board — skip the keyframe and let
    // Seedance reference mode follow the beats directly (labeled in the UI).
    // Motion-reference mode also skips the keyframe (reference mode, video-driven).
    // Stage 5 goes straight to Seedance REFERENCE mode (board beats + asset refs →
    // video). There is no intermediate keyframe still to approve: the storyboard is
    // the composition approval and the approved assets carry identity. A per-shot
    // director note (feedback) rides as shot.notes into the video prompt.
    const withNotes = feedback ? { ...shot, notes: feedback } : shot
    setShots((prev) => prev.map((s) => s.shotId === shot.shotId ? { ...s, status: 'animating' } : s))
    return await animateShot({ ...withNotes, status: 'animating' }, shotMeta, opts)
  }, [approvedAssetUrls, assetMap, animateShot, generationLocked, gateMessage, toastError])

  // ── Generate All — Item 4: keyframes ONLY. Stills are shown together in the
  // keyframe preview row for approval; Seedance runs only on approved stills. ──

  // Generate every clip in one pass — Seedance reference mode (board beats + asset
  // refs → video) per shot. No keyframe phase: the storyboard is the composition
  // approval, the approved assets carry identity. Chain toggle renders shots
  // sequentially (each shot's last frame seeds the next's first frame) for
  // scene continuity; otherwise a worker pool runs at Seedance's concurrency cap.
  // Item 4C: shared sequential-continuity runner — chains `subset` (in order), each
  // clip's last frame seeding the next's first frame, recording results onto `onto`.
  // Extracted from handleGenerateAll's chain branch so BOTH "Chain All" and "Chain
  // Selected" reuse ONE loop (no duplication).
  const runChainedSequence = useCallback(async (subset: GeneratedShot[], onto: GeneratedShot[],
                                                tier?: RenderTier) => {
    const metaOf = (shotId: string) => stage4Breakdown?.shots.find((s) => s.id === shotId)
    const record = (u: GeneratedShot) => { const idx = onto.findIndex((s) => s.shotId === u.shotId); if (idx !== -1) onto[idx] = u }
    let prevLastFrame: string | undefined
    for (let i = 0; i < subset.length; i++) {
      if (stopRequested.current) break
      const shot = subset[i]
      updateAgent('seedance', {
        detail: `Chaining ${i + 1}/${subset.length}: ${shot.shotId}`,
        progress: Math.round((i / subset.length) * 100),
      })
      setShots((prev) => prev.map((s) => s.shotId === shot.shotId ? { ...s, status: 'animating' } : s))
      try {
        const updated = await animateShot({ ...shot, status: 'animating' }, metaOf(shot.shotId),
          { firstFrameOverride: prevLastFrame, tier })
        prevLastFrame = updated.lastFrameUrl || prevLastFrame
        record(updated)
      } catch (e) {
        toastError(`Clip failed: ${shot.shotId}`, `${e instanceof Error ? e.message : 'error'} — continuing`)
      }
    }
  }, [stage4Breakdown, animateShot, updateAgent, toastError])

  const handleGenerateAll = useCallback(async () => {
    if (generationLocked) {
      toastError('Generation blocked', gateMessage)
      return
    }
    // Over-length segments are named ONCE, up front, and left out of the pass — inside
    // the pool they would each come back as their own failure toast between renders,
    // which is exactly when the user is not reading. animateShot refuses them anyway;
    // this is so the refusal is a batch-level statement instead of scattered noise.
    const pending = shots.filter((s) => s.status !== 'approved')
    const toGenerate = pending.filter((s) => !overlongIds.has(s.shotId))
    if (toGenerate.length < pending.length) {
      warning(`${pending.length - toGenerate.length} shot(s) are too long to render`,
        `${overlongList} — Seedance renders at most ${segMaxSecs}s per call. Split them in the `
        + 'Breakdown stage; the rest of the pass is running.')
    }
    if (!toGenerate.length) return
    stopRequested.current = false
    setIsGenerating(true)
    setStageStatus(5, 'generating')
    updateAgent('seedance', { status: 'active', detail: 'Generating all clips…', progress: 0 })

    const metaOf = (shotId: string) => stage4Breakdown?.shots.find((s) => s.id === shotId)
    // `allUpdated` lo escribe ahora `runChainedSequence`, que trae su propio `record`:
    // el pool plano que lo usaba aquí ya no existe.
    const allUpdated = [...shots]

    if (chainScene) {
      await runChainedSequence(toGenerate, allUpdated, passTier)   // Item 4C: reuse the shared runner
    } else {
      // CHAINED WITHIN A SCENE, SCENES IN PARALLEL. The flat worker pool that used to be
      // here submitted ten shots at once, so shot N+1 went out before shot N had finished
      // — and `planShot` attaches the previous shot's closing frame ONLY when that shot is
      // already `ready`/`approved` with a `lastFrameUrl`. It therefore almost never
      // attached it: measured across BLACK MIRROR and BLACK MIRROR V3, the closing frame
      // existed on disk for all 16 cuts and reached the next prompt in 5 of them — 1 of 8
      // in V3. The spatial state of a scene travels as that IMAGE (the text carry says
      // what happened, not where anything is), so without it the model re-invents the
      // room: 6 of 7 same-scene cuts broke in the first film and 5 of 7 in the second,
      // including a man and his whole bedside table swapping to the other side of the bed
      // between two shots with nothing on screen showing the move.
      //
      // Scenes do not need it from each other — a cut between scenes IS a change of
      // place — so they still run concurrently, bounded by the same Seedance cap. A film
      // of one scene now renders sequentially and takes longer; that is the trade, and it
      // buys the thing the whole storyboard stage exists to protect.
      //
      // The `chainScene` toggle above still means what it meant: chain EVERYTHING, across
      // scene boundaries too.
      const byScene = new Map<string, GeneratedShot[]>()
      for (const s of toGenerate) {
        const sc = (metaOf(s.shotId) as unknown as { sceneId?: string } | undefined)?.sceneId ?? s.shotId
        byScene.set(sc, [...(byScene.get(sc) ?? []), s])
      }
      const scenes = [...byScene.values()]
      let nextScene = 0
      const sceneWorker = async () => {
        for (;;) {
          if (stopRequested.current) return
          const i = nextScene++
          if (i >= scenes.length) return
          updateAgent('seedance', {
            detail: `Scene ${Math.min(nextScene, scenes.length)}/${scenes.length}: ${scenes[i].length} shot(s) in order`,
            progress: Math.round((i / scenes.length) * 100),
          })
          await runChainedSequence(scenes[i], allUpdated, passTier)
        }
      }
      const pool = Math.min(seedanceChunkSize(outputResolution), scenes.length)
      await Promise.all(Array.from({ length: pool }, sceneWorker))
    }

    if (isCurrentProject()) {
      commitVersion(5, { shots: allUpdated })
      setStageStatus(5, 'pending_review')
    }
    updateAgent('seedance', {
      status: stopRequested.current ? 'idle' : 'completed',
      detail: stopRequested.current ? 'Stopped by user' : 'All clips generated — review & approve',
      progress: 100,
    })
    setIsGenerating(false)
  }, [shots, stage4Breakdown, runChainedSequence, chainScene, passTier, outputResolution, commitVersion, setStageStatus, updateAgent, generationLocked, gateMessage, toastError, warning, overlongIds, overlongList, isCurrentProject, segMaxSecs])

  // Item 4C: "Chain Selected" — chains ONLY the ticked shots (strip order preserved for
  // correct frame seeding). Mirrors handleGenerateAll's commit/gate lifecycle. Does NOT
  // skip approved shots — ticking a shot is an explicit (re)render request (user-initiated,
  // not the upstream-driven auto-regen the versioning rules forbid).
  const handleChainSelected = useCallback(async () => {
    if (generationLocked) { toastError('Generation blocked', gateMessage); return }
    const subset = shots.filter((s) => selectedShotIds.includes(s.shotId))
    if (subset.length < 2) return   // a chain needs ≥2 shots; 1 = use per-shot Re-render
    stopRequested.current = false
    setIsGenerating(true); setStageStatus(5, 'generating')
    updateAgent('seedance', { status: 'active', detail: `Chaining ${subset.length} selected clips…`, progress: 0 })
    const allUpdated = [...shots]
    await runChainedSequence(subset, allUpdated, passTier)
    if (isCurrentProject()) { commitVersion(5, { shots: allUpdated }); setStageStatus(5, 'pending_review') }
    updateAgent('seedance', {
      status: stopRequested.current ? 'idle' : 'completed',
      detail: stopRequested.current ? 'Stopped by user' : 'Selected clips chained — review & approve',
      progress: 100,
    })
    setIsGenerating(false); setSelectedShotIds([])
  }, [passTier, shots, selectedShotIds, runChainedSequence, generationLocked, gateMessage, toastError, setStageStatus, updateAgent, commitVersion, isCurrentProject])

  // ── Promote ONE shot up the ladder (the per-shot twin of handlePromote) ───────
  // Same rank guard as the batch, so a shot already at or above the target is a
  // no-op rather than a paid re-render. (seed rides along but Seedance 2.0 ignores
  // it — a promotion is always a NEW take, never an upscale of the approved one.)
  const handlePromoteShot = useCallback(async (shotId: string, target: RenderTier) => {
    const shot = shots.find((s) => s.shotId === shotId)
    const meta = stage4Breakdown?.shots.find((s) => s.id === shotId)
    if (!shot || !shot.videoUrl || shot.status === 'animating') return
    if (tierRank(shot.tier) >= tierRank(target)) return
    const targetRes = TIER_FIXED_RESOLUTION[target] ?? outputResolution
    updateAgent('seedance', { status: 'active', detail: `${target}: ${shotId} → ${targetRes}…` })
    setShots((prev) => prev.map((s) => s.shotId === shotId ? { ...s, status: 'animating' } : s))
    // Per-shot lock: review/approve other shots while this one re-renders.
    await animateShot(shot, meta, { tier: target, resolution: outputResolution, seed: shot.seed })
  }, [shots, stage4Breakdown, animateShot, updateAgent, outputResolution])

  // Re-render this shot at the same resolution, honoring the latest notes/edits.
  // NOTE: Seedance 2.0 has no seed, so this is always a FRESH take (there is no
  // "keep the same look" replay — that promise was never achievable on 2.0).
  const handleRetake = useCallback(async (shotId: string) => {
    const shot = shots.find((s) => s.shotId === shotId)
    const meta = stage4Breakdown?.shots.find((s) => s.id === shotId)
    if (!shot || !shot.videoUrl || shot.status === 'animating') return
    stopRequested.current = false   // fresh user action clears any prior Stop
    updateAgent('seedance', { status: 'active', detail: `${shotId}: new take…` })
    setShots((prev) => prev.map((s) => s.shotId === shotId ? { ...s, status: 'animating' } : s))
    // Per-shot lock: only this shot is busy — the rest of the stage stays usable
    await animateShot(shot, meta, {
      // Without this the retake is stamped 'master' (animateShot's default) even though
      // it re-renders at the clip's own size — which drops the shot out of every
      // promotion pass, with no way back from the UI.
      tier: tierFor(shot),
      resolution: shot.renderedResolution ?? outputResolution,
    })
  }, [shots, stage4Breakdown, animateShot, updateAgent, outputResolution, tierFor])

  // Item 4F: switch the active shot to a previously-rendered take. shotSelectedVersion
  // is authoritative (survives rollback); we also swap the shot's media so the player
  // and Stage-6 use the chosen take. Prefer the disk-served path — CDN URLs 403 after
  // ~24h. The store setter runs OUTSIDE the setState updater.
  const handleSelectTake = useCallback((shotId: string, versionId: string) => {
    const take = (shotVersions[shotId] ?? []).find((t) => t.id === versionId)
    if (!take) return
    setSelectedShotVersion(shotId, versionId)
    const servedVideo = take.videoLocalPath ? serveUrl(take.videoLocalPath) : (take.videoUrl ?? '')
    setShots((prev) => prev.map((s) => s.shotId === shotId ? {
      ...s,
      selectedVersionId: versionId,
      status: 'ready' as const,
      videoUrl: servedVideo || s.videoUrl,
      videoLocalPath: take.videoLocalPath ?? s.videoLocalPath,
      previewUrl: take.previewUrl ?? undefined,
      assembledPrompt: take.assembledPrompt ?? s.assembledPrompt,
      renderedResolution: take.resolution ?? s.renderedResolution,
      lastFrameUrl: take.lastFrameUrl ?? s.lastFrameUrl,
      seedanceTaskId: take.seedanceTaskId ?? s.seedanceTaskId,
    } : s))
  }, [shotVersions, setSelectedShotVersion])

  // ── The cost ladder: promote finished shots UP a tier, in batch ──────────────
  // Ranked, never compared by string. The previous test was
  //   s.renderedResolution !== outputResolution
  // which is true in BOTH directions: lowering Settings from 4k to 720p turned
  // every finished 4k shot into a "candidate" and offered to re-render the whole
  // episode DOWNWARD, at full price, as an upgrade. Rank makes that impossible.
  //
  // A shot with no tier (every project that predates the ladder, and everything
  // reconstructed from disk) ranks as 'master' and is therefore never a candidate.
  // That is deliberate: disk cannot tell us what a clip was rendered at, and
  // guessing "draft" would put a whole episode one click from a ~$2,100 re-render.
  const promotableTo = useCallback((target: RenderTier) =>
    shots.filter((s) => (s.status === 'approved' || s.status === 'ready')
      && s.videoUrl && tierRank(s.tier) < tierRank(target)),
  [shots])

  const handlePromote = useCallback(async (target: RenderTier, only?: string[]) => {
    const candidates = only
      ? promotableTo(target).filter((s) => only.includes(s.shotId))
      : promotableTo(target)
    if (!candidates.length) return
    const targetRes = TIER_FIXED_RESOLUTION[target] ?? outputResolution
    stopRequested.current = false
    setIsGenerating(true)
    updateAgent('seedance', { status: 'active', detail: `${target} pass: ${candidates.length} shot(s) → ${targetRes}…`, progress: 0 })
    const metaOf = (shotId: string) => stage4Breakdown?.shots.find((s) => s.id === shotId)
    const hdChunk = seedanceChunkSize(targetRes)
    for (let i = 0; i < candidates.length; i += hdChunk) {
      if (stopRequested.current) break
      const chunk = candidates.slice(i, i + hdChunk)
      setShots((prev) => prev.map((s) => chunk.some((c) => c.shotId === s.shotId) ? { ...s, status: 'animating' } : s))
      updateAgent('seedance', { detail: `${target} pass ${Math.min(i + hdChunk, candidates.length)}/${candidates.length}…` })
      await Promise.all(chunk.map((s) => animateShot(s, metaOf(s.shotId), { tier: target, resolution: outputResolution, seed: s.seed })))
    }
    updateAgent('seedance', { status: 'completed', detail: `${target} pass complete`, progress: 100 })
    // Commit the batch as a Stage-5 version, the way Generate All does — a promotion
    // pass changed every one of these shots and must be restorable. Guarded on
    // isCurrentProject so a pass finishing after a project switch never writes into
    // the project the user has since opened.
    if (isCurrentProject()) {
      commitVersion(5, { shots: shotsRef.current })
      setStageStatus(5, 'pending_review')
    }
    setIsGenerating(false)
  }, [promotableTo, stage4Breakdown, animateShot, updateAgent, outputResolution,
      isCurrentProject, commitVersion, setStageStatus])

  // ── P3.14: Stop — halt the batch and cancel EVERY in-flight task ─────────────

  const handleStop = useCallback(async () => {
    stopRequested.current = true
    // Cancel all of them, not just the most recent submit. A batch has up to 10 tasks
    // in flight; cancelling one left the other nine queued at BytePlus, still billable,
    // and Stop looked like it had worked. Only queued tasks can actually be cancelled —
    // a running one finishes server-side and B2 reconcile recovers it either way.
    const inFlight = [...inFlightTaskIds.current]
    inFlightTaskIds.current.clear()
    await Promise.all(inFlight.map((id) =>
      pipelineApi.cancelVideoTask(id).catch(() => { /* already running — not cancellable */ })
    ))
    // Release any in-flight shot to its last-good state NOW so the UI unblocks
    // (a running Seedance task can't be cancelled — it finishes server-side and
    // B2 reconcile recovers it; the in-flight poll also bails via shouldStop).
    setShots((prev) => prev.map((s) => {
      if (s.status !== 'animating' && s.status !== 'generating') return s
      const status: GeneratedShot['status'] = s.videoUrl ? 'ready'
        : (s.keyframeLocalPath || s.thumbnailUrl) ? 'keyframe_ready' : 'queued'
      return { ...s, status }
    }))
    activePollers.current.clear()
    setIsGenerating(false)
    updateAgent('seedance', { status: 'idle', detail: 'Stopped — any running render finishes server-side (auto-recovered)' })
  }, [updateAgent])

  // ── P3.14: reconcile shots orphaned mid-animation (browser closed etc.) ──────

  // Runs on mount AND every 60s: any shot stuck in 'animating' with a task id
  // but no live poller (browser reload, old timeout, navigation) is resumed —
  // finished renders are recovered, dead ones released. Never strand a paid render.
  const recoverStranded = useCallback(() => {
    // Release shots stuck in 'generating' (they died before submitting to Seedance
    // — a reload mid-flight, or a batch that errored). They have no task to resume,
    // so leaving them 'generating' keeps the whole stage 'busy' and disables the
    // batch button. Drop them to a retriable state so generation can proceed.
    const stuckGenerating = shotsRef.current.filter((s) =>
      s.status === 'generating' && !s.seedanceTaskId && !activePollers.current.has(s.shotId))
    if (stuckGenerating.length) {
      const ids = new Set(stuckGenerating.map((s) => s.shotId))
      setShots((prev) => prev.map((p) => ids.has(p.shotId)
        ? { ...p, status: p.videoUrl ? 'ready' : (p.keyframeLocalPath || p.thumbnailUrl) ? 'keyframe_ready' : 'queued' }
        : p))
    }

    const stranded = shotsRef.current.filter((s) =>
      s.status === 'animating' && s.seedanceTaskId && !activePollers.current.has(s.shotId))
    for (const s of stranded) {
      activePollers.current.add(s.shotId)
      updateAgent('seedance', { status: 'active', detail: `${s.shotId}: resuming in-flight render…` })
      setShots((prev) => prev.map((p) => p.shotId === s.shotId && !p.renderStartedAt
        ? { ...p, renderStartedAt: Date.now() } : p))
      void (async () => {
        try {
          const render = await pollUntilDone(s.seedanceTaskId!)
          let videoLocalPath = ''
          let lastFrameLocalPath = ''
          try {
            const saved = await pipelineApi.saveShotVideo(
              s.shotId, render.videoUrl, projectName, localFolderRoot ?? '',
              { seed: render.seed, resolution: render.resolution, prompt: s.assembledPrompt ?? '', taskId: s.seedanceTaskId,
                lastFrameUrl: render.lastFrameUrl },
            )
            videoLocalPath = saved.local_path
            lastFrameLocalPath = saved.last_frame_local_path ?? ''
          } catch { /* CDN URL still works for now */ }
          setShots((prev) => prev.map((p) => p.shotId === s.shotId
            ? {
                ...p, status: 'ready', videoUrl: render.videoUrl,
                videoLocalPath: videoLocalPath || p.videoLocalPath,
                lastFrameLocalPath: lastFrameLocalPath || p.lastFrameLocalPath,
                seed: render.seed ?? p.seed,
                renderedResolution: render.resolution ?? p.renderedResolution,
                lastFrameUrl: render.lastFrameUrl || p.lastFrameUrl,
              }
            : p))
          updateAgent('seedance', { status: 'completed', detail: `${s.shotId} resumed and finished` })
        } catch {
          // Failed/expired upstream: release the shot back to a retriable state
          setShots((prev) => prev.map((p) => p.shotId === s.shotId
            ? { ...p, status: (p.keyframeLocalPath || p.thumbnailUrl) ? 'keyframe_ready' : 'queued' }
            : p))
          updateAgent('seedance', { status: 'idle', detail: `${s.shotId}: stale render released` })
        } finally {
          activePollers.current.delete(s.shotId)
        }
      })()
    }
  }, [projectName, localFolderRoot, updateAgent])

  // B2: adopt renders the BACKEND finished + saved to disk while this tab was
  // closed (the persistent render registry survives restarts and the 24h window).
  // A shot with no video yet, not actively polled here, picks up its saved clip.
  const reconcileFromRegistry = useCallback(async () => {
    if (!localFolderRoot && !projectName) return
    try {
      const { tasks } = await pipelineApi.getRenderRegistry(localFolderRoot ?? '', projectName)
      const done = tasks.filter((t) => t.status === 'completed' && t.video_local_path && t.shot_id)
      if (!done.length) return
      setShots((prev) => prev.map((s) => {
        if (s.videoUrl || activePollers.current.has(s.shotId)) return s
        const t = done.filter((d) => d.shot_id === s.shotId).pop()
        if (!t) return s
        return {
          ...s, status: 'ready',
          videoUrl: serveUrl(t.video_local_path!),
          previewUrl: t.preview_local_path ? serveUrl(t.preview_local_path) : s.previewUrl,
          videoLocalPath: t.video_local_path!,
          seed: t.seed ?? s.seed,
          renderedResolution: t.resolution || s.renderedResolution,
        }
      }))
    } catch { /* registry is best-effort — ignore if backend is old/unreachable */ }
  }, [localFolderRoot, projectName])

  useEffect(() => {
    // Short delay on mount so this session's own submits register their pollers first
    const initial = setTimeout(recoverStranded, 4_000)
    const adopt = setTimeout(reconcileFromRegistry, 4_500)
    const sweep = setInterval(recoverStranded, 60_000)
    return () => { clearTimeout(initial); clearTimeout(adopt); clearInterval(sweep) }
  }, [recoverStranded, reconcileFromRegistry])

  // ── B3: hand the batch to the BACKEND so it survives the tab closing ─────────
  // Everything above rescues renders that were already SUBMITTED. The submission
  // itself still lived in this tab (handleGenerateAll): close the browser at shot 12
  // of 40 and shots 13-40 were never sent at all, so there was nothing for the
  // reconciler to recover. This path posts the whole pass ONCE to the server-side
  // queue (contract C3); the backend submits each job itself and the registry +
  // reconciler save the results exactly as they do for an interactive render.
  //
  // Deliberately OPT-IN and additive: for a handful of shots, watching them render
  // in the tab is still the better mode, and that loop works.

  const [renderQueue, setRenderQueue] = useState<RenderQueueState | null>(null)
  const [queueSubmitting, setQueueSubmitting] = useState(false)

  const refreshRenderQueue = useCallback(async () => {
    try {
      const st = await pipelineApi.getRenderQueue({ projectName, projectPath: localFolderRoot ?? '' })
      // Never let a late response write ANOTHER project's queue into this view
      // (same guard the render callbacks use across a project-switch remount).
      if (!isCurrentProject()) return
      setRenderQueue(st.entries?.length ? st : null)
    } catch { /* older backend or server down — the panel just stays hidden */ }
  }, [projectName, localFolderRoot, isCurrentProject])

  const queueRunning = !!renderQueue?.running
  const queueDoneCount = renderQueue?.counts.done ?? 0
  // Shots the backend says may be billed twice (or billed at all, for a submit that
  // never came back). Falls back to counting the entries, so a backend that sends the
  // per-entry risk but not the roll-up still warns.
  const queueChargeAlerts = useMemo(
    () => (renderQueue?.entries ?? []).filter(
      (e) => e.charge_risk === 'duplicate' || e.charge_risk === 'likely'),
    [renderQueue])

  useEffect(() => {
    // On mount: adopt a queue a PREVIOUS session left running — that is the whole
    // point of this feature, so the panel has to come back after a reload. Then poll
    // only while it is alive; a finished queue does not need a 5s heartbeat.
    // Deferred one microtask so this first read isn't a synchronous setState inside
    // the effect (same reason as the hydration sync above).
    void Promise.resolve().then(refreshRenderQueue)
    if (!queueRunning) return
    const id = setInterval(() => { void refreshRenderQueue() }, 5_000)
    return () => clearInterval(id)
  }, [refreshRenderQueue, queueRunning])

  // Put finished background renders on the strip WITHOUT polling BytePlus again: the
  // backend already downloaded and saved them, so the registry is the source (a second
  // poller here would re-download a paid render as a duplicate take). Keyed on the done
  // count, so a queued shot shows up while the tab is open, not only after a reload.
  useEffect(() => {
    if (queueDoneCount > 0) void reconcileFromRegistry()
  }, [queueDoneCount, reconcileFromRegistry])

  const handleQueueInBackground = useCallback(async () => {
    if (generationLocked) { toastError('Generation blocked', gateMessage); return }
    const pending = shots.filter((s) => s.status !== 'approved')
    if (!pending.length) return
    setQueueSubmitting(true)
    try {
      const metaOf = (shotId: string) => stage4Breakdown?.shots.find((s) => s.id === shotId)
      const jobs: RenderQueueJob[] = []
      const skipped: string[] = []
      for (const shot of pending) {
        const shotMeta = metaOf(shot.shotId)
        // The refusals the interactive path makes per shot, applied BEFORE the post:
        // a job the server cannot render is an hour of queue time and a wasted slot.
        const unresolved = (shotMeta?.assetsUsed ?? [])
          .filter((id) => !approvedAssetUrls[id])
          .map((id) => assetMap[id])
          .filter((a) => a && (a.type === 'character' || a.type === 'environment'))
        if (unresolved.length > 0) {
          skipped.push(`${shot.shotId} (no approved ${unresolved.map((a) => a!.name).join(', ')})`)
          continue
        }
        // Over the API ceiling. The server rejects the WHOLE batch at enqueue for one of
        // these (it cannot render it, and a queue entry has no retry), so leaving it in
        // would block the other 39 shots from being queued at all.
        const plannedSecs = plannedDurationOf(shot.shotId, shotMeta)
        if (plannedSecs > segMaxSecs) {
          skipped.push(`${shot.shotId} (${plannedSecs.toFixed(1)}s — over the ${segMaxSecs}s Seedance limit; split it)`)
          continue
        }
        const plan = planShot(shot, shotMeta)
        // animateShot's two guards, same logic: continuity mode without an incoming
        // frame, and keyframe mode without a keyframe, both silently degrade into a
        // reference-less t2v that reinvents the character.
        if (!plan.keyframeUrl && (plan.chainMode || !plan.sbMode)) {
          skipped.push(`${shot.shotId} (no keyframe / no incoming frame)`)
          continue
        }
        // The SAME assembly the in-tab render uses — buildVideoParams for the render
        // itself, toVideoCreateBody for the wire shape /api/video/create takes (the
        // queue replays these bodies verbatim). Rebuilding either here would let a
        // queued shot drift away from the interactive one.
        //
        // Not carried over: the P2 cut-continuity ref (the previous shot's closing
        // frame). It is attached inside animateShot from a clip that has already
        // rendered, and at enqueue time no shot in this pass has rendered yet.
        jobs.push(toVideoCreateBody(buildVideoParams(shot, shotMeta, plan, true, { tier: passTier })))
      }
      if (!jobs.length) {
        toastError('Nothing to queue', skipped.length
          ? `Every pending shot is blocked — ${skipped.join('; ')}`
          : 'No pending shots')
        return
      }
      const resp = await pipelineApi.queueRender({
        projectName, projectPath: localFolderRoot ?? '', jobs,
      })
      info(`${resp.queued} shot(s) queued on the server`,
        'Rendering continues even if you close this tab — finished clips are saved by the backend'
        + (skipped.length ? `. Skipped: ${skipped.join('; ')}` : '.'))
      await refreshRenderQueue()
    } catch (e) {
      toastError('Could not queue the batch', e instanceof Error ? e.message : 'backend error')
    } finally {
      setQueueSubmitting(false)
    }
  }, [shots, stage4Breakdown, approvedAssetUrls, assetMap, planShot, buildVideoParams, passTier,
      projectName, localFolderRoot, generationLocked, gateMessage, toastError, info, refreshRenderQueue,
      plannedDurationOf, segMaxSecs])

  const handleCancelQueue = useCallback(async () => {
    try {
      const { cancelled, at_risk: atRisk = 0 } = await pipelineApi.cancelRenderQueue({
        projectName, projectPath: localFolderRoot ?? '',
      })
      // Shots already SUBMITTED are deliberately left alone upstream: they are being
      // billed and the backend still saves them. Say so, or "cancel" reads as a
      // promise that nothing else will be charged. `at_risk` is the other half of the
      // same honesty: those entries were cancelled but had ALREADY been handed to
      // BytePlus with no answer, so cancelling them un-bills nothing.
      info(`${cancelled} queued shot(s) cancelled`,
        'Shots already sent to Seedance keep rendering — they are paid for, and the backend still saves them'
        + (atRisk
          ? `. ${atRisk} of them were stranded mid-submit: a render may already have started and be billable — check the task list before re-queueing those shots`
          : ''))
      await refreshRenderQueue()
    } catch (e) {
      toastError('Could not cancel the queue', e instanceof Error ? e.message : 'backend error')
    }
  }, [projectName, localFolderRoot, info, toastError, refreshRenderQueue])

  // ── Approve shot / Approve All ────────────────────────────────────────────────

  const handleApprove = useCallback(() => {
    if (!activeShotId) return
    const updatedShots = shots.map((s) => s.shotId === activeShotId ? { ...s, status: 'approved' as const } : s)
    setShots(updatedShots)
    const newAllApproved = updatedShots.every((s) => s.status === 'approved')
    if (newAllApproved) {
      const versionId = commitVersion(5, { shots: updatedShots })
      approveVersion(5, versionId)
      success('All shots approved ✓', 'Moving to Cut & Edit →')
      goToStage(6)
    }
  }, [activeShotId, shots, commitVersion, approveVersion, goToStage, success])

  const handleApproveAll = useCallback(() => {
    const updatedShots = shots.map((s) => ({ ...s, status: 'approved' as const }))
    setShots(updatedShots)
    const versionId = commitVersion(5, { shots: updatedShots })
    approveVersion(5, versionId)
    success('All shots approved ✓', 'Moving to Cut & Edit →')
    goToStage(6)
  }, [shots, commitVersion, approveVersion, goToStage, success])

  // P5c.4: Autopilot runner — generate + animate EVERY shot (keyframe-mode shots
  // get a Seedream keyframe first; board/motion-ref shots animate directly).
  // Each rendered take is collected into a local array so commit reads the
  // finished set directly (no async-setState race). Sequential order lets the
  // P2 continuity logic in animateShot pick up each prior shot's closing frame.
  // Gate: auto → if EVERY shot rendered, approve all + lock (done); if any shot
  // failed, pause for the user to fix rather than ship a holed cut. manual →
  // commit the takes and pause for review. Per-shot QC stays advisory.
  const autopilotStage5 = useCallback(async (): Promise<AutopilotResult> => {
    if (generationLocked) {
      updateAgent('seedance', { status: 'error', detail: gateMessage })
      return 'error'
    }
    const toDo = shots.filter((s) => s.status !== 'approved')
    if (!toDo.length) return 'done'  // everything already approved
    stopRequested.current = false
    setIsGenerating(true)
    setStageStatus(5, 'generating')
    updateAgent('seedance', { status: 'active', detail: 'Autopilot: rendering every shot…', progress: 0 })
    const allUpdated = [...shots]
    try {
      for (let i = 0; i < toDo.length; i++) {
        if (stopRequested.current) break
        const shot = toDo[i]
        const meta = stage4Breakdown?.shots.find((s) => s.id === shot.shotId)
        updateAgent('seedance', { detail: `Shot ${i + 1}/${toDo.length}: ${shot.shotId}`, progress: Math.round((i / toDo.length) * 100) })
        const updated = await generateShot(shot, meta, '', { tier: tierFor(shot) })
        const idx = allUpdated.findIndex((s) => s.shotId === updated.shotId)
        if (idx !== -1) allUpdated[idx] = updated
      }
    } catch (e: unknown) {
      setIsGenerating(false)
      updateAgent('seedance', { status: 'error', detail: e instanceof Error ? e.message : 'Shot autopilot failed' })
      return 'error'
    }
    setIsGenerating(false)
    if (!isCurrentProject()) return 'paused'   // project switched mid-run — never write cross-project
    const everyRendered = allUpdated.every((s) => s.status === 'ready' || s.status === 'approved')
    if (gateMode === 'auto' && everyRendered && !stopRequested.current) {
      const approved = allUpdated.map((s) => ({ ...s, status: 'approved' as const }))
      setShots(approved)
      const vid = commitVersion(5, { shots: approved })
      approveVersion(5, vid)
      updateAgent('seedance', { status: 'completed', detail: 'All shots auto-approved' })
      return 'done'
    }
    commitVersion(5, { shots: allUpdated })
    setStageStatus(5, 'pending_review')
    updateAgent('seedance', { status: 'completed', detail: everyRendered ? 'Shots ready — review & approve' : 'Some shots need attention — review' })
    return 'paused'
  }, [shots, stage4Breakdown, generateShot, tierFor, commitVersion, approveVersion, setStageStatus, updateAgent, gateMode, generationLocked, gateMessage])
  useEffect(() => registerAutopilotRunner(5, autopilotStage5), [autopilotStage5])

  // ── Regenerate single shot — re-renders the clip with the director's note ────

  const handleRegenerate = useCallback(async (feedback: string) => {
    if (!activeShotId || isGenerating) return
    const shot = shots.find((s) => s.shotId === activeShotId)
    if (!shot || shot.status === 'animating' || shot.status === 'generating') return
    const meta = stage4Breakdown?.shots.find((s) => s.id === activeShotId)
    stopRequested.current = false   // a fresh user action clears any prior Stop
    // Per-shot lock: regeneration busies only this shot
    await generateShot(shot, meta, feedback, { tier: tierFor(shot) })
  }, [activeShotId, shots, stage4Breakdown, isGenerating, generateShot, tierFor])

  // ── Item 0/7c: assemble prompts for review BEFORE generating ─────────────────

  // Seedance direction prompt: full dry-run assembly — Claude SEES the actual
  // reference images and writes the @Image N-addressed prompt; nothing renders.
  const prepareDirectionPrompt = useCallback(async (shot: GeneratedShot, shotMeta: Shot | undefined) => {
    const plan = planShot(shot, shotMeta)
    setPreparingPrompt(true)
    updateAgent('seedance', { status: 'active', detail: `Writing direction prompt: ${shot.shotId}…`, progress: 5 })
    try {
      const resp = await pipelineApi.createVideoTask({
        ...buildVideoParams(shot, shotMeta, plan, true),
        dryRun: true,
      })
      setPendingDirections((prev) => ({
        ...prev,
        [shot.shotId]: {
          kind: 'video',
          prompt: resp.assembled_prompt ?? '',
          autoPrompt: resp.assembled_prompt ?? '',
          negative: resp.assembled_negative ?? '',
          refs: plan.refEntries,
        },
      }))
      // Same board/shot disagreement as at submit time — surfaced HERE too because this
      // panel is the review step, i.e. the one moment the user is looking at the prompt
      // and can still send the card back to phase 4 for free.
      if (resp.board_mismatch?.severity === 'warning') {
        warning(`${shot.shotId}: board does not match this segment`, resp.board_mismatch.summary)
        setBoardMismatches((p) => ({ ...p, [shot.shotId]: resp.board_mismatch!.summary }))
      } else {
        setBoardMismatches((p) => (p[shot.shotId] ? { ...p, [shot.shotId]: '' } : p))
      }
      updateAgent('seedance', { status: 'completed', detail: `Direction prompt ready: ${shot.shotId} — review before rendering` })
    } catch (e: unknown) {
      toastError(`Prompt assembly failed: ${shot.shotId}`, e instanceof Error ? e.message : 'error')
      updateAgent('seedance', { status: 'error', detail: 'Direction prompt assembly failed' })
    } finally {
      setPreparingPrompt(false)
    }
  }, [planShot, buildVideoParams, updateAgent, toastError, warning])

  // Generate from the panel: the (possibly edited) Seedance prompt runs VERBATIM.
  const handleGenerateFromPanel = useCallback(async (shotId: string) => {
    const pd = pendingDirections[shotId]
    const shot = shots.find((s) => s.shotId === shotId)
    const meta = stage4Breakdown?.shots.find((s) => s.id === shotId)
    if (!pd || !shot || !pd.prompt.trim()) return
    setPendingDirections((prev) => {
      const next = { ...prev }; delete next[shotId]; return next
    })
    setIsGenerating(true)
    setShots((prev) => prev.map((s) => s.shotId === shotId ? { ...s, status: 'animating' } : s))
    await animateShot({ ...shot, status: 'animating' }, meta, {
      // The only FIRST-render path that carried no tier: reviewing the prompt and then
      // rendering fell through to 'master' at the project size, with the pass selector
      // sitting on preview — an 11x bill for one click.
      tier: tierFor(shot),
      promptOverride: pd.prompt.trim(),
      negativeOverride: pd.negative,
      autoPrompt: pd.autoPrompt,
    })
    setIsGenerating(false)
  }, [pendingDirections, shots, stage4Breakdown, animateShot, tierFor])

  // P4: motion-reference mode — run Seedance in reference mode with an attached
  // reference video driving the motion. Toggling off restores the default
  // (storyboard reference mode). There is no keyframe mode anymore.
  const handleSetMotionRef = useCallback((shotId: string, on: boolean) => {
    setShots((prev) => prev.map((s): GeneratedShot =>
      s.shotId === shotId ? { ...s, mode: on ? 'motion_ref' : 'storyboard' } : s))
  }, [])

  /** Continuity: open this shot on the previous one's closing frame. Mutually
   *  exclusive with the reference-image modes, so turning it on drops the
   *  character sheets and the board for this shot — see planShot. */
  const handleSetContinuity = useCallback((shotId: string, on: boolean) => {
    setShots((prev) => prev.map((s): GeneratedShot =>
      s.shotId === shotId ? { ...s, mode: on ? 'continuity' : 'storyboard' } : s))
  }, [])

  // Item 7d: per-shot director notes, editable any time before generation
  const handleShotNotes = useCallback((shotId: string, notes: string) => {
    setShots((prev) => prev.map((s) => s.shotId === shotId ? { ...s, notes } : s))
  }, [])

  // P5a Magic Box: a natural-language instruction → Claude interprets it against
  // the shot's context into a refined note + the cheapest regen scope, then
  // regenerates just this shot. The updated shot is passed to the regen directly
  // so it never races the setShots state update.
  const handleDirectShot = useCallback(async (shotId: string, instruction: string) => {
    const shot = shotsRef.current.find((s) => s.shotId === shotId)
    const meta = stage4Breakdown?.shots.find((s) => s.id === shotId)
    if (!shot || !instruction.trim()) return
    stopRequested.current = false   // fresh user action clears any prior Stop
    const plan = planShot(shot, meta)
    updateAgent('qc', { status: 'active', detail: `Directing ${shotId}…`, progress: 20 })
    let res: { notes: string; scope: 'animate' | 'keyframe'; summary: string }
    try {
      res = await pipelineApi.directShot({
        instruction,
        action: meta?.action ?? '',
        camera: meta?.cameraAngle ?? '',
        lighting: meta?.lighting ?? '',
        notes: shot.notes ?? '',
        charName: plan.characterNames,
        envHint: plan.envHint,
        styleLabel: style.id,
      })
    } catch (e) {
      toastError(`Direct failed: ${shotId}`, e instanceof Error ? e.message : 'error')
      updateAgent('qc', { status: 'error', detail: 'Shot direction failed' })
      return
    }
    const updated: GeneratedShot = { ...shot, notes: res.notes }
    setShots((prev) => prev.map((s) => s.shotId === shotId ? { ...s, notes: res.notes } : s))
    updateAgent('qc', { status: 'completed', detail: `Directing ${shotId}: ${res.summary}` })
    success(`Directing ${shotId}`, res.summary)
    // Re-animate from the existing keyframe when only motion/camera/mood changed;
    // otherwise regenerate the keyframe (and animate). Fall back to keyframe scope
    // when there's no rendered take to re-animate from.
    if (res.scope === 'animate' && shot.videoUrl) {
      setShots((prev) => prev.map((s) => s.shotId === shotId ? { ...s, status: 'animating' } : s))
      await animateShot(updated, meta,
        { resolution: shot.renderedResolution ?? outputResolution, tier: tierFor(shot) })
    } else {
      await generateShot(updated, meta, '', { tier: tierFor(shot) })
    }
  }, [stage4Breakdown, planShot, animateShot, generateShot, style, updateAgent, toastError, success, outputResolution, tierFor])

  // Item 8: reopen an approved shot — the user must never be stranded at
  // Stage 6 with approved-but-unrendered shots and no way back.
  const handleUnapprove = useCallback((shotId: string) => {
    setShots((prev) => prev.map((s) => {
      if (s.shotId !== shotId) return s
      const reopened: GeneratedShot['status'] = s.videoUrl ? 'ready'
        : (s.thumbnailUrl || s.keyframeLocalPath) ? 'keyframe_ready' : 'queued'
      return { ...s, status: reopened }
    }))
    // Unlocking one shot reopens the stage if it was fully approved
    if (stage5.status === 'approved') setStageStatus(5, 'pending_review')
    success('Shot reopened', shotId)
  }, [stage5.status, setStageStatus, success])

  // Resolved-mode copies for display (SB default when a board exists)
  const displayShots = useMemo(() => shots.map((s) => ({ ...s, mode: effectiveModeOf(s) })), [shots, effectiveModeOf])
  const activeDisplayShot = activeShotId ? (displayShots.find((s) => s.shotId === activeShotId) ?? null) : null

  // Lo que este plano ADJUNTARÍA si se rodara ahora, para enseñarlo en el panel antes de
  // gastar. `planShot` es puro —sólo lee estado y arma listas— así que se puede llamar en
  // render; el memo es por coste, no por corrección. Se prefiere `allEntries` (sin
  // recortar) para poder marcar las que el tope del modelo descarta.
  const activeShotRefPlan = useMemo(() => {
    if (!activeDisplayShot) return { sent: [] as SentRefRow[], excluded: [] as SentRefRow[] }
    try {
      const plan = planShot(activeDisplayShot, activeShotMeta)
      const src = plan.allEntries.length ? plan.allEntries : plan.refEntries
      const row = (e: { url: string; label: string; path?: string }): SentRefRow => ({ url: e.url, label: e.label, key: refKey(e) })
      return { sent: src.map(row), excluded: plan.excludedEntries.map(row) }
    } catch {
      return { sent: [], excluded: [] }      // nunca dejar que una vista rompa la etapa
    }
  }, [activeDisplayShot, activeShotMeta, planShot])
  const activeShotRefs = activeShotRefPlan.sent

  // The project's approved assets, for the review panel's "From project" source. Approved
  // only — the same rule as the derived list: an unapproved sheet never anchors a render.
  const projectAssetsForPanel = useMemo(() =>
    Object.values(assetMap)
      .filter((a) => approvedAssetUrls[a.id])
      .map((a) => ({ id: a.id, name: a.name, type: a.type, url: approvedAssetUrls[a.id] })),
    [assetMap, approvedAssetUrls])

  // THE TWO VIEWS OF A SHOT'S REFERENCES CANNOT DISAGREE. The direction panel is a
  // snapshot taken when it was prepared; once the director excludes, restores, attaches
  // or detaches a reference in EITHER place, the prepared prompt — its numbering, its
  // role lines, its strip — is rebuilt from the new list. A hand-edited prompt is asked
  // first, because rebuilding replaces the text. Keyed per shot so switching shots or
  // mounting never triggers it: only a change on the shot being shown does.
  const refsKeyRef = useRef<Record<string, string>>({})
  const activeRefsKey = activeDisplayShot
    ? JSON.stringify({
        x: (shotRefMedia[activeDisplayShot.shotId] as ShotRefMedia | undefined)?.excluded ?? [],
        i: (shotRefMedia[activeDisplayShot.shotId]?.images ?? []).map((im) => im.url),
      })
    : ''
  useEffect(() => {
    if (!activeDisplayShot) return
    const id = activeDisplayShot.shotId
    const prev = refsKeyRef.current[id]
    refsKeyRef.current[id] = activeRefsKey
    if (prev === undefined || prev === activeRefsKey) return
    const pd = pendingDirections[id]
    if (!pd || preparingPrompt) return
    const edited = pd.prompt.trim() !== pd.autoPrompt.trim()
    if (edited && typeof window !== 'undefined'
        && !window.confirm('The direction prompt was edited by hand. Rebuild it with the new reference list? Your edits will be replaced.')) return
    void Promise.resolve().then(() => prepareDirectionPrompt(activeDisplayShot, activeShotMeta))
  }, [activeRefsKey, activeDisplayShot, activeShotMeta, pendingDirections, preparingPrompt, prepareDirectionPrompt])

  // 3-bug1c: per-shot staleness — a rendered clip whose storyboard board advanced
  // past the version it was built from. DERIVED (not a stored flag) so EVERY board-
  // regen path (per-shot Regen, whole-scene, batch, autopilot) trips it via the
  // monotonic board version, with no cross-stage store write. undefined source → not stale.
  const staleBoardShots = useMemo<Set<string>>(() =>
    new Set(shots.filter((s) => {
      const b = shotBoardMap[s.shotId]
      return !!s.videoUrl && !!b && s.sourceBoardVersion != null && b.version > s.sourceBoardVersion
    }).map((s) => s.shotId)),
  [shots, shotBoardMap])

  // The old full-screen "approve Stage 4 first" block is gone — the storyboard
  // requirement is now a named hard gate (banner + disabled generation), so the
  // user can see their shot list while the blocker is spelled out.

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StageHeader stageId={5} label="SG — Shot Generation" />

      {/* Item 1: HARD GATE banner — names the exact assets blocking generation */}
      {generationLocked && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red/10 border-b border-red/30 shrink-0">
          <ShieldAlert size={14} className="text-red shrink-0" />
          <span className="text-[12px] text-red font-semibold" data-testid="stage5-gate-message">
            {gateMessage}
          </span>
        </div>
      )}

      {/* Over the API ceiling: named BEFORE any batch, because the alternative is finding
          out shot by shot from a 422 in the middle of a paid pass. Deliberately NOT part
          of generationLocked — one legacy 21s shot must not stop the other 43 from
          rendering — so this is advisory and the batches skip exactly these shots. */}
      {overlongShots.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-amber/10 border-b border-amber/30 shrink-0">
          <ShieldAlert size={14} className="text-amber shrink-0" />
          <span className="text-[12px] text-amber font-semibold" data-testid="stage5-overlong-message">
            {overlongList} {overlongShots.length === 1 ? 'is' : 'are'} over the {segMaxSecs}s
            Seedance limit per call — these shots are skipped by every render pass. Split them into
            shots of {segMaxSecs}s or less in the Breakdown stage; rendering them capped would
            drop their last beats without saying so.
          </span>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-elevated border-b border-border shrink-0 flex-wrap gap-y-2">
        <Button
          variant="primary"
          size="sm"
          icon={<Clapperboard size={13} />}
          loading={isGenerating}
          onClick={handleGenerateAll}
          // Blocked while a background queue drains: both paths render the SAME
          // pending shots, so running them together would submit — and pay for —
          // every shot twice.
          disabled={alreadyLocked || !shots.length || generationLocked || anyShotBusy || queueRunning}
          title={queueRunning
            ? 'A background queue is already rendering these shots — cancel it first to render in the tab instead.'
            : 'Render every pending shot from this tab. You have to leave the tab open until it finishes.'}
        >
          Generate All Clips ({shots.filter((s) => s.status !== 'approved').length})
        </Button>

        {/* B3: the SAME pass, submitted by the backend instead of by this tab. Opt-in
            and additive — the in-tab batch above is untouched, because for a handful
            of shots watching them render is the right mode. This one is for an
            episode: it is the only path where closing the browser is safe. */}
        <Button
          variant="secondary"
          size="sm"
          icon={<CloudUpload size={13} />}
          loading={queueSubmitting}
          onClick={handleQueueInBackground}
          disabled={alreadyLocked || !shots.length || generationLocked || isGenerating || anyShotBusy
            || queueSubmitting || queueRunning}
          data-testid="queue-render-button"
          title={'Hand the whole pass to the backend: it submits each shot itself, so closing this tab '
            + 'no longer strands the shots that were never sent. Finished clips are downloaded and saved '
            + 'server-side and appear here on their own. Note that Chain All does NOT apply — a queued '
            + 'shot cannot inherit a closing frame that does not exist yet.'}
        >
          Render in Background ({shots.filter((s) => s.status !== 'approved').length})
        </Button>

        {/* The rung THIS pass renders at. Without this the first render always fell
            through to 'master': the ladder could only be climbed after paying the top
            price once, which defeats the point of having one. */}
        {!alreadyLocked && (
          <div className="flex items-center gap-1" data-testid="pass-tier">
            {TIER_ORDER.map((t) => {
              const res = TIER_FIXED_RESOLUTION[t] ?? outputResolution
              const pending = shots.filter((s) => s.status !== 'approved')
              // Priced off the length that will be REQUESTED, not off `s.duration ||
              // 5`: a pending shot has no take to measure, and the old fallback quoted
              // five seconds for anything the store had no duration for.
              const secs = pending.reduce((n, s) => n + plannedDurationOf(s.shotId), 0)
              const cost = videoCostPer5s(videoModel, res) * (secs / 5)
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setPassTier(t)}
                  disabled={isGenerating || anyShotBusy}
                  data-testid={`pass-tier-${t}`}
                  aria-pressed={passTier === t}
                  title={`Render this pass at ${res} — about $${cost.toFixed(2)} for the `
                    + `${pending.length} shot(s) still pending.`}
                  className={`px-2 py-1 rounded text-[10px] font-mono uppercase tracking-wide border transition-colors
                    ${passTier === t
                      ? 'bg-cyan/15 border-cyan text-cyan font-semibold'
                      : 'bg-transparent border-border text-text-muted hover:text-text'}
                    disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {t} · {res}
                </button>
              )
            })}
          </div>
        )}

        <div className="h-4 w-px bg-border" />

        <span className="text-[11px] text-text-muted">
          {approvedCount}/{shots.length} approved
        </span>

        {/* Live batch progress — so the stage visibly works while Seedance renders
            (each clip takes minutes; at 4k only ~3 run at once). */}
        {(isGenerating || anyShotBusy) && (
          <span className="text-[11px] text-orange font-mono flex items-center gap-1.5" data-testid="sg-progress">
            <span className="w-1.5 h-1.5 rounded-full bg-orange animate-pulse" />
            {shots.filter((s) => s.status === 'animating' || s.status === 'generating').length} rendering
            {' · '}
            {shots.filter((s) => s.status === 'ready' || s.status === 'approved').length}/{shots.length} done
          </span>
        )}

        {/* P3.15: continuity-chain toggle — applies to the "Animate All" batch
            only (it sequences the batch so each shot's last frame seeds the
            next shot's first frame). It does NOT affect a single regenerate /
            retake, so the label scopes it explicitly to avoid the impression
            that toggling it changes one shot. */}
        <button
          onClick={() => setChainScene((v) => !v)}
          disabled={isGenerating}
          title="Animate All option: render shots in sequence so each shot's last frame becomes the next shot's first frame (scene continuity). Has no effect on a single shot's regenerate/retake."
          className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-semibold transition-colors ${
            chainScene ? 'border-cyan/60 bg-cyan/15 text-cyan' : 'border-border text-text-muted hover:text-text-primary'
          }`}
          data-testid="chain-scene-toggle"
        >
          <Link2 size={11} /> Chain All
        </button>

        {/* Item 4C: "Select" reveals per-shot checkboxes on the strip; "Chain Selected"
            runs the continuity chain over just the ticked shots (≥2). Additive — Chain
            All (above) is unchanged. */}
        <button
          onClick={toggleSelectMode}
          disabled={isGenerating}
          title="Pick specific shots, then Chain Selected runs a continuity chain over just those (in strip order)."
          className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-semibold transition-colors ${
            selectMode ? 'border-orange/60 bg-orange/15 text-orange' : 'border-border text-text-muted hover:text-text-primary'
          }`}
          data-testid="select-mode-toggle"
        >
          <CheckSquare size={11} /> Select
        </button>
        {selectMode && (
          <Button variant="secondary" size="sm" icon={<Link2 size={13} />}
            onClick={handleChainSelected}
            disabled={isGenerating || anyShotBusy || generationLocked || selectedShotIds.length < 2}
            data-testid="chain-selected-button"
            title="Chain the ticked shots in strip order (each last frame seeds the next's first frame). Needs ≥2.">
            Chain Selected ({selectedShotIds.length})
          </Button>
        )}

        {/* The cost ladder: one button per rung, each showing how many shots it
            would move and what that costs. Only rungs with candidates appear, so a
            project already fully mastered shows none. */}
        {!alreadyLocked && TIER_ORDER.map((tier) => {
          const candidates = promotableTo(tier)
          if (!candidates.length) return null
          const res = TIER_FIXED_RESOLUTION[tier] ?? outputResolution
          // Same basis as the render this button triggers: a promotion is a FRESH take
          // at plannedDurationOf seconds, so quoting the old take's length (or 5 when it
          // has none) priced a job nobody was about to run.
          const secs = candidates.reduce((n, s) => n + plannedDurationOf(s.shotId), 0)
          const cost = videoCostPer5s(videoModel, res) * (secs / 5)
          return (
            <Button key={tier} variant="secondary" size="sm" icon={<Clapperboard size={13} />}
              onClick={() => handlePromote(tier)} disabled={isGenerating || anyShotBusy}
              data-testid={`tier-pass-${tier}`}
              title={`Render ${candidates.length} shot(s) at ${res} — about $${cost.toFixed(2)}. `
                + 'This is a FRESH take, not an upscale: Seedance 2.0 has no seed, so the '
                + 'result can differ from the take you approved. The prompt and first frame carry over.'}>
              {tier} → {res} ({candidates.length}) ~${cost.toFixed(2)}
            </Button>
          )
        })}

        {(isGenerating || anyShotBusy) && (
          <>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-orange animate-pulse" />
              <span className="text-[10px] text-orange font-mono font-semibold">RENDER ACTIVE</span>
            </div>
            {/* P3.14: Stop — halts the batch, cancels the queued task upstream,
                and releases any in-flight shot to its last-good take. */}
            <Button variant="danger" size="sm" icon={<Square size={11} />} onClick={handleStop} data-testid="stop-button">
              Stop
            </Button>
          </>
        )}

        {allReady && !allApproved && !alreadyLocked && !isGenerating && (
          <Button variant="approve" size="sm" icon={<CheckCircle size={13} />}
            onClick={handleApproveAll} className="ml-auto">
            Approve All → Stage 6
          </Button>
        )}

        {alreadyLocked && (
          <div className="ml-auto flex items-center gap-1.5 text-green text-[11px] font-semibold">
            <Lock size={12} /> Shots locked
            <Button variant="ghost" size="sm" onClick={() => goToStage(6)} className="ml-2">
              Continue →
            </Button>
          </div>
        )}
      </div>

      {/* B3: what the BACKEND still owes this project. Read from the server's queue,
          not from this tab's state, so it comes back intact after a reload — which is
          the only way the user can trust that closing the tab was safe. */}
      {renderQueue && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-elevated/40 border-b border-border shrink-0 overflow-x-auto"
          data-testid="render-queue-panel">
          <span className="text-[9px] font-semibold text-text-muted uppercase tracking-widest shrink-0">
            Background
          </span>
          <span className="text-[11px] font-mono flex items-center gap-1.5 shrink-0" data-testid="render-queue-counts">
            {queueRunning && <span className="w-1.5 h-1.5 rounded-full bg-orange animate-pulse" />}
            <span className="text-text-muted">{renderQueue.counts.queued} queued</span>
            <span className="text-orange">{renderQueue.counts.submitted} rendering</span>
            <span className="text-green">{renderQueue.counts.done} done</span>
            {renderQueue.counts.failed > 0 && (
              <span className="text-red">{renderQueue.counts.failed} failed</span>
            )}
          </span>
          <span className="text-[10px] text-text-muted shrink-0" data-testid="render-queue-note">
            {queueRunning
              ? 'Rendering on the server — you can close this tab; finished clips are saved and land here.'
              : 'Finished — every clip the backend rendered has been saved.'}
          </span>
          {/* A charge the operator cannot see is a charge they cannot dispute. The queue
              knows when a shot was submitted twice (a superseded claim files its own,
              already-billed task_id) or when a submit went out and never came back, and
              until now that lived only in the backend JSON and one server log line. */}
          {queueChargeAlerts.length > 0 && (
            <span className="text-[10px] text-red font-semibold shrink-0 cursor-help"
              data-testid="render-queue-charge-warning"
              title={queueChargeAlerts.map((e) =>
                `${e.shot_id}: ${e.charge_note || 'a charge may exist for this shot'}`
                + (e.duplicate_task_ids?.length
                  ? ` Duplicate task(s): ${e.duplicate_task_ids.join(', ')}.` : '')
              ).join('\n\n')}>
              ⚠ {queueChargeAlerts.length} shot(s) may be billed — check before re-queueing
            </span>
          )}
          {renderQueue.entries.map((e, i) => {
            // 'duplicate'/'likely' outrank the render status in the chip: a shot that
            // says "done" while a second paid render exists for it is the exact thing
            // this panel was hiding.
            const atRisk = e.charge_risk === 'duplicate' || e.charge_risk === 'likely'
            const title = [
              `${e.shot_id}: ${e.status}${e.task_id ? ` (task ${e.task_id})` : ''}`,
              e.error || '',
              e.charge_note || '',
              e.duplicate_task_ids?.length
                ? `Also billed for this shot: ${e.duplicate_task_ids.join(', ')}` : '',
            ].filter(Boolean).join('\n')
            return (
              <button
                key={`${e.shot_id}-${i}`}
                onClick={() => setActiveShotId(e.shot_id)}
                title={title}
                data-charge-risk={e.charge_risk || ''}
                className={`px-2 py-0.5 rounded border text-[9px] font-mono shrink-0 transition-colors ${
                  atRisk ? 'border-red/70 bg-red/20 text-red hover:bg-red/30'
                  : e.status === 'done' ? 'border-green/40 bg-green/10 text-green hover:bg-green/20'
                  : e.status === 'failed' ? 'border-red/50 bg-red/10 text-red hover:bg-red/20'
                  : e.status === 'submitted' ? 'border-orange/50 bg-orange/10 text-orange hover:bg-orange/20'
                  : e.status === 'cancelled' ? 'border-border text-text-muted line-through'
                  : 'border-border text-text-muted hover:text-text-primary'
                }`}>
                {e.shot_id} · {e.status}{atRisk ? ' ⚠' : ''}
              </button>
            )
          })}
          {queueRunning && (
            <Button variant="danger" size="sm" icon={<Square size={11} />}
              onClick={handleCancelQueue} className="ml-auto shrink-0"
              data-testid="cancel-queue-button"
              title="Drop the shots not yet submitted. Shots already sent keep rendering — they are already paid for, and the backend still saves them.">
              Cancel queue
            </Button>
          )}
        </div>
      )}

      {/* P2: scene consistency report — identity drift per rendered clip,
          side by side, so a bad take is caught BEFORE approval */}
      {displayShots.some((s) => shotQcResults[s.shotId]) && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-elevated/40 border-b border-border shrink-0 overflow-x-auto"
          data-testid="consistency-report">
          <span className="text-[9px] font-semibold text-text-muted uppercase tracking-widest shrink-0">
            Consistency
          </span>
          {displayShots.filter((s) => shotQcResults[s.shotId]).map((s) => {
            const qc = shotQcResults[s.shotId] as QCResponse & { identity_drift?: number | null }
            const pct = qc.identity_drift != null ? Math.round(qc.identity_drift * 100) : null
            const bad = (pct != null && pct >= 45) || qc.passed === false
            return (
              <button key={s.shotId} onClick={() => setActiveShotId(s.shotId)}
                title={qc.summary}
                className={`px-2 py-0.5 rounded border text-[9px] font-mono shrink-0 transition-colors ${
                  bad ? 'border-red/50 bg-red/10 text-red hover:bg-red/20'
                      : 'border-green/40 bg-green/10 text-green hover:bg-green/20'
                }`}>
                {s.shotId}{pct != null ? ` · drift ${pct}%` : ''}{qc.passed === false ? ' ⚠' : ''}
              </button>
            )
          })}
        </div>
      )}

      {/* Main 3-column workspace */}
      <div className="flex flex-1 min-h-0 gap-1.5 p-1.5">
        <ShotGenerationStrip
          shots={displayShots}
          activeShotId={activeShotId}
          onSelectShot={setActiveShotId}
          shotMeta={shotMetaMap}
          staleBoardShots={staleBoardShots}
          selectable={selectMode}
          selectedShotIds={selectedShotIds}
          onToggleSelect={toggleShotSelected}
        />

        <div className="flex flex-col flex-1 min-w-0 gap-1.5 overflow-y-auto">
          <SceneVideoPlayer shot={activeShot} shotMeta={activeShotMeta} />

          {/* Item 0/7c: assemble → review → generate. The Claude-written direction
              prompt (vision-grounded) lands here, editable, BEFORE any render. */}
          {activeDisplayShot && !alreadyLocked && !pendingDirections[activeDisplayShot.shotId] && (
            <div className="flex items-center gap-2 px-1 shrink-0">
              <Button variant="ghost" size="sm" icon={<FileText size={11} />}
                loading={preparingPrompt}
                onClick={() => prepareDirectionPrompt(activeDisplayShot, activeShotMeta)}
                disabled={isGenerating || activeShotBusy || preparingPrompt || generationLocked}
                className="text-[10px]"
                data-testid="prepare-direction-prompt">
                Seedance prompt…
              </Button>
              {activeDisplayShot.assembledPrompt && (
                <details className="ml-auto min-w-0" data-testid="shot-sent-prompt">
                  <summary className="text-[9px] font-semibold text-text-muted uppercase tracking-widest cursor-pointer hover:text-text-primary transition-colors">
                    Sent prompt
                  </summary>
                  <pre className="mt-1 p-2 bg-elevated/60 rounded border border-border text-[10px] font-mono text-text-muted whitespace-pre-wrap break-words max-h-36 overflow-y-auto">
                    {activeDisplayShot.assembledPrompt}
                  </pre>
                </details>
              )}
            </div>
          )}

          {activeDisplayShot && pendingDirections[activeDisplayShot.shotId] && !alreadyLocked && (
            <div className="shrink-0 px-1">
              <PromptPanel
                title={`Seedance Direction — ${activeDisplayShot.shotId}`}
                autoPrompt={pendingDirections[activeDisplayShot.shotId].autoPrompt}
                value={pendingDirections[activeDisplayShot.shotId].prompt}
                onChange={(p) => setPendingDirections((prev) => ({
                  ...prev,
                  [activeDisplayShot.shotId]: { ...prev[activeDisplayShot.shotId], prompt: p },
                }))}
                negative={pendingDirections[activeDisplayShot.shotId].negative}
                onNegativeChange={(n) => setPendingDirections((prev) => ({
                  ...prev,
                  [activeDisplayShot.shotId]: { ...prev[activeDisplayShot.shotId], negative: n },
                }))}
                refs={pendingDirections[activeDisplayShot.shotId].refs}
                onRemoveRef={(i) => { const r = pendingDirections[activeDisplayShot.shotId].refs[i]; if (r) removeShotRefAt(activeDisplayShot.shotId, r) }}
                excludedRefs={activeShotRefPlan.excluded}
                onRestoreRef={(i) => { const r = activeShotRefPlan.excluded[i]; if (r) restoreShotRef(activeDisplayShot.shotId, r.key ?? r.label) }}
                sentPrompt={activeDisplayShot.assembledPrompt ?? null}
                generateLabel={`Render Shot (${outputResolution})`}
                onGenerate={() => handleGenerateFromPanel(activeDisplayShot.shotId)}
                onReset={() => prepareDirectionPrompt(activeDisplayShot, activeShotMeta)}
                onCancel={() => setPendingDirections((prev) => {
                  const next = { ...prev }; delete next[activeDisplayShot.shotId]; return next
                })}
                busy={preparingPrompt || isGenerating || activeShotBusy}
                enhanceField="seedance_direction"
                enhanceContext={JSON.stringify({ model: videoModel })}
                testId="direction-prompt-panel"
              />
            </div>
          )}

          <FilmstripScrubber
            shots={displayShots}
            activeShotId={activeShotId}
            onSelectShot={setActiveShotId}
          />
        </div>

        <SceneReviewPanel
          // Remount per shot so transient local fields (Director Notes, Magic Box,
          // skill) reset when you switch clips instead of carrying over stale text.
          key={activeShotId ?? 'none'}
          shot={activeDisplayShot}
          qcResult={activeQcResult}
          refMedia={activeRefMedia}
          onRefMediaChange={(rm) => activeShotId && updateShotRefMedia(activeShotId, rm)}
          onApprove={handleApprove}
          onRenderHD={activeShotId && activeDisplayShot && tierRank(activeDisplayShot.tier) < tierRank('master')
            ? () => handlePromoteShot(activeShotId, 'master') : undefined}
          onRetake={activeShotId ? () => handleRetake(activeShotId) : undefined}
          onSetMotionRef={activeShotId ? (on) => handleSetMotionRef(activeShotId, on) : undefined}
          onSetContinuity={activeShotId ? (on) => handleSetContinuity(activeShotId, on) : undefined}
          hasStoryboard={!!(activeShotId && shotBoardMap[activeShotId])}
          onNotesChange={activeShotId ? (n) => handleShotNotes(activeShotId, n) : undefined}
          onDirect={activeShotId ? (instr) => handleDirectShot(activeShotId, instr) : undefined}
          onUnapprove={activeShotId ? () => handleUnapprove(activeShotId) : undefined}
          onRegenerate={handleRegenerate}
          boardStale={!!(activeShotId && staleBoardShots.has(activeShotId))}
          boardMismatch={activeShotId ? (boardMismatches[activeShotId] || undefined) : undefined}
          onGoToBoard={() => goToStage(4)}
          takes={activeShotId ? (shotVersions[activeShotId] ?? []) : []}
          selectedTakeId={activeShotId ? (shotSelectedVersion[activeShotId] ?? activeDisplayShot?.selectedVersionId) : undefined}
          onSelectTake={activeShotId ? (vid) => handleSelectTake(activeShotId, vid) : undefined}
          autoRefs={activeShotRefs}
          excludedRefs={activeShotRefPlan.excluded}
          onExcludeRef={(r) => activeShotId && excludeShotRef(activeShotId, r.key ?? r.label)}
          onRestoreRef={(r) => activeShotId && restoreShotRef(activeShotId, r.key ?? r.label)}
          projectAssets={projectAssetsForPanel}
          refCap={maxImageRefsFor(videoModel)}
          isGenerating={isGenerating || activeShotBusy}
        />
      </div>
    </div>
  )
}
