'use client'

import { useState, useMemo, useCallback, useEffect, useRef, createElement } from 'react'
import {
  Sparkles, CheckCircle, RefreshCw, Lock, Square,
  ChevronDown, ChevronUp, Users, Package, MapPin, Zap, Clapperboard, AlertTriangle, Shirt, Maximize2, X, Wand2
} from 'lucide-react'
import { PromptPanel } from '@/components/pipeline/PromptPanel'
import { StageHeader } from '@/components/pipeline/StageHeader'
import { StyleSelector } from '@/components/pipeline/StyleSelector'
import { VersionHistoryPanel } from '@/components/pipeline/VersionHistoryPanel'
import { EnvironmentAnglesPanel } from './EnvironmentAnglesPanel'
import { VoicePicker } from './VoicePicker'
import { ProImageEditor } from './ProImageEditor'
import { EnhanceButton } from '@/components/pipeline/EnhanceButton'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { QCActionCard } from '@/components/agent/QCActionCard'
import { ReferenceMediaPanel, emptyReferenceMedia, type ReferenceMedia } from '@/components/media/ReferenceMediaPanel'
import { usePipelineStore } from '@/store/pipeline.store'
import { useAgentsStore } from '@/store/agents.store'
import { useToast } from '@/components/ui/Toast'
import { pipelineApi, type QCResponse } from '@/lib/api/pipeline.api'
import { apiClient } from '@/lib/api/client'
import { registerAutopilotRunner, type AutopilotResult } from '@/lib/autopilotRegistry'
import { cn } from '@/lib/utils'
import { WardrobePanel } from './WardrobePanel'
import type { Asset, BreakdownData, Scene } from '@/lib/types/pipeline.types'

interface AssetGenState {
  imageUrls: string[]
  selectedUrl: string | null
  /** Absolute disk path saved via /api/asset/save-version — never expires. Used for keyframe refs. */
  localPath: string | null
  /** P2.9: dedicated face-only headshot (characters only) — the FIRST keyframe ref per
   *  the official ID-drift guidance. Derived automatically at approval. */
  headshotLocalPath: string | null
  status: 'idle' | 'generating' | 'pending' | 'approved' | 'error'
  qcResult: QCResponse | null
  feedback: string
  refMedia: ReferenceMedia
  errorMsg: string
  /** Per-variation failures (issue 3): index-aligned error strings for failed slots.
   *  Transient (not persisted) — a reload simply regenerates. */
  slotErrors: Array<string | null>
  /** Requested variation count for the CURRENT run (transient, display only). */
  expectedCount?: number
  /** Prompt review step: the final Seedream prompt awaiting user review/edit.
   *  Transient — set by preparePrompt, cleared when generation starts or is cancelled. */
  pendingPrompt: string | null
  /** The untouched auto-assembled prompt — basis for the "edited" badge + meta record. */
  autoPrompt: string | null
  /** Editable negative prompt (defaults to the project style's). */
  pendingNegative: string
  /** Director notes captured at prepare time (drives seed-from-selected behavior). */
  pendingFeedback: string
  /** True while Claude is writing the prompt (doctor + board template). */
  preparing: boolean
  /** The exact prompt used for the last render — reused verbatim by "Retry failed". */
  lastPrompt: string | null
  /** The async generation job behind an in-flight render. PERSISTED so a remount
   *  (stage nav / reload) can re-attach to the live job instead of losing the
   *  results — the poll loop itself dies with the closure. */
  jobId: string | null
  /** The auto prompt behind the last render — meta records both. */
  lastAutoPrompt: string | null
  lastNegative: string
}

// Item 5: characters render N (4/6/8, toolbar-selected) COMPLETE identity boards —
// the user picks one; canonical headshot+full-body are derived at approval.

const EMPTY_ASSET_STATE: AssetGenState = {
  imageUrls: [], selectedUrl: null, localPath: null, headshotLocalPath: null, status: 'idle',
  qcResult: null, feedback: '', refMedia: emptyReferenceMedia(), errorMsg: '', slotErrors: [], jobId: null,
  pendingPrompt: null, autoPrompt: null, pendingNegative: '', pendingFeedback: '',
  preparing: false, lastPrompt: null, lastAutoPrompt: null, lastNegative: '',
}

// Identity boards (2 Claude calls + 4× 2848×1600 renders) routinely exceed the
// global 120s axios timeout — the work succeeded server-side but the UI gave up.
// Generation calls get their own generous ceiling, like storyboard already does.
const GENERATION_TIMEOUT_MS = 600_000

// "Generate All" concurrency: assets in flight at once (4 variations each →
// 4×4=16 parallel Seedream requests, well under the 500 img/min rating).
// Raise to 6 if runs stay clean; back to 1 restores the old sequential batch.
const ASSET_BATCH_CONCURRENCY = 4

function getTypeIcon(type: string): React.ElementType {
  if (type === 'character')   return Users
  if (type === 'prop')        return Package
  if (type === 'wardrobe')    return Shirt
  if (type === 'environment') return MapPin
  return Zap
}
function getTypeBadgeColor(type: string): 'cyan' | 'orange' | 'green' | 'amber' {
  if (type === 'character')   return 'cyan'
  if (type === 'prop')        return 'orange'
  if (type === 'wardrobe')    return 'amber'
  if (type === 'environment') return 'green'
  return 'amber'
}

// Seedream CDN URLs (state.imageUrls) expire after ~24h; the approved variation
// is also saved to disk and served fresh through this endpoint, so a reloaded
// project keeps showing its image instead of a broken CDN link.
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const serveUrl = (p: string) => `${API_BASE}/api/asset/serve?path=${encodeURIComponent(p)}`

// P1: Stage 3 type tabs. 'fx' is treated as 'vfx' (same family).
type AssetTypeTab = 'all' | 'character' | 'voice' | 'prop' | 'wardrobe' | 'environment' | 'vfx'
type AssetTypeKey = 'character' | 'voice' | 'prop' | 'wardrobe' | 'environment' | 'vfx'
const normAssetType = (t: string): AssetTypeKey =>
  t === 'fx' ? 'vfx' : (t as AssetTypeKey)
/** A voice is cast, not drawn: it has no image to generate, approve or count. Every
 *  image-side tally in this view filters on this so one voice asset cannot leave the
 *  batch queue or the stage lock permanently one short of complete. */
const isImageAsset = (a: { type: string }): boolean => a.type !== 'voice'
const ASSET_TYPE_TABS: { id: Exclude<AssetTypeTab, 'all'>; label: string; color: 'cyan' | 'orange' | 'green' | 'amber' }[] = [
  { id: 'character',   label: 'Characters',   color: 'cyan' },
  { id: 'voice',       label: 'Voices',       color: 'cyan' },
  { id: 'prop',        label: 'Props',        color: 'orange' },
  { id: 'wardrobe',    label: 'Wardrobe',     color: 'amber' },
  { id: 'environment', label: 'Environments', color: 'green' },
  { id: 'vfx',         label: 'FX',           color: 'amber' },
]
function typeTabClasses(active: boolean, color: 'cyan' | 'orange' | 'green' | 'amber' | 'muted'): string {
  const activeMap: Record<string, string> = {
    cyan:   'border-cyan/60 bg-cyan/15 text-cyan',
    orange: 'border-orange/60 bg-orange/15 text-orange',
    green:  'border-green/60 bg-green/15 text-green',
    amber:  'border-amber/60 bg-amber/15 text-amber',
    muted:  'border-text-muted/60 bg-elevated text-text-primary',
  }
  return cn(
    'flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold transition-colors whitespace-nowrap',
    active ? activeMap[color] : 'border-border text-text-muted hover:text-text-primary',
  )
}

// Fields we persist to the store (enough to restore visible state on navigation)
// localPath is a disk path → small string, safe to persist
type PersistedAssetState = Pick<AssetGenState, 'imageUrls' | 'selectedUrl' | 'localPath' | 'headshotLocalPath' | 'status' | 'qcResult' | 'lastPrompt' | 'lastAutoPrompt' | 'lastNegative' | 'jobId'>

function hydrateFromStore(stored: Record<string, PersistedAssetState>): Record<string, AssetGenState> {
  return Object.fromEntries(
    Object.entries(stored).map(([id, s]) => {
      const state = { ...EMPTY_ASSET_STATE, ...s }
      // 'generating' is a TRANSIENT status: its poll loop lives only in JS memory,
      // so it cannot survive a remount. WITH a persisted jobId the mount-time
      // recovery re-attaches to the live job (results are adopted, not lost);
      // without one there is nothing to resume — downgrade so the card isn't a
      // stranded spinner: results already arrived → 'pending', none → 'idle'.
      if (state.status === 'generating' && !state.jobId) {
        state.status = state.imageUrls.length ? 'pending' : 'idle'
      }
      return [id, state]
    })
  )
}

export function AssetGenerationView() {
  const { stages, commitVersion, approveVersion, goToStage, patchStageData, style, projectName, localFolderRoot } = usePipelineStore()
  const { updateAgent } = useAgentsStore()
  const { success, warning, error: toastError } = useToast()
  const stage2 = stages[2]
  const stage3 = stages[3]

  const breakdown = useMemo<BreakdownData | null>(() => {
    if (!stage2.activeVersionId) return null
    const v = stage2.versions.find((v) => v.id === stage2.activeVersionId)
    return v?.data as BreakdownData ?? null
  }, [stage2.activeVersionId, stage2.versions])

  const assets = useMemo(() => breakdown?.assets ?? [], [breakdown])
  // Phase-2 (D2): the wardrobe editor assigns looks BY SCENE, so it needs the scene list.
  const scenes = useMemo<Scene[]>(() => breakdown?.scenes ?? [], [breakdown])

  // Rehydrate from store on mount (fixes "images lost on navigation")
  const [assetStates, setAssetStates] = useState<Record<string, AssetGenState>>(() => {
    const v3 = stage3.versions.find((v) => v.id === stage3.activeVersionId)
    const stored = (v3?.data as { assetStates?: Record<string, PersistedAssetState> })?.assetStates
    return stored ? hydrateFromStore(stored) : {}
  })

  const getAssetState = useCallback((id: string): AssetGenState =>
    assetStates[id] ?? EMPTY_ASSET_STATE,
  [assetStates])

  const [isGeneratingAll, setIsGeneratingAll] = useState(false)
  // Stop the "Generate All" batch — halts the loop before the next asset starts
  // (a Seedream variation already in flight finishes; like Stage 5's batch Stop).
  const stopRequested = useRef(false)
  // P1: which asset-type tab is active in Stage 3
  const [typeFilter, setTypeFilter] = useState<AssetTypeTab>('all')

  // How many variations to render per asset (4–8). A ref mirrors it so the
  // generation callback reads the latest value without re-creating its closure.
  const [variantCount, setVariantCount] = useState(4)
  const variantCountRef = useRef(variantCount)
  variantCountRef.current = variantCount

  // Environments whose multi-view + top-view sheet should auto-generate — set the
  // moment an environment is APPROVED (transient, in-memory: never re-fires on a
  // reload, so approving 6 envs doesn't retro-trigger 6 renders on next load).
  const [autoAnglesFor, setAutoAnglesFor] = useState<Set<string>>(() => new Set())

  // Counts per type (drives tab labels + which tabs are shown) and the filtered list
  const typeCounts = useMemo(() => {
    const c: Record<AssetTypeKey, number> = { character: 0, voice: 0, prop: 0, wardrobe: 0, environment: 0, vfx: 0 }
    for (const a of assets) c[normAssetType(a.type)]++
    return c
  }, [assets])
  // The batch queue size (what "Generate All" will actually run) — approved
  // assets are skipped, so the button must count the remainder, not the total.
  const remainingToGenerate = useMemo(
    () => assets.filter((a) => isImageAsset(a) && getAssetState(a.id).status !== 'approved').length,
    [assets, getAssetState],
  )
  const visibleAssets = useMemo(() => {
    const list = typeFilter === 'all' ? assets : assets.filter((a) => normAssetType(a.type) === typeFilter)
    // Phase-2 (D1): keep every wardrobe VARIANT directly under its base character. Variants
    // are ordinary character assets, so a flat list showed "Eli" and "Eli · Day Clothes" as
    // two unrelated cards — the list must read as ONE character with looks.
    const present = new Set(list.map((a) => a.id))
    const roots = list.filter((a) => !a.parentCharacterId || !present.has(a.parentCharacterId))
    const out: Asset[] = []
    for (const r of roots) {
      out.push(r, ...list.filter((a) => a.parentCharacterId === r.id))
    }
    // Any variant whose base is filtered out still has to appear (never hide an asset).
    for (const a of list) if (!out.includes(a)) out.push(a)
    return out
  }, [assets, typeFilter])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(assets.map((a) => a.id))
  )

  // setState updaters must be PURE — React runs them during render, and a store
  // write here triggers "Cannot update a component (TopBar) while rendering…".
  const updateAsset = useCallback((id: string, patch: Partial<AssetGenState>) => {
    setAssetStates((prev) => ({
      ...prev,
      [id]: { ...EMPTY_ASSET_STATE, ...(prev[id] ?? {}), ...patch },
    }))
  }, [])

  // Persist to the store AFTER render (effect), never inside the updater.
  // Strip data URIs to avoid overflowing localStorage (composite character
  // sheets are 100-200KB base64); only stable URLs/paths are worth persisting.
  useEffect(() => {
    if (Object.keys(assetStates).length === 0) return
    const toStore: Record<string, PersistedAssetState> = {}
    for (const [aid, s] of Object.entries(assetStates)) {
      const safeUrls = s.imageUrls.filter((u) => u && !u.startsWith('data:'))
      const safeSelected = s.selectedUrl && !s.selectedUrl.startsWith('data:') ? s.selectedUrl : null
      toStore[aid] = {
        imageUrls: safeUrls, selectedUrl: safeSelected, localPath: s.localPath,
        headshotLocalPath: s.headshotLocalPath, status: s.status, qcResult: s.qcResult,
        // Item 0: the store keeps what produced each artifact — auto + sent + negative
        lastPrompt: s.lastPrompt, lastAutoPrompt: s.lastAutoPrompt, lastNegative: s.lastNegative,
        jobId: s.jobId,
      }
    }
    patchStageData(3, { assetStates: toStore })
  }, [assetStates, patchStageData])

  useEffect(() => {
    if (assets.length === 0) return
    // Defer one microtask so the expansion sync isn't a synchronous setState in the effect
    void Promise.resolve().then(() => setExpandedIds((prev) => {
      if (prev.size > 0) return prev
      return new Set(assets.map((a) => a.id))
    }))
  }, [assets])

  // ── Job recovery: re-attach to generations that were in flight when this view
  // last unmounted (stage nav / reload). The poll loop dies with its closure, but
  // the backend job keeps rendering (ASSET_JOBS, 1h TTL) — without this, finished
  // renders never reached the UI and the spend was lost. Mirrors Stage 5's
  // recoverStranded.
  const resumeAssetJob = useCallback(async (assetId: string, jobId: string) => {
    interface JobSnap {
      status: 'preparing' | 'rendering' | 'done' | 'failed'
      slots: Array<{ url: string | null; error: string | null; pending?: boolean }>
      used_prompt?: string
      error?: string | null
    }
    try {
      const startedAt = Date.now()
      let shown = 0
      for (;;) {
        // Poll FIRST: the job may have finished while we were away — adopt instantly.
        const snap = (await apiClient.get<JobSnap>(`/api/assets/job/${jobId}`)).data
        const arrived = snap.slots.filter((s) => s.url).map((s) => s.url!)
        if (arrived.length > shown) {
          shown = arrived.length
          updateAsset(assetId, { imageUrls: arrived })
        }
        if (snap.status === 'done') {
          updateAsset(assetId, {
            imageUrls: arrived, status: 'pending', jobId: null,
            slotErrors: snap.slots.map((s) => s.error ?? null),
            ...(snap.used_prompt ? { lastPrompt: snap.used_prompt } : {}),
          })
          updateAgent('seedream', { status: 'completed', detail: 'Recovered a finished generation', progress: 100 })
          return
        }
        if (snap.status === 'failed') throw new Error(snap.error || 'Generation failed')
        if (Date.now() - startedAt > GENERATION_TIMEOUT_MS) throw new Error('Generation timed out')
        await new Promise((r) => setTimeout(r, 2500))
      }
    } catch (e) {
      // 404 = the backend restarted and the job is gone; anything else is a real
      // failure. Either way: release the card with an actionable message.
      const msg = e instanceof Error ? e.message : 'Generation lost'
      updateAsset(assetId, { status: 'error', errorMsg: msg, jobId: null })
    }
  }, [updateAsset, updateAgent])

  const recoveredJobsRef = useRef(false)
  useEffect(() => {
    if (recoveredJobsRef.current) return
    recoveredJobsRef.current = true
    // Deferred one microtask (file-wide pattern): no synchronous setState in effects.
    void Promise.resolve().then(() => {
      for (const [aid, s] of Object.entries(assetStates)) {
        if (s.jobId && s.status === 'generating') void resumeAssetJob(aid, s.jobId)
      }
    })
  }, [assetStates, resumeAssetJob])

  const toggleExpanded = (id: string) => setExpandedIds((prev) => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  // Step 1 of generation: Claude writes the FINAL Seedream prompt (doctor +
  // identity-board template for characters) and we surface it in the card for
  // the user to review/edit BEFORE any Seedream spend.
  const preparePrompt = useCallback(async (asset: Asset, withFeedback?: string): Promise<string | null> => {
    updateAsset(asset.id, { preparing: true, errorMsg: '' })
    updateAgent('qc', { status: 'active', detail: `Writing prompt: ${asset.name}…`, progress: 10 })

    // 0.2: prompt doctor — rewrite raw description to embed style/palette/lighting.
    // Non-fatal: falls back to raw description on failure.
    let description = asset.visualDescription
    let assembled: string | null = null
    try {
      const doctored = await pipelineApi.doctorPrompt(asset.visualDescription, asset.type, style)
      description = doctored.doctored_prompt
      assembled = doctored.assembled_prompt ?? null
    } catch { /* non-fatal — use raw description */ }
    if (withFeedback) description = `${description}\n\nDirector notes: ${withFeedback}`

    let prompt: string
    if (asset.type === 'character' || asset.type === 'prop' || asset.type === 'wardrobe') {
      // Production template: Claude expands the description into the full
      // multi-view sheet prompt (identity board for characters, object design
      // sheet for props, costume lookbook for wardrobe) — the exact text
      // Seedream will receive.
      try {
        const { data } = await apiClient.post<{ board_prompt: string }>('/api/assets/board-prompt', {
          asset_name: asset.name,
          description,
          style_label: style.id,
          style_suffix: style.promptSuffix,
          kind: asset.type,
        }, { timeout: GENERATION_TIMEOUT_MS })
        prompt = data.board_prompt
      } catch {
        // Board template unavailable — let the user edit the doctored description;
        // it is still sent verbatim as the final prompt.
        prompt = description
      }
    } else {
      // Mirror of the backend assembler: description [+ style suffix]
      prompt = (!withFeedback && assembled)
        ? assembled
        : [description, style.promptSuffix].filter((p) => p?.trim()).join(', ')
    }

    updateAsset(asset.id, {
      preparing: false, pendingPrompt: prompt, autoPrompt: prompt,
      pendingNegative: style.negativePrompt ?? '', pendingFeedback: withFeedback ?? '',
    })
    updateAgent('qc', { status: 'completed', detail: `Prompt ready: ${asset.name} — review before generating` })
    return prompt
  }, [updateAsset, updateAgent, style])

  // Step 2: send the (possibly user-edited) prompt to Seedream verbatim.
  const runGeneration = useCallback(async (asset: Asset, finalPrompt: string, withFeedback: string) => {
    const prevState = getAssetState(asset.id)
    const refMedia = prevState.refMedia
    const autoPrompt = prevState.autoPrompt ?? finalPrompt
    const negative = prevState.pendingNegative || style.negativePrompt || ''

    const refCount = refMedia.images.length
    updateAsset(asset.id, {
      status: 'generating', imageUrls: [], selectedUrl: null, qcResult: null,
      expectedCount: variantCountRef.current,
      errorMsg: '', pendingPrompt: null,
    })
    updateAgent('seedream', {
      status: 'active',
      detail: `Generating ${asset.name}${refCount ? ` (+${refCount} refs)` : ''}…`,
      progress: 20,
    })

    // Director notes express INTENT TO CHANGE — seeding the regen from the old
    // selected variation (w=0.9 identity ref) anchored the OLD face at the image
    // level and beat the note every time (e.g. "etnicidad española" kept producing
    // the same Asian face). Notes-regens are now prompt-driven: only the user's
    // explicit Reference Media rides along.
    const referenceImages = refMedia.images.map((img) => ({ url: img.url, role: img.role, weight: img.weight }))

    try {
      // Async job + progressive polling: each variation appears in the card the
      // moment its slot lands instead of waiting for the whole set.
      const { data: kick } = await apiClient.post<{ job_id: string; slot_count: number }>(
        '/api/assets/generate-async', {
          asset_id: asset.id,
          asset_name: asset.name,       // identity-board ID block
          description: asset.visualDescription,
          raw_description: asset.visualDescription,
          final_prompt: finalPrompt,    // user-reviewed prompt — sent to Seedream VERBATIM
          // Identity may be changing: the backend invalidates the character's cached
          // face block + face anchor so downstream re-derives from the NEW look.
          regen_notes: withFeedback || '',
          asset_type: asset.type,
          project_name: projectName,
          project_path: localFolderRoot ?? '',   // usage metering attribution
          count: variantCountRef.current,
          reference_images: referenceImages,
          negative_prompt: negative || undefined,
          style: {
            label: style.id,
            prompt_suffix: style.promptSuffix,
            negative_prompt: style.negativePrompt,
            anchor_image_refs: style.anchorImageRefs ?? [],
          },
        })

      // Persist the job id NOW: if the view unmounts (stage nav / reload) the
      // mount-time recovery re-attaches to this job instead of losing the render.
      updateAsset(asset.id, { jobId: kick.job_id, expectedCount: kick.slot_count })

      interface JobSnap {
        status: 'preparing' | 'rendering' | 'done' | 'failed'
        slots: Array<{ url: string | null; error: string | null; pending?: boolean }>
        used_prompt?: string
        error?: string | null
      }
      const startedAt = Date.now()
      let snap: JobSnap
      let shown = 0
      for (;;) {
        if (Date.now() - startedAt > GENERATION_TIMEOUT_MS) throw new Error('Generation timed out')
        await new Promise((r) => setTimeout(r, 2500))
        snap = (await apiClient.get<JobSnap>(`/api/assets/job/${kick.job_id}`)).data
        const arrived = snap.slots.filter((s) => s.url).map((s) => s.url!)
        if (arrived.length > shown) {
          shown = arrived.length
          updateAsset(asset.id, { imageUrls: arrived })
          updateAgent('seedream', {
            status: 'active',
            detail: `${asset.name}: ${shown}/${snap.slots.length} rendered`,
            progress: 20 + Math.round((60 * shown) / snap.slots.length),
          })
        }
        if (snap.status === 'done') break
        if (snap.status === 'failed') throw new Error(snap.error || 'Generation failed')
      }

      // P0.1: filter empty/falsy URLs before storing
      const urls: string[] = snap.slots.filter((s) => s.url).map((s) => s.url!)
      // Issue 3: per-slot failures shown explicitly — never present a partial
      // set as if it were the full one
      const slotErrors = snap.slots.map((s) => s.error ?? null)

      updateAsset(asset.id, {
        imageUrls: urls, status: 'pending', feedback: '', slotErrors, jobId: null,
        lastPrompt: snap.used_prompt || finalPrompt,
        lastAutoPrompt: autoPrompt,
        lastNegative: negative,
      })
      updateAgent('seedream', { status: 'active', detail: `${asset.name} rendered`, progress: 80 })

      // P4: QC is fire-and-forget — images are usable immediately, the Art
      // Director's verdict lands on the card whenever it's ready.
      if (urls.length) {
        void (async () => {
          try {
            const qc = await pipelineApi.qcAsset(
              { ...asset } as never,
              urls[0],
              style.id,
              style.promptSuffix,
              style.anchorImageRefs ?? [],
            )
            updateAsset(asset.id, { qcResult: qc })
            const driftInfo = qc.drift_score != null
              ? ` (drift: ${Math.round(qc.drift_score * 100)}%)`
              : ''
            updateAgent('qc', {
              status: qc.passed ? 'completed' : 'active',
              detail: qc.summary + driftInfo,
            })
          } catch { /* QC optional */ }
        })()
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Generation failed'
      // Bring the failed prompt back into the panel so the user can soften the
      // wording and retry directly (e.g. content-filter false positives).
      updateAsset(asset.id, { status: 'error', errorMsg: msg, pendingPrompt: finalPrompt, jobId: null })
      toastError(`Failed: ${asset.name}`, msg)
      updateAgent('seedream', { status: 'error', detail: msg })
    }
  }, [getAssetState, updateAsset, updateAgent, toastError, style])

  // Phase-2 wardrobe VARIANT: a variant (asset.parentCharacterId set) is NOT a fresh
  // t2i — it's a Seedream 5.0 Pro image-to-image EDIT of the base's APPROVED sheet
  // (tool 'wardrobe'). This (a) keeps the EXACT face/identity (i2i lock on the base),
  // (b) is a Pro output → KYC-HIGH i2i-exempt so it still passes Seedance's biometric
  // filter, and (c) is saved BYTE-EXACT (no re-encode) so the trust chain holds — the
  // same guarantees as the base sheet. Requires the base approved first (its sheet is
  // the edit source). Variants are always character-typed → Assets/Characters/<name>.
  // `justApprovedId`: el mismo contrato que generateDependentAsset. Cuando esto se dispara
  // DESDE la aprobación del padre, el estado de React aún no ha re-renderizado y
  // getAssetState(base.id).status sigue diciendo 'pending' — sin este parámetro la
  // variante recién desbloqueada se negaba a sí misma con "Approve X first". Medido en
  // el spec de lote: aprobar al padre no disparaba ninguna edición.
  const generateWardrobeVariant = useCallback(async (asset: Asset, justApprovedId?: string) => {
    const base = asset.parentCharacterId ? assets.find((a) => a.id === asset.parentCharacterId) : undefined
    if (!base) {
      toastError(`Cannot generate ${asset.name}`, 'Its base character is missing from the breakdown')
      return
    }
    const bs = getAssetState(base.id)
    const baseSheet = bs.localPath || bs.selectedUrl
    const baseApproved = bs.status === 'approved' || base.id === justApprovedId
    if (!baseApproved || !baseSheet) {
      toastError(`Approve ${base.name} first`,
        `${asset.name} edits ${base.name}'s approved sheet to swap wardrobe — approve the base look, then generate this variant.`)
      return
    }
    updateAsset(asset.id, { status: 'generating' })
    updateAgent('seedream', { status: 'active', detail: `${asset.name}: wardrobe edit…`, progress: 15 })
    try {
      const edited = await pipelineApi.editAsset({
        baseImage: baseSheet,                                  // base's byte-exact approved sheet (i2i source)
        tool: 'wardrobe',
        instruction: asset.wardrobe || asset.visualDescription,
        saveVersion: true,
        assetRelPath: `Assets/Characters/${asset.name}`,
        projectName,
        projectPath: localFolderRoot ?? '',
        styleSuffix: style.promptSuffix,
        assetType: asset.type,
        size: '2K',
        outputFormat: 'png',
      })
      const disp = edited.localPath ? serveUrl(edited.localPath) : edited.url
      updateAsset(asset.id, {
        imageUrls: [disp], selectedUrl: disp, localPath: edited.localPath || null,
        status: 'pending', slotErrors: [null], jobId: null,
        lastPrompt: edited.prompt || asset.wardrobe || '',
      })
      updateAgent('seedream', { status: 'active', detail: `${asset.name} wardrobe rendered — review & approve`, progress: 80 })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Wardrobe edit failed'
      updateAsset(asset.id, { status: 'error', errorMsg: msg, jobId: null })
      toastError(`Failed: ${asset.name}`, msg)
      updateAgent('seedream', { status: 'error', detail: msg })
    }
  }, [assets, getAssetState, updateAsset, updateAgent, toastError, projectName, localFolderRoot, style])

  // DEPENDENT asset: one that DEPICTS other assets (asset.dependsOn) — a photograph of
  // the couple, a briefing-room screen showing the hostage, a portrait on a wall. Like a
  // wardrobe variant it is NOT a fresh t2i: rendering it from its own description alone
  // is what put two strangers in the polaroid on DRAMA QUEEN 3's fridge. It is a Pro edit
  // (tool 'depicts') whose references are the APPROVED sheets of everyone it depicts, so
  // the faces inside the object are the film's own. Fires by itself the moment the last
  // dependency is approved — approving is the only manual step.
  const generateDependentAsset = useCallback(async (asset: Asset, justApprovedId?: string) => {
    // Identidades primero y el ENTORNO al final, porque los dos papeles son distintos y
    // el prompt los nombra por número: la gente fija las caras, la sala fija el muro que
    // hay detrás. Sin separarlos, la sala llega como una identidad más y el objeto se
    // inventa dónde está — BLACK MIRROR, 2026-08-15: la pantalla de la sala de crisis
    // salió con la mujer correcta y una pared de piedra rústica, en una película cuyas
    // dos únicas localizaciones son un despacho de roble y un dormitorio.
    const all = (asset.dependsOn ?? []).map((id) => assets.find((a) => a.id === id)).filter(Boolean) as Asset[]
    const deps = [...all.filter((d) => d.type !== 'environment'), ...all.filter((d) => d.type === 'environment')]
    if (!deps.length) return
    const sheets: string[] = []
    const waiting: string[] = []
    for (const d of deps) {
      const ds = getAssetState(d.id)
      const sheet = ds.localPath || ds.selectedUrl
      // The just-approved asset's own status is not in this render's snapshot yet
      // (assetStates is local state), so it counts as approved on its own id.
      const ok = (ds.status === 'approved' || d.id === justApprovedId) && !!sheet
      if (ok && sheet) sheets.push(sheet)
      else waiting.push(d.name)
    }
    if (waiting.length) {
      toastError(`${asset.name} is waiting`,
        `It depicts ${waiting.join(', ')} — approve ${waiting.length > 1 ? 'those' : 'that'} first and this renders itself from their approved sheets.`)
      return
    }
    updateAsset(asset.id, { status: 'generating' })
    updateAgent('seedream', { status: 'active', detail: `${asset.name}: rendering from ${deps.map((d) => d.name).join(', ')}…`, progress: 15 })
    try {
      const edited = await pipelineApi.editAsset({
        baseImage: sheets[0],                     // image 1 is always the subject slot
        referenceImages: sheets.slice(1),         // the rest of the depicted identities
        tool: 'depicts',
        // El papel de cada referencia, por número. La prosa de 'depicts' dice que se
        // ignoren los fondos de las referencias "salvo que la descripción lo pida" —
        // esta frase es esa petición, y sólo aparece cuando hay entorno del que depender.
        instruction: (() => {
          const base = asset.visualDescription || asset.name
          const envAt = deps.findIndex((d) => d.type === 'environment')
          if (envAt < 0) return base
          const who = deps.slice(0, envAt).map((d, i) => `Image ${i + 1} is ${d.name}`).join('; ')
          return `${base}. ${who ? who + '. ' : ''}Image ${envAt + 1} is ${deps[envAt].name}, `
            + 'the room this object is fixed in: take the wall, surfaces, materials and '
            + 'lighting of the surroundings from it, and place the object in that room.'
        })(),
        saveVersion: true,
        assetRelPath: assetRelPath(asset),
        projectName,
        projectPath: localFolderRoot ?? '',
        styleSuffix: style.promptSuffix,
        assetType: asset.type,
        size: '2K',
        outputFormat: 'png',
      })
      const disp = edited.localPath ? serveUrl(edited.localPath) : edited.url
      updateAsset(asset.id, {
        imageUrls: [disp], selectedUrl: disp, localPath: edited.localPath || null,
        status: 'pending', slotErrors: [null], jobId: null,
        lastPrompt: edited.prompt || asset.visualDescription || '',
      })
      updateAgent('seedream', { status: 'active', detail: `${asset.name} rendered from its approved sources — review & approve`, progress: 80 })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Dependent asset render failed'
      updateAsset(asset.id, { status: 'error', errorMsg: msg, jobId: null })
      toastError(`Failed: ${asset.name}`, msg)
      updateAgent('seedream', { status: 'error', detail: msg })
    }
  }, [assets, getAssetState, updateAsset, updateAgent, toastError, projectName, localFolderRoot, style])

  // Card buttons. Initial Generate: prepare the prompt and STOP — the user
  // reviews/edits it in the panel, then explicitly clicks Generate.
  // straightThrough (Regen-with-notes, QC Auto-Fix): the user's intent is new
  // images NOW — rebuild the prompt and generate immediately, no review pause.
  const generateAsset = useCallback(async (asset: Asset, withFeedback?: string, straightThrough = false) => {
    // Phase-2: a wardrobe variant renders via the Pro i2i edit of its base sheet,
    // NOT the t2i prompt path — no prompt review, identity comes from the base.
    if (asset.parentCharacterId) { await generateWardrobeVariant(asset); return }
    // An asset that depicts others renders FROM their approved sheets, never from its
    // own words — and says so if they are not approved yet instead of inventing faces.
    if (asset.dependsOn?.length) { await generateDependentAsset(asset); return }
    // Regen / QC Auto-Fix: improve the prompt that produced the CURRENT result
    // (st.lastPrompt — which already carries any manual edit the user made),
    // applying the feedback, instead of re-doctoring the original description
    // from scratch (which discarded edits and tended to repeat the same image).
    const st = getAssetState(asset.id)
    if (straightThrough && withFeedback?.trim() && st.lastPrompt?.trim()) {
      // Claude REWRITES the prompt applying the notes everywhere (FACE LOCK,
      // [SUBJECT], [WARDROBE]…) and removes contradictions. The old approach —
      // appending "revise per these notes" — lost to the prompt's own detailed
      // face spec, so identity notes (e.g. a different ethnicity) never landed.
      let improved = `${st.lastPrompt.trim()}\n\nRevise per these notes (apply the changes, keep everything else): ${withFeedback.trim()}`
      try {
        const { data } = await apiClient.post<{ revised: string }>('/api/prompt/revise', {
          prompt: st.lastPrompt.trim(), notes: withFeedback.trim(),
        })
        if (data.revised?.trim()) improved = data.revised.trim()
      } catch { /* Claude unavailable → concat fallback above still regenerates */ }
      await runGeneration(asset, improved, withFeedback)
      return
    }
    const prompt = await preparePrompt(asset, withFeedback)
    if (straightThrough && prompt) {
      await runGeneration(asset, prompt, withFeedback ?? '')
    }
  }, [getAssetState, preparePrompt, runGeneration, generateWardrobeVariant, generateDependentAsset])

  // Generate button inside the prompt-review panel.
  const executeGenerate = useCallback(async (asset: Asset) => {
    const st = getAssetState(asset.id)
    if (!st.pendingPrompt?.trim()) return
    await runGeneration(asset, st.pendingPrompt.trim(), st.pendingFeedback)
  }, [getAssetState, runGeneration])

  const cancelPrompt = useCallback((assetId: string) => {
    updateAsset(assetId, { pendingPrompt: null, pendingFeedback: '', preparing: false })
  }, [updateAsset])

  const handleGenerateAll = async () => {
    if (!assets.length) return
    stopRequested.current = false
    setIsGeneratingAll(true)
    updateAgent('seedream', { status: 'active', detail: 'Generating all assets…', progress: 0 })
    // Batch mode skips the per-asset review pause — prompts go straight through.
    // Pipelined: while asset N renders on Seedream, Claude is already writing
    // asset N+1's prompt, so the render pool never waits on prompt prep.
    // Voices have no image to render, and an asset that DEPICTS others cannot be
    // rendered until they are approved — it fires by itself the moment they are, so
    // queueing it here would only produce a "waiting" toast per batch run.
    // DOS dependencias, no una. `dependsOn` es un asset que RETRATA a otros; una variante
    // de vestuario expresa la suya en `parentCharacterId`, y este filtro sólo miraba la
    // primera. Una variante lo pasaba de forma vacía, entraba en la cola, y el worker la
    // mandaba por `runGeneration` — un text-to-image nuevo desde su prompt, no la edición
    // i2i de la lámina aprobada del padre. Otra cara, sin bloqueo de identidad, sin la
    // cadena de confianza biométrica que sólo conserva editar una salida Pro, y sin
    // aviso, porque la guardia que avisa vive en `generateAsset` y el lote no pasa por ahí.
    const baseApproved = (a: Asset) =>
      !a.parentCharacterId || getAssetState(a.parentCharacterId).status === 'approved'
    const queue = assets.filter((a) =>
      isImageAsset(a)
      && getAssetState(a.id).status !== 'approved'
      && (a.dependsOn ?? []).every((d) => getAssetState(d).status === 'approved')
      && baseApproved(a))
    // Lo que queda fuera se dice UNA vez, con nombres — no un toast por variante. Y se
    // dice por qué: aprobar al padre las dispara solas (ver handleApprove).
    const waitingVariants = assets.filter((a) =>
      isImageAsset(a) && a.parentCharacterId
      && getAssetState(a.id).status !== 'approved' && !baseApproved(a))
    if (waitingVariants.length) {
      const names = waitingVariants.map((a) => a.name).join(', ')
      warning(`${waitingVariants.length} wardrobe look(s) wait for their character`,
        `${names} — each is an edit of its base character's approved sheet, so it renders itself the moment that character is approved.`)
    }
    // Worker pool: N assets in flight at once (each renders its 4 variations in
    // parallel server-side). Seedream is rated 500 images/min, so 4×4=16 concurrent
    // requests sit far under the cap; prompt prep pipelines naturally because each
    // worker preps its own next asset while the others render. Stop is honored
    // before a worker pulls the next asset (in-flight ones finish, like before).
    let nextIndex = 0
    let completed = 0
    let failed = 0
    const runWorker = async () => {
      for (;;) {
        if (stopRequested.current) return
        const i = nextIndex++
        if (i >= queue.length) return
        const asset = queue[i]
        updateAgent('seedream', {
          detail: `${Math.min(nextIndex, queue.length)}/${queue.length}: ${asset.name}`,
          progress: Math.round(((completed + failed) / queue.length) * 100),
        })
        // One asset failing (prompt prep OR render) must NOT kill the batch —
        // mark it, tell the user, and let this worker pull the next asset.
        try {
          // Una variante con padre aprobado va por el MISMO camino que a mano: la edición
          // i2i de la lámina del padre. Nunca por el prompt t2i, que es lo que la
          // renderizaba con otra cara.
          if (asset.parentCharacterId) {
            await generateWardrobeVariant(asset)
          } else {
            const prompt = await preparePrompt(asset)
            if (stopRequested.current) return
            if (prompt) await runGeneration(asset, prompt, '')
          }
          completed++
        } catch (e) {
          failed++
          const msg = e instanceof Error ? e.message : 'prompt/render failed'
          updateAsset(asset.id, { status: 'error', errorMsg: msg })
          toastError(`Batch: ${asset.name} failed`, `${msg} — continuing with the next asset`)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(ASSET_BATCH_CONCURRENCY, queue.length) }, runWorker),
    )
    updateAgent('seedream', {
      status: stopRequested.current ? 'idle' : 'completed',
      detail: stopRequested.current
        ? `Stopped after ${completed}/${queue.length} — "Generate All" resumes (approved assets are skipped)`
        : `Batch done: ${completed}/${queue.length} assets generated${failed ? ` · ${failed} failed` : ''}`,
      progress: 100,
    })
    setIsGeneratingAll(false)
  }

  // Halt the batch: the loop stops before the next asset; a Seedream variation
  // already in flight completes (no per-image cancel exists upstream).
  const handleStopAll = useCallback(() => {
    stopRequested.current = true
    updateAgent('seedream', { status: 'idle', detail: 'Stop requested — finishing the current asset' })
  }, [updateAgent])

  // P5c.2: Autopilot runner — generate every asset, then PAUSE for review
  // (character identity is too critical to auto-approve). Registered once;
  // reads the latest handleGenerateAll via a ref.
  const genAllRef = useRef(handleGenerateAll)
  genAllRef.current = handleGenerateAll
  useEffect(() => registerAutopilotRunner(3, async (): Promise<AutopilotResult> => {
    try { await genAllRef.current(); return 'paused' }
    catch { return 'error' }
  }), [])

  // P0.3: Select a variation (marks preferred, does NOT approve yet)
  const handleSelectVariation = (assetId: string, url: string) => {
    updateAsset(assetId, { selectedUrl: url })
  }

  // Issue 3: regenerate ONLY the failed slots and merge them into the set
  const retryFailedVariations = useCallback(async (asset: Asset) => {
    const st = getAssetState(asset.id)
    const failedCount = st.slotErrors.filter(Boolean).length
    if (!failedCount) return
    updateAgent('seedream', { status: 'active', detail: `Retrying ${failedCount} failed variation(s): ${asset.name}` })
    try {
      const { data } = await apiClient.post<{
        urls?: string[]
        slots?: Array<{ url: string | null; error: string | null }>
      }>('/api/assets/generate', {
        asset_id: asset.id,
        asset_name: asset.name,
        description: asset.visualDescription,
        raw_description: asset.visualDescription,
        // Reuse the EXACT prompt of the original render so retried slots match
        // their siblings (esp. character boards — avoids a fresh Claude rewrite)
        final_prompt: st.lastPrompt ?? '',
        asset_type: asset.type,
        project_name: projectName,
        project_path: localFolderRoot ?? '',
        count: failedCount,
        reference_images: [],
        negative_prompt: style.negativePrompt || undefined,
        style: {
          label: style.id, prompt_suffix: style.promptSuffix,
          negative_prompt: style.negativePrompt, anchor_image_refs: style.anchorImageRefs ?? [],
        },
      }, { timeout: GENERATION_TIMEOUT_MS })
      const newUrls = (data.urls ?? []).filter(Boolean)
      // slotErrors is SLOT-indexed (null = that slot succeeded); imageUrls is COMPACTED
      // (successes only). The retry response only covers the slots we resent, in order,
      // so map it back onto the ORIGINAL slot positions. Replacing slotErrors with a
      // compacted `[...].filter(Boolean)` shrank the array to the retried count and
      // re-based every index — the error labels then named the wrong variations.
      const retriedSlots = st.slotErrors.reduce<number[]>((acc, err, i) => {
        if (err) acc.push(i)
        return acc
      }, [])
      const retried = data.slots ?? []
      const slotErrors = [...st.slotErrors]
      retriedSlots.forEach((slot, j) => { slotErrors[slot] = retried[j]?.error ?? null })
      const stillFailing = slotErrors.filter(Boolean).length
      updateAsset(asset.id, {
        // No fixed cap: the set size is however many variations were requested
        // (4/6/8) — the old .slice(0, 4) silently dropped retried slots on 6/8 sets.
        imageUrls: [...st.imageUrls, ...newUrls],
        slotErrors,
      })
      updateAgent('seedream', {
        status: stillFailing ? 'error' : 'completed',
        detail: stillFailing ? `${stillFailing} variation(s) still failing` : `${asset.name} complete`,
      })
    } catch (e: unknown) {
      toastError(`Retry failed: ${asset.name}`, e instanceof Error ? e.message : 'error')
    }
  }, [getAssetState, updateAsset, updateAgent, style, toastError])

  // Derive local folder path for an asset (e.g. "Assets/Characters/Jack")
  const assetRelPath = (asset: Asset): string => {
    const typeDir: Record<string, string> = {
      character: 'Assets/Characters',
      prop: 'Assets/Props',
      wardrobe: 'Assets/Wardrobe',
      environment: 'Assets/Environments',
      fx: 'Assets/FX',
      vfx: 'Assets/FX',
    }
    return `${typeDir[asset.type] ?? 'Assets'}/${asset.name}`
  }

  // P0.3 + P5: Approve the selected variation — updates counter and saves version to disk
  const handleApproveAsset = async (assetId: string) => {
    const state = getAssetState(assetId)
    if (!state.selectedUrl) return
    updateAsset(assetId, { status: 'approved' })
    const asset = assets.find((a) => a.id === assetId)
    const assetName = asset?.name ?? assetId
    success('Asset approved', assetName)

    // CONSISTENCY: a character's identity caches (fictional face block + face
    // anchor) are vision-grounded on whatever headshot was seen FIRST and never
    // updated — so approving a different variation left every shot rendering the
    // OLD face. Invalidate them on approval so the next SG generation rebuilds the
    // anchor from THIS approved sheet. Fire-and-forget, non-fatal.
    if (asset?.type === 'character' && !asset.parentCharacterId) {
      // Variants inherit the base's identity caches (they were i2i-edited from the
      // base sheet) — don't mint a separate face anchor for them.
      void pipelineApi.resetCharacterIdentity({
        projectName, projectPath: localFolderRoot ?? '', characters: [assetName],
      }).catch(() => { /* cache clear is best-effort */ })
    }

    // Environments: auto-generate the multi-view + top-view sheet now (so Seedance
    // has consistent references). The panel fires it once via the autoStart flag.
    if (asset?.type === 'environment') {
      setAutoAnglesFor((prev) => new Set(prev).add(assetId))
    }

    // WHATEVER DEPICTS THIS ASSET CAN NOW BE MADE. Approving is the only manual step:
    // the moment the last identity a photo/screen/portrait depends on is approved, that
    // asset renders itself from the approved sheets. Fired from HERE, and not from an
    // effect watching approvals, for the same reason autoAnglesFor is: on reload every
    // dependency is already approved, and an effect would re-bill every dependent asset
    // on every page load. Only a real approval in this session triggers a render.
    const unlocked = assets.filter((a) =>
      (a.dependsOn ?? []).includes(assetId)
      && !['approved', 'generating'].includes(getAssetState(a.id).status)
      && (a.dependsOn ?? []).every((d) =>
        d === assetId || getAssetState(d).status === 'approved'),
    )
    for (const dep of unlocked) {
      void generateDependentAsset(dep, assetId)
    }
    // Y LO MISMO PARA SUS VESTUARIOS. Una variante edita la lámina aprobada de su padre,
    // así que hasta este momento no podía existir; ahora sí, y se hace sola. Desde aquí y
    // no desde un efecto, por la razón de arriba: al recargar todo padre ya está aprobado
    // y un efecto re-facturaría cada variante en cada carga.
    const looks = assets.filter((a) =>
      a.parentCharacterId === assetId
      && !['approved', 'generating'].includes(getAssetState(a.id).status))
    for (const look of looks) {
      void generateWardrobeVariant(look, assetId)
    }

    // P5: persist to local folder and capture the stable local_path.
    // local_path is an absolute disk path that never expires, unlike the signed CDN URL.
    // It is passed to Seedream as a reference image for keyframe generation.
    if (localFolderRoot && state.selectedUrl) {
      if (asset) {
        try {
          const { data } = await apiClient.post<{ version: number; path: string; local_path: string; headshot_local_path: string }>(
            '/api/asset/save-version',
            {
              name: projectName, asset_rel_path: assetRelPath(asset),
              image_url: state.selectedUrl, project_path: localFolderRoot ?? '',
              // 2a: characters get a clean big-face headshot cropped off the sheet → the
              // dominant facial ref to Seedance (the tiny full-body faces drift). WHERE it is
              // cropped from is the backend's business and moved with the layout: on the
              // "headless" default it is the left-column 3/4 portrait, not the old top-left
              // close-up. We deliberately send NO sheet_layout — the server's default is the
              // same constant the sheet was generated with, so the two cannot drift.
              derive_headshot: asset.type === 'character',
              // Item 0: every saved artifact carries its provenance — the auto
              // prompt, the user's override (if edited), and what was sent.
              prompt_meta: {
                kind: asset.type === 'character' ? 'identity_board' : asset.type === 'prop' ? 'prop_sheet' : asset.type === 'wardrobe' ? 'wardrobe_sheet' : 'asset',
                auto_prompt: state.lastAutoPrompt ?? state.lastPrompt ?? '',
                prompt_override: state.lastPrompt !== state.lastAutoPrompt ? state.lastPrompt : null,
                sent_prompt: state.lastPrompt ?? '',
                negative_prompt: state.lastNegative,
                references: state.refMedia.images.map((img) => ({ url: img.url, label: img.role })),
                model: 'seedream',
              },
            }
          )
          // Store the absolute disk path — used instead of CDN URL for keyframe refs
          if (data.local_path) {
            updateAsset(assetId, { localPath: data.local_path })
          }
          // 2a: the derived headshot becomes ref #1 ("lock the face EXACTLY") in SG.
          if (data.headshot_local_path) {
            updateAsset(assetId, { headshotLocalPath: data.headshot_local_path })
          }

          // Voice: on FIRST approval, auto-lock a design voice inferred from the
          // approved portrait (Seed Audio 1.0) — the audio analogue of the face
          // anchor, matching the character-dossier auto-fill. Only when the character
          // has no voice yet, so it never clobbers a preset/clone the user picked.
          if (asset.type === 'character' && data.local_path) {
            const portrait = state.headshotLocalPath || data.local_path
            void (async () => {
              try {
                const { voices } = await pipelineApi.getCharacterVoices(projectName, localFolderRoot ?? '')
                if (!voices?.[assetName]?.versions?.length) {
                  await pipelineApi.assignVoice(assetName,
                    { speaker: '', pitch_rate: 0, speech_rate: 0, engine: 'seed_audio_image', image_ref_path: portrait },
                    projectName, localFolderRoot ?? '')
                }
              } catch { /* best-effort */ }
            })()
          }

          // P1 (consistency): the FIRST approved environment becomes the project
          // style anchor — every later keyframe/board/shot inherits its palette
          // and lighting (anchor refs ride at weight ~0.5-0.6 on all Seedream
          // calls and Seedance submissions). Only auto-set when none exists.
          if (asset.type === 'environment' && data.local_path
              && !(style.anchorImageRefs?.length)) {
            usePipelineStore.getState().setStyle({
              ...style,
              anchorImageRefs: [data.local_path],
            })
            success('Style anchor set', `${asset.name} now anchors the project look`)
          }

          // Characters: the approved sheet IS the downstream reference. Seedance 2.0
          // locks identity straight from it, so we no longer derive a single figure —
          // that discarded the sheet and drifted (MODEL_AUDIT P3, now superseded).
          // localPath stays pointed at the full sheet saved by save-version above.
          // It is no longer a "4-pose sheet with bare-face close-ups": since 2026-08-06
          // the default layout is HELL GRIND's — one large 3/4 portrait, a HEADLESS
          // front figure and a back figure, i.e. exactly ONE face on the sheet
          // (claude_agents._SHEET_LAYOUTS). Nothing here reads the layout; the sentence
          // is corrected only so it stops describing a sheet the pipeline stopped making.

          // Props: the approved multi-view sheet IS the downstream reference, like
          // characters. Seedance 2.0 reads the object cleanly from the multi-view, so
          // we no longer derive a single hero shot. localPath stays pointed at the
          // full sheet saved by save-version above.
        } catch (e) {
          console.warn('[P5] save-version failed (non-fatal):', e)
        }
      }
    }
  }

  // Persist described fields onto the breakdown character (stage 2). Fresh getState
  // read so we never patch stale breakdown data.
  const patchCharacterFields = (assetId: string, fields: Partial<Asset>) => {
    const st = usePipelineStore.getState()
    const s2 = st.stages[2]
    const v = s2.versions.find((ver) => ver.id === s2.activeVersionId)
    const bd = v?.data as BreakdownData | undefined
    if (!bd?.assets) return
    const newAssets = bd.assets.map((a) => (a.id === assetId ? { ...a, ...fields } : a))
    st.patchStageData(2, { assets: newAssets })
  }

  // ── Phase-2 (D2): wardrobe editing ────────────────────────────────────────────
  // A wardrobe VARIANT is an ordinary character asset carrying parentCharacterId +
  // wardrobe + sceneRefs (the scenes it is worn in) — no new data model. Every mutation
  // goes through here so shot.assetsUsed is RECOMPUTED from those sceneRefs rather than
  // patched incrementally: recomputation is idempotent and cannot leave a shot pointing at
  // a deleted look (it mirrors the backend's _apply_wardrobe_variants).
  const commitWardrobe = useCallback((mutate: (current: Asset[]) => Asset[]) => {
    const st = usePipelineStore.getState()
    const s2 = st.stages[2]
    const v = s2.versions.find((ver) => ver.id === s2.activeVersionId)
    const bd = v?.data as BreakdownData | undefined
    if (!bd?.assets || !bd?.shots) return

    const nextAssets = mutate([...bd.assets])
    const byId = new Map(nextAssets.map((a) => [a.id, a]))
    const family = new Map<string, Asset[]>()          // base id → its variants
    for (const a of nextAssets) {
      if (!a.parentCharacterId) continue
      family.set(a.parentCharacterId, [...(family.get(a.parentCharacterId) ?? []), a])
    }

    // Resolve each referenced character to the look worn in THAT shot's scene, keeping the
    // original reference order (it drives Seedance ref priority) and de-duplicating.
    const nextShots = bd.shots.map((sh) => {
      const seen = new Set<string>()
      const used: string[] = []
      for (const id of sh.assetsUsed ?? []) {
        const asset = byId.get(id)
        if (!asset) continue                            // dropped asset → drop the reference
        const baseId = asset.parentCharacterId ?? id
        const looks = family.get(baseId)
        const resolved = looks
          ? (looks.find((w) => (w.sceneRefs ?? []).includes(sh.sceneId))?.id ?? baseId)
          : id
        if (!seen.has(resolved)) { seen.add(resolved); used.push(resolved) }
      }
      return { ...sh, assetsUsed: used }
    })

    st.patchStageData(2, { assets: nextAssets, shots: nextShots })
  }, [])

  const addWardrobe = useCallback((base: Asset) => {
    commitWardrobe((current) => {
      // Continue the ASSET_NNN sequence so ids stay unique across the whole breakdown.
      const maxN = current.reduce((m, a) => {
        const n = Number(/(\d+)$/.exec(a.id)?.[1] ?? 0)
        return n > m ? n : m
      }, 0)
      const id = `ASSET_${String(maxN + 1).padStart(3, '0')}`
      return [...current, {
        id,
        name: `${base.name} · New look`,
        type: 'character' as const,
        visualDescription: base.visualDescription,   // identity comes from the base sheet
        sceneRefs: [],
        parentCharacterId: base.id,
        wardrobe: '',
      }]
    })
  }, [commitWardrobe])

  const updateWardrobe = useCallback((id: string, fields: Partial<Asset>) => {
    commitWardrobe((current) => current.map((a) => (a.id === id ? { ...a, ...fields } : a)))
  }, [commitWardrobe])

  // Deleting a look sends its shots back to the base automatically (assetsUsed is
  // recomputed above), so a shot is never left referencing a removed asset.
  const removeWardrobe = useCallback((id: string) => {
    commitWardrobe((current) => current.filter((a) => a.id !== id))
  }, [commitWardrobe])

  // Feature 2: read a character's reference image(s) with vision → structured
  // fields, then fold them into the character so generation uses them (the refs
  // are already attached visually via ReferenceMediaPanel).
  const handleDescribeRefs = async (asset: Asset) => {
    const urls = (getAssetState(asset.id).refMedia?.images ?? []).map((i) => i.url).filter(Boolean)
    if (!urls.length) { toastError('No references', 'Add a reference image first.'); return }
    const res = await pipelineApi.describeCharacterRefs(urls)
    const marker = '\n\n[From references]'
    const base = (asset.visualDescription || '').split(marker)[0].trimEnd()
    const block = [
      res.appearance && `Appearance: ${res.appearance}`,
      res.hairstyle && `Hair: ${res.hairstyle}`,
      res.wardrobe && `Wardrobe: ${res.wardrobe}`,
      res.shoes && `Shoes: ${res.shoes}`,
      res.props && `Props: ${res.props}`,
    ].filter(Boolean).join('. ')
    patchCharacterFields(asset.id, {
      visualDescription: block ? `${base}${marker} ${block}.` : base,
      wardrobe: res.wardrobe || asset.wardrobe,
      hairstyle: res.hairstyle || null,
      shoes: res.shoes || null,
    })
    success('References described', 'Fields filled — they feed the next generation.')
  }


  // Batch the environment angle sheets when the assets are locked.
  //
  // Approving an environment already sets autoAnglesFor, but that flag is read by the
  // per-asset EnvironmentAnglesPanel — which only exists while that card is EXPANDED,
  // and whose 0 ms autoStart timer is cancelled by its own cleanup during the re-render
  // storm an approval causes. Measured: 0 sheets generated across 6 locations and 3
  // approve flows. So on a 20-location film the operator had to expand 20 cards and click
  // 20 times, and any one they missed rendered its boards with no geometry — the model
  // then invents the half of the room the single base image does not show, which is how
  // one kitchen came back with windows on both walls.
  //
  // Runs at the lock, where every environment is approved and its base image saved (the
  // sheet is generated FROM that base). GETs first so a location that already has a sheet
  // is never re-billed — the 39 sheets already on disk in BLOOM must survive a re-lock
  // untouched. Bounded concurrency; a failure is reported and never blocks the stage.
  const generateMissingAngleSheets = useCallback(async (): Promise<{ made: number; had: number; failed: number }> => {
    const envs = assets.filter((a) => a.type === 'environment')
    const path = localFolderRoot ?? ''
    let made = 0, had = 0, failed = 0
    const q = [...envs]
    const worker = async () => {
      for (;;) {
        const a = q.shift()
        if (!a) return
        try {
          const { data: cur } = await apiClient.get<{ angles?: Record<string, string> }>(
            '/api/assets/environment-angles',
            { params: { project_name: projectName, project_path: path, asset_name: a.name } },
          )
          if (Object.keys(cur?.angles ?? {}).length) { had++; continue }
          const st = getAssetState(a.id)
          const base = st.localPath || st.selectedUrl
          if (!base) { failed++; continue }
          await apiClient.post('/api/assets/environment-angles', {
            description: a.visualDescription ?? a.name,
            base_image_url: base,
            style_suffix: style.promptSuffix,
            project_name: projectName, project_path: path, asset_name: a.name,
          }, { timeout: 900_000 })
          made++
        } catch { failed++ }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return { made, had, failed }
  }, [assets, localFolderRoot, projectName, getAssetState, style])

  const handleLockAndProceed = () => {
    // Keep assetStates in the committed version — Stage 5's hard gate reads
    // per-asset approval status from here; dropping it on lock would make
    // every asset look unapproved after the version switch.
    const persistedStates: Record<string, PersistedAssetState> = Object.fromEntries(
      Object.entries(assetStates).map(([id, s]) => [id, {
        imageUrls: s.imageUrls.filter((u) => u && !u.startsWith('data:')),
        selectedUrl: s.selectedUrl && !s.selectedUrl.startsWith('data:') ? s.selectedUrl : null,
        localPath: s.localPath,
        headshotLocalPath: s.headshotLocalPath,
        status: s.status,
        qcResult: s.qcResult,
        lastPrompt: s.lastPrompt, lastAutoPrompt: s.lastAutoPrompt, lastNegative: s.lastNegative,
        jobId: s.jobId,
      }])
    )
    const data = {
      assets: Object.fromEntries(
        Object.entries(assetStates).map(([id, s]) => [id, { selectedUrl: s.selectedUrl, imageUrls: s.imageUrls, localPath: s.localPath }])
      ),
      assetStates: persistedStates,
    }
    const versionId = commitVersion(3, data)
    approveVersion(3, versionId)
    success('Assets locked ✓', 'Moving to Scene Breakdown →')
    goToStage(4)
    // The sheets are generated AFTER the stage advances, on purpose: they are a
    // reference the storyboard needs, not a gate on getting there, and a 20-location
    // film takes minutes. Existing sheets are skipped, so this is a no-op on a re-lock.
    void (async () => {
      const envs = assets.filter((a) => a.type === 'environment')
      if (!envs.length) return
      updateAgent('seedream', { status: 'active', detail: `Angle sheets: ${envs.length} location(s)…` })
      const { made, had, failed } = await generateMissingAngleSheets()
      if (failed) {
        warning('Some angle sheets are missing',
          `${failed} location(s) have no reverse/top view — their boards will be drawn from one image only.`)
      }
      updateAgent('seedream', {
        status: failed ? 'active' : 'completed',
        detail: `Angle sheets: ${made} new, ${had} already had one${failed ? `, ${failed} failed` : ''}`,
      })
    })()
  }

  // Counted over IMAGE assets only: a voice is never approved on a picture, so counting
  // it would hold the stage lock one short forever and no film could leave stage 3.
  const imageAssets    = assets.filter(isImageAsset)
  const approvedCount  = imageAssets.filter((a) => getAssetState(a.id).status === 'approved').length
  const allApproved    = imageAssets.length > 0 && approvedCount === imageAssets.length
  // Lock the stage ONLY when every asset is approved. If an upstream change (e.g. a
  // breakdown regen) adds a NEW unapproved asset after the stage was locked, this
  // re-opens it so the new asset can be selected + approved — instead of a dead-end
  // where a locked stage hides the approve buttons for an asset that still needs them.
  const alreadyLocked  = stage3.status === 'approved' && allApproved

  if (stage2.status !== 'approved') {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <StageHeader stageId={3} label="AG — Asset Generation" />
        <div className="flex flex-1 items-center justify-center text-text-muted">
          <div className="text-center">
            <Sparkles size={32} className="text-cyan/30 mx-auto mb-3" />
            <p className="text-sm">Approve the Breakdown in Stage 2 first.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StageHeader stageId={3} label="AG — Asset Generation" />

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-elevated border-b border-border shrink-0 flex-wrap gap-y-2">
        {/* P1: style selector always visible in Stage 3 toolbar */}
        <StyleSelector />

        <div className="h-4 w-px bg-border" />

        <Button
          variant="primary"
          size="sm"
          icon={<Sparkles size={13} />}
          loading={isGeneratingAll}
          onClick={handleGenerateAll}
          disabled={alreadyLocked || !assets.length || remainingToGenerate === 0}
        >
          {/* Mirror the batch's real queue (approved are skipped) so a resumed
              batch reads "Generate 22 remaining", not a misleading "All (25)". */}
          {remainingToGenerate === 0
            ? `All ${imageAssets.length} approved ✓`
            : remainingToGenerate < imageAssets.length
              ? `Generate ${remainingToGenerate} remaining`
              : `Generate All (${imageAssets.length})`}
        </Button>

        {isGeneratingAll && (
          <Button
            variant="danger" size="sm" icon={<Square size={11} />}
            onClick={handleStopAll} data-testid="stage3-stop-button"
          >
            Stop
          </Button>
        )}

        <div className="h-4 w-px bg-border" />

        {/* Variations per asset (4–8) — more takes to choose from */}
        <div className="flex items-center gap-1" title="How many variations to render per asset">
          <span className="text-[11px] text-text-muted">Variants</span>
          {[4, 6, 8].map((n) => (
            <button key={n} onClick={() => setVariantCount(n)} disabled={alreadyLocked}
              className={cn('px-1.5 py-0.5 rounded text-[11px] border',
                variantCount === n ? 'border-cyan bg-cyan/15 text-cyan' : 'border-border text-text-muted hover:border-cyan/40',
                'disabled:opacity-40')}>
              {n}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border" />

        <span className="text-[11px] text-text-muted">
          {approvedCount}/{imageAssets.length} approved
        </span>

        {allApproved && !alreadyLocked && (
          <Button variant="approve" size="sm" icon={<Lock size={13} />}
            onClick={handleLockAndProceed} className="ml-auto">
            Lock Assets → Stage 4
          </Button>
        )}

        {alreadyLocked && (
          <div className="ml-auto flex items-center gap-1.5 text-green text-[11px] font-semibold">
            <CheckCircle size={13} /> Assets locked
            <Button variant="ghost" size="sm" onClick={() => goToStage(4)} className="ml-2">
              Continue →
            </Button>
          </div>
        )}
      </div>

      {/* P1: asset-type tabs */}
      {assets.length > 0 && (
        <div className="flex items-center gap-1.5 px-4 py-2 bg-base border-b border-border shrink-0 overflow-x-auto">
          <button
            type="button"
            data-testid="asset-tab-all"
            onClick={() => setTypeFilter('all')}
            className={typeTabClasses(typeFilter === 'all', 'muted')}
          >
            All <span className="opacity-60">{assets.length}</span>
          </button>
          {ASSET_TYPE_TABS.map((tab) => {
            const count = typeCounts[tab.id]
            if (!count) return null
            const Icon = getTypeIcon(tab.id)
            return (
              <button
                key={tab.id}
                type="button"
                data-testid={`asset-tab-${tab.id}`}
                onClick={() => setTypeFilter(tab.id)}
                className={typeTabClasses(typeFilter === tab.id, tab.color)}
              >
                <Icon size={12} />
                {tab.label} <span className="opacity-60">{count}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Asset list */}
      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        {assets.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            No assets found — regenerate the breakdown in Stage 2.
          </div>
        ) : visibleAssets.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted text-sm">
            No {typeFilter} assets in this breakdown.
          </div>
        ) : visibleAssets.map((asset) => {
        const isVariant = !!asset.parentCharacterId && assets.some((a) => a.id === asset.parentCharacterId)
        const isBaseCharacter = normAssetType(asset.type) === 'character' && !asset.parentCharacterId
        return (
        <div key={asset.id} className={cn('flex flex-col gap-2', isVariant && 'ml-5 pl-2 border-l-2 border-cyan/30')}>
          <AssetCard
            asset={asset}
            state={getAssetState(asset.id)}
            isExpanded={expandedIds.has(asset.id)}
            locked={alreadyLocked}
            projectName={projectName}
            projectPath={localFolderRoot ?? ''}
            assetRelPath={assetRelPath(asset)}
            autoAngles={autoAnglesFor.has(asset.id)}
            onToggle={() => toggleExpanded(asset.id)}
            onGenerate={(fb, straightThrough) => generateAsset(asset, fb, straightThrough)}
            onExecuteGenerate={() => executeGenerate(asset)}
            onCancelPrompt={() => cancelPrompt(asset.id)}
            onResetPrompt={() => preparePrompt(asset, getAssetState(asset.id).pendingFeedback || undefined)}
            onPendingPromptChange={(p) => updateAsset(asset.id, { pendingPrompt: p })}
            onPendingNegativeChange={(n) => updateAsset(asset.id, { pendingNegative: n })}
            onRetryFailed={() => retryFailedVariations(asset)}
            onSelect={(url) => handleSelectVariation(asset.id, url)}
            onApprove={() => handleApproveAsset(asset.id)}
            onFeedbackChange={(fb) => updateAsset(asset.id, { feedback: fb })}
            onRefMediaChange={(rm) => updateAsset(asset.id, { refMedia: rm })}
            onDescribeRefs={() => handleDescribeRefs(asset)}
            onUnapprove={() => updateAsset(asset.id, { status: 'pending' })}
            onStartOver={() => updateAsset(asset.id, {
              status: 'idle', imageUrls: [], selectedUrl: null, localPath: null,
              headshotLocalPath: null, qcResult: null, feedback: '', jobId: null,
            })}
            onEditApplied={(edited) => {
              // Make the kept edit the asset's approved image. Prefer the disk copy
              // (stable) so it survives the 24h CDN window; fall back to the URL.
              updateAsset(asset.id, edited.localPath
                ? { selectedUrl: edited.url, localPath: edited.localPath, status: 'approved' }
                : { selectedUrl: edited.url, status: 'approved' })
              // A character's look changed → invalidate identity caches so SG
              // re-derives the anchor from the edited image (same as on approval).
              if (asset.type === 'character') {
                void pipelineApi.resetCharacterIdentity({
                  projectName, projectPath: localFolderRoot ?? '', characters: [asset.name],
                }).catch(() => {})
              }
            }}
            onDescriptionChange={(text) => patchCharacterFields(asset.id, { visualDescription: text })}
          />
          {/* Phase-2 (D2): the character's looks live with the character, not as loose cards. */}
          {isBaseCharacter && (
            <WardrobePanel
              base={asset}
              variants={assets.filter((a) => a.parentCharacterId === asset.id)}
              scenes={scenes}
              locked={alreadyLocked}
              onAdd={() => addWardrobe(asset)}
              onUpdate={updateWardrobe}
              onRemove={removeWardrobe}
            />
          )}
        </div>
        )})}
      </div>
    </div>
  )
}

// ── Asset Card ─────────────────────────────────────────────────────────────────

interface AssetCardProps {
  asset: Asset
  state: AssetGenState
  isExpanded: boolean
  locked: boolean
  projectName: string
  projectPath: string
  assetRelPath: string
  autoAngles: boolean
  onToggle: () => void
  onGenerate: (feedback: string, straightThrough?: boolean) => void
  onExecuteGenerate: () => void
  onCancelPrompt: () => void
  onResetPrompt: () => void
  onPendingPromptChange: (prompt: string) => void
  onPendingNegativeChange: (neg: string) => void
  onRetryFailed: () => void
  onSelect: (url: string) => void
  onApprove: () => void
  onFeedbackChange: (fb: string) => void
  onRefMediaChange: (rm: ReferenceMedia) => void
  onDescribeRefs: () => Promise<void>
  onUnapprove: () => void
  onStartOver: () => void
  onEditApplied: (edited: { url: string; localPath: string }) => void
  onDescriptionChange: (text: string) => void
}

function AssetCard({ asset, state, isExpanded, locked, projectName, projectPath, assetRelPath, autoAngles, onToggle, onGenerate, onExecuteGenerate, onCancelPrompt, onResetPrompt, onPendingPromptChange, onPendingNegativeChange, onRetryFailed, onSelect, onApprove, onFeedbackChange, onRefMediaChange, onDescribeRefs, onUnapprove, onStartOver, onEditApplied, onDescriptionChange }: AssetCardProps) {
  const isChar = asset.type === 'character'
  const sceneLabels = asset.sceneRefs?.length ? asset.sceneRefs : []
  const [zoomUrl, setZoomUrl] = useState<string | null>(null)   // lightbox: view a board full-size
  const [describing, setDescribing] = useState(false)           // Feature 2: vision read of refs

  // P0.1: filter empty/falsy URLs before rendering — never pass src=""
  // Keep up to 5: [front, side, back, 3q, composite_sheet] for character cards
  // No cap here: the set size is whatever was generated (4/6/8). The legacy
  // .slice(0, 5) came from the dead "4 boards + 1 composite" contract and hid
  // variations 6-8 of larger sets.
  const validUrls = state.imageUrls.filter(Boolean)
  // Prefer the never-expiring disk copy for the selected/approved variation so a
  // reloaded project doesn't show a broken (expired) CDN thumbnail.
  const displaySrc = (url: string) =>
    state.localPath && url === state.selectedUrl ? serveUrl(state.localPath) : url

  const statusBorder = {
    idle:       'border-border',
    generating: 'border-orange/50 shadow-[var(--shadow-neon-orange)]',
    pending:    'border-cyan/40',
    approved:   'border-green/50 shadow-[var(--shadow-neon-green)]',
    error:      'border-red/50',
  }[state.status]

  // `data-status` expone al DOM el estado que hoy sólo vive en el React local de esta
  // vista: `assetStates` se persiste al store en los puntos de commit, así que durante
  // una tanda el localStorage no refleja nada y no hay forma de saber desde fuera si
  // algo sigue renderizando. Sin esto una prueba end-to-end da la tanda por terminada y
  // cierra la página encima de renders ya pagados (medido dos veces, 2026-08-15).
  // Sólo lectura; no cambia comportamiento.
  return (
    <div data-testid={`asset-card-${asset.id}`} data-asset-type={asset.type} data-status={state.status}
      className={cn('rounded-lg border bg-surface transition-shadow duration-200', statusBorder)}>
      {/* Full-size lightbox — click any board's magnifier to see it uncropped */}
      {zoomUrl && (
        <div className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setZoomUrl(null)} data-testid="image-lightbox">
          <img src={zoomUrl} alt="Full size" onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded shadow-2xl cursor-default" />
          <button onClick={() => setZoomUrl(null)} title="Close"
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20">
            <X size={18} />
          </button>
        </div>
      )}
      {/* ── Header row ── */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-elevated/50 transition-colors text-left"
      >
        <span className={cn('w-2 h-2 rounded-full shrink-0', {
          'bg-border':                state.status === 'idle',
          'bg-orange animate-pulse':  state.status === 'generating',
          'bg-cyan':                  state.status === 'pending',
          'bg-green':                 state.status === 'approved',
          'bg-red':                   state.status === 'error',
        })} />

        {createElement(getTypeIcon(asset.type), {
          size: 14,
          className: cn({
            'text-cyan':   asset.type === 'character',
            'text-orange': asset.type === 'prop',
            'text-green':  asset.type === 'environment',
            'text-amber':  asset.type === 'vfx' || asset.type === 'fx',
          }),
        })}

        <span className="text-sm font-semibold text-text-primary flex-1">{asset.name}</span>
        <span className="text-[10px] font-mono text-text-dim hidden sm:block">{asset.id}</span>
        <Badge label={asset.type} color={getTypeBadgeColor(asset.type)} />
        {state.status === 'approved' && <CheckCircle size={14} className="text-green shrink-0" />}
        {state.qcResult && !state.qcResult.passed && <Badge label="QC" color="orange" />}
        {isExpanded ? <ChevronUp size={13} className="text-text-muted shrink-0" /> : <ChevronDown size={13} className="text-text-muted shrink-0" />}
      </button>

      {/* P0.2: smooth expand/collapse via grid-rows transition — no conditional render */}
      <div className={cn(
        'grid transition-[grid-template-rows] duration-300 ease-in-out',
        isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}>
        <div className="overflow-hidden">
          <div className="border-t border-border">
            {/* Asset info */}
            <div className="px-4 py-3 bg-elevated/30 flex flex-col gap-2">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Visual Description</p>
                  {!locked && (
                    <EnhanceButton className="ml-auto" value={asset.visualDescription ?? ''}
                      onEnhanced={onDescriptionChange} field={`${asset.type} visual description for image generation`} />
                  )}
                </div>
                {locked ? (
                  <p className="text-[12px] text-text-primary leading-relaxed">{asset.visualDescription}</p>
                ) : (
                  // Editable so you can change the whole look direction, not just regenerate the same thing.
                  <textarea
                    value={asset.visualDescription ?? ''}
                    onChange={(e) => onDescriptionChange(e.target.value)}
                    rows={3}
                    placeholder="Describe how this asset should look — edit to change the whole direction…"
                    className="w-full bg-elevated border border-border rounded px-3 py-2 text-[12px] text-text-primary leading-relaxed placeholder:text-text-dim focus:outline-none focus:border-cyan/50 focus:ring-1 focus:ring-cyan/20 resize-y"
                  />
                )}
              </div>

              {sceneLabels.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
                    <Clapperboard size={10} className="inline mr-1" />Appears in
                  </p>
                  {sceneLabels.map((s) => (
                    <span key={s} className="px-2 py-0.5 rounded bg-cyan/10 text-cyan text-[10px] font-mono border border-cyan/20">
                      {s}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* ── Image area ── */}
            <div className="p-3">
              {/* Item 0: Prompt Transparency panel — the exact Seedream prompt +
                  negative + refs, editable, shown BEFORE any generation spend. */}
              {state.pendingPrompt !== null && state.status !== 'generating' && !locked && (
                <div className="mb-3" data-testid="prompt-review">
                  <PromptPanel
                    title={isChar ? 'Identity Board Prompt' : 'Seedream Prompt'}
                    autoPrompt={state.autoPrompt}
                    value={state.pendingPrompt}
                    onChange={onPendingPromptChange}
                    negative={state.pendingNegative}
                    onNegativeChange={onPendingNegativeChange}
                    refs={[
                      ...state.refMedia.images.map((img) => ({ url: img.url, label: img.role })),
                      ...(state.pendingFeedback && state.selectedUrl
                        ? [{ url: state.selectedUrl, label: 'selected variation (regen seed)' }]
                        : []),
                    ]}
                    sentPrompt={state.lastPrompt}
                    generateLabel={`Generate ${isChar ? 'Identity Boards' : 'Variations'}`}
                    onGenerate={onExecuteGenerate}
                    onReset={onResetPrompt}
                    onCancel={onCancelPrompt}
                    busy={state.preparing}
                    testId="prompt-review-panel"
                  />
                </div>
              )}

              {/* A VOICE HAS NO PICTURE. This asset speaks and is never seen — a phone
                  voice, a PA, a narrator — so its card carries the voice lock and nothing
                  else: no prompt, no variations, no approve-an-image row. Typed
                  'character' instead (as the writer did for BLACK MIRROR's kidnapper) it
                  would be drawn, paid for, and sent to the board as a person standing in
                  the room. Placed ahead of the image branches so none of them can run. */}
              {asset.type === 'voice' ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[11px] text-text-muted">
                    Heard, never seen — this speaker has no image. Lock the voice it speaks in;
                    it is used for every line it has.
                  </p>
                  <VoicePicker character={asset.name} />
                </div>
              ) : state.status === 'generating' ? (
                <div className="flex flex-col gap-3">
                  {/* Progressive arrival: each variation shows the moment its slot lands */}
                  {validUrls.length > 0 && (
                    <div className="grid grid-cols-4 gap-2" data-testid="progressive-grid">
                      {validUrls.map((url, i) => (
                        <div key={i} className={cn('rounded overflow-hidden border-2 border-border bg-elevated', isChar ? 'aspect-[4/3]' : 'aspect-video')}>
                          <img src={url} alt={`Variation ${i + 1}`} className="w-full h-full object-contain" />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-center gap-3 py-4 text-orange text-sm">
                    <span className="w-5 h-5 border-2 border-orange border-t-transparent rounded-full animate-spin" />
                    Generating with Seedream 5.0…
                    {validUrls.length > 0 && (
                      <span className="text-[11px] text-text-muted">
                        {validUrls.length}{state.expectedCount ? `/${state.expectedCount}` : ''} done — finishing the rest
                      </span>
                    )}
                  </div>
                </div>
              ) : state.status === 'error' ? (
                /* P0.3: inline error display with Retry */
                <div className="flex items-start gap-3 p-4 bg-red/5 rounded-lg border border-red/20">
                  <AlertTriangle size={16} className="text-red shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-red font-semibold mb-1">Generation failed</p>
                    {state.errorMsg && (
                      <p className="text-[11px] text-text-muted break-words">{state.errorMsg}</p>
                    )}
                  </div>
                  <Button variant="danger" size="sm" icon={<RefreshCw size={12} />}
                    loading={state.preparing}
                    onClick={() => onGenerate('')} className="shrink-0">
                    Retry
                  </Button>
                </div>
              ) : validUrls.length > 0 ? (
                /* P0.2 + P0.3: variation grid — same layout for ALL asset types */
                <div className="flex flex-col gap-3">
                  {state.status === 'approved' && state.localPath ? (
                    /* Opción A: once approved the choice is final (selection is
                       disabled) and the unapproved variations are CDN-only — gone
                       after ~24h. Show only the saved image, served from disk so
                       it never breaks on reload. */
                    <div className="group relative rounded-lg overflow-hidden border-2 border-green/40 bg-elevated cursor-zoom-in"
                      data-testid="approved-preview" onClick={() => setZoomUrl(serveUrl(state.localPath!))}>
                      <img
                        src={serveUrl(state.localPath)}
                        alt={`${asset.name} — approved`}
                        className={cn('w-full object-contain', isChar ? 'max-h-[420px]' : 'aspect-video')}
                      />
                      <span className="absolute top-1.5 right-1.5 p-1 rounded bg-bg/70 text-text-muted group-hover:text-cyan opacity-0 group-hover:opacity-100 transition-opacity">
                        <Maximize2 size={13} />
                      </span>
                    </div>
                  ) : (
                  <div className="grid grid-cols-4 gap-2">
                    {validUrls.map((url, i) => (
                      <div key={i} className="flex flex-col gap-1">
                        {/* Clickable thumbnail — clicking selects this variation */}
                        <button
                          onClick={() => setZoomUrl(displaySrc(url))}
                          title="Click to view full size"
                          className={cn(
                            'group relative rounded overflow-hidden border-2 transition-all w-full bg-elevated cursor-zoom-in',
                            // Show the WHOLE board (face row + body row) — object-contain, not
                            // cover, so nothing is cropped. Taller box for character sheets.
                            isChar ? 'aspect-[4/3]' : 'aspect-video',
                            state.selectedUrl === url
                              ? 'border-cyan shadow-[var(--shadow-neon-cyan)]'
                              : 'border-border hover:border-cyan/50',
                          )}
                        >
                          {/* P0.1: src is always a non-empty string here (filtered above).
                              Selected/approved variation serves from disk (never expires);
                              onError falls back to the disk copy if a CDN link 404s. */}
                          <img
                            src={displaySrc(url)}
                            alt={`Variation ${i + 1}`}
                            className="w-full h-full object-contain"
                            onError={(e) => {
                              if (state.localPath && url === state.selectedUrl) {
                                const fb = serveUrl(state.localPath)
                                if (e.currentTarget.src !== fb) e.currentTarget.src = fb
                              }
                            }}
                          />
                          {/* Clicking the board opens the full-size lightbox; the magnifier is
                              just an affordance. Select is the button below. */}
                          <span className="absolute top-1 right-1 p-1 rounded bg-bg/60 text-text-muted group-hover:text-cyan transition-colors">
                            <Maximize2 size={12} />
                          </span>
                          {state.selectedUrl === url && (
                            <div className="absolute inset-0 flex items-center justify-center bg-cyan/10 pointer-events-none">
                              <CheckCircle size={18} className="text-cyan drop-shadow-lg" />
                            </div>
                          )}
                        </button>
                        <span className="text-[9px] text-text-muted text-center">
                          {isChar ? `Board ${i + 1}` : `Variation ${i + 1}`}
                        </span>
                        {/* P0.3: Select button per variation for ALL asset types */}
                        {state.status !== 'approved' && !locked && (
                          <Button
                            variant={state.selectedUrl === url ? 'approve' : 'ghost'}
                            size="sm"
                            onClick={() => onSelect(url)}
                            className="text-[9px] h-6 px-2"
                          >
                            {state.selectedUrl === url ? '✓ Selected' : 'Select'}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  )}

                  {/* Item 0: read-only record of what produced these images */}
                  {state.lastPrompt && state.pendingPrompt === null && (
                    <details className="px-1" data-testid="sent-prompt-record">
                      <summary className="text-[9px] font-semibold text-text-muted uppercase tracking-widest cursor-pointer hover:text-text-primary transition-colors">
                        Sent prompt{state.lastAutoPrompt && state.lastPrompt !== state.lastAutoPrompt ? ' (user-edited)' : ''}
                      </summary>
                      <pre className="mt-1.5 p-2 bg-elevated/60 rounded border border-border text-[10px] font-mono text-text-muted whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                        {state.lastPrompt}
                        {state.lastNegative ? `\n\n— negative: ${state.lastNegative}` : ''}
                      </pre>
                    </details>
                  )}

                  {/* Issue 3: failed variation slots — explicit per-slot errors + retry,
                      never a partial set presented as complete */}
                  {state.slotErrors.some(Boolean) && !locked && (
                    <div className="flex flex-col gap-1.5 p-3 bg-amber/5 rounded-lg border border-amber/30" data-testid="variation-errors">
                      {state.slotErrors.map((err, i) => err ? (
                        <p key={i} className="text-[10px] text-amber">
                          <AlertTriangle size={10} className="inline mr-1" />
                          {/* `i` IS the slot index — slotErrors keeps a null per succeeded
                              slot (line ~475), so the variation number is i+1. The old
                              `imageUrls.length + i + 1` added the count of SUCCEEDED slots
                              (imageUrls is compacted) to a slot index, so a 4-slot set that
                              failed slots 3 and 4 reported "Variation 5" and "Variation 6". */}
                          Variation {i + 1} failed: {err.slice(0, 140)}
                        </p>
                      ) : null)}
                      <Button variant="regenerate" size="sm" icon={<RefreshCw size={11} />}
                        onClick={onRetryFailed} className="self-start">
                        Retry failed ({state.slotErrors.filter(Boolean).length})
                      </Button>
                    </div>
                  )}

                  {/* Approve row — advisory-with-override gate (matches stages 1/2/4) */}
                  {state.status === 'pending' && state.selectedUrl && !locked && (
                    <div className="flex flex-col gap-1.5">
                      {state.qcResult?.passed === false && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-orange/40 bg-orange/5 text-[11px]">
                          <AlertTriangle size={12} className="text-orange shrink-0" />
                          <span className="text-orange font-semibold">
                            {state.qcResult.persona ?? 'Art Director'} flagged issues
                          </span>
                          <span className="text-text-muted">— override to approve anyway</span>
                        </div>
                      )}
                      <Button
                        variant={state.qcResult?.passed === false ? 'regenerate' : 'approve'}
                        size="sm"
                        icon={state.qcResult?.passed === false
                          ? <AlertTriangle size={12} />
                          : <CheckCircle size={12} />}
                        onClick={onApprove}
                        className="w-full"
                      >
                        {state.qcResult?.passed === false
                          ? `Override & Approve ${isChar ? 'Identity Board' : 'Variation'}`
                          : `Approve ${isChar ? 'Identity Board' : 'Selected Variation'}`}
                      </Button>
                    </div>
                  )}

                  {state.status === 'approved' && (
                    <div className="flex flex-col gap-2 px-1">
                      <div className="flex items-center gap-1.5 text-green text-[11px] font-semibold flex-wrap">
                        <CheckCircle size={13} /> Approved
                        {/* Per-asset actions stay available even when the STAGE is
                            locked (autopilot auto-approve / manual lock): editing is
                            non-destructive (versioned) and Un-approve just re-opens
                            THIS asset — it must never be gated away by the stage lock. */}
                        <div className="ml-auto flex items-center gap-1">
                          <Button variant="ghost" size="sm" icon={<RefreshCw size={11} />}
                            onClick={() => onGenerate('')} className="text-[10px]">
                            Regenerate
                          </Button>
                          <Button variant="ghost" size="sm"
                            onClick={onUnapprove} className="text-[10px] text-amber"
                            title="Un-approve — go back to choosing a variation">
                            Un-approve
                          </Button>
                          <Button variant="ghost" size="sm" icon={<Square size={10} />}
                            onClick={onStartOver} className="text-[10px] text-text-muted"
                            title="Start over — clear this asset and generate from scratch">
                            Start over
                          </Button>
                        </div>
                      </div>
                      {/* P5: version history + revert */}
                      <VersionHistoryPanel
                        assetRelPath={assetRelPath}
                        currentUrl={state.selectedUrl}
                        onReverted={() => {}}
                        projectName={projectName}
                      />
                      {/* Seedream 5.0 Pro editor — markup + reference images + instruction.
                          Prefer a disk path (headshot/local) so the canvas loads reliably. */}
                      {(state.localPath || state.headshotLocalPath || state.selectedUrl) && (
                        <EditWithProPanel
                          asset={asset}
                          baseImage={state.localPath || state.headshotLocalPath || state.selectedUrl!}
                          assetRelPath={assetRelPath}
                          projectName={projectName}
                          projectPath={projectPath}
                          // Edit-with-Pro is non-destructive (new version) — available
                          // on any approved asset, even when the stage is locked.
                          disabled={false}
                          onApplied={onEditApplied}
                        />
                      )}
                      {/* P7: environment angles + top-view map — only for environment assets */}
                      {asset.type === 'environment' && state.selectedUrl && (
                        <EnvironmentAnglesPanel
                          assetName={asset.name}
                          description={asset.visualDescription}
                          approvedUrl={state.selectedUrl}
                          autoStart={autoAngles}
                        />
                      )}
                      {/* Voice lock — only for characters (reused for every line they speak).
                          The approved portrait's disk path enables "design from portrait". */}
                      {asset.type === 'character' && (
                        <VoicePicker character={asset.name} portraitPath={state.headshotLocalPath || state.localPath || undefined} />
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* No images yet — show reference panel + generate button */
                <div className="flex flex-col gap-3 p-3">
                  <ReferenceMediaPanel
                    value={state.refMedia}
                    onChange={onRefMediaChange}
                    maxImages={6}
                    disabled={locked}
                    defaultOpen
                  />
                  {/* Feature 2: read the character's reference image(s) with vision and
                      fill appearance / hair / wardrobe / shoes / props → feeds generation. */}
                  {isChar && state.refMedia.images.length > 0 && !locked && (
                    <div className="flex flex-col gap-1">
                      <Button variant="ghost" size="sm" icon={<Sparkles size={12} />} loading={describing}
                        onClick={async () => { setDescribing(true); try { await onDescribeRefs() } finally { setDescribing(false) } }}
                        className="w-full border border-violet/40 text-violet">
                        {describing ? 'Reading references…' : 'Describe from references → fill fields'}
                      </Button>
                      {(asset.wardrobe || asset.hairstyle || asset.shoes) && (
                        <div className="text-[10px] text-text-muted leading-relaxed px-1">
                          {asset.wardrobe && <div><span className="text-text">Wardrobe:</span> {asset.wardrobe}</div>}
                          {asset.hairstyle && <div><span className="text-text">Hair:</span> {asset.hairstyle}</div>}
                          {asset.shoes && <div><span className="text-text">Shoes:</span> {asset.shoes}</div>}
                        </div>
                      )}
                    </div>
                  )}
                  <Button variant="primary" size="sm" icon={<Sparkles size={12} />}
                    loading={state.preparing}
                    onClick={() => onGenerate('')} disabled={locked || state.pendingPrompt !== null} className="w-full">
                    {state.preparing ? 'Writing prompt with Claude…' : `Generate ${asset.name}`}
                    {state.refMedia.images.length > 0 && (
                      <span className="ml-1.5 text-[9px] opacity-70">
                        +{state.refMedia.images.length} ref
                      </span>
                    )}
                  </Button>
                </div>
              )}
            </div>

            {/* P0.2: Reference media + Director notes — always below image area, never clipped */}
            {!locked && validUrls.length > 0 && (
              <div className="px-4 pb-4 flex flex-col gap-3 border-t border-border pt-3">
                <ReferenceMediaPanel
                  value={state.refMedia}
                  onChange={onRefMediaChange}
                  maxImages={4}
                  disabled={locked}
                />

                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <label className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                      Director Notes for Regeneration
                      {state.selectedUrl && (
                        <span className="ml-2 text-cyan normal-case font-normal">
                          (will seed from selected variation)
                        </span>
                      )}
                    </label>
                    <EnhanceButton className="ml-auto" value={state.feedback}
                      onEnhanced={onFeedbackChange} field="director note for image regeneration"
                      context={`${asset.name}: ${asset.visualDescription ?? ''}`} />
                  </div>
                  <div className="flex gap-2">
                    <textarea
                      value={state.feedback}
                      onChange={(e) => onFeedbackChange(e.target.value)}
                      placeholder={`e.g. Make ${asset.name} look more weathered…`}
                      rows={2}
                      className={cn(
                        'flex-1 bg-elevated border border-border rounded px-3 py-2',
                        'text-xs text-text-primary placeholder:text-text-dim',
                        'focus:outline-none focus:border-orange/50 focus:ring-1 focus:ring-orange/20',
                        'resize-none transition-colors'
                      )}
                    />
                    <Button variant="regenerate" size="sm" icon={<RefreshCw size={12} />}
                      loading={state.preparing || state.status === 'generating'}
                      onClick={() => onGenerate(state.feedback, true)} className="shrink-0 self-start mt-0.5"
                      data-testid="regen-button">
                      Regen
                      {state.refMedia.images.length > 0 && (
                        <span className="ml-1 text-[9px] opacity-70">
                          +{state.refMedia.images.length}
                        </span>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Claude QC result */}
            {state.qcResult && (
              <div className="px-3 pb-3 border-t border-border pt-2">
                <QCActionCard
                  qcResult={state.qcResult}
                  context={asset.name}
                  isRegenerating={state.status === 'generating' || state.preparing}
                  onRegenerate={(notes) => onGenerate(notes, true)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Seedream 5.0 Pro edit ─────────────────────────────────────────────────────
// Trigger that opens the full Pro editor (markup canvas + reference images +
// instruction + enhance) for an approved asset. Every edit is saved as a NEW
// version (non-destructive) — promote it from Version History above.
function EditWithProPanel({
  asset, baseImage, assetRelPath, projectName, projectPath, disabled, onApplied,
}: {
  asset: Asset
  baseImage: string
  assetRelPath: string
  projectName: string
  projectPath: string
  disabled?: boolean
  onApplied: (edited: { url: string; localPath: string }) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} disabled={disabled}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded border border-violet/40 text-[11px] font-semibold text-violet hover:bg-violet/10 disabled:opacity-40">
        <Wand2 size={13} /> Edit with Pro
        <span className="ml-auto text-[10px] text-text-muted font-normal">markup · refs · instruction</span>
      </button>
      {open && (
        <ProImageEditor
          onClose={() => setOpen(false)}
          title={asset.name}
          baseImage={baseImage}
          assetRelPath={assetRelPath}
          projectName={projectName}
          projectPath={projectPath}
          onApplied={onApplied}
        />
      )}
    </>
  )
}
