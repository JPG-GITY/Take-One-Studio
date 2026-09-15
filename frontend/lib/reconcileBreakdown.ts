// ── Breakdown reconciliation ──────────────────────────────────────────────────
// The breakdown LLM renumbers ASSET_NNN / SHOT_NNN / SC-NN on every run
// (claude_agents.py: "IDs are LOCAL to this segment … renumbered globally"),
// but ALL downstream state is keyed by those IDs: stage-3 assetStates, stage-4
// shotBoards, stage-5 shots, dialogue.characterId → voice mapping. A regen
// therefore cross-wired approvals (verified on disk: ASSET_017 was "Eastern
// Open Settlement"'s approved image, shown under the regenerated breakdown's
// ASSET_017 = "Archivist Penn").
//
// Fix strategy (least invasive): rewrite the NEW breakdown's IDs to reuse the
// OLD IDs for entities that still exist — matched by stable content keys — so
// downstream state stays valid WITHOUT migrating three stages of persisted
// state. Unmatched (new) entities get fresh IDs that collide with nothing.
// The summary lists kept / changed / new so the UI can tell the user exactly
// which tomas are affected.

import type { Asset, BreakdownData, Scene, Shot } from '@/lib/types/pipeline.types'

export interface ReconcileSummary {
  assetsKept: string[]          // matched, description unchanged (state fully valid)
  assetsChanged: string[]       // matched, visualDescription changed (regen advised)
  assetsNew: string[]           // no old counterpart (start from idle)
  assetsRemoved: string[]       // existed before, gone now (state preserved, hidden)
  shotsKept: string[]           // matched + content-identical (boards/clips stay valid)
  shotsChanged: string[]        // matched but action/dialogue/camera changed → affected
  shotsNew: string[]
  shotsRemoved: string[]
}

const norm = (s: string | undefined | null) =>
  (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

const assetKey = (a: Asset) => `${norm(a.type)}|${norm(a.name)}`
const sceneKey = (sc: Scene) => norm(sc.heading)

/** Content fingerprint deciding whether a matched shot is "unchanged" — the fields
 *  that feed boards + Seedance. A differing fingerprint marks the toma as affected. */
const shotFingerprint = (s: Shot) => JSON.stringify({
  a: norm(s.action),
  c: norm(s.cameraAngle),
  l: norm(s.lighting),
  d: s.estimatedDuration,
  dl: (s.dialogue ?? []).map((d) => [norm(d.text), norm(d.emotion)]),
  p: norm(s.performance),
})

const idNum = (id: string) => {
  const m = /(\d+)\s*$/.exec(id)
  return m ? parseInt(m[1], 10) : 0
}

/** Rewrite `next`'s IDs to reuse `prev`'s IDs for matching entities. Pure. */
export function reconcileBreakdown(prev: BreakdownData, next: BreakdownData): {
  breakdown: BreakdownData
  summary: ReconcileSummary
} {
  const summary: ReconcileSummary = {
    assetsKept: [], assetsChanged: [], assetsNew: [], assetsRemoved: [],
    shotsKept: [], shotsChanged: [], shotsNew: [], shotsRemoved: [],
  }

  // ── Assets: match by (type, name) — the stable human identity of the asset ──
  const oldByKey = new Map<string, Asset>()
  for (const a of prev.assets) if (!oldByKey.has(assetKey(a))) oldByKey.set(assetKey(a), a)
  const usedOldAssetIds = new Set<string>()
  const assetIdMap = new Map<string, string>()   // new(temp) id → final id
  let nextAssetNum = Math.max(0, ...prev.assets.map((a) => idNum(a.id)),
    ...next.assets.map((a) => idNum(a.id)))

  const assets = next.assets.map((a) => {
    const old = oldByKey.get(assetKey(a))
    if (old && !usedOldAssetIds.has(old.id)) {
      usedOldAssetIds.add(old.id)
      assetIdMap.set(a.id, old.id)
      if (norm(old.visualDescription) === norm(a.visualDescription)) summary.assetsKept.push(a.name)
      else summary.assetsChanged.push(a.name)
      return { ...a, id: old.id }
    }
    // Fresh entity → an ID beyond every old/new number so it collides with nothing.
    nextAssetNum += 1
    const fresh = `ASSET_${String(nextAssetNum).padStart(3, '0')}`
    assetIdMap.set(a.id, fresh)
    summary.assetsNew.push(a.name)
    return { ...a, id: fresh }
  })
  summary.assetsRemoved = prev.assets
    .filter((a) => !usedOldAssetIds.has(a.id))
    .map((a) => a.name)

  // ── Scenes: heading+occurrence first, then ORDER-BASED pairing of leftovers ──
  // Headings are LLM-written free text and get reworded between runs ("IMPERIAL
  // PALACE HALL OF EMPERORS" → "IMPERIAL PALACE HALL", DAY↔NIGHT), and the same
  // location can head several scenes — exact-heading matching alone left most
  // scenes unmatched and renumbered EVERYTHING (SC-08+). Scenes follow script
  // order, so pairing the leftovers by position keeps scene IDs (and the stage-4
  // per-scene state keyed by them) stable; only a genuine count increase mints
  // fresh IDs, appended after the old maximum.
  const oldScenesByKey = new Map<string, Scene[]>()
  for (const sc of prev.scenes) {
    const arr = oldScenesByKey.get(sceneKey(sc)) ?? []
    arr.push(sc); oldScenesByKey.set(sceneKey(sc), arr)
  }
  const usedOldSceneIds = new Set<string>()
  const sceneMatch = new Map<string, Scene>()          // new(temp) id → old scene
  const seenHeading = new Map<string, number>()
  for (const sc of next.scenes) {                      // pass 1: heading + occurrence
    const k = sceneKey(sc)
    const idx = seenHeading.get(k) ?? 0
    seenHeading.set(k, idx + 1)
    const old = (oldScenesByKey.get(k) ?? [])[idx]
    if (old && !usedOldSceneIds.has(old.id)) {
      usedOldSceneIds.add(old.id)
      sceneMatch.set(sc.id, old)
    }
  }
  const leftoverOld = prev.scenes.filter((s) => !usedOldSceneIds.has(s.id))
  const leftoverNew = next.scenes.filter((s) => !sceneMatch.has(s.id))
  for (let i = 0; i < Math.min(leftoverOld.length, leftoverNew.length); i++) {
    usedOldSceneIds.add(leftoverOld[i].id)             // pass 2: pair in script order
    sceneMatch.set(leftoverNew[i].id, leftoverOld[i])
  }
  const sceneIdMap = new Map<string, string>()
  let nextSceneNum = Math.max(0, ...prev.scenes.map((s) => idNum(s.id)),
    ...next.scenes.map((s) => idNum(s.id)))
  const scenesPass1 = next.scenes.map((sc) => {
    const old = sceneMatch.get(sc.id)
    if (old) {
      sceneIdMap.set(sc.id, old.id)
      return { ...sc, id: old.id }
    }
    nextSceneNum += 1
    const fresh = `SC-${String(nextSceneNum).padStart(2, '0')}`
    sceneIdMap.set(sc.id, fresh)
    return { ...sc, id: fresh }
  })

  // ── Shots: exact action within the mapped scene, then ORDER-BASED pairing ──
  // Action text is rewritten between runs (the LLM rephrases; the director
  // auto-enhance polishes the stored text after commit), so exact matching alone
  // renumbered nearly every shot. ID reuse is deliberately LIBERAL (position
  // pairing keeps the toma's identity + downstream boards/clips), while the
  // content fingerprint stays STRICT — a reworded/redialogued shot keeps its ID
  // but is flagged as an affected toma, never silently "kept".
  const oldShotsByScene = new Map<string, Shot[]>()
  for (const s of prev.shots) {
    const arr = oldShotsByScene.get(s.sceneId) ?? []
    arr.push(s); oldShotsByScene.set(s.sceneId, arr)
  }
  const usedOldShotIds = new Set<string>()
  const shotMatch = new Map<string, Shot>()            // new(temp) id → old shot
  for (const s of next.shots) {                        // pass 1: exact action in scene
    const mappedScene = sceneIdMap.get(s.sceneId) ?? s.sceneId
    const old = (oldShotsByScene.get(mappedScene) ?? [])
      .find((o) => !usedOldShotIds.has(o.id) && norm(o.action) === norm(s.action))
    if (old) { usedOldShotIds.add(old.id); shotMatch.set(s.id, old) }
  }
  const unmatchedNewByScene = new Map<string, Shot[]>()
  for (const s of next.shots) {
    if (shotMatch.has(s.id)) continue
    const ms = sceneIdMap.get(s.sceneId) ?? s.sceneId
    const arr = unmatchedNewByScene.get(ms) ?? []
    arr.push(s); unmatchedNewByScene.set(ms, arr)
  }
  for (const [sceneId, newsList] of unmatchedNewByScene) {   // pass 2: pair in order
    const olds = (oldShotsByScene.get(sceneId) ?? []).filter((o) => !usedOldShotIds.has(o.id))
    for (let i = 0; i < Math.min(olds.length, newsList.length); i++) {
      usedOldShotIds.add(olds[i].id)
      shotMatch.set(newsList[i].id, olds[i])
    }
  }
  const shotIdMap = new Map<string, string>()
  let nextShotNum = Math.max(0, ...prev.shots.map((s) => idNum(s.id)),
    ...next.shots.map((s) => idNum(s.id)))

  const shots = next.shots.map((s) => {
    const mappedScene = sceneIdMap.get(s.sceneId) ?? s.sceneId
    const old = shotMatch.get(s.id)
    const remapped: Shot = {
      ...s,
      sceneId: mappedScene,
      assetsUsed: (s.assetsUsed ?? []).map((id) => assetIdMap.get(id) ?? id),
      dialogue: (s.dialogue ?? []).map((d) => ({
        ...d, characterId: assetIdMap.get(d.characterId) ?? d.characterId,
      })),
    }
    if (old) {
      shotIdMap.set(s.id, old.id)
      const same = shotFingerprint({ ...remapped, id: old.id }) === shotFingerprint(old)
      ;(same ? summary.shotsKept : summary.shotsChanged).push(old.id)
      return { ...remapped, id: old.id }
    }
    nextShotNum += 1
    const fresh = `SHOT_${String(nextShotNum).padStart(3, '0')}`
    shotIdMap.set(s.id, fresh)
    summary.shotsNew.push(fresh)
    return { ...remapped, id: fresh }
  })
  summary.shotsRemoved = prev.shots
    .filter((s) => !usedOldShotIds.has(s.id))
    .map((s) => s.id)

  // Scenes reference shots — rewrite their shotIds with the final shot IDs.
  const scenes = scenesPass1.map((sc) => ({
    ...sc,
    shotIds: sc.shotIds.map((id) => shotIdMap.get(id) ?? id),
  }))

  // Segments must be remapped, never spread through. `next` was generated with its OWN
  // local id space, and this whole file exists to rewrite those onto the ids already on
  // disk. Copying `segments` untouched would leave them pointing at the pre-reconcile
  // numbering — so `segmentOf('SHOT_003')` would hand stage 5 a DIFFERENT shot's beats
  // and durations, and it would render the wrong thing while every id looked right.
  // Harmless only while the segment keying was broken; live the moment it works.
  const segments = (next.segments ?? []).map((sg) => ({
    ...sg,
    id: shotIdMap.get(sg.id) ?? sg.id,
    sceneId: sceneIdMap.get(sg.sceneId) ?? sg.sceneId,
    shots: (sg.shots ?? []).map((sh) => ({
      ...sh,
      id: shotIdMap.get(sh.id) ?? sh.id,
      assetsUsed: (sh.assetsUsed ?? []).map((a) => assetIdMap.get(a) ?? a),
      dialogue: (sh.dialogue ?? []).map((d) => ({
        ...d,
        characterId: assetIdMap.get(d.characterId) ?? d.characterId,
      })),
    })),
  }))
  const segScenes = scenes.map((sc) => ({
    ...sc,
    segmentIds: (sc.segmentIds ?? []).map((id) => shotIdMap.get(id) ?? id),
  }))

  return { breakdown: { ...next, assets, shots, scenes: segScenes, segments }, summary }
}
