import { test, expect } from './isolation'

// P5b: gateMode. The TopBar toggle flips manual↔auto; in 'auto', a shot whose
// final-scene QC passes (with acceptable drift) approves itself — no click.
// The animate + QC chain is route-mocked for determinism.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const mkShot = (id: string) => ({
  id, sceneId: 'SC-T', action: 'she turns to the door', visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'medium', lighting: 'soft', estimatedDuration: 5, dialogue: [],
})

const seed = (gateMode: 'manual' | 'auto', shotStatus: string) => ({
  state: {
    projectId: 'gm', projectName: 'gm', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', { assets: [], shots: [mkShot('GM_1')], scenes: [{ id: 'SC-T', heading: 'INT. ROOM - DAY', description: 'd', shotIds: ['GM_1'] }] }),
      3: stg('approved', { assetStates: {} }),
      4: idle(),
      5: stg('pending_review', { shots: [{
        shotId: 'GM_1', thumbnailUrl: 'http://localhost:8000/api/asset/serve?path=/tmp/gm/kf.png',
        keyframeLocalPath: '/tmp/gm/Shots/GM_1/Keyframes/Versions/v001.png',
        videoUrl: '', duration: 5, status: shotStatus, mode: 'keyframe',
      }] }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', gateMode, localFolderRoot: '/tmp/gm', approvedShotIds: [],
  },
  version: 4,
})

const readStore = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
  const s5 = st.state.stages['5']
  // approve-all commits a NEW active version — read that, not versions[0]
  const v = s5.versions.find((v: { id: string }) => v.id === s5.activeVersionId) ?? s5.versions[s5.versions.length - 1]
  const shots = v?.data?.shots ?? []
  return { gateMode: st.state.gateMode, activeStage: st.state.activeStage,
    shot: (shots as Array<{ shotId: string; status: string }>).find((s) => s.shotId === 'GM_1') }
})

test('gateMode toggle flips and persists', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), seed('manual', 'ready'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.getByTestId('gatemode-toggle').click()
  await expect(page.getByTestId('gatemode-toggle')).toContainText('✓')
  await expect.poll(async () => (await readStore(page)).gateMode, { timeout: 4000 }).toBe('auto')
  console.log('[gatemode] toggle → auto (persisted)')
})

test('auto: a QC-passing shot approves itself and advances', async ({ page }) => {
  await page.route('**/api/video/create', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'cgt-gm', assembled_prompt: 'p' }) }))
  await page.route('**/api/video/poll/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'completed', video_url: 'http://localhost:8000/api/asset/serve?path=/tmp/gm/v1.mp4', seed: 5, resolution: '480p' }) }))
  await page.route('**/api/shot/save-video', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, path: '/tmp/gm/Shots/GM_1/video_v001.mp4', local_path: '/tmp/gm/Shots/GM_1/video_v001.mp4' }) }))
  await page.route('**/api/finalscene/qc', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passed: true, summary: 'looks good', checks: [], identity_drift: 0.3 }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), seed('auto', 'keyframe_ready'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.getByTestId('strip-shot-GM_1').click()
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /Animate with Seedance/i }).click()

  // After render → QC pass → auto-approve, with NO manual approve click
  await expect.poll(async () => (await readStore(page)).shot?.status, { timeout: 25_000, intervals: [500] }).toBe('approved')
  console.log('[gatemode] shot auto-approved on QC pass')
})
