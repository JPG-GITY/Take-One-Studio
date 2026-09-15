import { test, expect } from './isolation'
import { openAutopilot } from './hydration'

// P5c.4: with Script→Storyboard all approved, autopilot resumes at Stage 5 and
// renders EVERY shot via the registered runner. Board-backed shots animate
// directly (storyboard mode, no keyframe). In the AUTO gate every rendered take
// is approved and the stage locks. All Seedance calls are route-mocked.

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`

const mkShot = (id: string) => ({
  id, sceneId: 'SC-1', action: `Action ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [],
})

const approvedBoard = (sid: string) => ({
  status: 'approved', boardUrl: '',
  boardLocalPath: `/tmp/auto/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'a', red: '', blue: '', green: '', orange: '', purple: '' }],
})

const SEED = {
  state: {
    projectId: 's5auto', projectName: 'auto', projectType: 'film', projectStructure: {}, activeStage: 5,
    gateMode: 'auto',
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'INT. ROOM - NIGHT' }, true)]),
      2: stg('approved', 'v1', [ver('v1', {
        assets: [],
        shots: [mkShot('SHOT_1'), mkShot('SHOT_2')],
        scenes: [{ id: 'SC-1', heading: 'INT. ROOM - NIGHT', description: 'd', shotIds: ['SHOT_1', 'SHOT_2'] }],
      }, true)]),
      3: stg('approved', 'v1', [ver('v1', { assetStates: {} }, true)]),
      4: stg('approved', 'v1', [ver('v1', {
        sceneStates: { 'SC-1': { status: 'approved', shotBoards: { SHOT_1: approvedBoard('SHOT_1'), SHOT_2: approvedBoard('SHOT_2') }, qcResult: null, notes: '' } },
      }, true)]),
      5: idle(),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/auto', approvedShotIds: [],
  },
  version: 4,
}

const shotStatus = (page: import('@playwright/test').Page, shotId: string) =>
  page.evaluate((sid) => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s5 = st.state.stages['5']
    const v = s5.versions.find((v: { id: string }) => v.id === s5.activeVersionId) ?? s5.versions[s5.versions.length - 1]
    return (v?.data?.shots as Array<{ shotId: string; status: string }> | undefined)?.find((s) => s.shotId === sid)?.status ?? 'missing'
  }, shotId)

const stage5Status = (page: import('@playwright/test').Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state.stages['5'].status)

test('auto gate: autopilot resumes at Stage 5, renders every shot, approves + locks', async ({ page }) => {
  test.setTimeout(90_000)
  // P4: board-backed shots DEFAULT to keyframe mode (SB is opt-in), so a keyframe
  // is rendered first, then animated.
  await page.route('**/api/video/keyframe', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    keyframe_url: serve('/tmp/auto/Shots/kf.png'), keyframe_local_path: '/tmp/auto/Shots/kf.png',
    shot_id: 'x', assembled_prompt: 'p', sent_prompt: 'p', ref_count: 1,
  }) }))
  await page.route('**/api/video/create', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'cgt-auto-1', assembled_prompt: 'p' }) }))
  await page.route('**/api/video/poll/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    status: 'completed',
    video_url: serve('/tmp/auto/Shots/out.mp4'),
    seed: 123, resolution: '480p', last_frame_url: serve('/tmp/auto/Shots/last.png'),
  }) }))
  await page.route('**/api/shot/save-video', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, path: '', local_path: '/tmp/auto/Shots/saved.mp4', bytes: 2_000_000 }) }))
  await page.route('**/api/finalscene/qc', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passed: true, summary: 'ok', checks: [], identity_drift: 0.1 }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('render the cut')
  await page.getByTestId('autopilot-start').click()

  // Every shot rendered and auto-approved; the stage locks
  await expect.poll(() => shotStatus(page, 'SHOT_1'), { timeout: 60_000, intervals: [1000] }).toBe('approved')
  await expect.poll(() => shotStatus(page, 'SHOT_2'), { timeout: 30_000, intervals: [1000] }).toBe('approved')
  await expect.poll(() => stage5Status(page), { timeout: 10_000, intervals: [500] }).toBe('approved')
  console.log('[autopilot] Stage 5 — every shot rendered + auto-approved, stage locked')

  // Stage 6 has no runner yet (P5c.5) so the loop stops cleanly, not in error
  await expect(page.getByTestId('autopilot-button')).toHaveText('Autopilot', { timeout: 10_000 })
})

test('manual gate: autopilot renders every shot then pauses for review (not auto-approved)', async ({ page }) => {
  test.setTimeout(90_000)
  await page.route('**/api/video/keyframe', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    keyframe_url: serve('/tmp/auto/Shots/kf.png'), keyframe_local_path: '/tmp/auto/Shots/kf.png',
    shot_id: 'x', assembled_prompt: 'p', sent_prompt: 'p', ref_count: 1,
  }) }))
  await page.route('**/api/video/create', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'cgt-auto-2', assembled_prompt: 'p' }) }))
  await page.route('**/api/video/poll/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    status: 'completed', video_url: serve('/tmp/auto/Shots/out.mp4'), seed: 123, resolution: '480p', last_frame_url: serve('/tmp/auto/Shots/last.png'),
  }) }))
  await page.route('**/api/shot/save-video', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, path: '', local_path: '/tmp/auto/Shots/saved.mp4', bytes: 2_000_000 }) }))
  await page.route('**/api/finalscene/qc', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passed: true, summary: 'ok', checks: [], identity_drift: 0.1 }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({ ...s, state: { ...s.state, gateMode: 'manual' } })), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('render then pause')
  await page.getByTestId('autopilot-start').click()

  // Shots render to 'ready' but are NOT approved; the stage waits for review
  await expect.poll(() => shotStatus(page, 'SHOT_1'), { timeout: 60_000, intervals: [1000] }).toBe('ready')
  await expect.poll(() => shotStatus(page, 'SHOT_2'), { timeout: 30_000, intervals: [1000] }).toBe('ready')
  await expect.poll(() => stage5Status(page), { timeout: 10_000, intervals: [500] }).toBe('pending_review')
  console.log('[autopilot] manual gate — all shots rendered (ready), paused for review, none auto-approved')

  await expect(page.getByTestId('autopilot-button')).toHaveText('Autopilot', { timeout: 10_000 })
})
