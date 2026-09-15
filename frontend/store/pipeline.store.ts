'use client'

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist, createJSONStorage } from 'zustand/middleware'
import { nanoid } from 'nanoid'
import type {
  StageId,
  StageStatus,
  StageSlice,
  QCResult,
  StageVersion,
  ProjectStyle,
  GalleryItem,
  TrayItem,
  GeneratedShot,
  ShotVersion,
} from '@/lib/types/pipeline.types'
import { DEFAULT_STYLE } from '@/lib/styles'
import { migrateStagesToSegments } from '@/lib/segments'

// Editing stage N marks all stages > N as invalidated (stale but preserved)
const DOWNSTREAM: Record<StageId, StageId[]> = {
  1: [2, 3, 4, 5, 6],
  2: [3, 4, 5, 6],
  3: [4, 5, 6],
  4: [5, 6],
  5: [6],
  6: [],
}

const MAX_VERSIONS = 20

export type ProjectType = 'tv' | 'film' | 'vfx_shot'

export interface ProjectStructure {
  // TV
  season?: string
  episode?: string
  // TV + Film
  scene?: string
  // Film
  act?: string
  // VFX
  sequence?: string
  shot?: string
}

export interface FinalCutEdit {
  order: string[]   // sequence shotIds in order
  /** Timeline clips that are NOT canonical Stage-5 shots (e.g. Extend continuations) —
   *  persisted whole so they survive a reload (their id isn't in the SG shot list). */
  extraClips?: GeneratedShot[]
  clips: Record<string, { inPoint: number; outPoint: number | null; transitionIn: { type: string; dur: number } | null; volume: number; fadeIn: number; fadeOut: number }>
  audio: Array<{
    id: string; path: string; name: string; srcDuration: number; timelineStart: number
    inPoint: number; outPoint: number; volume: number; fadeIn: number; fadeOut: number
    /** Sidechain-duck this clip under the dialogue on export — a music bed yes, an
     *  imported voice-over or spot effect no. Optional + read-time defaulted (to true,
     *  the mix an older edit already shipped with) so a pre-duck persisted edit stays
     *  valid → migrate() stays a no-op. */
    duck?: boolean
  }>
  /** 5K: global master/bus gain (1 = unity). Optional + read-time defaulted so a
   *  pre-5K persisted edit stays valid (no migrate needed). */
  master?: number
  /** 5C: V2 overlay track — re-take clips mounted ON TOP of V1 (not replacing it),
   *  positioned like an audio clip but carrying video. Optional + read-time defaulted
   *  so a pre-5C persisted edit stays valid → migrate() stays a no-op (version 5). */
  overlays?: Array<{
    id: string; sourceShotId: string; shot: GeneratedShot; timelineStart: number
    inPoint: number; outPoint: number; volume: number; fadeIn: number; fadeOut: number
  }>
}

interface PipelineStore {
  projectId: string
  projectName: string
  projectType: ProjectType
  projectStructure: ProjectStructure
  activeStage: StageId
  stages: Record<StageId, StageSlice>
  style: ProjectStyle
  targetDurationSecs: number   // desired final cut length; drives script + breakdown prompts
  // Project frame shape — exact pixels for Seedream keyframes, ratio for Seedance
  aspectRatio: '16:9' | '9:16' | '1:1'
  // Final render/export resolution. 4k = Seedance 2.0 base only → native 10-bit HEVC.
  outputResolution: '720p' | '1080p' | '4k'
  // Which Seedance model renders the film. Default 2.5: it is the only one that can
  // generate up to 30 s in a single take and accept a 50-material reference budget
  // (30 images / 10 videos / 10 audio), which is what keeps continuity — and voices —
  // from breaking across a scene. The cost is its 1080p ceiling: 4k is base 2.0 only,
  // so the picker WARNS rather than blocks and the user chooses.
  videoModel: 'v25' | 'base' | 'fast' | 'mini'
  // P5b: 'auto' auto-approves items whose QC passes (fewer manual clicks); 'manual' = always review
  gateMode: 'manual' | 'auto'
  // P5c: Autopilot run state — transient, never persisted (a reload must not resume a run)
  autopilot: { running: boolean; phase: string; error: string | null; concept: string }
  // The story spine is the document the shot list is written FROM, and until now it only
  // came into being as a side effect INSIDE the breakdown — approving it afterwards is not
  // approving it. Approving the script now REQUESTS a derivation, and this flag is how
  // stage 1 says so to a panel that lives in stage 2 and is not mounted yet.
  //
  // Transient like `autopilot`, and for the same reason: it is a request, not a fact about
  // the project. A reload that replayed it would spend a Claude pass nobody asked for.
  pendingSpineDerive: boolean
  localFolderRoot: string | null
  // Stage 4 shot approvals — store-level so they survive navigation (was component useState)
  approvedShotIds: string[]
  // P3: Studio gallery — generations persist across navigation (was component useState)
  gallery: GalleryItem[]
  // P3b: shared reference tray — references picked from the gallery, reusable in
  // any stage's ReferenceMediaPanel (bridges Studio ↔ pipeline, which aren't co-visible)
  referenceTray: TrayItem[]
  // Stage 6 final-cut edit — sequence order, per-clip settings, and audio clips.
  // Store-level so they survive navigating away from Stage 6 (was component useState).
  finalCutEdit: FinalCutEdit | null
  // Item 4F: per-shot take history — normalized maps by id, kept TOP-LEVEL (NOT
  // inside the Stage-5 version snapshot). A take must survive every
  // commitVersion(5,{shots}) — which replaces the version data with {shots} only —
  // and any ring-buffer rollback; storing takes in the snapshot would silently drop
  // them. Maps-by-id (never nested in shots[]) so a deep store array can't trip the
  // Phase-0 render loops.
  shotVersions: Record<string, ShotVersion[]>       // shotId → takes, oldest→newest
  shotSelectedVersion: Record<string, string>       // shotId → selected take id
  /** Las referencias que el DIRECTOR eligió a mano para un plano, por shotId.
   *
   *  Vivían en un `useState` de la vista de la etapa 5, así que componer las referencias
   *  de un plano y recargar la página las perdía — un modo manual cuyo trabajo no
   *  sobrevive a un F5 no es utilizable. Opcional y con default en lectura, para que
   *  `migrate()` siga siendo un no-op (ver el comentario de v5); `partialize` ya quita las
   *  data: URI, así que una imagen pegada en crudo no infla localStorage. */
  shotRefMedia?: Record<string, ShotRefMedia>
  /** Las referencias que el DIRECTOR eligió para el TABLERO de un plano, por shotId.
   *
   *  Campo aparte de `shotRefMedia` a propósito, aunque la clave sea la misma: éstas son
   *  referencias de imagen para Seedream (el tablero de la etapa 4) y aquéllas de vídeo
   *  para Seedance (el render de la etapa 5). Un mismo plano puede querer cosas distintas
   *  en cada sitio, y compartir el campo haría que tocar una etapa cambiara la otra en
   *  silencio. Mismo contrato: opcional y con default en lectura, para que `migrate()`
   *  siga siendo un no-op. */
  boardRefMedia?: Record<string, ShotRefMedia>
  // F2: when the snapshot this state came from was WRITTEN (ms epoch, stamped by
  // partializeState on every save). Persisted, so after a reload it holds the time of
  // the last successful localStorage write — the only way boot can tell a stale browser
  // copy (a quota-failed write leaves the PREVIOUS entry in place, see the storage
  // adapter below) from the newer copy ProjectAutosave put on disk.
  savedAt: number

  setProjectName: (name: string) => void
  setProjectMeta: (type: ProjectType, structure: ProjectStructure) => void
  approveShot: (shotId: string) => void
  unapproveShot: (shotId: string) => void
  addGalleryItem: (item: GalleryItem) => void
  removeGalleryItem: (id: string) => void
  clearGallery: () => void
  addToTray: (item: TrayItem) => void
  removeFromTray: (id: string) => void
  clearTray: () => void
  setStyle: (style: ProjectStyle) => void
  setTargetDuration: (secs: number) => void
  setAspectRatio: (ar: '16:9' | '9:16' | '1:1') => void
  setOutputResolution: (r: '720p' | '1080p' | '4k') => void
  setVideoModel: (m: 'v25' | 'base' | 'fast' | 'mini') => void
  setGateMode: (mode: 'manual' | 'auto') => void
  startAutopilot: (concept: string) => void
  stopAutopilot: () => void
  /** Ask for a spine to be derived as soon as the Story panel can do it (stage-1 approval). */
  requestSpineDerive: () => void
  /** Consume the request. Called by whoever acts on it, BEFORE the request goes out. */
  clearSpineDerive: () => void
  setAutopilotPhase: (phase: string) => void
  setAutopilotError: (error: string | null) => void
  setLocalFolderRoot: (root: string) => void
  setFinalCutEdit: (edit: FinalCutEdit) => void
  goToStage: (id: StageId) => void

  // Versioning
  commitVersion: <T>(stageId: StageId, data: T, qcResult?: QCResult) => string
  approveVersion: (stageId: StageId, versionId: string, notes?: string) => void
  rollbackToVersion: (stageId: StageId, versionId: string) => void
  /** Clear the stale-upstream flag, keeping this stage's existing output. */
  acknowledgeUpstream: (stageId: StageId) => void

  // Status
  setStageStatus: (stageId: StageId, status: StageStatus) => void

  // In-place data patch (saves generated state without creating a new version)
  patchStageData: (stageId: StageId, patch: Record<string, unknown>) => void
  // Item 4F: append a rendered take to a shot's normalized history; select a take.
  addShotVersion: (shotId: string, take: Omit<ShotVersion, 'id' | 'createdAt'>) => string
  setSelectedShotVersion: (shotId: string, versionId: string) => void
  /** Guardar las referencias que el director eligió para un plano. Ver `shotRefMedia`. */
  setShotRefMedia: (shotId: string, media: ShotRefMedia) => void
  /** Ídem para el tablero. Ver `boardRefMedia`. */
  setBoardRefMedia: (shotId: string, media: ShotRefMedia) => void

  // Reset
  resetPipeline: () => void

  // Load a saved project snapshot (from disk) — replaces the persisted slices
  loadProjectState: (snapshot: Partial<ProjectSnapshot>) => void
}

// The persisted shape (matches `partialize`) — what a project snapshot on disk
// holds and what loadProjectState restores.
/** Lo que `ReferenceMediaPanel` produce, tipado aquí para que el store no dependa de un
 *  componente. Estructural a propósito: si el panel gana un campo, esto no se rompe. */
export interface ShotRefMedia {
  images: Array<{ url: string; role?: string; weight?: number }>
  videos: Array<{ url: string; motion?: string }>
  audio: { url: string } | null
  /** DERIVED references the director took out of this shot — "not the jar in SHOT_019".
   *  Keys are the asset folder (or the label when there is none), so the choice survives
   *  a re-approved version of the asset. OPTIONAL + read-time defaulted: older snapshots
   *  have no such field and `migrate()` stays a no-op. */
  excluded?: string[]
}

export type ProjectSnapshot = Pick<
  PipelineStore,
  'projectId' | 'projectName' | 'projectType' | 'projectStructure' | 'stages'
  | 'style' | 'targetDurationSecs' | 'aspectRatio' | 'outputResolution' | 'videoModel' | 'gateMode'
  | 'localFolderRoot' | 'approvedShotIds' | 'gallery' | 'referenceTray'
  | 'shotVersions' | 'shotSelectedVersion' | 'shotRefMedia' | 'boardRefMedia' | 'finalCutEdit' | 'savedAt'
>

const makeInitialStage = (): StageSlice => ({
  status: 'idle',
  activeVersionId: null,
  versions: [],
  isDirty: false,
})

const makeInitialStages = (): Record<StageId, StageSlice> => ({
  1: makeInitialStage(),
  2: makeInitialStage(),
  3: makeInitialStage(),
  4: makeInitialStage(),
  5: makeInitialStage(),
  6: makeInitialStage(),
})

/**
 * The persisted subset of the store — the ONE definition of what a project
 * snapshot is. Used by the persist middleware AND by ProjectAutosave, which
 * writes the same shape to disk; `loadProjectState` consumes it on Open. Keep
 * them identical: a snapshot that differs between the two sources is how a
 * reopened project silently loses work.
 *
 * Strips `data:` URIs from version data — composite character sheets can be
 * 100-200KB of base64 each and overflow the 5-10MB localStorage limit, which
 * surfaced as a truncated JSON string on the next page load.
 */
export const partializeState = (s: PipelineStore): ProjectSnapshot => {
  const stripDataUris = (obj: unknown): unknown => {
    if (typeof obj === 'string') return obj.startsWith('data:') ? '' : obj
    if (Array.isArray(obj)) return obj.map(stripDataUris)
    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, stripDataUris(v)])
      )
    }
    return obj
  }
  return {
    projectId: s.projectId,
    projectName: s.projectName,
    projectType: s.projectType,
    projectStructure: s.projectStructure,
    stages: stripDataUris(s.stages) as typeof s.stages,
    style: s.style,
    targetDurationSecs: s.targetDurationSecs,
    aspectRatio: s.aspectRatio,
    outputResolution: s.outputResolution,
    videoModel: s.videoModel,
    gateMode: s.gateMode,
    localFolderRoot: s.localFolderRoot,
    approvedShotIds: s.approvedShotIds,
    gallery: s.gallery,
    referenceTray: s.referenceTray,
    finalCutEdit: s.finalCutEdit,
    shotVersions: s.shotVersions,               // Item 4F: take history (path/URL strings only, no data: URIs)
    shotSelectedVersion: s.shotSelectedVersion,
    shotRefMedia: s.shotRefMedia,               // referencias elegidas a mano, por plano
    boardRefMedia: s.boardRefMedia,             // ídem, pero para el tablero de la etapa 4
    // Stamped HERE, not read off the store, so every writer (persist middleware and
    // ProjectAutosave) dates its own copy with the same clock. It is deliberately NOT
    // mutated into the store: doing that on partialize would re-enter persist on every
    // write. The store's `savedAt` therefore keeps the value it was rehydrated with —
    // i.e. the age of the browser copy — which is exactly what boot compares to disk.
    savedAt: Date.now(),
  }
}

/**
 * F2b — the last-opened project folder, in its OWN tiny localStorage key.
 *
 * `localFolderRoot` is part of the persisted SNAPSHOT, so boot-from-disk (ProjectAutosave)
 * could only ever fire when that snapshot survived — i.e. it recovered a STALE or PRUNED
 * browser copy but never an ABSENT one, which is half the reason it exists. A snapshot that
 * was never written (fresh browser), that the user cleared, or whose very first write blew
 * the quota leaves NO root at all, and boot returned early with a complete project sitting
 * on disk. This key holds a path — a few bytes — and is written on its own, so the multi-MB
 * snapshot's quota failures and the ring-buffer prune can never take it down with them.
 *
 * Deliberately NOT part of `partializeState`: it must survive exactly the writes that fail.
 */
const PROJECT_ROOT_KEY = 'takeone-project-root-v1'

/** Mirror the active project folder into the standalone key (null = no project → forget it,
 *  so a Reset can't be undone by the next boot). Never throws: SSR has no localStorage, and
 *  a private-mode/quota refusal just means boot falls back to the snapshot's copy. */
export const rememberProjectRoot = (root: string | null): void => {
  try {
    if (root) localStorage.setItem(PROJECT_ROOT_KEY, root)
    else localStorage.removeItem(PROJECT_ROOT_KEY)
  } catch { /* non-fatal — the snapshot still carries the root when it survives */ }
}

/** The last-opened project folder, or null. Read at boot ONLY when the store has no root. */
export const recallProjectRoot = (): string | null => {
  try { return localStorage.getItem(PROJECT_ROOT_KEY) } catch { return null }
}

/**
 * F2c — has this browser EVER persisted this app? Either key counts, including a
 * snapshot that currently holds no project.
 *
 * The boot fallback that asks the BACKEND which project was last worked on (see
 * ProjectAutosave) may only run for a browser holding NOTHING of ours: cleared site
 * data, a fresh browser, incognito. "No root" is a weaker test and the wrong one — a
 * rootless snapshot is a browser that has been here and deliberately has no project
 * open right now (a Reset, a project cleared on purpose), and re-opening one behind the
 * user's back is precisely what that fallback must never do. The persist key is the one
 * configured as `name` below; it is spelled out in both places already.
 */
export const hasLocalProjectMemory = (): boolean => {
  try {
    return localStorage.getItem('takeone-pipeline-v1') != null
        || localStorage.getItem(PROJECT_ROOT_KEY) != null
  } catch { return false }   // no localStorage at all (SSR) → nothing remembered
}

/**
 * Quota rescue: drop every stage version EXCEPT the active one (and any the user
 * ever approved) from an already-serialized snapshot, so a long-form project that
 * outgrew localStorage still persists its live state instead of nothing.
 *
 * A 500-shot episode carries a 20-entry ring buffer per stage (MAX_VERSIONS), i.e.
 * ~20 full copies of the breakdown/boards — tens of MB against a 5-10MB quota. The
 * previous behaviour on QuotaExceededError was `removeItem(name)`, which deleted the
 * WHOLE project from the browser with only a console.warn. History still lives on
 * disk (ProjectAutosave), so pruning the browser copy is lossless for the user.
 *
 * Returns null when the payload can't be parsed or nothing could be pruned.
 */
const pruneSnapshotForQuota = (value: string): string | null => {
  try {
    const doc = JSON.parse(value) as { state?: ProjectSnapshot }
    const stages = doc?.state?.stages
    if (!stages) return null
    let dropped = 0
    for (const stage of Object.values(stages) as StageSlice[]) {
      const versions = stage?.versions
      if (!Array.isArray(versions) || versions.length <= 1) continue
      const keep = versions.filter((v) => v.id === stage.activeVersionId || v.approved)
      dropped += versions.length - keep.length
      stage.versions = keep.length ? keep : versions.slice(-1)
    }
    return dropped > 0 ? JSON.stringify(doc) : null
  } catch {
    return null
  }
}

export const usePipelineStore = create<PipelineStore>()(
  persist(
    immer((set) => ({
      projectId: nanoid(),
      projectName: 'UNTITLED',
      projectType: 'tv' as ProjectType,
      projectStructure: { season: '01', episode: '01', scene: '01' },
      activeStage: 1 as StageId,
      stages: makeInitialStages(),
      style: DEFAULT_STYLE,
      targetDurationSecs: 60,   // default: 1-minute short
      aspectRatio: '16:9' as const,
      outputResolution: '4k' as const,
      videoModel: 'v25' as const,
      gateMode: 'manual' as const,
      autopilot: { running: false, phase: '', error: null, concept: '' },
      pendingSpineDerive: false,
      localFolderRoot: null,
      approvedShotIds: [],
      gallery: [],
      referenceTray: [],
      finalCutEdit: null,
      shotVersions: {},           // Item 4F: per-shot take history (top-level, survives rollbacks)
      shotRefMedia: {},           // referencias que el director eligió por plano
      boardRefMedia: {},          // ídem para el tablero de ese plano
      shotSelectedVersion: {},
      savedAt: 0,                 // F2: 0 = never written (or written by a pre-F2 build)

      setProjectName: (name) =>
        set((s) => { s.projectName = name }),

      setFinalCutEdit: (edit) =>
        set((s) => { s.finalCutEdit = edit }),

      addGalleryItem: (item) =>
        set((s) => {
          // Newest first; dedupe by id; cap to keep localStorage bounded
          s.gallery = [item, ...s.gallery.filter((g) => g.id !== item.id)].slice(0, 60)
        }),

      removeGalleryItem: (id) =>
        set((s) => { s.gallery = s.gallery.filter((g) => g.id !== id) }),

      clearGallery: () =>
        set((s) => { s.gallery = [] }),

      addToTray: (item) =>
        set((s) => {
          // dedupe by url; newest first; cap
          s.referenceTray = [item, ...s.referenceTray.filter((t) => t.url !== item.url)].slice(0, 24)
        }),

      removeFromTray: (id) =>
        set((s) => { s.referenceTray = s.referenceTray.filter((t) => t.id !== id) }),

      clearTray: () =>
        set((s) => { s.referenceTray = [] }),

      approveShot: (shotId) =>
        set((s) => {
          if (!s.approvedShotIds.includes(shotId)) s.approvedShotIds.push(shotId)
        }),

      unapproveShot: (shotId) =>
        set((s) => {
          s.approvedShotIds = s.approvedShotIds.filter((id) => id !== shotId)
        }),

      setProjectMeta: (type, structure) =>
        set((s) => { s.projectType = type; s.projectStructure = structure }),

      setStyle: (style) =>
        set((s) => { s.style = style }),

      setTargetDuration: (secs) =>
        set((s) => { s.targetDurationSecs = secs }),

      setAspectRatio: (ar) =>
        set((s) => { s.aspectRatio = ar }),

      setOutputResolution: (r) =>
        set((s) => { s.outputResolution = r }),

      setVideoModel: (m) =>
        set((s) => { s.videoModel = m }),

      setGateMode: (mode) =>
        set((s) => { s.gateMode = mode }),

      startAutopilot: (concept) =>
        set((s) => { s.autopilot = { running: true, phase: 'Starting…', error: null, concept } }),

      stopAutopilot: () =>
        set((s) => { s.autopilot.running = false }),

      setAutopilotPhase: (phase) =>
        set((s) => { s.autopilot.phase = phase }),

      setAutopilotError: (error) =>
        set((s) => { s.autopilot.error = error; if (error) s.autopilot.running = false }),

      requestSpineDerive: () =>
        set((s) => { s.pendingSpineDerive = true }),

      clearSpineDerive: () =>
        set((s) => { s.pendingSpineDerive = false }),

      setLocalFolderRoot: (root) => {
        // Mirror into the standalone key (New-project init + opening a folder that has
        // no snapshot yet both land here) so boot can still find the project when the
        // snapshot is gone — see rememberProjectRoot.
        rememberProjectRoot(root)
        set((s) => { s.localFolderRoot = root })
      },

      goToStage: (id) =>
        set((s) => { s.activeStage = id }),

      commitVersion: (stageId, data, qcResult) => {
        const id = nanoid()
        set((s) => {
          const stage = s.stages[stageId]
          const version: StageVersion = {
            id,
            createdAt: Date.now(),
            data,
            qcResult: qcResult ?? null,
            approvalNotes: '',
          }
          // Ring buffer — keep last MAX_VERSIONS
          const versions = [...stage.versions, version]
          stage.versions = versions.slice(-MAX_VERSIONS)
          stage.activeVersionId = id
          stage.status = 'pending_review'
          stage.isDirty = false
          // A new breakdown means new shot IDs — stale approvals must not carry over
          if (stageId === 2) s.approvedShotIds = []
        })
        return id
      },

      approveVersion: (stageId, versionId, notes = '') =>
        set((s) => {
          const stage = s.stages[stageId]
          const v = stage.versions.find((v) => v.id === versionId)
          if (v) { v.approvalNotes = notes; v.approved = true }  // durable ever-approved marker (stepper gate)
          stage.status = 'approved'
          // Cascade: mark downstream as invalidated (not deleted). prevStatus
          // lets "Keep current work" restore the stage when the upstream
          // change turns out to be cosmetic.
          DOWNSTREAM[stageId].forEach((downId) => {
            const ds = s.stages[downId]
            if (ds.status !== 'idle') {
              if (ds.status !== 'invalidated') ds.prevStatus = ds.status
              ds.status = 'invalidated'
              ds.isDirty = true
            }
          })
        }),

      rollbackToVersion: (stageId, versionId) =>
        set((s) => {
          s.stages[stageId].activeVersionId = versionId
          s.stages[stageId].status = 'pending_review'
          DOWNSTREAM[stageId].forEach((downId) => {
            const ds = s.stages[downId]
            ds.isDirty = true
            if (ds.status === 'approved') {
              ds.prevStatus = ds.status
              ds.status = 'invalidated'
            }
          })
        }),

      // "Keep current work": the user reviewed the upstream change and chose
      // to keep this stage's existing output — clear the stale flag and
      // restore the pre-invalidation status. Nothing regenerated or deleted.
      acknowledgeUpstream: (stageId) =>
        set((s) => {
          const stage = s.stages[stageId]
          stage.isDirty = false
          if (stage.status === 'invalidated') {
            stage.status = stage.prevStatus ?? 'pending_review'
          }
          stage.prevStatus = undefined
        }),

      setStageStatus: (stageId, status) =>
        set((s) => { s.stages[stageId].status = status }),

      patchStageData: (stageId, patch) =>
        set((s) => {
          const stage = s.stages[stageId]
          if (!stage.activeVersionId) {
            // No active version — create one silently
            const id = nanoid()
            stage.versions = [{ id, createdAt: Date.now(), data: patch, qcResult: null, approvalNotes: '' }]
            stage.activeVersionId = id
            return
          }
          const v = stage.versions.find((v) => v.id === stage.activeVersionId)
          if (v) {
            v.data = { ...(v.data as Record<string, unknown> ?? {}), ...patch }
          }
        }),

      // Item 4F: append a render as a take (disk already versioned it as video_vNNN.mp4);
      // cap per-shot at MAX_VERSIONS (mirrors the ring buffer) so a long re-roll session
      // can't overflow localStorage; a fresh take is auto-selected. Returns the take id.
      addShotVersion: (shotId, take) => {
        const id = nanoid()
        set((s) => {
          const list = s.shotVersions[shotId] ?? []
          s.shotVersions[shotId] = [...list, { ...take, id, createdAt: Date.now() }].slice(-MAX_VERSIONS)
          s.shotSelectedVersion[shotId] = id
        })
        return id
      },

      setSelectedShotVersion: (shotId, versionId) =>
        set((s) => { s.shotSelectedVersion[shotId] = versionId }),

      setShotRefMedia: (shotId, media) =>
        set((s) => {
          // Default en lectura: el campo es opcional para que `migrate()` no tenga que
          // tocar los estados ya guardados, así que el primer uso lo crea.
          if (!s.shotRefMedia) s.shotRefMedia = {}
          s.shotRefMedia[shotId] = media
        }),

      setBoardRefMedia: (shotId, media) =>
        set((s) => {
          if (!s.boardRefMedia) s.boardRefMedia = {}
          s.boardRefMedia[shotId] = media
        }),

      resetPipeline: () => {
        // Forget the folder too — otherwise the next boot would recall it and pull the
        // project the user just reset straight back out of disk.
        rememberProjectRoot(null)
        set((s) => {
          // Full fresh start — a new project id remounts the stage views (keyed
          // on projectId in the dashboard), clearing their local state too.
          s.projectId = nanoid()
          s.projectName = 'UNTITLED'
          s.projectType = 'tv'
          s.projectStructure = { season: '01', episode: '01', scene: '01' }
          s.activeStage = 1
          s.stages = makeInitialStages()
          s.style = DEFAULT_STYLE
          s.targetDurationSecs = 60
          s.aspectRatio = '16:9'
          s.outputResolution = '4k'
          s.videoModel = 'v25'
          s.gateMode = 'manual'
          s.approvedShotIds = []
          s.gallery = []
          s.referenceTray = []
          s.finalCutEdit = null
          s.shotVersions = {}
          s.shotSelectedVersion = {}
          // No active project → setup button reads "Project Setup" again.
          s.localFolderRoot = null
        })
      },

      loadProjectState: (snap) => {
        // Every Open path (snapshot, reconstruction, and boot-from-disk) funnels through
        // here with `localFolderRoot` set by planProjectLoad — mirror it.
        if (snap.localFolderRoot !== undefined) rememberProjectRoot(snap.localFolderRoot)
        set((s) => {
          if (snap.projectId) s.projectId = snap.projectId
          if (snap.projectName != null) s.projectName = snap.projectName
          if (snap.projectType) s.projectType = snap.projectType
          if (snap.projectStructure) s.projectStructure = snap.projectStructure
          // Segments (v6). This is the ONE entry point zustand's `migrate` can never
          // cover: pipeline_state.json carries no version field at all (its top-level
          // keys are just `savedAt` and `state`), so a project opened from disk lands
          // here verbatim. Without this line, ROBOTECH opens with stage-2 shots and no
          // segments, and every downstream reader silently sees an un-migrated project.
          if (snap.stages) s.stages = migrateStagesToSegments(snap.stages) as typeof snap.stages
          if (snap.style) s.style = snap.style
          if (typeof snap.targetDurationSecs === 'number') s.targetDurationSecs = snap.targetDurationSecs
          if (snap.aspectRatio) s.aspectRatio = snap.aspectRatio
          if (snap.outputResolution) s.outputResolution = snap.outputResolution
          if (snap.videoModel) s.videoModel = snap.videoModel
          if (snap.gateMode) s.gateMode = snap.gateMode
          if (snap.localFolderRoot !== undefined) s.localFolderRoot = snap.localFolderRoot
          if (snap.approvedShotIds) s.approvedShotIds = snap.approvedShotIds
          if (snap.gallery) s.gallery = snap.gallery
          if (snap.referenceTray) s.referenceTray = snap.referenceTray
          if (snap.shotVersions) s.shotVersions = snap.shotVersions
          if (snap.shotSelectedVersion) s.shotSelectedVersion = snap.shotSelectedVersion
          // Carry the loaded copy's age with it — after restoring FROM disk, memory is
          // exactly as old as that disk copy. (A reconstruction has none → stays put.)
          if (typeof snap.savedAt === 'number') s.savedAt = snap.savedAt
          // The Final Cut timeline is PERSISTED (partialize) but used to be missing from
          // ProjectSnapshot, so opening a project restored every slice EXCEPT the cut — the
          // stage kept whatever finalCutEdit was already in memory (the PREVIOUS project's
          // timeline, since the stage views only remount on projectId). That is the "Stage 6
          // is cached / won't refresh" report (2026-07-27). ALWAYS assign — a snapshot with
          // no cut CLEARS it, so a project can never inherit another project's timeline.
          s.finalCutEdit = snap.finalCutEdit ?? null
          // A freshly-opened project starts at stage 1 with no autopilot run — and with no
          // pending spine request: the one in memory belongs to the project being left, and
          // honouring it here would derive a spine for THIS script on the other one's request.
          s.activeStage = 1
          s.autopilot = { running: false, phase: '', error: null, concept: '' }
          s.pendingSpineDerive = false
        })
      },
    })),
    {
      name: 'takeone-pipeline-v1',
      // Pipeline restructure (2026-06-10): index 4 changed meaning — was the
      // text-only Scene Breakdown review, is now the Storyboard stage. We keep
      // the same localStorage key and use zustand's built-in versioning: the
      // migration preserves stages 1-3 (script/breakdown/assets), 5 (shots)
      // and 6, and resets stage 4 to idle — its old {approvedShots, shots}
      // payload has no meaning for storyboards, and the review function it
      // carried now lives in the Storyboard stage itself.
      // v3 (same day): storyboard data went from one-grid-per-scene to
      // one-board-per-shot — old sceneStates can't render, so stage 4 resets
      // again. Boards regenerate in one click; everything else is preserved.
      // v4 (P3): added the Studio `gallery` slice — additive, initialised empty.
      // v5 (Phase 0): additive character/asset/shot fields (variants, versioning,
      //   custom shots, voice). ALL new fields are optional → existing records stay
      //   valid untouched; defaults are applied at READ sites (`x ?? default`), so
      //   the migration is a no-op transform and just marks the schema version.
      // v6 (segments): the unit of generation stops being the shot and becomes the
      //   SEGMENT — one Seedance call (≤15 s) holding several shots the model cuts
      //   internally, which is the only way a sub-4 s beat can exist (the API floor is
      //   4 s per call). The transform is LOSSLESS and keeps every id: a migrated
      //   segment inherits the shot's id, so the six shotId-keyed maps (boards,
      //   approvals, versions, the cut) keep resolving with no rekey at all.
      version: 6,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as { stages?: Record<number, unknown>; gallery?: unknown }
        if (version < 3 && state?.stages) {
          state.stages[4] = makeInitialStage()
          // If the user was parked on old Stage 4, keep them there — it now
          // shows the (empty) Storyboard stage, which is the correct next step.
        }
        if (version < 4 && !Array.isArray(state?.gallery)) {
          state.gallery = []
        }
        // v5: no transform needed — every Phase-0 field is optional and read-time
        // defaulted, so pre-v5 characters/assets/shots load unchanged.
        if (version < 6 && state?.stages) {
          // Guarded: the failure path below (onRehydrateStorage) DELETES the key, so a
          // throw here would cost the user their project. A migration that silently
          // does nothing is recoverable; one that wipes localStorage is not.
          try {
            migrateStagesToSegments(state.stages)
          } catch (e) {
            console.warn('[pipeline.store] v6 segment migration skipped:', e)
          }
        }
        return state
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.warn('[pipeline.store] Rehydration failed (corrupt/truncated localStorage) — resetting to defaults:', error)
          // Clear the corrupt entry so next refresh starts clean
          try { localStorage.removeItem('takeone-pipeline-v1') } catch { /* ignore */ }
        }
        // Heal a doubled project segment left by an incomplete consolidation
        // (…/Alastor/Alastor → …/Alastor). localFolderRoot is the path EVERY
        // generation writes to, so a nested root silently fragments the project
        // on disk (videos/anchors land in the wrong place). Collapse it here so
        // the next write targets the real project root.
        if (state?.localFolderRoot) {
          const parts = state.localFolderRoot.split('/')
          for (let i = 0; i < parts.length - 1; i++) {
            if (parts[i] && parts[i] === parts[i + 1]) {
              state.localFolderRoot = [...parts.slice(0, i + 1), ...parts.slice(i + 2)].join('/')
              console.warn('[pipeline.store] healed nested localFolderRoot →', state.localFolderRoot)
              break
            }
          }
          // Back-fill the standalone key from the snapshot that just rehydrated: a user
          // whose project pre-dates F2b has never been through setLocalFolderRoot/
          // loadProjectState since, so this is the only place the key can be seeded for
          // them — and it must happen BEFORE the snapshot is the one that goes missing.
          // Only when there IS a root: a snapshot that rehydrated WITHOUT one is exactly
          // the pruned/absent case the key exists to survive, so it must not clear it.
          rememberProjectRoot(state.localFolderRoot)
        }
      },
      partialize: partializeState,
      // Recover gracefully from a corrupted/truncated localStorage entry
      // (e.g. from a previous session that hit the storage limit before
      // data URIs were filtered out in partialize).
      storage: createJSONStorage(() => ({
        getItem: (name) => {
          try {
            return localStorage.getItem(name)
          } catch {
            return null
          }
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, value)
            return
          } catch (e) {
            // QuotaExceededError. NEVER removeItem here (the old behaviour): that
            // deleted the entire project from the browser over a size limit, with
            // only a console.warn. Instead drop the version history — it is already
            // on disk via ProjectAutosave — and keep the live state.
            console.warn('[pipeline.store] localStorage write failed (quota?) — pruning version history:', e)
            const pruned = pruneSnapshotForQuota(value)
            if (pruned) {
              try {
                localStorage.setItem(name, pruned)
                return
              } catch { /* fall through — still too big */ }
            }
            // Last resort: leave the PREVIOUS entry intact. A stale browser copy
            // is recoverable (disk holds the truth); an erased one is not.
            console.warn('[pipeline.store] snapshot still exceeds quota — keeping the previous localStorage entry; disk autosave remains authoritative')
          }
        },
        removeItem: (name) => {
          try { localStorage.removeItem(name) } catch { /* ignore */ }
        },
      })),
    }
  )
)

// ─── Selectors ───────────────────────────────────────────────────────────────

export const selectActiveStageData = <T>(
  store: PipelineStore,
  stageId: StageId
): T | null => {
  const stage = store.stages[stageId]
  if (!stage.activeVersionId) return null
  const v = stage.versions.find((v) => v.id === stage.activeVersionId)
  return v ? (v.data as T) : null
}
