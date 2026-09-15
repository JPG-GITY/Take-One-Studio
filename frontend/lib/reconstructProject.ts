/**
 * Legacy-project reconstruction: turn the raw on-disk bundle from
 * `/api/project/load`.reconstruct into pipeline-store state. The backend does
 * the disk discovery (script.json, breakdown.json, asset images matched by
 * name↔id, shot media); here we own the store shapes — Stage 2 goes through the
 * canonical normalizeBreakdown, assets become saved-preview AssetStates, and
 * rendered shots come back as ready takes pointed at their local files.
 */

import { normalizeBreakdown } from '@/features/stage2-breakdown/BreakdownView'
import { approxScriptRuntime } from '@/lib/scriptRuntime'
import type { ProjectSnapshot, ProjectType, ProjectStructure } from '@/store/pipeline.store'
import type { StageSlice, StageId, GeneratedShot } from '@/lib/types/pipeline.types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const serveUrl = (p: string) => `${API_BASE}/api/asset/serve?path=${encodeURIComponent(p)}`

interface ReconAsset { assetId: string; name: string; type: string; status: string; localPath: string; headshotLocalPath?: string }
interface ReconBoard { boardLocalPath: string; version: number; rows: number; cols: number; panels?: unknown[]; autoPrompt?: string; sentPrompt?: string }
/** `duration` is null when the backend could not measure the take (see
 *  storage.reconstruct_project) — it is NOT a number waiting for a default. */
interface ReconShot { shotId: string; videoLocalPath: string; keyframeLocalPath: string; status: string; duration: number | null; board?: ReconBoard | null }
export interface ReconstructBundle {
  script: { concept: string; content: string } | null
  breakdown: unknown | null
  assets: ReconAsset[]
  shots: ReconShot[]
}
export interface ProjectManifest { name?: string; type?: string; structure?: Record<string, unknown> }

const idle = (): StageSlice => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const slice = (status: StageSlice['status'], id: string, data: unknown, notes = ''): StageSlice => ({
  status, activeVersionId: id,
  versions: [{ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: notes }],
  isDirty: false,
})

/** True when the bundle holds anything worth reconstructing. */
export function bundleHasContent(b?: ReconstructBundle | null): boolean {
  return !!b && (!!b.script?.content || !!b.breakdown || b.assets.length > 0 || b.shots.some((s) => !!s.videoLocalPath))
}

/**
 * Which stages a state MEANINGFULLY populates (a version that merely exists but
 * holds empty data — e.g. stage 4 with `sceneStates: {}` — does NOT count). Used
 * to decide snapshot-vs-reconstruction: if reconstruction can supply a stage the
 * snapshot lacks (a legacy project's stage 4 boards), we reconstruct in full so
 * stage 2 and stage 4 keep consistent scene ids.
 */
export function populatedStages(state?: Partial<ProjectSnapshot> | null): Set<number> {
  const out = new Set<number>()
  const stages = state?.stages as Record<number, StageSlice> | undefined
  if (!stages) return out
  const dataOf = (n: number): Record<string, unknown> | null => {
    const st = stages[n]
    if (!st) return null
    const v = st.versions.find((x) => x.id === st.activeVersionId) ?? st.versions[st.versions.length - 1]
    return (v?.data as Record<string, unknown>) ?? null
  }
  const len = (x: unknown) => (Array.isArray(x) ? x.length : 0)
  const keys = (x: unknown) => (x && typeof x === 'object' ? Object.keys(x as object).length : 0)

  const d1 = dataOf(1); if (d1?.content) out.add(1)
  // `segments` counts as stage-2 content too. Miss this and a migrated snapshot looks
  // EMPTY here, `reconAddsStages` flips true, and opening the project rebuilds it from
  // disk artefacts — discarding every approval, board and cut the snapshot was holding.
  const d2 = dataOf(2); if (len(d2?.segments) || len(d2?.shots) || len(d2?.assets)) out.add(2)
  const d3 = dataOf(3); if (keys(d3?.assetStates)) out.add(3)
  const d4 = dataOf(4)
  const scenes = (d4?.sceneStates ?? {}) as Record<string, { shotBoards?: object }>
  if (Object.values(scenes).some((s) => keys(s?.shotBoards))) out.add(4)
  const d5 = dataOf(5); if (len(d5?.shots)) out.add(5)
  const d6 = dataOf(6); if (len(d6?.sequence)) out.add(6)
  return out
}

/** A moved project folder leaves ABSOLUTE media paths (asset localPath, keyframes,
 *  serve URLs — raw and URL-encoded) pointing at the old location, so every image
 *  404s after the move. When the snapshot recorded a different root than the folder
 *  being opened, rewrite every occurrence of the old root (both encodings) with the
 *  new one before hydrating. */
export function migrateMovedPaths(state: Partial<ProjectSnapshot>, newRoot: string): Partial<ProjectSnapshot> {
  const oldRoot = state.localFolderRoot
  if (!oldRoot || oldRoot === newRoot) return state
  const json = JSON.stringify(state)
    .split(oldRoot).join(newRoot)
    .split(encodeURIComponent(oldRoot)).join(encodeURIComponent(newRoot))
  try { return JSON.parse(json) as Partial<ProjectSnapshot> } catch { return state }
}

/** The `/api/project/load` response. Shared by the two callers that hydrate a project
 *  from disk: the Open tab (ProjectSetupPanel) and boot (ProjectAutosave). */
export interface ProjectLoadResponse {
  state: Partial<ProjectSnapshot> | null
  /** ISO-8601, stamped by the backend when pipeline_state.json was written. Pre-dates
   *  the snapshot-level `state.savedAt` and is the fallback for older files. */
  savedAt?: string | null
  manifest: ProjectManifest
  reconstruct?: ReconstructBundle
  path: string
  /** Media pointers the backend corrected while reading the snapshot: a shot naming a
   *  video that is not on disk, or naming the mute take when its dubbed sibling is
   *  sitting next to it. Sent SEPARATELY from `state` because boot deliberately keeps a
   *  populated browser copy over the disk snapshot — it may hold unsaved work — which
   *  would otherwise throw the correction away on the one path that matters most:
   *  reopening a project this tab already has. A pointer is not work. */
  media_heals?: MediaHeal[]
}

/** One corrected shot. `videoLocalPath` empty + `status` 'draft' means no take exists on
 *  disk at all and the shot must stop claiming to be rendered. */
export interface MediaHeal {
  shot_id: string
  /** Absent when this heal only corrects the prompt. Empty string means NO take exists on
   *  disk; the consumer must apply key by key so that distinction survives. */
  video_local_path?: string
  video_url?: string
  status?: string
  /** The prompt the backend recorded beside the take. Wins over the store's copy, which
   *  is written by the browser and drifts when a tab does not survive to the final write. */
  assembled_prompt?: string
}

export type ProjectLoadPlan =
  | { kind: 'reconstructed'; snapshot: Partial<ProjectSnapshot> }
  | { kind: 'snapshot';      snapshot: Partial<ProjectSnapshot> }
  | { kind: 'empty';         snapshot: null }

/**
 * Decide what a `/api/project/load` response should become in the store. ONE copy of
 * this decision: Open and boot must land a project in the identical state, and this
 * used to live inline in ProjectSetupPanel where boot could not reach it. Callers own
 * only their own messaging — the plan is pure.
 */
export function planProjectLoad(data: ProjectLoadResponse, path: string): ProjectLoadPlan {
  const recon = bundleHasContent(data.reconstruct)
    ? reconstructState(data.reconstruct!, data.manifest, path)
    : null
  const snapPop = populatedStages(data.state)
  const reconPop = populatedStages(recon)
  // Does disk hold a stage the snapshot doesn't meaningfully populate? (e.g. a
  // legacy snapshot saved before storyboard reconstruction existed.)
  const reconAddsStages = [...reconPop].some((n) => !snapPop.has(n))

  // Full reconstruction — keeps stage 2 + stage 4 scene ids consistent.
  if (recon && reconAddsStages) return { kind: 'reconstructed', snapshot: { ...recon, localFolderRoot: path } }
  // Snapshot is the richer/authoritative copy — restore it.
  if (snapPop.size > 0 && data.state) {
    return { kind: 'snapshot', snapshot: { ...migrateMovedPaths(data.state, path), localFolderRoot: path } }
  }
  // Legacy project with no usable snapshot — rebuild from disk.
  if (recon) return { kind: 'reconstructed', snapshot: { ...recon, localFolderRoot: path } }
  // Truly empty folder — the caller decides what "nothing to restore" means for it.
  return { kind: 'empty', snapshot: null }
}

export function reconstructState(bundle: ReconstructBundle, manifest: ProjectManifest, path: string): Partial<ProjectSnapshot> {
  const stages: Record<StageId, StageSlice> = { 1: idle(), 2: idle(), 3: idle(), 4: idle(), 5: idle(), 6: idle() }

  // Stage 1 — Script
  if (bundle.script?.content) {
    const words = bundle.script.content.trim().split(/\s+/).filter(Boolean).length
    // The real runtime is the backend's (POST /api/script/runtime) and this function is
    // pure + synchronous — so a reconstructed project carries the words/130 page rule
    // FLAGGED approximate, and Stage 1 replaces it the moment it measures the script
    // it is showing. Flagged rather than dropped: the field is not optional.
    const rt = approxScriptRuntime(bundle.script.content)
    stages[1] = slice('approved', 'rec-1', {
      concept: bundle.script.concept ?? '', content: bundle.script.content,
      wordCount: words, estimatedRuntime: Math.round(rt.seconds / 60),
      estimatedRuntimeSecs: rt.seconds, runtimeApprox: true,
    }, 'reconstructed from disk')
  }

  // Stage 2 — Breakdown (canonical normalizer owns the shape + scene synthesis)
  const bd = bundle.breakdown ? normalizeBreakdown(bundle.breakdown) : null
  if (bd) {
    stages[2] = slice('approved', 'rec-2', bd, 'reconstructed from disk')
  }

  // Stage 3 — Assets: each matched disk image becomes an APPROVED saved preview.
  // A legacy project's on-disk assets are finished work — and if its shots
  // rendered (they require approved char/env refs), the assets were approved.
  // The manifest's `approved` pointer is unreliable (approval lived in the store,
  // not the manifest), so existence on disk is the truth. Un-approve to redo.
  if (bundle.assets.length) {
    const assetStates: Record<string, unknown> = {}
    for (const a of bundle.assets) {
      const url = serveUrl(a.localPath)
      assetStates[a.assetId] = {
        imageUrls: [url], selectedUrl: url, localPath: a.localPath,
        headshotLocalPath: a.headshotLocalPath || undefined,
        status: 'approved',
        qcResult: null,
      }
    }
    stages[3] = slice('approved', 'rec-3', { assetStates }, 'reconstructed from disk')
  }

  // Stage 4 — Storyboard: one board per shot, grouped into scenes, marked APPROVED
  // (finished work — the boards were used to render the shots). The structured
  // panels weren't persisted on disk, so panels stay empty — the board IMAGE is
  // what the stage shows. Un-approve a board to regenerate it.
  const boardByShot = new Map(bundle.shots.filter((s) => s.board).map((s) => [s.shotId, s.board!]))
  if (bd && boardByShot.size) {
    const sceneStates: Record<string, unknown> = {}
    for (const scene of bd.scenes) {
      const shotBoards: Record<string, unknown> = {}
      for (const sid of scene.shotIds) {
        const b = boardByShot.get(sid)
        if (!b) continue
        shotBoards[sid] = {
          status: 'approved', boardUrl: '', boardLocalPath: b.boardLocalPath,
          version: b.version, rows: b.rows, cols: b.cols, panels: b.panels ?? [], notes: '',
          autoPrompt: b.autoPrompt, sentPrompt: b.sentPrompt,
        }
      }
      if (Object.keys(shotBoards).length) {
        sceneStates[scene.id] = { status: 'approved', shotBoards, qcResult: null, notes: '' }
      }
    }
    if (Object.keys(sceneStates).length) {
      stages[4] = slice('approved', 'rec-4', { sceneStates }, 'reconstructed from disk')
    }
  }

  // Stage 5 — Shots: rendered videos restored as ready takes (local paths never expire)
  if (bundle.shots.some((s) => s.videoLocalPath)) {
    const shots: GeneratedShot[] = bundle.shots.map((s) => ({
      shotId: s.shotId,
      thumbnailUrl: s.keyframeLocalPath ? serveUrl(s.keyframeLocalPath) : '',
      videoUrl: s.videoLocalPath ? serveUrl(s.videoLocalPath) : '',
      videoLocalPath: s.videoLocalPath || undefined,
      keyframeLocalPath: s.keyframeLocalPath || undefined,
      // Deliberately UNSET when the backend could not measure the take, exactly like
      // renderedResolution below. `?? 5` stood here, and a reopened project's shots
      // reached the phase-6 gate as five-second clips it counted as measured — which is
      // the one case qc_final_cut's "unknown is not scored" rule exists to cover.
      duration: s.duration ?? undefined,
      // Deliberately UNKNOWN, not '480p'. Disk reconstruction cannot tell what a
      // clip was rendered at, and claiming 480p made every shot of a reopened
      // project look like a cheap draft — which, next to a promote-to-master
      // button, is one click from re-rendering a whole episode at 4k (~$3.89 per
      // 5s shot). Undefined reads as "already at the top tier" everywhere that
      // ranks tiers, so a reopened project is never offered for promotion.
      renderedResolution: undefined,
      status: s.videoLocalPath ? 'ready' : 'queued',
    }))
    stages[5] = slice('pending_review', 'rec-5', { shots })
  }

  return {
    projectName: manifest.name,
    projectType: (manifest.type as ProjectType) ?? 'film',
    projectStructure: (manifest.structure as ProjectStructure) ?? {},
    stages,
    localFolderRoot: path,
  }
}
