import { test, expect } from './isolation'
import { openAutopilot } from './hydration'

// P5c.3: Autopilot is resume-aware. With Script/Breakdown/Assets already
// approved, re-running it must NOT regenerate them — it skips straight to
// Stage 4, boards every scene via the registered runner, and (manual gate)
// PAUSES for review. Storyboard generation is route-mocked (no real spend).

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const mkShot = (id: string) => ({
  id, sceneId: 'SC-1', action: `Action ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [],
})

const SEED = {
  state: {
    projectId: 's4auto', projectName: 'auto', projectType: 'film', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'INT. ROOM - NIGHT' }, true)]),
      2: stg('approved', 'v1', [ver('v1', {
        assets: [{ id: 'ENV_1', name: 'Room', type: 'environment', visual_description: 'a room' }],
        shots: [mkShot('SHOT_1'), mkShot('SHOT_2')],
        scenes: [{ id: 'SC-1', heading: 'INT. ROOM - NIGHT', description: 'd', shotIds: ['SHOT_1', 'SHOT_2'] }],
      }, true)]),
      3: stg('approved', 'v1', [ver('v1', { assetStates: { ENV_1: { status: 'approved' } } }, true)]),
      4: idle(),
      5: idle(),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/auto', approvedShotIds: [],
  },
  version: 4,
}

const board = (sid: string) => ({
  shot_id: sid, board_url: '', board_local_path: `/tmp/auto/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1,
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'a', red: '', blue: '', green: '', orange: '', purple: '' }],
  auto_prompt: 'p', sent_prompt: 'p',
})

const boardStatus = (page: import('@playwright/test').Page, sceneId: string, shotId: string) =>
  page.evaluate(({ sc, sh }) => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s4 = st.state.stages['4']
    const v = s4.versions.find((v: { id: string }) => v.id === s4.activeVersionId) ?? s4.versions[s4.versions.length - 1]
    return v?.data?.sceneStates?.[sc]?.shotBoards?.[sh]?.status ?? 'missing'
  }, { sc: sceneId, sh: shotId })

test('autopilot resumes at Stage 4, boards every scene, then pauses (manual gate)', async ({ page }) => {
  test.setTimeout(60_000)
  await page.route('**/api/storyboard/generate', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ boards: [board('SHOT_1'), board('SHOT_2')] }) }))
  await page.route('**/api/storyboard/qc', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passed: true, summary: 'ok', checks: [], drift_score: 0.1 }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('resume into storyboards')
  await page.getByTestId('autopilot-start').click()

  // The runner boarded the scene's shots — 'pending' = generated, not yet approved
  await expect.poll(() => boardStatus(page, 'SC-1', 'SHOT_1'), { timeout: 30_000, intervals: [500] }).toBe('pending')
  await expect.poll(() => boardStatus(page, 'SC-1', 'SHOT_2'), { timeout: 10_000, intervals: [500] }).toBe('pending')
  console.log('[autopilot] Stage 4 boards generated (pending) — resumed past approved stages')

  // …then it PAUSED at Stage 4 (manual gate) — the running marker drops
  await expect(page.getByTestId('autopilot-button')).toHaveText('Autopilot', { timeout: 10_000 })
  console.log('[autopilot] paused at Stage 4 for review')
})

const stage4Status = (page: import('@playwright/test').Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state.stages['4'].status)

test('auto gate: autopilot auto-approves the storyboards and advances past Stage 4', async ({ page }) => {
  test.setTimeout(60_000)
  await page.route('**/api/storyboard/generate', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ boards: [board('SHOT_1'), board('SHOT_2')] }) }))
  await page.route('**/api/storyboard/qc', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passed: true, summary: 'ok', checks: [], drift_score: 0.1 }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({ ...s, state: { ...s.state, gateMode: 'auto' } })), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('auto-board it')
  await page.getByTestId('autopilot-start').click()

  // In auto gate the boards are approved (not merely pending) and Stage 4 locks
  await expect.poll(() => boardStatus(page, 'SC-1', 'SHOT_1'), { timeout: 30_000, intervals: [500] }).toBe('approved')
  await expect.poll(() => stage4Status(page), { timeout: 10_000, intervals: [500] }).toBe('approved')
  console.log('[autopilot] auto gate — Stage 4 boards approved + stage locked, advanced past SG')

  // Stage 5 has no runner yet (P5c.4) so the loop stops cleanly, not in error
  await expect(page.getByTestId('autopilot-button')).toHaveText('Autopilot', { timeout: 10_000 })
})
