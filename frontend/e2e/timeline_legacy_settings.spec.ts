import { test, expect } from './isolation'

// Regression: clip settings persisted BEFORE fadeIn/fadeOut existed lacked those
// fields, so the timeline crashed reading `st.fadeIn.toFixed(1)` on the video fade
// handle. getSettings now merges defaults, so Stage 6 mounts cleanly.

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`
const shot = (id: string) => ({
  shotId: id, thumbnailUrl: '', videoUrl: serve(`/tmp/leg/Shots/${id}/v.mp4`),
  videoLocalPath: `/tmp/leg/Shots/${id}/v.mp4`, duration: 5, status: 'approved',
  renderedResolution: '480p', seed: 1,
})

const SEED = {
  state: {
    projectId: 'legacy', projectName: 'leg', projectType: 'film', projectStructure: {}, activeStage: 6,
    gateMode: 'manual',
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'y' }, true)]),
      2: stg('approved', 'v1', [ver('v1', { assets: [], shots: [], scenes: [] }, true)]),
      3: stg('approved', 'v1', [ver('v1', { assetStates: {} }, true)]),
      4: stg('approved', 'v1', [ver('v1', { sceneStates: {} }, true)]),
      5: stg('approved', 'v1', [ver('v1', { shots: [shot('SHOT_1'), shot('SHOT_2')] }, true)]),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/leg', approvedShotIds: ['SHOT_1', 'SHOT_2'],
    // The legacy edit: clip settings WITHOUT fadeIn/fadeOut (the crash trigger).
    finalCutEdit: {
      order: ['SHOT_1', 'SHOT_2'],
      clips: {
        SHOT_1: { inPoint: 0, outPoint: null, transitionIn: null, volume: 1 },
        SHOT_2: { inPoint: 0, outPoint: null, transitionIn: null, volume: 0.8 },
      },
      audio: [],
    },
  },
  version: 4,
}

test('Stage 6 mounts with legacy clip settings (no fadeIn) without crashing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })

  // The multi-track timeline renders → the video fade handle read st.fadeIn safely.
  await expect(page.getByTestId('timeline-track')).toBeVisible({ timeout: 10_000 })
  expect(errors.filter((e) => /toFixed|undefined/.test(e))).toEqual([])
  console.log('[legacy-settings] Stage 6 timeline rendered without the toFixed crash')
})
