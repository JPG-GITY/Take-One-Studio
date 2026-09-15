import { test, expect } from './isolation'

// P5a Magic Box: a natural-language instruction is interpreted by Claude into a
// refined note + regen scope, then regenerates just that shot. All generation
// endpoints are route-mocked so the test is deterministic and spends nothing.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const mkShot = (id: string) => ({
  id, sceneId: 'SC-T', action: 'she walks to the window', visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'medium', lighting: 'soft daylight', estimatedDuration: 5, dialogue: [],
})

const SEED = {
  state: {
    projectId: 'mb', projectName: 'mb', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', { assets: [], shots: [mkShot('MB_1')], scenes: [{ id: 'SC-T', heading: 'INT. ROOM - DAY', description: 'd', shotIds: ['MB_1'] }] }),
      3: stg('approved', { assetStates: {} }),
      4: idle(),
      // a rendered shot with a keyframe → 'animate' scope re-animates it
      5: stg('pending_review', { shots: [{
        shotId: 'MB_1', thumbnailUrl: '', videoUrl: 'http://localhost:8000/api/asset/serve?path=/tmp/mb/v0.mp4',
        keyframeLocalPath: '/tmp/mb/Shots/MB_1/Keyframes/Versions/v001.png',
        duration: 5, status: 'ready', renderedResolution: '480p', seed: 11, mode: 'keyframe',
      }] }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/mb', approvedShotIds: [],
  },
  version: 4,
}

const shotState = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
  const shots = st.state.stages['5'].versions[0]?.data?.shots ?? []
  return (shots as Array<{ shotId: string; status: string; notes?: string }>).find((s) => s.shotId === 'MB_1')
})

test('Magic Box: an instruction refines the note + regenerates just this shot', async ({ page }) => {
  let directCalled = false
  await page.route('**/api/shot/direct', async (route) => {
    directCalled = true
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ notes: 'slow push-in at dusk; she looks scared', scope: 'animate', summary: 'Slower push-in, dusk light, tense' }) })
  })
  // Mock the animate chain so nothing real/paid runs
  await page.route('**/api/video/create', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'cgt-mb-1', assembled_prompt: 'p' }) }))
  await page.route('**/api/video/poll/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'completed', video_url: 'http://localhost:8000/api/asset/serve?path=/tmp/mb/v1.mp4', seed: 11, resolution: '480p' }) }))
  await page.route('**/api/shot/save-video', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 2, path: '/tmp/mb/Shots/MB_1/video_v002.mp4', local_path: '/tmp/mb/Shots/MB_1/video_v002.mp4' }) }))
  await page.route('**/api/finalscene/qc', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passed: true, summary: 'ok', checks: [], identity_drift: 0.3 }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.getByTestId('strip-shot-MB_1').click()
  await page.waitForTimeout(300)

  // Direct the shot in natural language
  await page.getByTestId('direct-input').fill('slower, push in at dusk, she looks scared')
  await page.getByTestId('direct-apply').click()

  // Claude was asked, and the refined note is applied to the shot (persisted)
  await expect.poll(() => directCalled, { timeout: 5000 }).toBe(true)
  await expect.poll(async () => (await shotState(page))?.notes, { timeout: 8000 }).toBe('slow push-in at dusk; she looks scared')
  console.log('[magic-box] refined note applied to the shot')

  // …and only this shot regenerates — it leaves 'ready' and comes back rendered
  await expect.poll(async () => (await shotState(page))?.status, { timeout: 20_000, intervals: [500] }).toBe('ready')
  console.log('[magic-box] shot re-animated to ready')
})
