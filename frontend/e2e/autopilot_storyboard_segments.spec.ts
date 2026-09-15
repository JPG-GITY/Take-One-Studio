import { test, expect } from './isolation'
import { openAutopilot } from './hydration'

/**
 * Stage 4's three board call sites — manual "Generate Boards", "Board all scenes" and
 * the autopilot runner — each used to assemble their OWN /api/storyboard/generate body,
 * and two of them had drifted: no `segmentShots` key at all. StoryboardShotIn defaults
 * that field to [], so the backend fell through to its uniform ~1-beat-per-1.5s grid and
 * boarded a rhythm the render is not going to have: a segment whose real cuts are 2s + 6s
 * came back as 5 uniform 1.6s beats (measured against claude_agents.storyboard_panels).
 *
 * So: assert on the BODY every path sends, over the SAME segment. A payload assertion is
 * what stops the three from drifting again — the boards themselves are mocked here.
 */

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

// ONE segment, TWO internal cuts: 2s then 6s. The flat shot projection carries their
// sum, which is the only duration the old payload ever told the backend about.
const SEGMENT = {
  id: 'SHOT_1', sceneId: 'SC-1', order: 0,
  sceneSettings: { time: 'night', light: 'single practical' },
  shots: [
    { id: 'SHOT_1_S1', durationSecs: 2, shotSize: 'CU', cameraMove: 'static', layout: 'Ana screen-left', action: 'Ana snaps her head to the door', assetsUsed: ['CHAR_1'] },
    { id: 'SHOT_1_S2', durationSecs: 6, shotSize: 'WIDE', cameraMove: 'push in', layout: 'door screen-right', action: 'she crosses the room and opens it', assetsUsed: ['CHAR_1'] },
  ],
}

const FLAT_SHOT = {
  id: 'SHOT_1', sceneId: 'SC-1', action: 'Ana snaps to the door, then crosses and opens it',
  visualDescription: 'vd SHOT_1', assetsUsed: ['CHAR_1'], cameraAngle: 'wide', lighting: 'single practical',
  performance: 'coiled, then decisive', estimatedDuration: 8, dialogue: [],
}

const SEED = {
  state: {
    projectId: 's4seg', projectName: 'auto', projectType: 'film', projectStructure: {}, activeStage: 4,
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'INT. ROOM - NIGHT' }, true)]),
      2: stg('approved', 'v1', [ver('v1', {
        assets: [{ id: 'CHAR_1', name: 'Ana', type: 'character', visualDescription: 'short dark hair, grey coat' }],
        shots: [FLAT_SHOT],
        scenes: [{ id: 'SC-1', heading: 'INT. ROOM - NIGHT', description: 'd', shotIds: ['SHOT_1'] }],
        segments: [SEGMENT],
      }, true)]),
      3: stg('approved', 'v1', [ver('v1', { assetStates: { CHAR_1: { status: 'approved', selectedUrl: 'http://x/ana.png', localPath: '/tmp/auto/Assets/Characters/Ana/v1.png' } } }, true)]),
      4: idle(),
      5: idle(),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/auto', approvedShotIds: [],
  },
  version: 4,
}

const BOARD = {
  shot_id: 'SHOT_1', board_url: '', board_local_path: '/tmp/auto/Shots/SHOT_1/board.png',
  version: 1, rows: 1, cols: 2,
  panels: [
    { label: 'SHOT_1-A', time: '0-2s', name: 'Snap', shot_type: 'CU.', desc: 'a', red: '', blue: '', green: '', orange: '', purple: '' },
    { label: 'SHOT_1-B', time: '2-8s', name: 'Cross', shot_type: 'Wide.', desc: 'b', red: '', blue: '', green: '', orange: '', purple: '' },
  ],
  auto_prompt: 'p', sent_prompt: 'p',
}

type Body = { shots?: Array<Record<string, unknown>> }

/** Route /api/storyboard/generate, keeping every body it is sent. */
const captureBoards = async (page: import('@playwright/test').Page, sink: Body[]) => {
  await page.route('**/api/storyboard/generate', (r) => {
    sink.push(r.request().postDataJSON() as Body)
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ boards: [BOARD] }) })
  })
  await page.route('**/api/storyboard/qc', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ passed: true, summary: 'ok', checks: [], drift_score: 0.1 }),
  }))
}

const boot = async (page: import('@playwright/test').Page, seed: unknown = SEED) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), seed)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
}

/** The one thing every path has to say about this segment: its real internal cuts. */
const expectRealCuts = (body: Body | undefined, who: string) => {
  expect(body, `${who} sent no body`).toBeTruthy()
  const shot = body!.shots?.[0] as { segmentShots?: Array<{ duration_sec: number }>; assets?: unknown[] } | undefined
  expect(shot, `${who} sent no shots`).toBeTruthy()
  expect(shot!.segmentShots, `${who} omitted segmentShots`).toHaveLength(2)
  expect(shot!.segmentShots!.map((s) => s.duration_sec)).toEqual([2, 6])
  // Identity references travel with the beats — a board without them draws a generic figure.
  expect(shot!.assets, `${who} omitted assets`).toHaveLength(1)
  console.log(`[stage4:${who}] segmentShots=${JSON.stringify(shot!.segmentShots!.map((s) => s.duration_sec))} `
    + `assets=${(shot!.assets as Array<{ name: string }>).map((a) => a.name).join(',')}`)
}

test('manual "Generate Boards" sends the segment\'s real cuts', async ({ page }) => {
  test.setTimeout(60_000)
  const bodies: Body[] = []
  await captureBoards(page, bodies)
  await boot(page)
  await page.getByRole('button', { name: /Generate Boards/ }).click()
  await expect.poll(() => bodies.length, { timeout: 30_000, intervals: [250] }).toBe(1)
  expectRealCuts(bodies[0], 'manual')
})

test('"Board all scenes" sends the same payload as the manual path', async ({ page }) => {
  test.setTimeout(60_000)
  const bodies: Body[] = []
  await captureBoards(page, bodies)
  await boot(page)
  await page.getByTestId('board-all-scenes').click()
  await expect.poll(() => bodies.length, { timeout: 30_000, intervals: [250] }).toBe(1)
  expectRealCuts(bodies[0], 'batch')
})

test('the autopilot runner sends the same payload as the manual path', async ({ page }) => {
  test.setTimeout(60_000)
  const bodies: Body[] = []
  await captureBoards(page, bodies)
  await boot(page, { ...SEED, state: { ...SEED.state, activeStage: 3 } })
  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('board the segment')
  await page.getByTestId('autopilot-start').click()
  await expect.poll(() => bodies.length, { timeout: 40_000, intervals: [250] }).toBe(1)
  expectRealCuts(bodies[0], 'autopilot')
})
