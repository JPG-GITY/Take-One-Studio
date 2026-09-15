import { test, expect } from './isolation'
import { readFileSync, existsSync } from 'node:fs'

// Shots → segments, proved against the REAL ROBOTECH project on disk rather than a
// fixture. The whole migration rests on one rule: a migrated segment INHERITS the shot's
// id, because six live maps are keyed by shot id (stage-4 shotBoards, stage-5 shots[],
// approvedShotIds, shotVersions, shotSelectedVersion, finalCutEdit) plus the Shots/<id>/
// folders and the render registry. Mint new ids and ROBOTECH loses 44 approvals, 44
// boards and its final cut — silently, because nothing type-checks a keyed lookup.
//
// These run in-process (no browser) so they are fast and deterministic.

const ROBOTECH = `${process.env.HOME}/Documents/TakeOne-Project/ROBOTECH`
const STATE = `${ROBOTECH}/pipeline_state.json`
const BREAKDOWN = `${ROBOTECH}/Breakdown/breakdown.json`

// eslint-disable-next-line @typescript-eslint/no-require-imports
const seg = require('../lib/segments') as typeof import('../lib/segments')

type BD = import('../lib/types/pipeline.types').BreakdownData
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const readBreakdown = (p: string, dig = false): BD =>
  (dig ? readJson(p).state.stages['2'].versions[0].data : readJson(p)) as BD

test.describe('shots → segments', () => {
  test('every ROBOTECH shot becomes a segment that KEEPS its id', async () => {
    test.skip(!existsSync(STATE), 'ROBOTECH not on this machine')
    const bd = readBreakdown(STATE, true)
    const before = (bd.shots as Array<{ id: string }>).map((s) => s.id)
    expect(before.length).toBeGreaterThan(10)

    const after = seg.shotsToSegments(bd)
    expect(after.segments).toHaveLength(before.length)
    expect(after.segments!.map((s: { id: string }) => s.id)).toEqual(before)
    // Each carries exactly one sub-shot, suffixed — never a bare renumber.
    for (const s of after.segments!) {
      expect(s.shots).toHaveLength(1)
      expect(s.shots[0].id).toBe(`${s.id}_S1`)
    }
    console.log(`[segments] ${before.length} shots → ${after.segments!.length} segments, ids intact`)
  })

  test('the six shotId-keyed maps still resolve after migration', async () => {
    test.skip(!existsSync(STATE), 'ROBOTECH not on this machine')
    const st = readJson(STATE).state
    const migrated = seg.shotsToSegments(st.stages['2'].versions[0].data as BD)
    const ids = new Set(migrated.segments!.map((s: { id: string }) => s.id))

    const boards = Object.values(st.stages['4'].versions[0].data.sceneStates as Record<string,
      { shotBoards: Record<string, unknown> }>).flatMap((sc) => Object.keys(sc.shotBoards))
    const gen = (st.stages['5'].versions[0].data.shots as Array<{ shotId: string }>).map((s) => s.shotId)
    const approved: string[] = st.approvedShotIds ?? []
    const edl: string[] = st.finalCutEdit?.order ?? []
    const clips = Object.keys(st.finalCutEdit?.clips ?? {})

    for (const [name, keys] of Object.entries({ shotBoards: boards, generated: gen, approvedShotIds: approved, edlOrder: edl, edlClips: clips })) {
      const orphans = keys.filter((k) => !ids.has(k))
      expect(orphans, `${name} orphaned by the migration: ${orphans.slice(0, 5).join(', ')}`).toEqual([])
    }
    console.log(`[segments] boards ${boards.length} · generated ${gen.length} · approved `
      + `${approved.length} · edl ${edl.length} — zero orphans`)
  })

  test('the derived shots projection preserves count, order and durations', async () => {
    test.skip(!existsSync(STATE), 'ROBOTECH not on this machine')
    const bd = readBreakdown(STATE, true)
    const orig = bd.shots as Array<{ id: string; estimatedDuration: number; assetsUsed: string[] }>
    const after = seg.shotsToSegments(bd)

    expect(after.shots.map((s) => s.id)).toEqual(orig.map((s: { id: string }) => s.id))
    expect(after.shots.map((s) => s.estimatedDuration)).toEqual(orig.map((s: { estimatedDuration: number }) => s.estimatedDuration))
    // Assets are what bind a shot to its approved character/environment images.
    expect(after.shots.map((s) => s.assetsUsed)).toEqual(orig.map((s: { assetsUsed: string[] }) => s.assetsUsed))
    // And the segment's own duration equals what the shot claimed.
    for (const s of after.segments!) {
      expect(seg.segmentDurationSecs(s)).toBe(
        orig.find((o) => o.id === s.id)!.estimatedDuration)
    }
    console.log('[segments] projection round-trips ids, durations and assets')
  })

  test('scenes keep pointing at units of generation', async () => {
    test.skip(!existsSync(STATE), 'ROBOTECH not on this machine')
    const bd = readBreakdown(STATE, true)
    const after = seg.shotsToSegments(bd)
    const ids = new Set(after.segments!.map((s: { id: string }) => s.id))
    let total = 0
    for (const sc of after.scenes) {
      expect(sc.segmentIds).toBeDefined()
      for (const id of sc.segmentIds!) expect(ids.has(id)).toBe(true)
      total += sc.segmentIds!.length
    }
    expect(total).toBe(after.segments!.length)
    console.log(`[segments] ${after.scenes.length} scenes cover all ${total} segments`)
  })

  test('running it twice changes nothing', async () => {
    test.skip(!existsSync(STATE), 'ROBOTECH not on this machine')
    const bd = readBreakdown(STATE, true)
    const once = seg.shotsToSegments(bd)
    const twice = seg.shotsToSegments(once)
    expect(JSON.stringify(twice.segments)).toBe(JSON.stringify(once.segments))
    expect(JSON.stringify(twice.shots)).toBe(JSON.stringify(once.shots))
    console.log('[segments] idempotent — three entry points can all fire on one state')
  })

  test('the legacy snake_case breakdown.json on disk also migrates', async () => {
    test.skip(!existsSync(BREAKDOWN), 'ROBOTECH breakdown not on this machine')
    const bd = readBreakdown(BREAKDOWN)
    // Written by the backend in snake_case; the normaliser must not choke on it.
    const after = seg.shotsToSegments(bd)
    expect(Array.isArray(after.segments)).toBe(true)
    expect(after.segments!.length).toBe((bd.shots ?? []).length)
    console.log(`[segments] disk breakdown.json → ${after.segments!.length} segments`)
  })

  test('a multi-shot segment sums its shots', async () => {
    const s = {
      id: 'SHOT_001', sceneId: 'SC-1', order: 0,
      shots: [
        { id: 'SHOT_001', durationSecs: 1.5, action: 'foot hits the line', assetsUsed: [] },
        { id: 'SHOT_002', durationSecs: 5, action: 'walks away', assetsUsed: [] },
        { id: 'SHOT_003', durationSecs: 3, action: 'head turns', assetsUsed: [] },
      ],
    }
    // 1.5 s is the point of the whole change: impossible as its own render (API floor 4 s).
    expect(seg.segmentDurationSecs(s)).toBe(9.5)
    console.log('[segments] a 3-shot segment sums to 9.5s')
  })

  // These two cover the hole the first version of this file left: every test read
  // ROBOTECH, which ALREADY had segments, so they all exercised the early-return no-op
  // while two critical defects sat in the paths they never touched.

  test('LEGACY migration keeps action and visualDescription apart', async () => {
    test.skip(!existsSync(BREAKDOWN), 'ROBOTECH breakdown not on this machine')
    // breakdown.json has NO segments, so this is the real legacy path — the one that
    // runs for every project on disk that has not been opened yet.
    const bd = readBreakdown(BREAKDOWN)
    expect(bd.segments).toBeUndefined()
    const src = (bd.shots as Array<{ id: string; action?: string; visual_description?: string }>)
    const pairs = src.filter((s) => s.action && s.visual_description && s.action !== s.visual_description)
    expect(pairs.length).toBeGreaterThan(5)

    const after = seg.shotsToSegments(bd)
    // Fusing them wrote one string into BOTH fields of every shot of every project that
    // was opened, and the pair cannot be recovered afterwards.
    const fused = after.shots.filter((s) => s.action && s.action === s.visualDescription)
    expect(fused, `${fused.length} shot(s) had their two prose fields fused`).toHaveLength(0)
    console.log(`[segments] legacy path: ${after.shots.length} shots, 0 fused`)
  })

  test('the BACKEND shape yields one card per CALL, not per beat', async () => {
    // Exactly what claude_agents._group_into_segments emits: the segment inherits the id
    // of its FIRST shot, and the flat list still carries one entry per beat.
    const bd = {
      assets: [],
      shots: [
        { id: 'SHOT_001', sceneId: 'SC-1', action: 'foot', visualDescription: 'tight', assetsUsed: [], estimatedDuration: 1.5 },
        { id: 'SHOT_002', sceneId: 'SC-1', action: 'walks', visualDescription: 'wide', assetsUsed: [], estimatedDuration: 5 },
        { id: 'SHOT_003', sceneId: 'SC-1', action: 'turns', visualDescription: 'medium', assetsUsed: [], estimatedDuration: 3 },
        { id: 'SHOT_004', sceneId: 'SC-2', action: 'door', visualDescription: 'interior', assetsUsed: [], estimatedDuration: 6 },
      ],
      scenes: [
        { id: 'SC-1', heading: 'EXT. HIGHWAY', description: '', shotIds: ['SHOT_001', 'SHOT_002', 'SHOT_003'] },
        { id: 'SC-2', heading: 'INT. ROOM', description: '', shotIds: ['SHOT_004'] },
      ],
      segments: [
        { id: 'SHOT_001', sceneId: 'SC-1', order: 0, shots: [
          { id: 'SHOT_001', durationSecs: 1.5, action: 'foot', assetsUsed: [] },
          { id: 'SHOT_002', durationSecs: 5, action: 'walks', assetsUsed: [] },
          { id: 'SHOT_003', durationSecs: 3, action: 'turns', assetsUsed: [] }] },
        { id: 'SHOT_004', sceneId: 'SC-2', order: 1, shots: [
          { id: 'SHOT_004', durationSecs: 6, action: 'door', assetsUsed: [] }] },
      ],
    }
    const out = seg.shotsToSegments(bd as unknown as BD)
    // One strip card per Seedance CALL. One per beat rendered each beat separately:
    // three 4s calls instead of one 9.5s take — triple the cost and no internal cut.
    expect(out.shots).toHaveLength(2)
    expect(out.shots.map((s) => s.id)).toEqual(['SHOT_001', 'SHOT_004'])
    expect(out.shots[0].estimatedDuration).toBe(9.5)
    // And every card must resolve its own segment, or segment mode never fires.
    const ids = new Set(out.segments!.map((s: { id: string }) => s.id))
    for (const s of out.shots) expect(ids.has(s.id)).toBe(true)
    expect(out.scenes.every((sc) => (sc.segmentIds ?? []).length > 0)).toBe(true)
    // The composition prose survives the projection.
    expect(out.shots[0].visualDescription).toBe('tight')
    console.log('[segments] backend shape: 4 beats → 2 calls, 9.5s + 6s, ids resolve')
  })

  test('empty and malformed input is returned untouched, never crashed on', async () => {
    expect(seg.shotsToSegments(null)).toBeNull()
    expect(seg.shotsToSegments(undefined)).toBeUndefined()
    expect(seg.shotsToSegments({} as Partial<BD>)).toEqual({})
    expect(seg.shotsToSegments({ assets: [] } as Partial<BD>)).toEqual({ assets: [] })
    // migrateStagesToSegments runs on whole snapshots, including junk ones.
    expect(seg.migrateStagesToSegments(null) as unknown).toBeNull()
    expect(seg.migrateStagesToSegments({ '2': {} }) as unknown).toEqual({ '2': {} })
    console.log('[segments] degenerate input is a no-op, not a thrown migration')
  })
})
