import { test, expect } from './isolation'
import { openAutopilot } from './hydration'

// P5c.5: with the whole pipeline approved through Stage 5, autopilot resumes at
// Stage 6 and (auto gate) assembles + ffmpeg-renders the final cut, then commits
// and approves the delivery. In the manual gate it pauses for the user to
// arrange/export. The render call is route-mocked (no real ffmpeg).

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`

const shot = (id: string) => ({
  shotId: id, thumbnailUrl: '', videoUrl: serve(`/tmp/auto/Shots/${id}/v.mp4`),
  videoLocalPath: `/tmp/auto/Shots/${id}/v.mp4`, duration: 5, status: 'approved',
  renderedResolution: '480p', seed: 1,
})

const SEED = {
  state: {
    projectId: 's6auto', projectName: 'auto', projectType: 'film', projectStructure: {}, activeStage: 6,
    gateMode: 'auto',
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'y' }, true)]),
      2: stg('approved', 'v1', [ver('v1', { assets: [], shots: [], scenes: [] }, true)]),
      3: stg('approved', 'v1', [ver('v1', { assetStates: {} }, true)]),
      4: stg('approved', 'v1', [ver('v1', { sceneStates: {} }, true)]),
      5: stg('approved', 'v1', [ver('v1', { shots: [shot('SHOT_1'), shot('SHOT_2')] }, true)]),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/auto', approvedShotIds: ['SHOT_1', 'SHOT_2'],
  },
  version: 4,
}

const stage6 = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s6 = st.state.stages['6']
    const v = s6.versions.find((v: { id: string }) => v.id === s6.activeVersionId) ?? s6.versions[s6.versions.length - 1]
    return { status: s6.status, exportUrl: v?.data?.exportUrl ?? null }
  })

test('auto gate: autopilot resumes at Stage 6, renders + approves the final cut', async ({ page }) => {
  test.setTimeout(60_000)
  let renderCalls = 0
  await page.route('**/api/edit/render', (r) => { renderCalls++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ output_path: '/tmp/auto/TakeOne_Final.mp4', filename: 'TakeOne_Final.mp4' }) }) })

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('ship it')
  await page.getByTestId('autopilot-start').click()

  await expect.poll(() => stage6(page).then((s) => s.status), { timeout: 30_000, intervals: [500] }).toBe('approved')
  const final = await stage6(page)
  expect(final.exportUrl).toBe('/tmp/auto/TakeOne_Final.mp4')
  expect(renderCalls).toBeGreaterThan(0)
  console.log('[autopilot] Stage 6 — final cut rendered + approved:', final.exportUrl)

  await expect(page.getByTestId('autopilot-button')).toHaveText('Autopilot', { timeout: 10_000 })
})

test('manual gate: autopilot pauses at Stage 6 for the user to export', async ({ page }) => {
  test.setTimeout(60_000)
  let renderCalls = 0
  await page.route('**/api/edit/render', (r) => { renderCalls++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ output_path: '/x.mp4', filename: 'x.mp4' }) }) })

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({ ...s, state: { ...s.state, gateMode: 'manual' } })), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('let me export')
  await page.getByTestId('autopilot-start').click()

  // It lands on the delivery stage and pauses — no auto-export, stage not approved
  await expect(page.getByTestId('autopilot-button')).toHaveText('Autopilot', { timeout: 20_000 })
  expect((await stage6(page)).status).not.toBe('approved')
  expect(renderCalls).toBe(0)
  console.log('[autopilot] manual gate — paused at delivery, no auto-export')
})
