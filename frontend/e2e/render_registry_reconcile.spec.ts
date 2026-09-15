import { test, expect } from './isolation'

// B2: a render the backend finished + saved to disk while the tab was closed is
// recorded in the persistent registry. On Stage 5 mount the frontend reconciles
// against /api/video/registry and adopts the saved clip — the shot goes 'ready'
// with a disk-served URL, no live poller needed. Registry is mocked for determinism.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const mkShot = (id: string) => ({
  id, sceneId: 'SC-T', action: `Action for ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [],
})

const SEED = {
  state: {
    projectId: 'reg', projectName: 'reg', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', { assets: [], shots: [mkShot('REG_1')], scenes: [{ id: 'SC-T', heading: 'INT. T - NIGHT', description: 'd', shotIds: ['REG_1'] }] }),
      3: stg('approved', { assetStates: {} }),
      4: idle(),
      // shot never finished in THIS session: no video, no live poller
      5: stg('pending_review', { shots: [{ shotId: 'REG_1', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued' }] }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_reg', approvedShotIds: [],
  },
  version: 3,
}

const shotState = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
  const shots = st.state.stages['5'].versions[0]?.data?.shots ?? []
  return (shots as Array<{ shotId: string; status: string; videoUrl?: string; seed?: number }>).find((s) => s.shotId === 'REG_1')
})

test('stage 5 adopts a backend-saved render from the registry on mount', async ({ page }) => {
  await page.route('**/api/video/registry**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ tasks: [{
      task_id: 'cgt-reg-1', status: 'completed', shot_id: 'REG_1',
      video_local_path: '/tmp/takeone_reg/Shots/REG_1/video_v001.mp4', seed: 42, resolution: '1080p',
    }] }),
  }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })

  // reconcileFromRegistry fires ~4.5s after mount
  await expect.poll(async () => (await shotState(page))?.status, { timeout: 15_000, intervals: [500] }).toBe('ready')
  const s = await shotState(page)
  console.log('[registry] adopted →', JSON.stringify(s))
  expect(s?.videoUrl).toContain('/api/asset/serve')
  expect(s?.videoUrl).toContain('video_v001.mp4')
  expect(s?.seed).toBe(42)
})
