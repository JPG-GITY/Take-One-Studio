'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { Film, Pencil, CheckCircle, Lock, RefreshCw, Camera, Clock, MessageSquare, ShieldCheck, FileText, X, Maximize2, Wand2 } from 'lucide-react'
import { StageHeader } from '@/components/pipeline/StageHeader'
import { PromptPanel } from '@/components/pipeline/PromptPanel'
import { EnhanceButton } from '@/components/pipeline/EnhanceButton'
import { ProImageEditor } from '@/features/stage3-assets/ProImageEditor'
import { ReferenceMediaPanel, emptyReferenceMedia, type ReferenceMedia } from '@/components/media/ReferenceMediaPanel'
import { ReferencesSent } from '@/components/media/ReferencesSent'
import { Button } from '@/components/ui/Button'
import { QCResultBadge } from '@/components/agent/QCResultBadge'
import { usePipelineStore } from '@/store/pipeline.store'
import { useProjectGuard } from '@/lib/useProjectGuard'
import { useAgentsStore } from '@/store/agents.store'
import { useToast } from '@/components/ui/Toast'
import { apiClient } from '@/lib/api/client'
import { pipelineApi, type QCResponse, type VoiceConfig } from '@/lib/api/pipeline.api'
import { cn } from '@/lib/utils'
import { registerAutopilotRunner, type AutopilotResult } from '@/lib/autopilotRegistry'
import { boardIds } from '@/lib/segments'
import type { BreakdownData, Shot, SceneStoryboardState, ShotBoardState, StoryboardBeat, Segment } from '@/lib/types/pipeline.types'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const serveUrl = (p: string) => `${API_BASE}/api/asset/serve?path=${encodeURIComponent(p)}`
// 3-bug2: how many scenes board concurrently. The backend's PROCESS-GLOBAL board
// semaphore (STORYBOARD_CONCURRENCY) is the real BytePlus throttle; this only bounds
// open HTTP requests + Claude beat fan-out from the client. Set 1 for the old serial batch.
const SCENE_BATCH_CONCURRENCY = 3

const EMPTY_SCENE_STATE: SceneStoryboardState = {
  status: 'idle', shotBoards: {}, qcResult: null, notes: '',
}

interface BoardResponse {
  boards: Array<{
    shot_id: string
    board_url: string
    board_local_path: string
    version: number
    rows: number
    cols: number
    panels: StoryboardBeat[]
    auto_prompt?: string
    sent_prompt?: string
  }>
}

/** Item 0: one assembled (dry-run) board prompt, editable before generation. */
interface PendingBoardSpec {
  shot_id: string
  prompt: string
  auto_prompt: string
  beats: StoryboardBeat[]
  rows: number
  cols: number
  width: number
  height: number
  /** Las imágenes con las que se va a dibujar, en el orden en que se envían, calculadas
   *  por la MISMA función que las envía (`_board_references`). `dropped` marca lo que se
   *  consideró y no cupo, que antes desaparecía sin dejar rastro. */
  references?: Array<{ label: string; url: string; source: 'derived' | 'director'; dropped: boolean; excluded?: boolean }>
}

/**
 * Stage 4 — Storyboard. ONE BOARD PER SEGMENT: a 2-column grid of beat panels, one
 * per beat of the segment, each labelled with its own time range (0–9.5s, 9.5–15.5s …).
 * Scene approval = every board approved; SG's gate consumes that approval and SG uses
 * each board directly as its composition reference.
 *
 * The panels are NOT sketches. `_board_prompt` (server.py) asks for "fully rendered
 * production film stills… dramatic motivated lighting, real shallow depth of field,
 * filmic color grade" and bans pencil, arrows and diagram marks by name — or, in a
 * stylised project, the project's own locked art style. This comment used to describe
 * "1–4 monochrome pencil beat panels", which was true of a version of stage 4 that no
 * longer exists and sent at least one reader (2026-08-09) to the wrong conclusion about
 * what Seedance is being shown. The panel COUNT follows the segment's beats — DryRUN's
 * SHOT_005 has six — and the grid is laid out by `_board_geometry`, always 2 columns
 * unless there is a single panel.
 */
export function StoryboardView() {
  const { stages, patchStageData, commitVersion, approveVersion, goToStage, projectName, localFolderRoot, aspectRatio, gateMode, setStageStatus, style } = usePipelineStore()
  const { updateAgent } = useAgentsStore()
  const isCurrentProject = useProjectGuard()
  const { success, error: toastError } = useToast()
  const stage3 = stages[3]
  const stage4 = stages[4]

  const breakdown = useMemo(() => {
    const v = stages[2].versions.find((v) => v.id === stages[2].activeVersionId)
    return (v?.data as BreakdownData | null) ?? null
  }, [stages])

  const scenes = useMemo(() => breakdown?.scenes ?? [], [breakdown])
  const shots = useMemo(() => breakdown?.shots ?? [], [breakdown])
  // A board corresponds to one Seedance CALL. When that call is a segment holding
  // several shots, the board's panels ARE those shots — the breakdown already decided
  // the cuts. A migrated segment inherits the shot's id, so on existing projects this
  // map is 1:1 and every board stays exactly as it was.
  const segmentMap = useMemo<Record<string, Segment>>(() => {
    const s2 = stages[2]
    const v = s2.versions.find((x) => x.id === s2.activeVersionId)
    const segs = ((v?.data as { segments?: Segment[] })?.segments) ?? []
    return Object.fromEntries(segs.map((sg) => [sg.id, sg]))
  }, [stages])
  const segmentOf = useCallback((id: string) => segmentMap[id], [segmentMap])

  // Conceptual thread: id → approved look, so the board can draw the real characters
  // (wardrobe, helmet) instead of a generic figure.
  const assetMap = useMemo(() => {
    // Pull the approved image per asset from Stage 3 so each panel can lock the REAL
    // character (face + wardrobe) as a Seedream reference, not just a text description.
    const v3 = stage3.versions.find((v) => v.id === stage3.activeVersionId)
    const d3 = v3?.data as {
      assetStates?: Record<string, { selectedUrl?: string | null; localPath?: string | null }>
    } | null
    const m: Record<string, { name: string; type: string; appearance: string; refUrl: string }> = {}
    for (const a of breakdown?.assets ?? []) {
      const st = d3?.assetStates?.[a.id]
      m[a.id] = {
        name: a.name, type: a.type, appearance: a.visualDescription ?? '',
        refUrl: st?.localPath ?? st?.selectedUrl ?? '',
      }
    }
    return m
  }, [breakdown, stage3])

  const [sceneStates, setSceneStates] = useState<Record<string, SceneStoryboardState>>(() => {
    const v4 = stage4.versions.find((v) => v.id === stage4.activeVersionId)
    return ((v4?.data as { sceneStates?: Record<string, SceneStoryboardState> })?.sceneStates) ?? {}
  })
  const [activeSceneId, setActiveSceneId] = useState<string | null>(scenes[0]?.id ?? null)
  // Per-shot busy tracking so you can Regen a finished board WHILE other shots
  // (or a batch) are still rendering — the old single `isGenerating` blocked all.
  const [busyShots, setBusyShots] = useState<Set<string>>(new Set())
  const [batchRunning, setBatchRunning] = useState(false)   // "Board all scenes" / autopilot loop
  const markShotsBusy = useCallback((ids: string[], busy: boolean) => {
    setBusyShots((prev) => {
      const n = new Set(prev)
      ids.forEach((id) => (busy ? n.add(id) : n.delete(id)))
      return n
    })
  }, [])
  const isGenerating = busyShots.size > 0 || batchRunning
  // Shots whose board image 404'd (file lost/moved) — show a "regenerate" prompt
  // instead of a broken <img>, so a missing file never renders as a broken tile.
  const [brokenBoards, setBrokenBoards] = useState<Set<string>>(new Set())
  const [zoomBoard, setZoomBoard] = useState<string | null>(null)   // board lightbox
  const [editShotId, setEditShotId] = useState<string | null>(null) // Pro editor target
  // Item 0: per-shot assembled prompts awaiting review (transient)
  const [pendingSpecs, setPendingSpecs] = useState<Record<string, PendingBoardSpec>>({})
  // El tope de referencias del tablero, tal como lo declara el servidor (ver arriba).
  const [boardMaxRefs, setBoardMaxRefs] = useState<number | undefined>(undefined)
  // Las referencias que el director eligió para el tablero de cada plano. Del store, no
  // de un useState: componerlas y recargar la página las perdería, y son trabajo suyo.
  const storedBoardRefMedia = usePipelineStore((st) => st.boardRefMedia)
  const boardRefMedia = useMemo(
    () => (storedBoardRefMedia ?? {}) as Record<string, ReferenceMedia>, [storedBoardRefMedia])
  const setBoardRefMedia = usePipelineStore((st) => st.setBoardRefMedia)
  // Las derivadas que el director retiró, por etiqueta y por plano. Local: es una decisión
  // sobre ESTA pasada de tablero, no material que deba sobrevivir a un reinicio.
  const [boardExclusions, setBoardExclusions] = useState<Record<string, string[]>>({})
  const toggleBoardExclusion = useCallback((shotId: string, label: string) => {
    setBoardExclusions((prev) => {
      const cur = prev[shotId] ?? []
      return { ...prev, [shotId]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  }, [])
  const [preparingShotId, setPreparingShotId] = useState<string | null>(null)

  const getScene = useCallback((id: string): SceneStoryboardState =>
    sceneStates[id] ?? EMPTY_SCENE_STATE, [sceneStates])

  // Pure updater + persistence effect (never write the store during render)
  const updateScene = useCallback((id: string, patch: Partial<SceneStoryboardState>) => {
    setSceneStates((prev) => ({ ...prev, [id]: { ...EMPTY_SCENE_STATE, ...(prev[id] ?? {}), ...patch } }))
  }, [])

  useEffect(() => {
    if (Object.keys(sceneStates).length === 0) return
    patchStageData(4, { sceneStates })
  }, [sceneStates, patchStageData])

  const activeScene = scenes.find((sc) => sc.id === activeSceneId) ?? null
  const activeState = activeSceneId ? getScene(activeSceneId) : EMPTY_SCENE_STATE
  const sceneShots = useMemo(
    () => (activeScene ? shots.filter((s) => boardIds(activeScene).includes(s.id)) : []),
    [activeScene, shots],
  )

  const sceneApproved = useCallback((sc: { id: string; shotIds?: string[]; segmentIds?: string[] }) => {
    const st = getScene(sc.id)
    const ids = boardIds(sc)
    return ids.length > 0 && ids.every((sid) => st.shotBoards[sid]?.status === 'approved')
  }, [getScene])

  // Global remaining-boards counter (drives the "Board all scenes" button)
  const totalUnboarded = useMemo(() =>
    scenes.reduce((n, sc) => {
      const st = getScene(sc.id)
      return n + boardIds(sc).filter((sid) => !st.shotBoards?.[sid]?.boardLocalPath).length
    }, 0),
  [scenes, getScene])

  const approvedScenes = scenes.filter(sceneApproved).length
  const allApproved = scenes.length > 0 && approvedScenes === scenes.length
  const alreadyLocked = stage4.status === 'approved'

  // 3.2b: who SPEAKS in a shot, in first-speaking order, resolved to the exact string the
  // clip was rendered under — `assetMap[...].name ?? characterId`, the same expression both
  // dialogue call sites send as `character` and the key server._render_dialogue_clip looks
  // that speaker's locked voice anchor up by. Resolving it any other way would key a
  // verdict to a name the audio was never rendered under. First-speaking order because it
  // is the order the backend numbers the voices in (server.py:4355-4367), so the rows read
  // top-to-bottom the way the take plays.
  const speakersOf = useCallback((shot: Shot): string[] => {
    const out: string[] = []
    for (const d of shot.dialogue ?? []) {
      if (!d.text?.trim()) continue
      const name = assetMap[d.characterId]?.name ?? d.characterId
      if (name && !out.includes(name)) out.push(name)
    }
    return out
  }, [assetMap])

  // 3.2b: a speaker's standing verdict on the shot's clip. READ-TIME DEFAULT, which is the
  // whole reason `migrate()` stays a no-op (pipeline.store.ts:628-631): a board written
  // before per-voice verdicts existed carries ONE verdict for the whole clip, so that
  // verdict IS every speaker's until somebody says otherwise. Without it a pre-2026-08-09
  // approved clip would show "0/2 voices approved" while Stage 5 went on consuming it as
  // approved (FinalGenView.tsx:742). `??` and not `||`: an explicit `false` must survive.
  const voiceApproved = useCallback((board: ShotBoardState | undefined, speaker: string) =>
    (board?.dialogueSpeakerApproved ?? {})[speaker] ?? board?.dialogueApproved === true, [])

  // ── Generate boards (whole scene, or a single shot for regen-with-notes) ────

  // The `shots` array EVERY board request carries — built HERE, once, for all four
  // call sites (prompt assembly, per-scene generate, "Board all scenes", autopilot).
  // The batch and the autopilot used to assemble their own copies and both had
  // drifted: no `segmentShots` key at all. StoryboardShotIn defaults that field to [],
  // so an omitted key is indistinguishable from a deliberately empty one and the
  // backend silently fell back to its uniform ~1-beat-per-1.5s grid — a segment whose
  // real cuts are 2s + 6s came back as five 1.6s beats, a rhythm the render will not
  // have. Anything a board needs goes in this function, never at a call site.
  // `scene` is a parameter because the batch and the autopilot board scenes OTHER than
  // the one on screen, and isSceneFinal is per-scene; it defaults to the active one.
  const shotPayload = useCallback((targetShots: Shot[], scene?: { shotIds?: string[]; segmentIds?: string[] } | null) => {
    const sc = scene ?? activeScene
    // THE ROOM THE SCENE HAPPENS IN, resolved once from every shot of the scene — not
    // from the shots being boarded. A shot whose `assetsUsed` omits the environment sends
    // a board request with no location, and the endpoint reserves its two environment
    // slots from the shot's own asset list: no angle sheet, no base plate, and Seedream
    // draws a room of its own invention. DRAMA QUEEN 3, 2026-08-14: SHOT_003 came back a
    // different kitchen, in different light, from the other three boards of its scene.
    //
    // It must be resolved from the SCENE and not from `targetShots`, because Regen sends
    // ONE shot: with the single-shot payload there is nobody to inherit from, which is
    // precisely the button a director presses to fix a board that came out wrong.
    // The breakdown links these at source now (_ensure_scene_environments) — this is what
    // rescues the breakdowns already on disk, 16 of 18 projects on this machine.
    const sceneEnv = (() => {
      const ids = sc ? boardIds(sc) : []
      for (const sid of ids) {
        const shot = shots.find((x) => x.id === sid)
        for (const aid of shot?.assetsUsed ?? []) {
          const a = assetMap[aid]
          if (a?.type === 'environment') return a
        }
      }
      return undefined
    })()
    return targetShots.map((s) => ({
      // LO QUE EL DIRECTOR ELIGIÓ PARA ESTE TABLERO. Va en el mismo payload que usan el
      // preview y el render, así que lo que ve en la tarjeta es lo que se dibuja.
      extra_refs: (boardRefMedia[s.id]?.images ?? [])
        .filter((im) => im.url && im.role === 'reference_image').map((im) => im.url),
      exclude_refs: boardExclusions[s.id] ?? [],
      id: s.id, action: s.action, cameraAngle: s.cameraAngle ?? '',
      lighting: s.lighting ?? '',
      estimatedDuration: s.estimatedDuration,
      // scene-final shot closes on a held pose under isolated light
      isSceneFinal: sc ? boardIds(sc)[boardIds(sc).length - 1] === s.id : false,
      // Acting direction — the boards should show HOW the beat is played, not just what happens.
      performance: s.performance ?? '',
      // Conceptual thread: the approved look of the assets in THIS shot → the board
      // draws the real characters/props (wardrobe, helmet), not a generic figure.
      assets: (() => {
        const own = (s.assetsUsed ?? []).map((id) => assetMap[id]).filter(Boolean)
        // Append, never replace: a shot that names its own location keeps it, and a
        // second one (rare, and the endpoint handles it) is not displaced.
        return own.some((a) => a?.type === 'environment') || !sceneEnv
          ? own : [...own, sceneEnv]
      })(),
      // The shots inside this segment — the board's beats come straight from them
      // rather than from a uniform time grid the render will not honour.
      segmentShots: (segmentOf(s.id)?.shots ?? []).map((x) => ({
        duration_sec: x.durationSecs, shot_size: x.shotSize,
        camera_move: x.cameraMove, layout: x.layout, action: x.action,
      })),
    }))
  }, [activeScene, assetMap, segmentOf, shots, boardRefMedia, boardExclusions])

  // Item 0: dry-run — Claude writes the beats + exact board prompt, NO render.
  // The prompt lands in a PromptPanel on the shot card for review/editing.
  const prepareBoardPrompt = useCallback(async (shot: Shot, notes?: string) => {
    if (!activeScene) return
    setPreparingShotId(shot.id)
    updateAgent('cinematic', { status: 'active', detail: `Writing board prompt: ${shot.id}…`, progress: 10 })
    try {
      const { data } = await apiClient.post<{ items: PendingBoardSpec[]; max_refs?: number }>('/api/storyboard/assemble', {
        cast_names: Object.values(assetMap).filter((a) => a.type === 'character').map((a) => a.name),
        scene_id: activeScene.id,
        scene_heading: activeScene.heading,
        shots: shotPayload([shot]),
        aspect_ratio: aspectRatio,
            // Locked project style — the board renders in THIS style, not hardcoded photoreal
            style_label: style.id,
            style_suffix: style.promptSuffix,
        notes: notes ?? '',
        project_name: projectName,
        project_path: localFolderRoot ?? '',
      }, { timeout: 300_000 })
      const item = data.items.find((i) => i.shot_id === shot.id) ?? data.items[0]
      if (item) setPendingSpecs((prev) => ({ ...prev, [shot.id]: item }))
      // El tope viene del servidor en vez de estar copiado aquí: BOARD_MAX_REFS no tiene
      // hoy ningún espejo en el frontend y crear uno es fabricar una constante que se
      // puede quedar atrás sin que nadie lo note.
      if (typeof data.max_refs === 'number') setBoardMaxRefs(data.max_refs)
      updateAgent('cinematic', { status: 'completed', detail: `Board prompt ready: ${shot.id}` })
    } catch (e: unknown) {
      toastError(`Prompt assembly failed: ${shot.id}`, e instanceof Error ? e.message : 'error')
      updateAgent('cinematic', { status: 'error', detail: 'Board prompt assembly failed' })
    } finally {
      setPreparingShotId(null)
    }
  }, [activeScene, aspectRatio, projectName, localFolderRoot, shotPayload, updateAgent, toastError, style, assetMap])

  // 3.2: dialogue clips (Seed Audio 1.0, locked voices) for a set of shots —
  // concurrent (4), auto-approved (listen + Regenerate on each board afterwards).
  // Called AUTOMATICALLY right after boards land, and by the manual batch button.
  const [dialogueBatchRunning, setDialogueBatchRunning] = useState(false)
  const generateDialogueClips = useCallback(async (targets: Array<{ sceneId: string; shotId: string }>) => {
    if (!targets.length) return
    setDialogueBatchRunning(true)
    updateAgent('cinematic', { status: 'active', detail: `Dialogue: 0/${targets.length}…`, progress: 0 })
    let idx = 0, done = 0
    const worker = async () => {
      for (;;) {
        const i = idx++
        if (i >= targets.length) return
        const { sceneId, shotId } = targets[i]
        const shot = shots.find((sh) => sh.id === shotId)
        const lines = (shot?.dialogue ?? []).filter((d) => d.text?.trim()).map((d) => ({
          character: assetMap[d.characterId]?.name ?? d.characterId, text: d.text, emotion: d.emotion,
        }))
        if (lines.length) {
          try {
            const res = await pipelineApi.renderDialogueClip({ shotId, dialogue: lines, projectName, projectPath: localFolderRoot ?? '',
              // Scene mode: ONE take with the voices overlapping, when the breakdown
              // wrote a direction for it. Empty → the per-line concat of before.
              dialogueScene: shot?.dialogueScene ?? '' })
            const cur = getScene(sceneId)
            const b = cur.shotBoards[shotId]
            if (b) updateScene(sceneId, { shotBoards: { ...cur.shotBoards, [shotId]: {
              ...b, dialogueClipPath: res.path, dialogueApproved: true,
              // 3.2b: a fresh clip voids every earlier per-voice verdict — they were about
              // audio that no longer exists. This path has ALWAYS marked its own clips
              // approved (nobody has heard them either way), so the map is seeded to AGREE
              // with that flag instead of contradicting it: an empty map beside
              // dialogueApproved:true would read "0/2 voices approved" on a shot Stage 5
              // already consumes. Un-tick a voice on the board to take it back for a listen.
              dialogueSpeakerApproved: Object.fromEntries((shot ? speakersOf(shot) : []).map((s) => [s, true])),
            } } })
          } catch { /* skip one, keep going */ }
        }
        done++
        updateAgent('cinematic', { status: 'active', detail: `Dialogue: ${done}/${targets.length}…`, progress: Math.round(100 * done / targets.length) })
      }
    }
    // ONE worker, not four. Dialogue goes through the same content-risk audit as the
    // music, and this repo's own live A/B (2026-07-12, documented at the soundtrack
    // generator) measured that audit rejecting parallel bursts 3-4 times out of 4 while
    // spaced sequential calls passed 4 of 5. The music path was moved to sequential for
    // exactly that reason; the dialogue batch was left at four and has been paying the
    // rejection rate ever since — and a rejected line is a silent shot, not an error.
    await worker()
    updateAgent('cinematic', { status: 'completed', detail: `Dialogue generated: ${targets.length}`, progress: 100 })
    setDialogueBatchRunning(false)
  }, [shots, assetMap, projectName, localFolderRoot, getScene, updateScene, updateAgent, speakersOf])

  // Recover boards stranded by a reload mid-render: the backend finished and
  // saved them to disk, but the awaiting tab died before the response landed, so
  // the scene sits on 'generating' forever with zero boards. On mount, any shot
  // with no board in state asks the backend for its latest disk version (+ meta
  // sidecar) and restores it — nothing is regenerated. Mirrors AG's recovery.
  const recoveredRef = useRef(false)
  useEffect(() => {
    if (recoveredRef.current || !scenes.length) return
    recoveredRef.current = true
    void (async () => {
      // Query a shot's latest disk board if its slot is EMPTY (fill it), OR its scene is stranded
      // on 'generating' — a regen whose async write was orphaned by navigating away mid-render
      // (3-bug1a) — so we can pick up a disk version NEWER than what's in state.
      const toQuery = new Set<string>()
      for (const sc of scenes) {
        const st = getScene(sc.id)
        const sceneStranded = st.status === 'generating'
        for (const sid of boardIds(sc)) {
          if (!st.shotBoards?.[sid]?.boardLocalPath || sceneStranded) toQuery.add(sid)
        }
      }
      const stranded = scenes.filter((sc) => getScene(sc.id).status === 'generating')
      if (!toQuery.size && !stranded.length) return
      let found = new Map<string, { shot_id: string; board_local_path: string; version: number; rows: number; cols: number; panels: StoryboardBeat[]; auto_prompt: string; sent_prompt: string }>()
      if (toQuery.size) {
        try {
          const { data } = await apiClient.get<{ boards: Array<{ shot_id: string; board_local_path: string; version: number; rows: number; cols: number; panels: StoryboardBeat[]; auto_prompt: string; sent_prompt: string }> }>(
            '/api/storyboard/recover', {
              params: { project_name: projectName, project_path: localFolderRoot ?? '', shot_ids: [...toQuery].join(',') },
            })
          found = new Map(data.boards.map((b) => [b.shot_id, b]))
        } catch { /* recovery is best-effort */ }
      }
      const recoveredShots: Array<{ sceneId: string; shotId: string }> = []
      for (const sc of scenes) {
        const st = getScene(sc.id)
        const boards = { ...st.shotBoards }
        let changed = false
        for (const sid of boardIds(sc)) {
          const rec = found.get(sid)
          // Fill an empty slot OR refresh when disk holds a NEWER version than state — a
          // regenerated board whose write was lost to an unmount mid-render (3-bug1a).
          if (rec && (!boards[sid]?.boardLocalPath || rec.version > (boards[sid]?.version ?? 0))) {
            boards[sid] = {
              status: 'pending', boardUrl: '', boardLocalPath: rec.board_local_path,
              version: rec.version, rows: rec.rows, cols: rec.cols, panels: rec.panels,
              notes: '', autoPrompt: rec.auto_prompt, sentPrompt: rec.sent_prompt,
            }
            changed = true
            recoveredShots.push({ sceneId: sc.id, shotId: sid })
          }
        }
        const isStranded = st.status === 'generating'
        if (changed || isStranded) {
          const anyBoard = Object.values(boards).some((b) => b?.boardLocalPath)
          updateScene(sc.id, { shotBoards: boards, status: anyBoard ? 'pending' : 'idle' })
        }
      }
      if (recoveredShots.length) {
        success('Boards recovered', `${recoveredShots.length} board(s) restored from disk — nothing regenerated`)
        // 3.2: recovered shots with dialogue get their voice clips too (auto flow)
        const dlg = recoveredShots.filter(({ shotId }) => {
          const sh = shots.find((x) => x.id === shotId)
          return sh && (sh.dialogue ?? []).some((d) => d.text?.trim())
        })
        if (dlg.length) void generateDialogueClips(dlg)
      }
    })()
    // run-once on mount per project — recoveredRef guards re-fires
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes])

  // Camera Director QC over a WHOLE scene's boards. Advisory and fire-and-forget: the
  // boards are already on screen, so a QC hiccup must never flip the stage to error.
  //
  // Factored out because it used to live inside generateBoards only — the single-scene
  // path. "Board all scenes" and the autopilot never ran it, so a film boarded either of
  // those ways was never looked at: BLOOM shipped 41 boards with a character crossing the
  // axis between two beats of one shot and a kitchen with windows on both walls, and the
  // one gate that reads ALL the scene's boards together (it is the only thing that can
  // see cross-panel drift) had not run once. Same lesson as buildRenderPayload in stage 6:
  // a second call site is how a step gets silently dropped.
  const runSceneQC = useCallback((sceneId: string, heading: string,
                                  boards: Record<string, ShotBoardState>, sceneShots: Shot[]) => {
    void (async () => {
      try {
        const allPanels = Object.values(boards).flatMap((bd) => bd.panels)
        const boardUrls = Object.values(boards)
          .map((bd) => bd.boardLocalPath || bd.boardUrl).filter((u): u is string => !!u)
        if (!boardUrls.length) return
        const { data: qc } = await apiClient.post<QCResponse>('/api/storyboard/qc', {
          scene_id: sceneId,
          scene_heading: heading,
          panels: allPanels,
          shots: sceneShots.map((s) => ({ id: s.id, action: s.action, cameraAngle: s.cameraAngle ?? '' })),
          board_urls: boardUrls,
          grid_url: boardUrls[0] ?? '',
        }, { timeout: 300_000 })
        if (!isCurrentProject()) return
        updateScene(sceneId, { qcResult: qc })
        updateAgent('cinematic', { status: qc.passed ? 'completed' : 'active', detail: qc.summary })
      } catch (qe: unknown) {
        const msg = qe instanceof Error ? qe.message : 'Storyboard QC failed'
        console.warn('[Storyboard] advisory QC skipped:', msg)
        updateAgent('cinematic', { status: 'completed', detail: 'Boards ready (QC skipped)' })
      }
    })()
  }, [isCurrentProject, updateScene, updateAgent])

  const generateBoards = useCallback(async (targetShots: Shot[], notes?: string, boardsSpec?: PendingBoardSpec[]) => {
    if (!activeScene || !targetShots.length) return
    const busyIds = targetShots.map((s) => s.id)
    markShotsBusy(busyIds, true)
    updateScene(activeScene.id, { status: 'generating' })
    updateAgent('cinematic', { status: 'active', detail: `Storyboarding ${activeScene.id}…`, progress: 10 })
    try {
      const { data } = await apiClient.post<BoardResponse>('/api/storyboard/generate', {
        cast_names: Object.values(assetMap).filter((a) => a.type === 'character').map((a) => a.name),
        scene_id: activeScene.id,
        scene_heading: activeScene.heading,
        shots: shotPayload(targetShots),
        aspect_ratio: aspectRatio,
            // Locked project style — the board renders in THIS style, not hardcoded photoreal
            style_label: style.id,
            style_suffix: style.promptSuffix,
        notes: notes ?? '',
        project_name: projectName,
        project_path: localFolderRoot ?? '',
        // Item 0: a reviewed (possibly edited) spec is rendered VERBATIM
        boards_spec: boardsSpec ?? [],
      }, { timeout: 900_000 })

      // Guard the completion write against a mid-render project switch (mirrors the batch/autopilot
      // runners) — a stale generateBoards must never write this scene's boards into another project.
      // (If the SAME project's view unmounted via navigation, the disk save + version-aware recovery
      // above restore the regenerated board on return — 3-bug1a.)
      if (!isCurrentProject()) return

      const updatedBoards: Record<string, ShotBoardState> = { ...getScene(activeScene.id).shotBoards }
      for (const b of data.boards) {
        const prevBoard = updatedBoards[b.shot_id]
        updatedBoards[b.shot_id] = {
          status: 'pending',
          boardUrl: b.board_url,
          boardLocalPath: b.board_local_path,
          version: b.version,
          rows: b.rows, cols: b.cols,
          panels: b.panels,
          notes: '',
          autoPrompt: b.auto_prompt,
          sentPrompt: b.sent_prompt,
          // A board regen must NOT lose the shot's dialogue clip — the audio depends
          // on the LINES, not the board pixels (replacing the record wiped it before).
          // The per-voice verdicts travel WITH it (3.2b): they describe that same clip,
          // and losing them while dialogueApproved survived would show "0/2 voices
          // approved" on a shot Stage 5 already treats as approved.
          ...(prevBoard?.dialogueClipPath
            ? {
                dialogueClipPath: prevBoard.dialogueClipPath,
                dialogueApproved: prevBoard.dialogueApproved,
                dialogueSpeakerApproved: prevBoard.dialogueSpeakerApproved,
              }
            : {}),
        }
      }
      // Generated boards consume their pending review specs
      setPendingSpecs((prev) => {
        const next = { ...prev }
        for (const b of data.boards) delete next[b.shot_id]
        return next
      })
      updateScene(activeScene.id, { status: 'pending', shotBoards: updatedBoards })
      updateAgent('cinematic', { status: 'active', detail: `Boards ready: ${activeScene.id}`, progress: 70 })

      // 3.2: the dialogue is generated AUTOMATICALLY together with the boards
      // (Seed Audio 1.0, locked voices) — listen/direct/Regenerate on each board.
      const dlgTargets = targetShots
        .filter((sh) => (sh.dialogue ?? []).some((d) => d.text?.trim())
          && updatedBoards[sh.id] && !updatedBoards[sh.id].dialogueClipPath)
        .map((sh) => ({ sceneId: activeScene.id, shotId: sh.id }))
      if (dlgTargets.length) void generateDialogueClips(dlgTargets)

      // Camera Director QC — advisory, shared with the batch and autopilot paths.
      runSceneQC(activeScene.id, activeScene.heading, updatedBoards, sceneShots)
    } catch (e: unknown) {
      if (!isCurrentProject()) return   // switched project mid-render — don't touch the new project's state
      const msg = e instanceof Error ? e.message : 'Storyboard generation failed'
      updateScene(activeScene.id, { status: 'idle' })
      toastError(`Storyboard failed: ${activeScene.id}`, msg)
      updateAgent('cinematic', { status: 'error', detail: msg })
    } finally {
      markShotsBusy(busyIds, false)
    }
  }, [activeScene, sceneShots, aspectRatio, projectName, localFolderRoot, getScene, updateScene, updateAgent, toastError, shotPayload, markShotsBusy, style, generateDialogueClips, isCurrentProject, runSceneQC, assetMap])

  const handleApproveShotBoard = useCallback((shotId: string) => {
    if (!activeSceneId) return
    const st = getScene(activeSceneId)
    const board = st.shotBoards[shotId]
    if (!board) return
    updateScene(activeSceneId, {
      shotBoards: { ...st.shotBoards, [shotId]: { ...board, status: 'approved' } },
    })
  }, [activeSceneId, getScene, updateScene])

  // Generic per-shot board patch (dialogue clip, approval, …).
  const patchBoard = useCallback((shotId: string, patch: Partial<ShotBoardState>) => {
    if (!activeSceneId) return
    const st = getScene(activeSceneId)
    const board = st.shotBoards[shotId]
    if (!board) return
    updateScene(activeSceneId, { shotBoards: { ...st.shotBoards, [shotId]: { ...board, ...patch } } })
  }, [activeSceneId, getScene, updateScene])

  // 3.2: render the shot's dialogue with the characters' LOCKED voices (Seed Audio 1.0)
  // next to the board — generate → preview → approve. The approved clip feeds SG.
  const [dialogueBusyShot, setDialogueBusyShot] = useState<string | null>(null)
  const handleGenerateDialogueClip = useCallback(async (shot: Shot) => {
    const lines = (shot.dialogue ?? []).filter((d) => d.text?.trim()).map((d) => ({
      character: assetMap[d.characterId]?.name ?? d.characterId, text: d.text, emotion: d.emotion,
    }))
    if (!lines.length) return
    setDialogueBusyShot(shot.id)
    try {
      const res = await pipelineApi.renderDialogueClip({
        shotId: shot.id, dialogue: lines, projectName, projectPath: localFolderRoot ?? '',
        // Scene mode: ONE take with the voices overlapping, when the breakdown wrote
        // a direction for it. Empty → the per-line concat this always produced.
        dialogueScene: shot.dialogueScene ?? '',
      })
      patchBoard(shot.id, {
        dialogueClipPath: res.path, dialogueApproved: false,
        // 3.2b: a regenerated take is DIFFERENT audio, so every per-voice verdict from the
        // previous one is void. Cleared rather than carried, or a voice would stay ticked
        // on a clip nobody has heard — approving starts again, one speaker at a time.
        dialogueSpeakerApproved: {},
      })
    } catch (e: unknown) {
      toastError('Dialogue failed', e instanceof Error ? e.message : 'error')
    } finally {
      setDialogueBusyShot(null)
    }
  }, [assetMap, projectName, localFolderRoot, patchBoard, toastError])

  // 3.2b: approve — or take back — ONE speaker's voice in the shot's dialogue clip.
  // A two- or three-hander is a single fused take (the whole point: they talk OVER each
  // other, and server.py:4470-4474 says such a render cannot be split back per speaker),
  // so the only per-speaker thing that exists is the VERDICT. `dialogueApproved` is
  // recomputed from the whole map here and never written on its own, because that flag is
  // what Stage 5 gates the clip on (FinalGenView.tsx:742) — if it could be true while one
  // voice was still unheard, "approved" would mean nothing.
  const setSpeakerApproval = useCallback((shot: Shot, speaker: string, approved: boolean) => {
    if (!activeSceneId) return
    const st = getScene(activeSceneId)
    const board = st.shotBoards[shot.id]
    if (!board) return
    const speakers = speakersOf(shot)
    // Materialise the read-time default before editing it, so touching ONE voice on a
    // pre-2026-08-09 board does not silently drop the other voices' inherited verdict.
    const next: Record<string, boolean> = Object.fromEntries(
      speakers.map((s) => [s, voiceApproved(board, s)]))
    next[speaker] = approved
    updateScene(activeSceneId, {
      shotBoards: {
        ...st.shotBoards,
        [shot.id]: {
          ...board,
          dialogueSpeakerApproved: next,
          // every() over a one-speaker list is exactly today's single Approve button, so
          // the one-voice shot keeps behaving the way it always has.
          dialogueApproved: speakers.length > 0 && speakers.every((s) => next[s] === true),
        },
      },
    })
  }, [activeSceneId, getScene, updateScene, speakersOf, voiceApproved])

  // 3.2b: audition ONE character's voice on its own. The shot's clip is a single fused take
  // and cannot be split per speaker, so a per-voice audition has to be a fresh render, and
  // it goes through /api/voice/preview for three reasons: it speaks that character's LOCKED
  // config through the same engine production uses; it answers with a data URI and writes
  // nothing to disk (/api/shot/dialogue-clip would OVERWRITE Shots/<id>/dialogue.mp3 —
  // re-rendering a subset of the lines through it would destroy the take the user is
  // judging); and it is the ONLY call in this flow that reports `voice_fallback`, i.e. that
  // Seed Audio rejected the reference and what you just heard is a generic substitute.
  // It is a paid render, so it fires on an explicit click only — never with the boards.
  const [auditionBusy, setAuditionBusy] = useState('')                    // `${shotId}::${speaker}`
  const [auditions, setAuditions] = useState<Record<string, { url: string; fellBack: boolean }>>({})
  // Locked voices, fetched once and remembered WITH the project they came from — a cache
  // that outlived a project switch would audition this film's character in another film's
  // voice. In a ref, never in the store: these clips are `data:` URIs and partializeState
  // blanks every string starting with `data:` (pipeline.store.ts:210-219), so a persisted
  // audition would come back as an empty <audio src>.
  const voicesRef = useRef<{ project: string; voices: Record<string, VoiceConfig> } | null>(null)
  const handleAuditionSpeaker = useCallback(async (shot: Shot, speaker: string) => {
    const key = `${shot.id}::${speaker}`
    setAuditionBusy(key)
    try {
      if (voicesRef.current?.project !== projectName) {
        const { voices } = await pipelineApi.getCharacterVoices(projectName, localFolderRoot ?? '')
        voicesRef.current = { project: projectName, voices: voices ?? {} }
      }
      const cfg = voicesRef.current.voices[speaker]
      if (!cfg) {
        // Not an error: it means this character never got a voice lock, so the clip spoke
        // them in the default voice. Say which it is instead of auditioning a stand-in.
        toastError(`No locked voice for ${speaker}`, 'Lock one in Stage 3 (Voice lock) — this character is speaking in the default voice')
        return
      }
      // The line they actually speak in THIS shot, so the audition is the performance being
      // judged and not a stock sentence. The config is narrowed field by field rather than
      // spread: a locked voice also carries its whole `versions` history, which the preview
      // request has no use for.
      const line = (shot.dialogue ?? []).find(
        (d) => (assetMap[d.characterId]?.name ?? d.characterId) === speaker && d.text?.trim())?.text
      const { audio_b64, voice_fallback } = await pipelineApi.previewVoice({
        speaker: cfg.speaker, pitch_rate: cfg.pitch_rate, speech_rate: cfg.speech_rate,
        loudness_rate: cfg.loudness_rate ?? 0, engine: cfg.engine ?? 'seed_tts',
        ref_audio_path: cfg.ref_audio_path ?? '', image_ref_path: cfg.image_ref_path ?? '',
      }, line || undefined)
      if (!isCurrentProject()) return   // switched project mid-audition — never write into the new one
      setAuditions((prev) => ({ ...prev, [key]: { url: audio_b64, fellBack: voice_fallback } }))
    } catch (e: unknown) {
      toastError(`Audition failed: ${speaker}`, e instanceof Error ? e.message : 'error')
    } finally {
      // Only clear OUR spinner: two auditions can overlap and the slower one must not
      // un-spin the button the user is still waiting on.
      setAuditionBusy((cur) => (cur === key ? '' : cur))
    }
  }, [assetMap, projectName, localFolderRoot, isCurrentProject, toastError])

  // Batch: generate the dialogue for EVERY shot with dialogue in one go (no more
  // clicking 60 shots). Concurrent, auto-approved (the user can regenerate any one).
  const dialogueTargets = useMemo(() => {
    const out: Array<{ sceneId: string; shotId: string }> = []
    for (const sc of scenes) {
      const st = sceneStates[sc.id]
      for (const sid of boardIds(sc)) {
        const shot = shots.find((s) => s.id === sid)
        const board = st?.shotBoards?.[sid]
        if (shot && (shot.dialogue ?? []).some((d) => d.text?.trim()) && board && !board.dialogueClipPath) {
          out.push({ sceneId: sc.id, shotId: sid })
        }
      }
    }
    return out
  }, [scenes, sceneStates, shots])
  const handleGenerateAllDialogue = useCallback(
    () => generateDialogueClips(dialogueTargets),
    [generateDialogueClips, dialogueTargets])

  // Item 8: reopen an approved board — never strand the user downstream
  const handleReopenShotBoard = useCallback((shotId: string) => {
    if (!activeSceneId) return
    const st = getScene(activeSceneId)
    const board = st.shotBoards[shotId]
    if (!board) return
    updateScene(activeSceneId, {
      status: 'pending',
      shotBoards: { ...st.shotBoards, [shotId]: { ...board, status: 'pending' } },
    })
    if (stage4.status === 'approved') {
      usePipelineStore.getState().setStageStatus(4, 'pending_review')
    }
  }, [activeSceneId, getScene, updateScene, stage4.status])

  const handleShotNotes = useCallback((shotId: string, notes: string) => {
    if (!activeSceneId) return
    const st = getScene(activeSceneId)
    const board = st.shotBoards[shotId] ?? { status: 'idle', boardUrl: '', boardLocalPath: '', version: 0, rows: 1, cols: 1, panels: [], notes: '' }
    updateScene(activeSceneId, { shotBoards: { ...st.shotBoards, [shotId]: { ...board, notes } } })
  }, [activeSceneId, getScene, updateScene])

  const handleLock = useCallback(() => {
    const versionId = commitVersion(4, { sceneStates })
    approveVersion(4, versionId)
    success('Storyboards locked ✓', 'Moving to SG →')
    goToStage(5)
  }, [sceneStates, commitVersion, approveVersion, goToStage, success])

  // Approve every existing board across all scenes in one click (the per-board
  // Approve, batched). Useful for a reconstructed/finished project and for fast
  // review; the "Lock → SG" button then appears.
  const handleApproveAllBoards = useCallback(() => {
    setSceneStates((prev) => {
      const next = { ...prev }
      for (const scene of scenes) {
        const st = next[scene.id] ?? EMPTY_SCENE_STATE
        const boards: Record<string, ShotBoardState> = { ...st.shotBoards }
        let changed = false
        for (const sid of boardIds(scene)) {
          const b = boards[sid]
          if (b?.boardLocalPath && b.status !== 'approved') {
            boards[sid] = { ...b, status: 'approved' }
            changed = true
          }
        }
        if (changed) next[scene.id] = { ...EMPTY_SCENE_STATE, ...st, shotBoards: boards }
      }
      return next
    })
    success('All boards approved', 'Review, or Lock Storyboards → SG')
  }, [scenes, success])

  // Any board image exists but not every scene is approved yet
  const anyBoards = scenes.some((sc) => boardIds(sc).some((sid) => getScene(sc.id).shotBoards[sid]?.boardLocalPath))

  // P5c.3: Autopilot runner — board EVERY scene, then either PAUSE for review
  // (manual gate) or auto-approve + lock and continue (auto gate). Mirrors the
  // Stage 3 runner pattern: a ref always points at the latest closure and a
  // stable runner registered once delegates to it. Boards are accumulated into
  // a local working copy so commit/approve reads the freshly-generated set
  // directly (never racing the async setState). QC is advisory and skipped here.
  // ── "Board all scenes": one click boards EVERY scene, resumably ─────────────
  // Long-form projects have 10+ scenes; clicking through them one by one doesn't
  // scale. Per-scene progressive commits (updateScene → persist effect) mean a
  // Stop / failure / reload loses nothing — re-running skips boarded shots.
  const stopBatchRef = useRef(false)
  const handleBoardAllScenes = async () => {
    if (!scenes.length || batchRunning) return
    stopBatchRef.current = false
    setBatchRunning(true)
    let boardsMade = 0
    let failedScenes = 0
    // 3-bug2: bounded worker pool over scenes (was a strictly-serial for-loop). Workers
    // pull DISJOINT scene indices; each reads/writes only its own scene.id. The backend
    // global board semaphore keeps total BytePlus load unchanged.
    let nextIndex = 0
    let completedScenes = 0
    const runWorker = async () => {
      for (;;) {
        if (stopBatchRef.current) return
        const si = nextIndex++
        if (si >= scenes.length) return
        const scene = scenes[si]
        const targetShots = shots.filter((s) => boardIds(scene).includes(s.id))
        const cur = getScene(scene.id)
        const sceneUnboarded = targetShots.filter((s) => !cur.shotBoards?.[s.id]?.boardLocalPath)
        if (!sceneUnboarded.length) { completedScenes++; continue }
        updateAgent('cinematic', {
          status: 'active',
          detail: `Boarding ${scene.id} (${sceneUnboarded.length} shots)…`,
          progress: Math.round((completedScenes / scenes.length) * 100),
        })
        updateScene(scene.id, { status: 'generating' })
        // Mark this scene's shots busy so a per-shot Regen elsewhere isn't blocked,
        // but this scene's own shots can't be double-fired mid-batch.
        const sceneBusyIds = sceneUnboarded.map((s) => s.id)
        markShotsBusy(sceneBusyIds, true)
        // A failing scene must not kill the batch — mark it, continue with the next.
        try {
          const { data } = await apiClient.post<BoardResponse>('/api/storyboard/generate', {
        cast_names: Object.values(assetMap).filter((a) => a.type === 'character').map((a) => a.name),
            scene_id: scene.id,
            scene_heading: scene.heading,
            // Same shots array the manual path sends, from the same builder — this
            // path used to build its own and had silently lost the segment's real
            // cuts (see shotPayload).
            shots: shotPayload(sceneUnboarded, scene),
            aspect_ratio: aspectRatio,
            // Locked project style — the board renders in THIS style, not hardcoded photoreal
            style_label: style.id,
            style_suffix: style.promptSuffix,
            notes: '',
            project_name: projectName,
            project_path: localFolderRoot ?? '',
            boards_spec: [],
          }, { timeout: 900_000 })
          if (!isCurrentProject()) { stopBatchRef.current = true; return }   // switched mid-batch — stop peers too, never write cross-project
          const boards: Record<string, ShotBoardState> = { ...getScene(scene.id).shotBoards }
          for (const b of data.boards) {
            const prevBoard = boards[b.shot_id]
            boards[b.shot_id] = {
              status: 'pending',
              boardUrl: b.board_url, boardLocalPath: b.board_local_path,
              version: b.version, rows: b.rows, cols: b.cols, panels: b.panels,
              notes: '', autoPrompt: b.auto_prompt, sentPrompt: b.sent_prompt,
              // Board regen must not lose the dialogue clip (audio follows the lines),
              // nor the per-voice verdicts that describe it (3.2b)
              ...(prevBoard?.dialogueClipPath
                ? {
                    dialogueClipPath: prevBoard.dialogueClipPath,
                    dialogueApproved: prevBoard.dialogueApproved,
                    dialogueSpeakerApproved: prevBoard.dialogueSpeakerApproved,
                  }
                : {}),
            }
          }
          updateScene(scene.id, { status: 'pending', shotBoards: boards })
          // Mismo gate que la ruta manual. Sin esto una película entera boardeada por
          // el autopilot no se mira ni una vez (BLOOM: 41 boards, 0 pasadas de QC).
          runSceneQC(scene.id, scene.heading, boards, targetShots ?? unboarded)
          boardsMade += data.boards.length
          // 3.2: dialogue auto-generates with the boards (fire-and-forget per scene)
          const dlgT = sceneUnboarded
            .filter((sh) => (sh.dialogue ?? []).some((d) => d.text?.trim())
              && boards[sh.id] && !boards[sh.id].dialogueClipPath)
            .map((sh) => ({ sceneId: scene.id, shotId: sh.id }))
          if (dlgT.length) void generateDialogueClips(dlgT)
        } catch (e: unknown) {
          failedScenes++
          updateScene(scene.id, { status: 'idle' })
          const msg = e instanceof Error ? e.message : 'Storyboard generation failed'
          toastError(`Storyboard failed: ${scene.id}`, `${msg} — continuing with the next scene`)
        } finally {
          markShotsBusy(sceneBusyIds, false)
          completedScenes++
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(SCENE_BATCH_CONCURRENCY, scenes.length) }, runWorker))
      updateAgent('cinematic', {
        status: 'completed',
        detail: stopBatchRef.current
          ? `Stopped — ${boardsMade} boards made; "Board all scenes" resumes where it left off`
          : `All scenes boarded: ${boardsMade} new boards${failedScenes ? ` · ${failedScenes} scene(s) failed` : ''}`,
        progress: 100,
      })
    } finally {
      setBatchRunning(false)
    }
  }

  const autopilotStage4 = useCallback(async (): Promise<AutopilotResult> => {
    if (!scenes.length) return 'error'
    const autoApprove = gateMode === 'auto'
    setBatchRunning(true)
    updateAgent('cinematic', { status: 'active', detail: 'Autopilot: storyboarding every scene…', progress: 5 })
    const work: Record<string, SceneStoryboardState> = Object.fromEntries(
      Object.entries(sceneStates).map(([k, v]) => [k, { ...v }]),
    )
    try {
      // 3-bug2: bounded worker pool over scenes (was strictly serial). Workers pull
      // DISJOINT indices and mutate `work` only at their own scene.id — race-free
      // (JS single-threaded between awaits). The backend global board semaphore keeps
      // total BytePlus load unchanged; the post-loop isCurrentProject guard is preserved.
      let nextIndex = 0
      const runWorker = async () => {
        for (;;) {
          const si = nextIndex++
          if (si >= scenes.length) return
          const scene = scenes[si]
          const targetShots = shots.filter((s) => boardIds(scene).includes(s.id))
          const cur = work[scene.id] ?? EMPTY_SCENE_STATE
          const unboarded = targetShots.filter((s) => !cur.shotBoards?.[s.id]?.boardLocalPath)
          if (!unboarded.length) continue
          const { data } = await apiClient.post<BoardResponse>('/api/storyboard/generate', {
        cast_names: Object.values(assetMap).filter((a) => a.type === 'character').map((a) => a.name),
            scene_id: scene.id,
            scene_heading: scene.heading,
            // Same shots array the manual path sends, from the same builder. This path
            // assembled its own copy twice over: it lost `assets`, so an autopilot-boarded
            // episode drew generic figures instead of its own characters, and it lost
            // `segmentShots`, so the beats were a uniform grid (see shotPayload). Both
            // came back the same way — by copying a call site instead of sharing one.
            shots: shotPayload(unboarded, scene),
            aspect_ratio: aspectRatio,
            // Locked project style — the board renders in THIS style, not hardcoded photoreal
            style_label: style.id,
            style_suffix: style.promptSuffix,
            notes: '',
            project_name: projectName,
            project_path: localFolderRoot ?? '',
            boards_spec: [],
          }, { timeout: 900_000 })
          const boards: Record<string, ShotBoardState> = { ...cur.shotBoards }
          for (const b of data.boards) {
            const prevBoard = boards[b.shot_id]
            boards[b.shot_id] = {
              status: autoApprove ? 'approved' : 'pending',
              boardUrl: b.board_url, boardLocalPath: b.board_local_path,
              version: b.version, rows: b.rows, cols: b.cols, panels: b.panels,
              notes: '', autoPrompt: b.auto_prompt, sentPrompt: b.sent_prompt,
              // …and the per-voice verdicts with it (3.2b) — same reason as the two paths above
              ...(prevBoard?.dialogueClipPath
                ? {
                    dialogueClipPath: prevBoard.dialogueClipPath,
                    dialogueApproved: prevBoard.dialogueApproved,
                    dialogueSpeakerApproved: prevBoard.dialogueSpeakerApproved,
                  }
                : {}),
            }
          }
          work[scene.id] = { ...EMPTY_SCENE_STATE, ...cur, status: autoApprove ? 'approved' : 'pending', shotBoards: boards }
        }
      }
      await Promise.all(Array.from({ length: Math.min(SCENE_BATCH_CONCURRENCY, scenes.length) }, runWorker))
      if (!isCurrentProject()) return 'paused'   // project switched mid-run — never write cross-project
      setSceneStates(work)
      // The SAME gate the manual and batch paths run. Without it an unattended episode is
      // never looked at once: BLOOM shipped 41 boards — a character crossing the axis
      // between two beats of one shot, a kitchen with windows on both walls — and the one
      // check that reads a whole scene's boards TOGETHER (the only thing that can see
      // cross-panel drift) had not run a single time.
      for (const [scId, scState] of Object.entries(work)) {
        const sc = scenes.find((x) => x.id === scId)
        if (!sc) continue
        runSceneQC(scId, sc.heading, scState.shotBoards ?? {},
                   shots.filter((sh) => boardIds(sc).includes(sh.id)))
      }
      // 3.2: dialogue auto-generates with the boards in autopilot too
      const apDlg: Array<{ sceneId: string; shotId: string }> = []
      for (const [scId, scState] of Object.entries(work)) {
        for (const [sid, b] of Object.entries(scState.shotBoards ?? {})) {
          const sh = shots.find((x) => x.id === sid)
          if (sh && (sh.dialogue ?? []).some((d) => d.text?.trim()) && b.boardLocalPath && !b.dialogueClipPath) {
            apDlg.push({ sceneId: scId, shotId: sid })
          }
        }
      }
      if (apDlg.length) void generateDialogueClips(apDlg)
      if (autoApprove) {
        const versionId = commitVersion(4, { sceneStates: work })
        approveVersion(4, versionId)
        updateAgent('cinematic', { status: 'completed', detail: 'Storyboards auto-approved' })
        return 'done'
      }
      setStageStatus(4, 'pending_review')
      updateAgent('cinematic', { status: 'completed', detail: 'Storyboards ready — review & lock' })
      return 'paused'
    } catch (e: unknown) {
      updateAgent('cinematic', { status: 'error', detail: e instanceof Error ? e.message : 'Storyboard autopilot failed' })
      return 'error'
    } finally {
      setBatchRunning(false)
    }
  }, [scenes, shots, sceneStates, gateMode, aspectRatio, projectName, localFolderRoot, commitVersion, approveVersion, setStageStatus, updateAgent, style, generateDialogueClips, isCurrentProject, shotPayload, runSceneQC, assetMap])
  // Re-register whenever the runner's closure changes; the cleanup unregisters
  // the stale one so the controller always awaits the current generation logic.
  useEffect(() => registerAutopilotRunner(4, autopilotStage4), [autopilotStage4])

  // ── Gates ────────────────────────────────────────────────────────────────────

  if (stage3.status !== 'approved') {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <StageHeader stageId={4} label="Storyboard" />
        <div className="flex flex-1 items-center justify-center text-text-muted">
          <div className="text-center">
            <Film size={32} className="mx-auto mb-3 text-cyan/30" />
            <p className="text-sm">Approve assets in AG first.</p>
          </div>
        </div>
      </div>
    )
  }

  const qcResult = activeState.qcResult as QCResponse | null
  const unboarded = sceneShots.filter((s) => !activeState.shotBoards[s.id]?.boardLocalPath)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StageHeader stageId={4} label="Storyboard" />

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-2 bg-elevated border-b border-border shrink-0 flex-wrap">
        <Button
          variant="primary" size="sm" icon={<Pencil size={13} />}
          loading={isGenerating}
          onClick={() => generateBoards(unboarded.length ? unboarded : sceneShots)}
          disabled={alreadyLocked || !sceneShots.length}
        >
          {unboarded.length && unboarded.length < sceneShots.length
            ? `Board remaining shots (${unboarded.length})`
            : `Generate Boards (${sceneShots.length} shots)`}
        </Button>
        <Button
          variant="secondary" size="sm" icon={<Film size={13} />}
          loading={isGenerating}
          onClick={handleBoardAllScenes}
          disabled={alreadyLocked || totalUnboarded === 0}
          data-testid="board-all-scenes"
        >
          {totalUnboarded === 0 ? 'All scenes boarded ✓' : `Board all scenes (${totalUnboarded} shots left)`}
        </Button>
        {isGenerating && (
          <Button variant="ghost" size="sm" onClick={() => { stopBatchRef.current = true }} data-testid="board-all-stop">
            Stop after this scene
          </Button>
        )}
        {dialogueTargets.length > 0 && (
          <Button variant="secondary" size="sm" icon={<MessageSquare size={13} />}
            loading={dialogueBatchRunning} onClick={handleGenerateAllDialogue}
            disabled={alreadyLocked} data-testid="gen-all-dialogue"
            title="Generate the dialogue voice (Seed Audio 1.0) for every shot with dialogue">
            Generate all dialogue ({dialogueTargets.length})
          </Button>
        )}
        <span className="text-[11px] text-text-muted">{approvedScenes}/{scenes.length} scenes approved</span>
        {!allApproved && !alreadyLocked && anyBoards && (
          <Button variant="secondary" size="sm" icon={<CheckCircle size={13} />}
            onClick={handleApproveAllBoards} data-testid="approve-all-boards">
            Approve All
          </Button>
        )}
        {allApproved && !alreadyLocked && (
          <Button variant="approve" size="sm" icon={<Lock size={13} />} onClick={handleLock} className="ml-auto">
            Lock Storyboards → SG
          </Button>
        )}
        {alreadyLocked && (
          <div className="ml-auto flex items-center gap-1.5 text-green text-[11px] font-semibold">
            <CheckCircle size={13} /> Storyboards locked
            <Button variant="ghost" size="sm" onClick={() => goToStage(5)} className="ml-2">Continue →</Button>
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: scene navigator */}
        <aside className="w-48 shrink-0 border-r border-border flex flex-col bg-surface overflow-y-auto">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Scenes</p>
          </div>
          <div className="flex flex-col p-1.5 gap-0.5">
            {scenes.map((sc) => {
              const st = getScene(sc.id)
              const done = sceneApproved(sc)
              const boarded = boardIds(sc).filter((sid) => st.shotBoards[sid]?.boardLocalPath).length
              return (
                <button key={sc.id} onClick={() => setActiveSceneId(sc.id)}
                  className={cn(
                    'text-left px-3 py-2 rounded text-xs transition-colors',
                    activeSceneId === sc.id
                      ? 'bg-cyan/10 text-cyan border border-cyan/30'
                      : 'text-text-muted hover:bg-elevated hover:text-text-primary'
                  )}>
                  <span className="flex items-center gap-1.5">
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', {
                      'bg-border': st.status === 'idle',
                      'bg-orange animate-pulse': st.status === 'generating',
                      'bg-cyan': st.status === 'pending' && !done,
                      'bg-green': done,
                    })} />
                    <span className="font-semibold truncate">{sc.id}</span>
                    {done && <CheckCircle size={11} className="text-green shrink-0" />}
                  </span>
                  <span className="block text-[9px] truncate opacity-70 mt-0.5">{sc.heading}</span>
                  <span className="block text-[9px] opacity-60 mt-0.5">{boarded}/{boardIds(sc).length} boards</span>
                </button>
              )
            })}
          </div>
        </aside>

        {/* Center: one board row PER SHOT */}
        <div className="flex-1 min-w-0 overflow-y-auto p-3 flex flex-col gap-3" data-testid="storyboard-canvas">
          {activeState.status === 'generating' && (
            <div className="flex items-center gap-3 text-orange px-2">
              <span className="w-4 h-4 border-2 border-orange border-t-transparent rounded-full animate-spin" />
              <p className="text-xs">Sketching boards for {activeSceneId}…</p>
            </div>
          )}

          {sceneShots.map((shot) => {
            const board = activeState.shotBoards[shot.id]
            // 3.2b: one voice → the strip stays exactly as it was; two or three → each is
            // approved on its own and the shot's clip counts as approved only when all are.
            const speakers = speakersOf(shot)
            const approvedVoices = speakers.filter((s) => voiceApproved(board, s)).length
            return (
              <div key={shot.id} className={cn(
                'rounded-lg border bg-surface',
                board?.status === 'approved' ? 'border-green/40' : 'border-border'
              )} data-testid={`shot-board-${shot.id}`}>
                {/* Shot header: id, camera, duration, beats */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
                  <span className="text-[10px] font-mono text-cyan font-semibold">{shot.id}</span>
                  <span className="flex items-center gap-1 text-[10px] text-text-muted">
                    <Camera size={10} />{shot.cameraAngle ?? '—'}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-text-muted font-mono">
                    <Clock size={10} />{shot.estimatedDuration}s
                  </span>
                  {board?.panels?.length ? (
                    <span className="text-[9px] font-mono text-text-dim">
                      {board.panels.map((p) => `${p.time ? `${p.time} ` : ''}${p.name ? `${p.label} "${p.name}"` : p.label}`).join(' · ')}
                    </span>
                  ) : null}
                  {board?.status === 'approved' && <CheckCircle size={13} className="text-green ml-auto" />}
                </div>

                <div className="flex gap-3 p-3 flex-wrap lg:flex-nowrap">
                  {/* The shot's board */}
                  <div className="w-full lg:w-[420px] shrink-0">
                    {(board?.boardLocalPath || board?.boardUrl) && brokenBoards.has(board.boardLocalPath || board.boardUrl) ? (
                      <div className="aspect-video rounded border border-dashed border-amber/50 bg-amber/5 flex flex-col items-center justify-center gap-1 text-amber text-[11px] px-3 text-center">
                        <span>Board file missing (lost on disk)</span>
                        <span className="text-text-dim text-[10px]">Re-board this scene to restore it</span>
                      </div>
                    ) : board?.boardLocalPath || board?.boardUrl ? (
                      <div className="relative w-full group">
                        <img
                          src={board.boardLocalPath ? serveUrl(board.boardLocalPath) : board.boardUrl}
                          alt={`Storyboard ${shot.id}`}
                          className="w-full rounded border border-border bg-black cursor-zoom-in"
                          data-testid={`board-img-${shot.id}`}
                          onClick={() => setZoomBoard(board.boardLocalPath ? serveUrl(board.boardLocalPath) : board.boardUrl)}
                          onError={() => setBrokenBoards((prev) => {
                            const key = board.boardLocalPath || board.boardUrl
                            if (prev.has(key)) return prev
                            const next = new Set(prev); next.add(key); return next
                          })}
                        />
                        <span className="absolute top-1 right-1 p-1 rounded bg-black/60 text-white/70 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                          <Maximize2 size={12} />
                        </span>
                        {/* Time labels as overlays — Seedream 5.0 Lite mangles rendered
                            text, so panels are drawn clean and the timecodes are laid over
                            each grid cell here (rows x cols, row-major = panel order). */}
                        {board.rows > 0 && board.cols > 0 && (board.panels?.length ?? 0) > 0 && (
                          <div
                            className="absolute inset-0 grid pointer-events-none"
                            style={{
                              gridTemplateColumns: `repeat(${board.cols}, 1fr)`,
                              gridTemplateRows: `repeat(${board.rows}, 1fr)`,
                            }}
                          >
                            {Array.from({ length: board.rows * board.cols }).map((_, i) => (
                              <div key={i} className="relative">
                                {board.panels[i]?.time && (
                                  <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[9px] font-mono font-semibold tracking-tight">
                                    {board.panels[i].time}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="aspect-video rounded border border-dashed border-border flex items-center justify-center text-text-dim text-[11px]">
                        No board yet
                      </div>
                    )}
                  </div>

                  {/* Action, dialogue, approval, notes */}
                  <div className="flex flex-col gap-2 flex-1 min-w-0">
                    <p className="text-[11px] text-text-primary leading-relaxed break-words">{shot.action}</p>
                    {shot.performance && (
                      <p className="text-[10px] text-cyan/90 leading-relaxed break-words">
                        <span className="font-semibold uppercase tracking-wider text-[9px] text-cyan/70">Acting · </span>
                        {shot.performance}
                      </p>
                    )}
                    {shot.dialogue?.length ? (
                      <div className="flex flex-col gap-0.5 pl-2 border-l border-orange/30">
                        {shot.dialogue.map((d, i) => (
                          <span key={i} className="text-[10px] text-text-muted">
                            <MessageSquare size={9} className="inline mr-1 text-orange" />
                            <span className="text-orange font-semibold">{d.characterId}:</span>{' '}
                            <span className="italic">&quot;{d.text}&quot;</span>
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {/* 3.2: dialogue voice — generate (Seed Audio 1.0, locked voices) →
                        preview → approve, right next to the board. Approved clip feeds SG. */}
                    {shot.dialogue?.length && board && !alreadyLocked ? (
                      <div className="flex flex-col gap-1 pl-2 border-l border-cyan/30">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[9px] font-semibold text-cyan/70 uppercase tracking-widest">Dialogue voice</span>
                          <Button variant="ghost" size="sm" loading={dialogueBusyShot === shot.id}
                            onClick={() => handleGenerateDialogueClip(shot)} className="text-[10px]">
                            {board.dialogueClipPath ? 'Regenerate' : 'Generate dialogue'}
                          </Button>
                          {/* ONE speaker — the control this strip has always had, unchanged. */}
                          {board.dialogueClipPath && speakers.length <= 1 && (
                            board.dialogueApproved ? (
                              <span className="text-[10px] text-green flex items-center gap-1"><CheckCircle size={11} /> Approved</span>
                            ) : (
                              <Button variant="approve" size="sm" icon={<CheckCircle size={11} />}
                                onClick={() => patchBoard(shot.id, { dialogueApproved: true })} className="text-[10px]">
                                Approve voice
                              </Button>
                            )
                          )}
                          {/* 3.2b: two or three voices in ONE fused take — the tally, so it is
                              obvious the clip is not through until every voice has been heard. */}
                          {board.dialogueClipPath && speakers.length > 1 && (
                            <span className={cn('text-[10px] flex items-center gap-1',
                              board.dialogueApproved ? 'text-green' : 'text-amber')}
                              data-testid={`dialogue-voices-${shot.id}`}>
                              {board.dialogueApproved && <CheckCircle size={11} />}
                              {approvedVoices}/{speakers.length} voices approved
                            </span>
                          )}
                        </div>
                        {board.dialogueClipPath && (
                          <audio controls src={serveUrl(board.dialogueClipPath)} className="h-7 w-full max-w-[280px]" />
                        )}
                        {/* 3.2b: one row per speaking character — audition that voice alone,
                            then approve it. The clip above is the take they all share. */}
                        {board.dialogueClipPath && speakers.length > 1 && speakers.map((spk) => {
                          const aud = auditions[`${shot.id}::${spk}`]
                          return (
                            <div key={spk} className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[10px] text-orange font-semibold truncate max-w-[110px]" title={spk}>{spk}</span>
                              <Button variant="ghost" size="sm" className="text-[10px]"
                                loading={auditionBusy === `${shot.id}::${spk}`}
                                onClick={() => handleAuditionSpeaker(shot, spk)}
                                title={`Hear ${spk}'s locked voice alone, saying their line in this shot (the clip above is the shared take)`}>
                                Audition
                              </Button>
                              {voiceApproved(board, spk) ? (
                                <button
                                  onClick={() => setSpeakerApproval(shot, spk, false)}
                                  data-testid={`reopen-voice-${shot.id}-${spk}`}
                                  title={`Take ${spk}'s voice back for another listen`}
                                  className="px-1.5 py-0.5 rounded border border-green/40 bg-green/10 text-green text-[10px] font-semibold hover:bg-green/20 transition-colors flex items-center gap-1">
                                  <CheckCircle size={10} /> Approved
                                </button>
                              ) : (
                                <Button variant="approve" size="sm" icon={<CheckCircle size={11} />}
                                  onClick={() => setSpeakerApproval(shot, spk, true)} className="text-[10px]"
                                  data-testid={`approve-voice-${shot.id}-${spk}`}>
                                  Approve {spk}
                                </Button>
                              )}
                              {aud && <audio controls src={aud.url} className="h-7 w-full max-w-[220px]" />}
                              {aud?.fellBack && (
                                <span className="text-[10px] text-red">
                                  Generic voice — Seed Audio rejected {spk}&apos;s reference
                                </span>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : null}

                    {board && board.status !== 'approved' && !alreadyLocked && (
                      <Button variant="approve" size="sm" icon={<CheckCircle size={12} />}
                        onClick={() => handleApproveShotBoard(shot.id)}
                        disabled={!board.boardLocalPath && !board.boardUrl}
                        data-testid={`approve-board-${shot.id}`}>
                        Approve Board
                      </Button>
                    )}
                    {board?.status === 'approved' && (
                      <button
                        onClick={() => handleReopenShotBoard(shot.id)}
                        data-testid={`reopen-board-${shot.id}`}
                        className="self-start px-2 py-1 rounded border border-red/40 bg-red/10 text-red text-[10px] font-semibold hover:bg-red/20 transition-colors"
                      >
                        Reopen Board
                      </button>
                    )}

                    {board && !alreadyLocked && (
                      <div className="flex gap-1.5 flex-wrap">
                        {/* 3-bug1b: multi-line director note with scroll (was a
                            one-line <input> that clipped anything past ~1 line).
                            handleShotNotes stores a plain string → no type change. */}
                        <textarea
                          value={board.notes}
                          onChange={(e) => handleShotNotes(shot.id, e.target.value)}
                          placeholder="Notes… e.g. wider framing on beat B"
                          rows={2}
                          className="flex-1 min-w-[140px] bg-elevated border border-border rounded px-2 py-1 text-[10px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-orange/50 resize-y max-h-40 overflow-y-auto leading-snug"
                        />
                        <EnhanceButton value={board.notes}
                          onEnhanced={(t) => handleShotNotes(shot.id, t)}
                          field="storyboard shot note" />
                        <Button variant="regenerate" size="sm" icon={<RefreshCw size={11} />}
                          onClick={() => generateBoards([shot], board.notes)}
                          disabled={busyShots.has(shot.id)} className="shrink-0">
                          Regen
                        </Button>
                      </div>
                    )}

                    {/* Item 0: assemble the exact board prompt for review BEFORE rendering */}
                    {!alreadyLocked && !pendingSpecs[shot.id] && (
                      <Button variant="ghost" size="sm" icon={<FileText size={11} />}
                        loading={preparingShotId === shot.id}
                        onClick={() => prepareBoardPrompt(shot, board?.notes)}
                        disabled={busyShots.has(shot.id) || preparingShotId !== null}
                        className="self-start text-[10px]"
                        data-testid={`board-prompt-btn-${shot.id}`}>
                        {board ? 'Regen via prompt…' : 'Prepare prompt…'}
                      </Button>
                    )}

                    {/* Edit with Pro — markup / references / instruction on this board */}
                    {board && (board.boardLocalPath || board.boardUrl) && !alreadyLocked && (
                      <button onClick={() => setEditShotId(shot.id)}
                        className="self-start flex items-center gap-1.5 text-[10px] font-semibold text-violet hover:text-violet/80">
                        <Wand2 size={12} /> Edit with Pro
                      </button>
                    )}

                    {/* Item 0: read-only record of what produced this board */}
                    {board?.sentPrompt && !pendingSpecs[shot.id] && (
                      <details data-testid={`board-sent-prompt-${shot.id}`}>
                        <summary className="text-[9px] font-semibold text-text-muted uppercase tracking-widest cursor-pointer hover:text-text-primary transition-colors">
                          Sent prompt{board.autoPrompt && board.sentPrompt !== board.autoPrompt ? ' (user-edited)' : ''}
                        </summary>
                        <pre className="mt-1.5 p-2 bg-elevated/60 rounded border border-border text-[10px] font-mono text-text-muted whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                          {board.sentPrompt}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>

                {/* Item 0: the board's PromptPanel — edit, then render verbatim */}
                {pendingSpecs[shot.id] && !alreadyLocked && (
                  <div className="px-3 pb-3">
                    <PromptPanel
                      title={`Board Prompt — ${shot.id}`}
                      autoPrompt={pendingSpecs[shot.id].auto_prompt}
                      value={pendingSpecs[shot.id].prompt}
                      onChange={(p) => setPendingSpecs((prev) => ({
                        ...prev, [shot.id]: { ...prev[shot.id], prompt: p },
                      }))}
                      sentPrompt={board?.sentPrompt ?? null}
                      generateLabel="Generate Board"
                      onGenerate={() => generateBoards([shot], board?.notes, [pendingSpecs[shot.id]])}
                      onReset={() => prepareBoardPrompt(shot, board?.notes)}
                      onCancel={() => setPendingSpecs((prev) => {
                        const next = { ...prev }; delete next[shot.id]; return next
                      })}
                      busy={busyShots.has(shot.id) || preparingShotId === shot.id}
                      testId={`board-prompt-panel-${shot.id}`}
                    />

                    {/* CON QUÉ SE VA A DIBUJAR, Y LA POSIBILIDAD DE CAMBIARLO.
                        La etapa elegía las referencias del tablero entera en el servidor,
                        las recortaba al tope y las enviaba sin enseñárselas a nadie: la
                        única huella era una línea de log, y llegaba después de pagar. La
                        lista viene ahora de la misma función que las envía, así que lo que
                        se ve aquí es lo que se dibuja. Debajo, el panel para añadir. Mismo
                        orden que la tarjeta de plano de la etapa 5. */}
                    <div className="mt-3 pt-3 border-t border-border flex flex-col gap-2"
                         data-testid={`board-references-${shot.id}`}>
                      <ReferencesSent
                        refs={(pendingSpecs[shot.id].references ?? [])
                          .filter((r) => !r.dropped)
                          .map((r) => ({ url: r.url, label: r.label }))}
                        title="Drawn from"
                        testId={`board-refs-${shot.id}`}
                      />
                      {/* Lo descartado, con su razón y con la acción al lado: una derivada
                          que el director retiró se puede devolver, y una que no cupo le
                          dice que hay que hacer sitio. */}
                      {(pendingSpecs[shot.id].references ?? []).some((r) => r.dropped) && (
                        <ul className="flex flex-col gap-0.5" data-testid={`board-refs-dropped-${shot.id}`}>
                          {(pendingSpecs[shot.id].references ?? []).filter((r) => r.dropped).map((r, i) => (
                            <li key={`${r.url}-${i}`} className="flex items-baseline gap-1.5">
                              <span className="text-[10px] text-text-dim line-through truncate" title={r.label}>
                                {r.label}
                              </span>
                              <span className="text-[9px] text-amber shrink-0">
                                {r.excluded ? 'removed' : `over the ${boardMaxRefs ?? ''} limit`}
                              </span>
                              {r.source === 'derived' && (
                                <button
                                  onClick={() => toggleBoardExclusion(shot.id, r.label)}
                                  className="text-[9px] text-cyan hover:underline shrink-0"
                                  data-testid={`board-ref-restore-${shot.id}`}>
                                  {r.excluded ? 'put back' : ''}
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* Quitar una derivada que SÍ entró: es la forma de hacer sitio. */}
                      {(pendingSpecs[shot.id].references ?? []).filter((r) => !r.dropped && r.source === 'derived').length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {(pendingSpecs[shot.id].references ?? [])
                            .filter((r) => !r.dropped && r.source === 'derived')
                            .map((r, i) => (
                              <button key={`${r.url}-${i}`}
                                onClick={() => toggleBoardExclusion(shot.id, r.label)}
                                title={`Drop ${r.label} from this board`}
                                className="text-[9px] px-1.5 py-0.5 rounded border border-border text-text-muted hover:text-amber hover:border-amber/40 transition-colors"
                                data-testid={`board-ref-drop-${shot.id}`}>
                                × {r.label.length > 24 ? `${r.label.slice(0, 24)}…` : r.label}
                              </button>
                            ))}
                        </div>
                      )}
                      <ReferenceMediaPanel
                        value={boardRefMedia[shot.id] ?? emptyReferenceMedia()}
                        onChange={(rm) => setBoardRefMedia(shot.id, rm)}
                        maxImages={4}
                        disabled={busyShots.has(shot.id) || preparingShotId === shot.id}
                      />
                      {/* La lista es AUTORITATIVA: la calcula el servidor con la misma
                          función que la envía. Por eso refrescarla es una acción explícita
                          y no algo que ocurra a cada clic — el endpoint reescribe las
                          viñetas con Claude, así que cuesta. El director decide cuándo. */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => prepareBoardPrompt(shot, board?.notes)}
                          disabled={busyShots.has(shot.id) || preparingShotId === shot.id}
                          className="text-[9px] px-1.5 py-0.5 rounded border border-border text-text-muted hover:text-cyan hover:border-cyan/40 transition-colors disabled:opacity-40"
                          data-testid={`board-refs-refresh-${shot.id}`}>
                          {preparingShotId === shot.id ? 'Re-checking…' : 'Re-check the list'}
                        </button>
                        <span className="text-[9px] text-text-dim leading-snug">
                          Generate uses your changes either way.
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {!sceneShots.length && (
            <div className="flex items-center justify-center flex-1 text-text-muted text-sm">
              No shots in this scene — check the Breakdown.
            </div>
          )}
        </div>

        {/* Right: scene QC */}
        <aside className="w-60 shrink-0 border-l border-border flex flex-col bg-surface overflow-y-auto">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Scene Review</p>
          </div>
          <div className="p-3 flex flex-col gap-3">
            <div>
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-1.5">
                <ShieldCheck size={10} className="inline mr-1" />Camera Director QC
              </p>
              {qcResult ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap gap-1">
                    {qcResult.checks.map((c) => (
                      <QCResultBadge key={c.label} label={c.label} passed={c.passed} />
                    ))}
                  </div>
                  <p className="text-[10px] text-text-muted leading-relaxed">{qcResult.summary}</p>
                </div>
              ) : (
                <p className="text-[10px] text-text-dim">Runs automatically after generation — advisory: it flags issues (including visual drift across panels) but does not block Approve.</p>
              )}
            </div>
            <div className="border-t border-border pt-3 text-[10px] text-text-muted flex flex-col gap-1">
              <div className="flex justify-between">
                <span>Boards</span>
                <span className="font-mono text-cyan">
                  {sceneShots.filter((s) => activeState.shotBoards[s.id]?.boardLocalPath).length}/{sceneShots.length}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Approved</span>
                <span className="font-mono text-green">
                  {sceneShots.filter((s) => activeState.shotBoards[s.id]?.status === 'approved').length}/{sceneShots.length}
                </span>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Board lightbox — click any board to view it full-size */}
      {zoomBoard && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6 cursor-zoom-out"
          onClick={() => setZoomBoard(null)} data-testid="board-lightbox">
          <img src={zoomBoard} alt="Storyboard full size" onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full object-contain rounded shadow-2xl" />
          <button onClick={() => setZoomBoard(null)} title="Close"
            className="absolute top-4 right-4 p-2 rounded bg-bg/70 text-text hover:text-cyan">
            <X size={18} />
          </button>
        </div>
      )}

      {/* Edit with Pro — markup / refs / instruction on the selected board */}
      {editShotId && activeState.shotBoards[editShotId]?.boardLocalPath && (
        <ProImageEditor
          title={editShotId}
          baseImage={activeState.shotBoards[editShotId].boardLocalPath}
          assetRelPath={`Shots/${editShotId}/Storyboard`}
          projectName={projectName}
          projectPath={localFolderRoot ?? ''}
          onClose={() => setEditShotId(null)}
          onApplied={(edited) => {
            if (!activeSceneId) return
            const cur = getScene(activeSceneId)
            const b = cur.shotBoards[editShotId]
            if (b) updateScene(activeSceneId, {
              shotBoards: { ...cur.shotBoards, [editShotId]: { ...b, boardLocalPath: edited.localPath, boardUrl: edited.url } },
            })
          }}
        />
      )}
    </div>
  )
}
