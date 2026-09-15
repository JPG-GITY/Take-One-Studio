'use client'

import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { Layers, Users, Package, MapPin, Zap, Shirt, Sparkles, Loader2, Plus, X, Milestone, CheckCircle } from 'lucide-react'
import { StageHeader } from '@/components/pipeline/StageHeader'
import { ApprovalControls } from '@/components/pipeline/ApprovalControls'
import { Card, CardBody } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { QCActionCard, QCRunningCard } from '@/components/agent/QCActionCard'
import { StorySpinePanel, type SpineStatus } from './StorySpinePanel'
import { runDirectorPass, autoEnrichCharacters, scriptContextFor } from './directorPass'
import { usePipelineStore } from '@/store/pipeline.store'
import { shotsToSegments, syncSegmentsFromShots } from '@/lib/segments'
import { reconcileBreakdown, type ReconcileSummary } from '@/lib/reconcileBreakdown'
import { useAgentsStore } from '@/store/agents.store'
import { useToast } from '@/components/ui/Toast'
import { pipelineApi, type QCResponse } from '@/lib/api/pipeline.api'
import { cn } from '@/lib/utils'
import type { BreakdownData, CharacterProp, Segment, SegmentShot, StageSlice } from '@/lib/types/pipeline.types'

/**
 * The DeepSeek breakdown API returns snake_case field names.
 * Our TypeScript types use camelCase. This normalises the API response
 * so downstream code never sees undefined on camelCase access.
 *
 * Mappings:
 *   asset.visual_description  → asset.visualDescription
 *   shot.visual_description   → shot.visualDescription
 *   shot.assets_used          → shot.assetsUsed
 *   shot.duration_sec         → shot.estimatedDuration
 *   type "fx"                 → "vfx"
 *   Synthesises `scenes` from shots grouped by shot.scene heading
 *   Adds `sceneRefs` to assets (which shots reference each asset)
 */
type RawRecord = Record<string, unknown>

/**
 * The film's premise, as /api/breakdown/generate wants it: the DEVELOPED concept when
 * "Develop idea" produced one, else the original. Read from the APPROVED stage-1
 * version, so it is the premise the script on screen was actually written from.
 *
 * Exported because the autopilot drives the same endpoint from AutopilotController and
 * used to pass its own copy — the text typed in the autopilot box. On a fresh run the
 * two agree; on a RESUMED one (script written by hand, autopilot picking up at stage 2)
 * they do not, and the breakdown's concurrent batches were told a premise that had
 * nothing to do with the script they were slicing.
 */
export function storyConceptOf(stage1: StageSlice): string {
  if (!stage1.activeVersionId) return ''
  const d = stage1.versions.find((v) => v.id === stage1.activeVersionId)?.data as
    { concept?: string; expandedConcept?: string } | undefined
  return d?.expandedConcept || d?.concept || ''
}

export function normalizeBreakdown(raw: object): BreakdownData {
  const r = raw as RawRecord
  const rawAssets = (r.assets ?? []) as RawRecord[]
  const rawShots  = (r.shots  ?? []) as RawRecord[]

  const assetSceneRefs: Record<string, Set<string>> = {}

  // Heading text per shot, parallel to `shots` — the scene list needs it for display
  // even when identity comes from the backend's scene_id instead.
  const headings: string[] = []

  const shots = rawShots.map((s: RawRecord, i: number): BreakdownData['shots'][0] => {
    const id          = String(s.id ?? `SHOT_${String(i + 1).padStart(3, '0')}`)
    const sceneHeading = String(s.scene ?? s.action ?? id)
    // Scene IDENTITY. Prefer the backend's stable scene_id: using the heading string
    // meant every return to "INT. KITCHEN - DAY" in an episode collapsed into a single
    // scene, and a shot whose heading was missing fell back to its own ACTION TEXT —
    // making that shot its own private scene. Projects generated before scene_id
    // existed keep the heading behaviour exactly, so nothing already on disk shifts.
    const sceneKey = s.scene_id ? String(s.scene_id) : sceneHeading
    const assetsUsed  = (s.assets_used ?? s.assetsUsed ?? []) as string[]
    headings.push(sceneHeading)

    // Track which scenes each asset appears in
    assetsUsed.forEach((aid) => {
      if (!assetSceneRefs[aid]) assetSceneRefs[aid] = new Set()
      assetSceneRefs[aid].add(sceneKey)
    })

    return {
      id,
      sceneId:           sceneKey,
      action:            String(s.action ?? s.scene ?? ''),
      visualDescription: String(s.visual_description ?? s.visualDescription ?? ''),
      assetsUsed,
      cameraAngle:       s.camera ? String(s.camera) : s.camera_angle ? String(s.camera_angle) : undefined,
      lighting:          s.lighting ? String(s.lighting) : undefined,
      estimatedDuration: Number(s.duration_sec ?? s.estimatedDuration ?? 5),
      dialogue:          (s.dialogue as BreakdownData['shots'][0]['dialogue']) ?? [],
      // The story sequence this shot belongs to, when the backend stamped one. Spread
      // conditionally so a project with no spine produces the exact object it produces
      // today — and carried at all because this shape is what gets POSTed back to
      // /api/breakdown/qc: dropping it here would leave the footage-share check
      // permanently blind to every breakdown the UI ever generated.
      ...(s.sequence_id || s.sequenceId
        ? { sequenceId: String(s.sequence_id ?? s.sequenceId) } : {}),
      // The SCENE-MODE dialogue direction Claude wrote for this shot (the VOICES block
      // and the numbered overlap instructions). Carried for the same reason sequenceId is:
      // this normalizer builds every Shot field by field with NO spread, so a field it does
      // not name is destroyed the instant the breakdown lands — which is exactly what made
      // scene mode dead code on its first pass (two reviewers, 2026-08-09). Conditional, so
      // a breakdown without one produces the identical object it produces today.
      ...(s.dialogue_scene || s.dialogueScene
        ? { dialogueScene: String(s.dialogue_scene ?? s.dialogueScene) } : {}),
    }
  })

  const assets = rawAssets.map((a: RawRecord, i: number): BreakdownData['assets'][0] => {
    const id   = String(a.id ?? `ASSET_${String(i + 1).padStart(3, '0')}`)
    const type = (() => {
      const t = String(a.type ?? 'prop')
      return (t === 'fx' ? 'vfx' : t) as BreakdownData['assets'][0]['type']
    })()
    return {
      id,
      name:              String(a.name ?? id),
      type,
      visualDescription: String(a.visual_description ?? a.visualDescription ?? ''),
      sceneRefs:         [...(assetSceneRefs[id] ?? [])],
      // Phase-2 wardrobe variants: carry the parent link + costume through so the
      // store/AG/SG can group variants under their base character (dropped before →
      // the variant scaffolding never received data). Optional; absent on plain assets.
      ...(a.parentCharacterId ? { parentCharacterId: String(a.parentCharacterId) } : {}),
      ...(a.wardrobe ? { wardrobe: String(a.wardrobe) } : {}),
      // Who this asset DEPICTS (backend `depends_on`). Dropping it here would leave the
      // photo/screen/portrait to render from its own words, which is the whole defect.
      ...(Array.isArray(a.depends_on ?? a.dependsOn)
        ? { dependsOn: (a.depends_on ?? a.dependsOn) as string[] }
        : {}),
    }
  })

  // Build scenes from unique shot.sceneId values, keeping the heading for display.
  const sceneMap = new Map<string, { heading: string; shotIds: string[] }>()
  shots.forEach((s, i) => {
    const entry = sceneMap.get(s.sceneId) ?? { heading: headings[i], shotIds: [] }
    entry.shotIds.push(s.id)
    sceneMap.set(s.sceneId, entry)
  })
  const scenes = [...sceneMap.entries()].map(([key, { heading, shotIds }], i) => ({
    // When identity came from the backend, Scene.id IS Shot.sceneId. They used to be
    // different namespaces (synthetic SC-NN vs a heading string), which is why
    // reconcileBreakdown's sceneIdMap — keyed by Scene.id, queried with Shot.sceneId —
    // never matched anything, and why WardrobePanel's scene refs did not line up with
    // the ones AssetGenerationView compares against.
    id:          key.startsWith('SC-') ? key : `SC-${String(i + 1).padStart(2, '0')}`,
    heading,
    description: heading,
    shotIds,
  }))

  // The backend now GROUPS shots into segments — one Seedance call holding several
  // shots it cuts internally. Carry that grouping through (snake_case → camelCase);
  // without this the response's segments are dropped on the floor and shotsToSegments
  // silently rebuilds one-shot segments, throwing away the whole rhythm the breakdown
  // just proposed. Falls back to per-shot segments when the payload has none.
  const rawSegments = (r.segments ?? []) as RawRecord[]
  const segments = rawSegments.length ? rawSegments.map((sg, i): Segment => ({
    id: String(sg.id ?? `SEG_${String(i + 1).padStart(3, '0')}`),
    sceneId: String(sg.scene_id ?? sg.sceneId ?? ''),
    // The segment is the unit the footage-share check weighs (it holds the PADDED
    // seconds that actually get rendered), so its tag has to survive normalisation too.
    ...(sg.sequence_id || sg.sequenceId
      ? { sequenceId: String(sg.sequence_id ?? sg.sequenceId) } : {}),
    order: i,
    shots: ((sg.shots ?? []) as RawRecord[]).map((s, j): SegmentShot => ({
      id: String(s.id ?? `SEG_${i + 1}_S${j + 1}`),
      durationSecs: Number(s.duration_sec ?? s.durationSecs ?? 0),
      shotSize: (s.shot_size ?? s.shotSize) as SegmentShot['shotSize'],
      cameraMove: (s.camera_move ?? s.cameraMove) as SegmentShot['cameraMove'],
      layout: s.layout ? String(s.layout) : undefined,
      action: String(s.action ?? s.visual_description ?? ''),
      assetsUsed: (s.assets_used ?? s.assetsUsed ?? []) as string[],
      dialogue: (s.dialogue ?? []) as SegmentShot['dialogue'],
      performance: s.performance ? String(s.performance) : undefined,
    })),
    sceneSettings: (sg.lighting || (sg.shots as RawRecord[])?.[0]?.lighting)
      ? { light: String(sg.lighting ?? (sg.shots as RawRecord[])[0].lighting) }
      : undefined,
  })) : undefined

  // Idempotent either way: with segments present it just derives the flat projection.
  // The breakdown read the script, so it is the one that knows what language the
  // dialogue is in. Carried explicitly: this normaliser builds its result field by
  // field, so anything not named here is dropped on the floor.
  const dialogueLanguage = String(r.dialogue_language ?? r.dialogueLanguage ?? '')
  return shotsToSegments({ assets, shots, scenes, ...(segments ? { segments } : {}),
    ...(dialogueLanguage ? { dialogueLanguage } : {}) })
}

// MapPin avoids collision with JS built-in Map; Zap covers both "vfx" and "fx"
function getTypeIcon(type: string): React.ElementType {
  if (type === 'character') return Users
  if (type === 'prop')      return Package
  if (type === 'wardrobe')  return Shirt
  if (type === 'environment') return MapPin
  return Zap // vfx, fx, or unknown
}
function getTypeColor(type: string): 'cyan' | 'orange' | 'green' | 'amber' {
  if (type === 'character')   return 'cyan'
  if (type === 'prop')        return 'orange'
  if (type === 'wardrobe')    return 'amber'
  if (type === 'environment') return 'green'
  return 'amber'
}

// 'story' is the film bible's STORY SPINE — it lives here rather than in stage 1 because
// it is THIS stage's input: the breakdown is written from it and its four gates already
// feed this stage's QC. It is no longer a by-product of the generate below — the panel
// can derive it from the approved script first (F1), which is the only way approving it
// can mean anything — and since 2026-08-12 approving the script REQUESTS that derivation,
// so the spine is normally already on screen when this stage opens.
type TabId = 'story' | 'assets' | 'shots' | 'scenes'

export function BreakdownView() {
  const { stages, commitVersion, approveVersion, goToStage, patchStageData, projectName, localFolderRoot, targetDurationSecs, videoModel } = usePipelineStore()
  const { updateAgent } = useAgentsStore()
  const { success, error: toastError, warning } = useToast()
  const stage  = stages[2]
  const stage1 = stages[1]

  const [isGenerating, setIsGenerating] = useState(false)
  const [isQcRunning,  setIsQcRunning]  = useState(false)
  const [qcResult,     setQcResult]     = useState<QCResponse | null>(null)
  const [feedback,     setFeedback]     = useState('')
  const [errorMsg,     setErrorMsg]     = useState<string | null>(null)
  // F1: land on Story when there is nothing generated yet. The spine is proposed,
  // edited and approved BEFORE the shot list is written from it, so opening on an empty
  // Assets table pointed the user at the one thing they cannot do yet. Once a breakdown
  // exists, Assets is the default it has always been. Read through getState() so this is
  // decided once per mount — the view is keyed on projectId, so a project switch remounts
  // it and re-decides.
  const [activeTab,    setActiveTab]    = useState<TabId>(() => {
    const st = usePipelineStore.getState()
    // A pending derivation wins over everything: stage 1 has just been approved and the
    // spine is about to be written here. Landing on Assets would hide the one thing
    // happening — and on a project that already has a breakdown, that is where the
    // default below would have sent us.
    if (st.pendingSpineDerive) return 'story'
    return st.stages[2].activeVersionId ? 'assets' : 'story'
  })
  const [autoEnhance,  setAutoEnhance]  = useState(true)   // director polish of shots after breakdown
  const [dossiersRunning, setDossiersRunning] = useState(false)

  // F1: the story gate needs the approval state even when the Story tab was never
  // opened — StorySpinePanel is unmounted then and cannot report it. One GET on mount;
  // every later change comes from the panel itself (onStatusChange), no second request.
  // null = not known yet, which gates nothing.
  const [spine, setSpine] = useState<SpineStatus | null>(null)
  const refreshSpine = useCallback(async () => {
    try {
      const r = await pipelineApi.getBible({ projectName, projectPath: localFolderRoot ?? '' })
      setSpine({ hasSpine: (r.bible?.sequences?.length ?? 0) > 0, approved: !!r.approved })
    } catch {
      // Unreadable bible / backend down → no spine, so no gate. A generate that cannot
      // reach the backend is about to fail on its own; blocking it first only hides why.
      setSpine({ hasSpine: false, approved: false })
    }
  }, [projectName, localFolderRoot])
  // Deferred one microtask, the same shape StorySpinePanel uses for its own load: the
  // react-hooks rule rejects a setState the effect body can reach synchronously.
  useEffect(() => { void Promise.resolve().then(refreshSpine) }, [refreshSpine])

  // Read active breakdown data directly from the store — survives navigation
  const activeData = useMemo<BreakdownData | null>(() => {
    if (!stage.activeVersionId) return null
    const v = stage.versions.find((v) => v.id === stage.activeVersionId)
    return (v?.data as BreakdownData) ?? null
  }, [stage.activeVersionId, stage.versions])
  // Same definition of "done" the pass itself uses: BOTH the prose dossier and the acting
  // profile. Counting on personality alone would hide every character enriched before the
  // acting field existed — they have a dossier and no performance.
  const missingDossiers = useMemo(
    () => (activeData?.assets ?? []).filter((x) => x.type === 'character'
      && !(x.personality?.trim() && x.acting?.trim())),
    [activeData])


  const scriptContent = useMemo(() => {
    const s1 = stages[1]
    if (!s1.activeVersionId) return ''
    const v = s1.versions.find((v) => v.id === s1.activeVersionId)
    return (v?.data as { content?: string })?.content ?? ''
  }, [stages])

  // The premise, for the breakdown's concurrent batches. Prefer the DEVELOPED concept
  // when "Develop idea" produced one — it is richer than the one-line original and,
  // until now, was written to the store in stage 1 and read by nothing, ever.
  // Derived by storyConceptOf, which the autopilot's stage-2 call uses too.
  const storyConcept = useMemo(() => storyConceptOf(stages[1]), [stages])

  // The director pass (character dossiers → shot direction) lives in ./directorPass.
  // It used to live HERE, as two closures, which is exactly why the unattended path
  // never ran it — AutopilotController cannot call a function that only exists while
  // this component is mounted. One implementation, two callers; see that file's header.

  const handleGenerate = async (withFeedback?: string) => {
    // F1 — the STORY gate. `spine_approved` used to be written and then read only for
    // display: approving the story changed nothing, and skipping it said nothing, while
    // the shot list below is written FROM that spine (server.py folds the bible into the
    // breakdown's story context). Three cases, deliberately different:
    //   · no spine at all  → no gate whatsoever. Most existing projects have no bible and
    //                        must keep working exactly as they did.
    //   · spine, unapproved → this warning, overridable. A hard block would be a dead end
    //                        the day the derivation itself is what is broken.
    //   · spine, approved   → straight through.
    // Cancelling opens the Story tab, so "no" leads somewhere instead of nowhere.
    if (spine?.hasSpine && !spine.approved && typeof window !== 'undefined' && !window.confirm(
      'The story spine has NOT been approved.\n\n' +
      'The shot list is written from it — the sequences, their obstacles and the value ' +
      'chain — so generating now bakes in a story you have not signed off on. The Story tab ' +
      'lets you read it, change it and approve it first.\n\nGenerate the breakdown anyway?'
    )) {
      setActiveTab('story')
      return
    }
    // Guard against the "regenerate wiped my approved work" jam: a new breakdown is a
    // NEW set of assets/shots, so approvals downstream may no longer match. Nothing is
    // deleted (History rollback restores the previous breakdown), but warn first when
    // downstream stages already hold work.
    const st = usePipelineStore.getState()
    const downstreamHasWork = ([3, 4, 5] as const).some((id) => st.stages[id].status !== 'idle')
    if (downstreamHasWork && typeof window !== 'undefined' && !window.confirm(
      'Regenerating the breakdown builds a NEW set of assets and shots. Approved work downstream ' +
      '(assets, storyboards, shots) may no longer match and can be orphaned — nothing is deleted, ' +
      'and you can roll back the breakdown from History. Regenerate anyway?'
    )) {
      return
    }
    setIsGenerating(true)
    setErrorMsg(null)
    setQcResult(null)
    updateAgent('breakdown', { status: 'active', detail: 'Analysing script…', progress: 10 })

    try {
      const prompt = withFeedback ? `${scriptContent}\n\nDirector notes: ${withFeedback}` : scriptContent
      const bd = await pipelineApi.generateBreakdown(prompt, projectName, localFolderRoot ?? '', targetDurationSecs, storyConcept, videoModel)

      // Normalise: DeepSeek returns snake_case; TypeScript types use camelCase
      // Also maps "fx" → "vfx" for type consistency
      let normalised: BreakdownData = normalizeBreakdown(bd)

      // RECONCILE against the previous breakdown: the LLM renumbers ASSET/SHOT/SC
      // IDs every run, but all downstream state (AG approvals, boards, clips,
      // dialogue voices) is keyed by them. Reusing the old IDs for matching
      // entities keeps that state valid; the summary names the affected tomas.
      const prevBD = usePipelineStore.getState().stages[2].versions.find(
        (v) => v.id === usePipelineStore.getState().stages[2].activeVersionId)?.data as BreakdownData | undefined
      const keptShotApprovals = prevBD ? [...usePipelineStore.getState().approvedShotIds] : []
      let recon: ReconcileSummary | null = null
      if (prevBD?.assets?.length) {
        const r = reconcileBreakdown(prevBD, normalised)
        normalised = r.breakdown
        recon = r.summary
      }

      commitVersion<BreakdownData>(2, normalised)
      // The result lives in Assets/Shots — generating from the Story tab (the default
      // while nothing exists) would otherwise leave the user staring at the spine.
      setActiveTab('assets')
      // /api/breakdown/generate still derives a bible lazily when the project has none,
      // so a project that was ungated a moment ago may now HAVE an unapproved spine.
      void refreshSpine()

      if (recon) {
        // commitVersion(2) clears approvedShotIds ("new breakdown = new shot IDs").
        // With reconciled IDs, shots that are content-identical keep their identity —
        // restore ONLY those approvals; changed/new tomas stay unapproved.
        const { approveShot } = usePipelineStore.getState()
        const keptSet = new Set(recon.shotsKept)
        keptShotApprovals.filter((id) => keptSet.has(id)).forEach((id) => approveShot(id))
        const parts = [
          `${recon.assetsKept.length + recon.shotsKept.length} kept`,
          recon.assetsChanged.length + recon.shotsChanged.length
            ? `${recon.assetsChanged.length} assets + ${recon.shotsChanged.length} shots changed`
            : '',
          recon.assetsNew.length + recon.shotsNew.length
            ? `${recon.assetsNew.length + recon.shotsNew.length} new`
            : '',
          recon.assetsRemoved.length + recon.shotsRemoved.length
            ? `${recon.assetsRemoved.length + recon.shotsRemoved.length} removed`
            : '',
        ].filter(Boolean).join(' · ')
        success('Breakdown reconciled', parts)
        const affected = [...recon.assetsChanged, ...recon.shotsChanged]
        updateAgent('breakdown', {
          status: 'completed', progress: 100,
          detail: affected.length
            ? `Affected (regen advised): ${affected.slice(0, 12).join(', ')}${affected.length > 12 ? '…' : ''}`
            : 'Breakdown complete — all previous work still matches',
        })
      } else {
        updateAgent('breakdown', { status: 'completed', detail: 'Breakdown complete', progress: 100 })
      }

      // Director pass — auto-fill character dossiers, then (if enabled) polish every
      // shot's action/visual. SEQUENTIAL so the two patchStageData writes never race.
      // Non-blocking; the buttons stay for manual overrides.
      // The SAME call the autopilot makes — the only difference is `enhanceShots`, which
      // this path lets the user switch off for very long films and the unattended path
      // cannot (it has no toggle to read).
      void (async () => {
        const out = await runDirectorPass(normalised, { enhanceShots: autoEnhance })
        // A failed dossier pass used to return in silence and let the panel read
        // COMPLETED. Now it reaches the user: sticky error toast + a red Breakdown Agent.
        if (out.error) toastError('Director pass failed', out.error)
        else if (out.warning) warning('Director pass incomplete', out.warning)
      })()

      // Try Claude QC — non-blocking if backend is down
      setIsQcRunning(true)
      updateAgent('qc', { status: 'active', detail: 'Breakdown QC running…' })
      try {
        // PAIRED with AutopilotController's gate, which sends the SAME body with one
        // deliberate difference: deterministicOnly=true, because everything that can
        // stop an unattended run is arithmetic. Every other field must match.
        // videoModel is the SAME value generateBreakdown was handed above, and it has to
        // be: the plan was written against that model's per-call ceiling, so judging it
        // against another one fails a breakdown for being what it was asked to be.
        const qc = await pipelineApi.qcBreakdown(normalised, scriptContent, targetDurationSecs, false,
          { name: projectName, path: localFolderRoot ?? '' }, videoModel)
        setQcResult(qc)
        updateAgent('qc', { status: qc.passed ? 'completed' : 'active', detail: qc.summary })
      } catch {
        updateAgent('qc', { status: 'idle', detail: 'QC skipped (offline)' })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Generation failed'
      setErrorMsg(msg)
      toastError('Breakdown failed', msg)
      updateAgent('breakdown', { status: 'error', detail: msg })
    } finally {
      setIsGenerating(false)
      setIsQcRunning(false)
    }
  }

  const handleApprove = () => {
    if (!stage.activeVersionId) return
    approveVersion(2, stage.activeVersionId)
    success('Breakdown approved', 'Moving to Asset Generation →')
    goToStage(3)
  }


  // Items 3&4: the breakdown is the downstream contract — every field the user
  // approves must be fully readable AND editable in place.
  const handleEditAsset = (id: string, patch: Partial<BreakdownData['assets'][0]>) => {
    if (!activeData) return
    patchStageData(2, { ...activeData, assets: activeData.assets.map((a) => a.id === id ? { ...a, ...patch } : a) })
  }
  const handleEditShot = (id: string, patch: Partial<BreakdownData['shots'][0]>) => {
    if (!activeData) return
    // STAMP the acting direction as hand-written the moment a human touches it. This is
    // the ONLY writer of `performanceSource`, and it is what buys the director pass the
    // right to clear a stale auto value (see directorPass.ts): without a provenance mark
    // the merge cannot tell "the last pass wrote this" from "the director typed this",
    // and it was resolving that ambiguity by never clearing anything — so the backend's
    // deliberate blank for a character-less shot was discarded 6/6 times on BLOOM.
    // Only when `performance` is actually in the patch: editing the action must not
    // silently promote an auto performance to manual.
    const stamped = 'performance' in patch ? { ...patch, performanceSource: 'manual' as const } : patch
    // Through syncSegmentsFromShots, or the edit never reaches the render: stage 5 builds
    // its prompt from `segments`, so writing only `shots` showed the change in the UI and
    // sent Seedance the text from before it.
    patchStageData(2, syncSegmentsFromShots({
      ...activeData,
      shots: activeData.shots.map((s) => s.id === id ? { ...s, ...stamped } : s),
    }))
  }
  const handleEditScene = (id: string, patch: Partial<BreakdownData['scenes'][0]>) => {
    if (!activeData) return
    patchStageData(2, { ...activeData, scenes: activeData.scenes.map((sc) => sc.id === id ? { ...sc, ...patch } : sc) })
  }

  // One-click misclassification fix: changing a type updates the stored
  // breakdown in place, which drives AG categorization (sheet vs variations).
  const handleTypeChange = (assetId: string, newType: BreakdownData['assets'][0]['type']) => {
    if (!activeData) return
    patchStageData(2, {
      ...activeData,
      assets: activeData.assets.map((a) => a.id === assetId ? { ...a, type: newType } : a),
    })
  }

  // Approve is available whenever there's generated data — QC is advisory not blocking
  const canApprove = stage.status === 'pending_review'

  // STORY FIRST, and the order is the argument: assets, shots and scenes are all written
  // FROM the spine, so a tab bar that put it last read as an appendix to the breakdown
  // instead of its source. Reading order = pipeline order.
  const TABS: Array<{ id: TabId; label: string; count: number }> = [
    // Count stays 0: the spine lives in bible.json, not in the breakdown version, and
    // reading it just to number a tab would fire a request on every stage visit.
    { id: 'story',  label: 'Story',   count: 0 },
    { id: 'assets', label: 'Assets',  count: activeData?.assets?.length ?? 0 },
    { id: 'shots',  label: 'Shots',   count: activeData?.shots?.length  ?? 0 },
    { id: 'scenes', label: 'Scenes',  count: activeData?.scenes?.length ?? 0 },
  ]

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <StageHeader stageId={2} label="Breakdown" />

      <div className="flex flex-1 min-h-0 gap-3 p-3">
        {/* Left: controls — SCROLLABLE, the same shape stage 1 uses and for the same
            reason it needed one. This column is a flex child with no overflow of its own,
            so every card in it was squeezed to fit the viewport instead of the column
            growing: measured on a breakdown with a QC verdict, "Auto-enhance shots after
            breakdown" was clipped mid-line under the Generate button, and the Producer
            card was cut off in the middle of its badge list — which is where the notes
            explaining each failure live. The user's report was that the UI had "lost
            visibility" and that the last issues "have no reading". min-h-0 is what lets a
            flex child shrink so its own scrollbar can appear.

            EVERY CHILD BELOW CARRIES shrink-0, and that is the half that makes it work.
            A flex item shrinks BEFORE it overflows, so the scrollbar alone changed
            nothing: the column kept squeezing its tallest child — the QC verdict — and
            that card's own `overflow-hidden` cut the sentence instead of scrolling it.
            Stage 1 puts shrink-0 on all three of its cards for exactly this reason. */}
        <div className="flex flex-col gap-3 w-64 shrink-0 min-h-0 overflow-y-auto pr-1">
          <Card className="shrink-0">
            <CardBody className="flex flex-col gap-3">
              <Button
                variant="primary"
                icon={<Layers size={14} />}
                loading={isGenerating}
                onClick={() => handleGenerate()}
                disabled={stage1.status !== 'approved' || stage.status === 'approved'}
                className="w-full"
              >
                Generate Breakdown
              </Button>

              <label className="flex items-center gap-2 text-[11px] text-text-muted cursor-pointer select-none" title="After the breakdown, the Director auto-fills character dossiers and polishes every shot's action/visual. Turn off for very long films to save time/cost.">
                <input type="checkbox" checked={autoEnhance} onChange={(e) => setAutoEnhance(e.target.checked)}
                  data-testid="auto-enhance-toggle" className="accent-cyan" />
                <Sparkles size={11} className="text-cyan" /> Auto-enhance shots after breakdown
              </label>

              {/* The director pass runs ONCE, fire-and-forget, right after a breakdown is
                  generated — so a film whose pass 502'd, or whose operator left the stage
                  before it finished, had no way back to its dossiers except enriching each
                  character by hand. The cost is not cosmetic: `acting` is what
                  assemble_subject_profiles puts in every Seedance prompt, and without it
                  the performance half of the prompt is simply absent. Measured on
                  BLACKMIRROR V3: 0 of 7 characters had a profile and 0 of 9 render prompts
                  carried one, while DryRUN had 8 of 8. autoEnrichCharacters only touches
                  characters with an empty dossier, so this is safe to press at any time. */}
              {/* NO gated on the stage being unapproved, and that gate is exactly what
                  this button was written for: a film only reveals its missing profiles at
                  RENDER time, when the breakdown has long been approved — which is the
                  state BLACKMIRROR V3 was in. Filling a dossier renumbers nothing and
                  changes no shot, so nothing downstream goes stale; it writes the same
                  character fields the sidebar already lets you edit after approval. */}
              {missingDossiers.length > 0 && (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    if (!activeData) return
                    setDossiersRunning(true)
                    try {
                      const out = await autoEnrichCharacters(activeData)
                      if (out.enriched) success(`${out.enriched} dossier(s) written`,
                        'Every character now carries an acting profile the render prompt can use.')
                      if (out.failed) toastError(`${out.failed} dossier(s) failed`,
                        `${out.failedNames.join(', ')} — ${out.firstError ?? 'no detail'}`)
                    } finally { setDossiersRunning(false) }
                  }}
                  disabled={dossiersRunning}
                  data-testid="write-dossiers"
                  className="w-full"
                >
                  {dossiersRunning ? 'Writing dossiers…'
                    : `Write ${missingDossiers.length} missing character dossier(s)`}
                </Button>
              )}

              {stage1.status !== 'approved' && (
                <p className="text-[11px] text-text-muted text-center">
                  Approve the script in Stage 1 first.
                </p>
              )}

              {activeData && (() => {
                const totalSecs = activeData.shots?.reduce((acc, s) => acc + (s.estimatedDuration ?? 5), 0) ?? 0
                const overBudget = totalSecs > targetDurationSecs * 1.15   // >15% over target
                const nearBudget = totalSecs > targetDurationSecs * 0.85   // within 15% either side
                const durationLabel = totalSecs >= 60
                  ? `${Math.round(totalSecs / 60 * 10) / 10} min`
                  : `${totalSecs}s`
                const targetLabel = targetDurationSecs >= 60
                  ? `${Math.round(targetDurationSecs / 60 * 10) / 10} min`
                  : `${targetDurationSecs}s`
                return (
                  <div className="flex flex-col gap-1 pt-1 border-t border-border text-[11px] text-text-muted">
                    {[
                      { label: 'Characters',   count: activeData.assets?.filter(a => a.type === 'character').length ?? 0,   color: 'text-cyan'   },
                      { label: 'Props',        count: activeData.assets?.filter(a => a.type === 'prop').length ?? 0,         color: 'text-orange' },
                      { label: 'Wardrobe',     count: activeData.assets?.filter(a => a.type === 'wardrobe').length ?? 0,     color: 'text-amber'  },
                      { label: 'Environments', count: activeData.assets?.filter(a => a.type === 'environment').length ?? 0,  color: 'text-green'  },
                      { label: 'VFX',          count: activeData.assets?.filter(a => a.type === 'vfx' || a.type === 'fx').length ?? 0, color: 'text-amber' },
                      { label: 'Shots',        count: activeData.shots?.length ?? 0,                                          color: 'text-cyan'   },
                    ].map(({ label, count, color }) => (
                      <div key={label} className="flex justify-between items-center">
                        <span>{label}</span>
                        <span className={cn('font-mono font-semibold', color)}>{count}</span>
                      </div>
                    ))}
                    {/* Running total duration vs target */}
                    {totalSecs > 0 && (
                      <div className={cn(
                        'flex justify-between items-center pt-1 mt-0.5 border-t border-border/60',
                        overBudget ? 'text-red' : nearBudget ? 'text-green' : 'text-amber'
                      )}>
                        <span className="font-semibold">Est. Runtime</span>
                        <span className="font-mono font-bold text-[10px]">
                          {durationLabel}
                          <span className="font-normal opacity-60 ml-1">/ {targetLabel}</span>
                        </span>
                      </div>
                    )}
                  </div>
                )
              })()}
            </CardBody>
          </Card>

          {/* F1: the story layer, right next to the button that consumes it. The spine
              is what the shot list is written FROM, so its state belongs here and not
              only behind a tab the user has no reason to open. */}
          {spine && !spine.approved && (
            <Card className={cn('border shrink-0', spine.hasSpine ? 'border-orange/50' : 'border-border')}>
              <CardBody className="flex flex-col gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Milestone size={12} className={spine.hasSpine ? 'text-orange' : 'text-cyan'} />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Story spine
                  </span>
                  <span className={cn(
                    'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono',
                    spine.hasSpine ? 'text-orange border-orange/40 bg-orange/10'
                                   : 'text-text-muted border-border bg-elevated'
                  )} data-testid="spine-gate-state">
                    {spine.hasSpine ? 'Not approved' : 'Not written'}
                  </span>
                </div>
                <p className="text-[11px] text-text-muted leading-relaxed">
                  {spine.hasSpine
                    ? 'Take One Studio wrote the story spine, but you have not approved it — and the shot list is written from it.'
                    : 'No story spine yet. Take One Studio reads it out of the approved script — logline, characters, sequences — for you to change and approve before the shot list is written.'}
                </p>
                <Button variant={spine.hasSpine ? 'regenerate' : 'ghost'} size="sm"
                  icon={<Milestone size={12} />} onClick={() => setActiveTab('story')}
                  data-testid="spine-gate-open">
                  {spine.hasSpine ? 'Review & approve' : 'Open the story'}
                </Button>
              </CardBody>
            </Card>
          )}
          {spine?.approved && (
            <div className="flex items-center gap-1.5 text-[11px] text-green px-1 shrink-0" data-testid="spine-gate-approved">
              <CheckCircle size={12} className="shrink-0" /> Story spine approved
            </div>
          )}

          {/* QC card — actionable. Bounded and scrollable on its own, the same wrapper
              stage 1 gives this component: the verdict now prints a paragraph per failing
              check, and without a ceiling it grows until Override & Approve is below the
              fold — which is where the user has to go to act on what he just read. */}
          <div className="shrink-0 flex flex-col gap-3 max-h-[50%] overflow-y-auto pr-1">
          {isQcRunning && <QCRunningCard context="Breakdown" />}
          {qcResult && !isQcRunning && (
            <QCActionCard
              qcResult={qcResult}
              context="Breakdown"
              isRegenerating={isGenerating}
              onRegenerate={(notes) => {
                setFeedback(notes)
                handleGenerate(notes)
              }}
            />
          )}
          </div>

          {errorMsg && (
            <div className="text-xs text-red bg-red/10 border border-red/30 rounded px-3 py-2 shrink-0">
              {errorMsg}
            </div>
          )}

          {stage.status !== 'idle' && (
            <div className="shrink-0">
            <ApprovalControls
              approveLabel="Approve Breakdown"
              onApprove={handleApprove}
              onRegenerate={(fb) => handleGenerate(fb)}
              canApprove={canApprove}
              isGenerating={isGenerating || isQcRunning}
              feedback={feedback}
              onFeedbackChange={setFeedback}
              /* BLOCKING failures, not `passed`. `passed` is false the moment ANY check
                 fails, so seven advisory notes — a long runtime, a repeated shot size,
                 four story observations — turned this into "Override & Approve" with a
                 warning triangle, which reads as "you are about to force through
                 something broken". Measured on a clean rehearsal breakdown: 0 blocking,
                 7 notes, and the button still said Override. Same correction as the QC
                 card's badge: a note and a stop are not the same news. */
              qcPassed={qcResult ? !qcResult.checks.some((c) => !c.passed && c.blocking) : null}
              qcPersona={qcResult?.persona}
            />
            </div>
          )}
        </div>

        {/* Right: data table */}
        <Card className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-border shrink-0">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider transition-colors',
                  activeTab === tab.id
                    ? 'text-cyan border-b-2 border-cyan bg-cyan/5'
                    : 'text-text-muted hover:text-text-primary'
                )}
              >
                {tab.label}
                {/* The Story tab carries no count (the spine is not in this stage's
                    version), so its state is the dot: orange = a spine waiting for
                    approval, dim = none written yet. */}
                {tab.id === 'story' && spine && !spine.approved && (
                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
                    spine.hasSpine ? 'bg-orange' : 'bg-text-dim')}
                    title={spine.hasSpine ? 'Story spine not approved' : 'No story spine yet'}
                    data-testid="story-tab-dot" />
                )}
                {tab.count > 0 && (
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-[9px] font-bold',
                    activeTab === tab.id ? 'bg-cyan/20 text-cyan' : 'bg-border text-text-muted'
                  )}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto">
            {/* Story is checked BEFORE activeData: the spine is read from bible.json, so
                it stays reachable (with its own empty state) even when this tab has no
                breakdown version yet. */}
            {activeTab === 'story' ? (
              // setSpine is a stable setter, so the panel's ref-guarded callback never
              // re-fires its load: the gate above is updated by the same responses the
              // panel already got, with no extra request.
              <StorySpinePanel onStatusChange={setSpine} />
            ) : !activeData ? (
              <div className="flex items-center justify-center h-full text-text-muted text-sm">
                {stage1.status !== 'approved'
                  ? 'Approve the script in Stage 1 to unlock breakdown'
                  : 'Click Generate Breakdown to analyse the script'
                }
              </div>
            ) : activeTab === 'assets' ? (
              <AssetsTable assets={activeData.assets ?? []} onTypeChange={handleTypeChange} onEdit={handleEditAsset}
                contextOf={(id) => scriptContextFor(activeData, id)}
                onEnrichError={(n, m) => toastError(`Dossier failed for ${n}`, m)} />
            ) : activeTab === 'shots' ? (
              <ShotsTable shots={activeData.shots ?? []} assets={activeData.assets ?? []} onEdit={handleEditShot} />
            ) : (
              <ScenesTable scenes={activeData.scenes ?? []} onEdit={handleEditScene} />
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

// ── Sub-tables ────────────────────────────────────────────────────────────────

const ASSET_TYPES: Array<BreakdownData['assets'][0]['type']> = ['character', 'prop', 'wardrobe', 'environment', 'vfx']

/** Inline-editable multi-line field — commits on blur. Keyed by row id so
 *  switching rows remounts with fresh defaultValue. */
function EditField({ value, onCommit, rows = 2, mono = false, testid }: {
  value: string
  onCommit: (v: string) => void
  rows?: number
  mono?: boolean
  testid?: string
}) {
  return (
    <textarea
      defaultValue={value}
      rows={rows}
      spellCheck={false}
      data-testid={testid}
      onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value) }}
      className={cn(
        'w-full bg-elevated border border-border rounded px-2.5 py-1.5 text-xs text-text-primary',
        'focus:outline-none focus:border-cyan/50 resize-y leading-relaxed',
        mono && 'font-mono'
      )}
    />
  )
}

/** Editable field with an AI "enhance / write" button (Seed 2.0 Pro). Controlled
 *  locally so an enhance result replaces the text and the LLM never fights typing;
 *  commits to the store on blur or after an enhance. `field` names it for the LLM,
 *  `context` grounds the rewrite (character/shot description). */
function SmartField({ value, field, context, onCommit, rows = 2, placeholder }: {
  value: string
  field: string
  context: string
  onCommit: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  const [val, setVal] = useState(value)
  const [seen, setSeen] = useState(value)
  const [busy, setBusy] = useState(false)
  // Sync when the external value changes (e.g. Director "Generate detail" fills it)
  // WITHOUT an effect — React's endorsed store-prev-value-during-render pattern.
  if (seen !== value) { setSeen(value); setVal(value) }
  const enhance = async () => {
    setBusy(true)
    try {
      const t = await pipelineApi.enhanceText(field, val, context)
      if (t) { setVal(t); onCommit(t) }
    } catch { /* ignore — leave current text */ } finally { setBusy(false) }
  }
  return (
    <div className="relative">
      <textarea
        value={val}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => { if (val !== value) onCommit(val) }}
        className="w-full bg-elevated border border-border rounded px-2 py-1.5 pr-7 text-[11px] text-text-primary focus:outline-none focus:border-cyan/50 resize-y leading-relaxed"
      />
      <button onClick={enhance} disabled={busy} title={val.trim() ? 'Enhance with AI' : 'Write with AI'}
        className="absolute top-1.5 right-1.5 text-text-dim hover:text-cyan disabled:opacity-50">
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
      </button>
    </div>
  )
}

/** Small add/remove/edit editor for a character's props (hats, canes, swords…).
 *  Uncontrolled inputs (defaultValue + onBlur), keyed by prop id, so typing never
 *  re-renders the list (the render-loop trap with nested store arrays). */
function PropsEditor({ props, onChange }: { props: CharacterProp[]; onChange: (p: CharacterProp[]) => void }) {
  const add = () => onChange([...props, { id: `prop_${Date.now().toString(36)}`, type: '', description: '' }])
  const update = (id: string, patch: Partial<CharacterProp>) =>
    onChange(props.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const remove = (id: string) => onChange(props.filter((p) => p.id !== id))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
          Props (hats, canes, swords, garments, footwear…)
        </label>
        <button onClick={add} data-testid="prop-add"
          className="text-[10px] text-cyan hover:text-cyan/80 font-semibold">+ Add prop</button>
      </div>
      {props.map((p) => (
        <div key={p.id} className="flex gap-1.5 items-center">
          <input defaultValue={p.type} placeholder="type"
            onBlur={(e) => e.target.value !== p.type && update(p.id, { type: e.target.value })}
            className="w-28 bg-elevated border border-border rounded px-2 py-1 text-[10px] text-text-primary focus:outline-none focus:border-cyan/50" />
          <input defaultValue={p.description} placeholder="description"
            onBlur={(e) => e.target.value !== p.description && update(p.id, { description: e.target.value })}
            className="flex-1 bg-elevated border border-border rounded px-2 py-1 text-[10px] text-text-primary focus:outline-none focus:border-cyan/50" />
          <button onClick={() => remove(p.id)}
            className="text-text-dim hover:text-red text-xs px-1" title="Remove prop">×</button>
        </div>
      ))}
    </div>
  )
}

/** Editable per-shot dialogue: character + line + emotion, add/remove. Keyed by
 *  length so add/remove remounts inputs with fresh values (no index-key stale bug);
 *  text/emotion are uncontrolled (onBlur) so typing never re-renders the table. */
function DialogueEditor({ dialogue, characters, onChange }: {
  dialogue: NonNullable<BreakdownData['shots'][0]['dialogue']>
  characters: { id: string; name: string }[]
  onChange: (d: NonNullable<BreakdownData['shots'][0]['dialogue']>) => void
}) {
  const add = () => onChange([...dialogue, { characterId: characters[0]?.id ?? '', text: '', emotion: '' }])
  const upd = (i: number, patch: Partial<(typeof dialogue)[0]>) =>
    onChange(dialogue.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const rm = (i: number) => onChange(dialogue.filter((_, j) => j !== i))
  // Readable, roomy fields (was text-[10px] on a single cramped row). Each line is its
  // own card: character + emotion on top, the spoken line full-width below.
  const inp = 'bg-elevated border border-border rounded px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-cyan/50'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Dialogue</p>
        <button onClick={add} data-testid="dialogue-add"
          className="flex items-center gap-1 text-[11px] text-cyan hover:text-cyan font-semibold border border-cyan/40 rounded-md px-2 py-1 hover:bg-cyan/10 transition-colors">
          <Plus size={12} /> Add line
        </button>
      </div>
      {dialogue.length === 0 && (
        <p className="text-[11px] text-text-dim italic px-0.5">No lines yet — click <span className="text-cyan not-italic font-semibold">Add line</span> to write dialogue for this shot.</p>
      )}
      {dialogue.map((d, i) => (
        <div key={`${dialogue.length}-${i}`} className="flex flex-col gap-1.5 rounded-lg border border-border bg-elevated/40 p-2">
          <div className="flex items-center gap-2">
            <select value={d.characterId} onChange={(e) => upd(i, { characterId: e.target.value })}
              className={`${inp} w-32 text-orange font-semibold cursor-pointer`}>
              {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              {!characters.some((c) => c.id === d.characterId) && <option value={d.characterId}>{d.characterId || '—'}</option>}
            </select>
            <input defaultValue={d.emotion ?? ''} placeholder="emotion (e.g. weary, urgent)"
              onBlur={(e) => e.target.value !== (d.emotion ?? '') && upd(i, { emotion: e.target.value })} className={`${inp} flex-1`} />
            <button onClick={() => rm(i)} className="text-text-dim hover:text-red p-1 shrink-0" title="Remove line"><X size={14} /></button>
          </div>
          <textarea defaultValue={d.text} placeholder="Spoken line…" rows={2}
            onBlur={(e) => e.target.value !== d.text && upd(i, { text: e.target.value })}
            className={`${inp} w-full italic leading-snug resize-y min-h-[2.4rem]`} />
        </div>
      ))}
    </div>
  )
}

/** Character dossier — hand-editable fields + a Director "Generate detail" pass
 *  that fills personality / backstory / wardrobe from the description (Seed 2.0 Pro). */
function CharacterDetail({ a, onEdit, scriptContext, onError }: {
  a: BreakdownData['assets'][0]
  onEdit: (id: string, patch: Partial<BreakdownData['assets'][0]>) => void
  /** Their lines and actions from the breakdown. The director pass has always sent this;
   *  this button sent nothing, so it wrote a dossier for a generic person with the right
   *  name — the acting profile is the half of the prompt that carries performance, and an
   *  ungrounded one is worse than none because it reads convincing. */
  scriptContext: string
  onError: (name: string, msg: string) => void
}) {
  const [gen, setGen] = useState(false)
  // Feeds the per-field SmartField enhancers below. NOT the enrich call — that one needs
  // the character's lines and actions, which is what `scriptContext` carries.
  const ctx = `${a.name}: ${a.visualDescription}`
  const generate = async () => {
    setGen(true)
    try {
      const d = await pipelineApi.enrichCharacter(a.name, a.visualDescription, scriptContext)
      onEdit(a.id, {
        personality: d.personality || a.personality,
        backstory: d.backstory || a.backstory,
        wardrobe: d.wardrobe || a.wardrobe,
        acting: d.acting || a.acting,
      })
    } catch (e) {
      // NAME the casualty, for the reason directorPass.ts already records: a swallowed
      // failure here leaves the character with no acting profile and nothing on screen
      // says so, and the loss only surfaces as a flat performance a hundred renders later.
      onError(a.name, e instanceof Error ? e.message : 'enrich failed')
    } finally { setGen(false) }
  }
  const lc = 'text-[9px] font-semibold text-text-muted uppercase tracking-widest'
  return (
    <div className="flex flex-col gap-2 mt-1 pt-2 border-t border-border/60" data-testid={`character-detail-${a.id}`}>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold text-cyan uppercase tracking-widest flex items-center gap-1.5">
          <Users size={11} /> Character detail
          {a.parentCharacterId && <span className="text-[9px] text-amber font-normal normal-case">· variant of {a.parentCharacterId}</span>}
        </span>
        <button onClick={generate} disabled={gen} data-testid={`char-generate-${a.id}`}
          title="Director: write personality, backstory & wardrobe from the description"
          className="ml-auto flex items-center gap-1 text-[10px] text-cyan hover:text-cyan/80 font-semibold disabled:opacity-50">
          {gen ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />} Generate detail
        </button>
      </div>
      <label className={lc}>Personality</label>
      <SmartField value={a.personality ?? ''} field="personality" context={ctx} rows={2} onCommit={(v) => onEdit(a.id, { personality: v })} />
      <label className={lc}>Backstory</label>
      <SmartField value={a.backstory ?? ''} field="backstory" context={ctx} rows={3} onCommit={(v) => onEdit(a.id, { backstory: v })} />
      <label className={lc}>Wardrobe (costume)</label>
      <SmartField value={a.wardrobe ?? ''} field="wardrobe" context={ctx} rows={2} onCommit={(v) => onEdit(a.id, { wardrobe: v })} />
      {/* The acting master profile. It gets the most rows of any field here because it is
        * the only one that goes to the generation model verbatim-ish: every shot's acting
        * direction is a re-expression of this paragraph, so an edit here changes the
        * performance across the whole film rather than in one dossier. */}
      <label className={lc}>Acting master profile</label>
      <SmartField value={a.acting ?? ''} field="acting master profile" context={ctx} rows={5}
        onCommit={(v) => onEdit(a.id, { acting: v })} />
      <label className={lc}>Dialogue notes</label>
      <SmartField value={a.dialogueNotes ?? ''} field="dialogue notes" context={ctx} rows={2} onCommit={(v) => onEdit(a.id, { dialogueNotes: v })} />
      <PropsEditor props={a.props ?? []} onChange={(props) => onEdit(a.id, { props })} />
    </div>
  )
}

function AssetsTable({ assets, onTypeChange, onEdit, contextOf, onEnrichError }: {
  assets: BreakdownData['assets']
  onTypeChange: (assetId: string, t: BreakdownData['assets'][0]['type']) => void
  onEdit: (id: string, patch: Partial<BreakdownData['assets'][0]>) => void
  contextOf: (assetId: string) => string
  onEnrichError: (name: string, msg: string) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  if (!assets.length) return <EmptyState message="No assets extracted" />
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-surface z-10">
        <tr className="border-b border-border">
          {['ID', 'Name', 'Type', 'Description', 'Scenes'].map((h) => (
            <th key={h} className="text-left px-4 py-2 text-[10px] font-semibold text-text-muted uppercase tracking-widest whitespace-nowrap">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {assets.map((a) => {
          const Icon = getTypeIcon(a.type)
          const color = getTypeColor(a.type)
          const isOpen = expanded === a.id
          return (
            <React.Fragment key={a.id}>
              <tr
                className="border-b border-border/50 hover:bg-elevated/40 transition-colors cursor-pointer"
                onClick={() => setExpanded(isOpen ? null : a.id)}
                data-testid={`asset-row-${a.id}`}
              >
                <td className="px-4 py-2.5 font-mono text-xs text-cyan">{a.id}</td>
                <td className="px-4 py-2.5 text-text-primary font-medium">
                  <div className="flex items-center gap-2">
                    <Icon size={13} className={`text-${color}`} />
                    {a.name}
                  </div>
                </td>
                <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <select
                    value={a.type === 'fx' ? 'vfx' : a.type}
                    onChange={(e) => onTypeChange(a.id, e.target.value as BreakdownData['assets'][0]['type'])}
                    data-testid={`asset-type-${a.id}`}
                    className={cn(
                      'bg-elevated border border-border rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wider',
                      'cursor-pointer focus:outline-none focus:border-cyan/50',
                      `text-${color}`
                    )}
                  >
                    {ASSET_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5 text-text-muted text-xs max-w-[280px]">
                  <span className={isOpen ? '' : 'line-clamp-2'}>{a.visualDescription}</span>
                </td>
                <td className="px-4 py-2.5 text-text-muted text-xs font-mono">
                  {a.sceneRefs?.join(', ') ?? '—'}
                </td>
              </tr>
              {isOpen && (
                <tr className="border-b border-border/50 bg-elevated/20">
                  <td colSpan={5} className="px-4 py-3">
                    <div className="flex flex-col gap-2 max-w-3xl" data-testid={`asset-detail-${a.id}`}>
                      <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Name</label>
                      <EditField value={a.name} rows={1} onCommit={(v) => onEdit(a.id, { name: v })} />
                      <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Visual Description (full, editable)</label>
                      <EditField value={a.visualDescription} rows={4} onCommit={(v) => onEdit(a.id, { visualDescription: v })}
                        testid={`asset-desc-edit-${a.id}`} />

                      {a.type === 'character' && <CharacterDetail a={a} onEdit={onEdit}
                        scriptContext={contextOf(a.id)} onError={onEnrichError} />}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function ShotsTable({ shots, assets, onEdit }: {
  shots: BreakdownData['shots']
  assets: BreakdownData['assets']
  onEdit: (id: string, patch: Partial<BreakdownData['shots'][0]>) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  if (!shots.length) return <EmptyState message="No shots in breakdown" />
  const assetMap = Object.fromEntries((assets ?? []).map((a) => [a.id, a.name]))
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-surface z-10">
        <tr className="border-b border-border">
          {['ID', 'Action', 'Duration', 'Camera', 'Assets Used', 'Dialogue'].map((h) => (
            <th key={h} className="text-left px-4 py-2 text-[10px] font-semibold text-text-muted uppercase tracking-widest whitespace-nowrap">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {shots.map((s) => {
          const isOpen = expanded === s.id
          return (
            <React.Fragment key={s.id}>
              <tr
                className="border-b border-border/50 hover:bg-elevated/40 transition-colors cursor-pointer"
                onClick={() => setExpanded(isOpen ? null : s.id)}
                data-testid={`shot-row-${s.id}`}
              >
                <td className="px-4 py-2.5 font-mono text-xs text-cyan">{s.id}</td>
                <td className="px-4 py-2.5 text-text-primary text-xs max-w-[200px]">
                  <span className={isOpen ? '' : 'line-clamp-2'}>{s.action}</span>
                </td>
                <td className="px-4 py-2.5 text-text-muted text-xs font-mono whitespace-nowrap">
                  {s.estimatedDuration}s
                </td>
                <td className="px-4 py-2.5 text-text-muted text-xs">{s.cameraAngle ?? '—'}</td>
                <td className="px-4 py-2.5 text-xs">
                  <div className="flex flex-wrap gap-1">
                    {(s.assetsUsed ?? []).map((id) => (
                      <span key={id} className="px-1.5 py-0.5 rounded bg-cyan/10 text-cyan text-[9px] font-mono border border-cyan/20">
                        {assetMap[id] ?? id}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-text-muted text-[10px] max-w-[160px]">
                  {s.dialogue?.length ? `${s.dialogue.length} line(s)` : '—'}
                </td>
              </tr>
              {isOpen && (
                <tr className="border-b border-border/50 bg-elevated/20">
                  <td colSpan={6} className="px-4 py-3">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid={`shot-detail-${s.id}`}>
                      <div className="flex flex-col gap-2">
                        <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Action (full, editable)</label>
                        <SmartField value={s.action} field="action" context={`${s.visualDescription} · ${s.cameraAngle ?? ''}`} rows={3} onCommit={(v) => onEdit(s.id, { action: v })} />
                        <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Visual Description</label>
                        <SmartField value={s.visualDescription} field="visual description" context={s.action} rows={3} onCommit={(v) => onEdit(s.id, { visualDescription: v })} />
                        <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Acting / Performance <span className="normal-case font-normal text-text-dim">(intent — fed to Seedance)</span></label>
                        <SmartField value={s.performance ?? ''} field="acting direction / performance intent for a video shot" context={`${s.action} · ${(s.dialogue ?? []).map((d) => d.text).join(' | ')}`} rows={2} onCommit={(v) => onEdit(s.id, { performance: v })} />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Camera</label>
                        <EditField value={s.cameraAngle ?? ''} rows={2} onCommit={(v) => onEdit(s.id, { cameraAngle: v })} />
                        <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Lighting</label>
                        <EditField value={s.lighting ?? ''} rows={2} onCommit={(v) => onEdit(s.id, { lighting: v })} />
                        <DialogueEditor
                          dialogue={s.dialogue ?? []}
                          characters={assets.filter((x) => x.type === 'character').map((x) => ({ id: x.id, name: x.name }))}
                          onChange={(dl) => onEdit(s.id, { dialogue: dl })}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function ScenesTable({ scenes, onEdit }: {
  scenes: BreakdownData['scenes']
  onEdit: (id: string, patch: Partial<BreakdownData['scenes'][0]>) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  if (!scenes.length) return <EmptyState message="No scenes extracted" />
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-surface z-10">
        <tr className="border-b border-border">
          {['ID', 'Heading', 'Description', 'Shots'].map((h) => (
            <th key={h} className="text-left px-4 py-2 text-[10px] font-semibold text-text-muted uppercase tracking-widest">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {scenes.map((sc) => {
          const isOpen = expanded === sc.id
          return (
            <React.Fragment key={sc.id}>
              <tr
                className="border-b border-border/50 hover:bg-elevated/40 transition-colors cursor-pointer"
                onClick={() => setExpanded(isOpen ? null : sc.id)}
              >
                <td className="px-4 py-2.5 font-mono text-xs text-cyan">{sc.id}</td>
                <td className="px-4 py-2.5 font-medium text-text-primary text-xs">{sc.heading}</td>
                <td className="px-4 py-2.5 text-text-muted text-xs max-w-[280px]">
                  <span className={isOpen ? '' : 'line-clamp-2'}>{sc.description}</span>
                </td>
                <td className="px-4 py-2.5 text-text-muted text-xs font-mono">
                  {isOpen ? sc.shotIds?.join(', ') : `${sc.shotIds?.length ?? 0} shots`}
                </td>
              </tr>
              {isOpen && (
                <tr className="border-b border-border/50 bg-elevated/20">
                  <td colSpan={4} className="px-4 py-3">
                    <div className="flex flex-col gap-2 max-w-3xl">
                      <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Heading</label>
                      <EditField value={sc.heading} rows={1} onCommit={(v) => onEdit(sc.id, { heading: v })} />
                      <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">Description (full, editable)</label>
                      <EditField value={sc.description} rows={3} onCommit={(v) => onEdit(sc.id, { description: v })} />
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full text-text-muted text-sm p-8">
      {message}
    </div>
  )
}
