import { test, expect } from './isolation'
import { openAutopilot } from './hydration'

/**
 * The autopilot's export used to build its OWN /api/edit/render body, and it had
 * drifted from the manual one: no `audio_clips` key at all. RenderRequest defaults
 * that field to [], so under the auto gate the film was mixed with NO music and no
 * imported audio — and then committed AND approved. Measured on a real render of the
 * same three-clip timeline: the body the autopilot sent produced a programme at
 * -91.0 dB (digital silence, ffmpeg volumedetect); the same timeline with audio_clips
 * came back at -18.3 dB.
 *
 * So: assert on the BODY the autopilot sends, not on the render result — the render is
 * mocked here, and a payload assertion is what stops the two paths drifting again.
 * Second test: a render that comes back reporting the film has no audible programme
 * must NOT be auto-approved.
 */

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

const BED = {
  id: 'aud_1', path: '/tmp/auto/music.wav', name: 'music.wav', srcDuration: 12,
  timelineStart: 0, inPoint: 0, outPoint: 12, volume: 0.7, fadeIn: 0, fadeOut: 0, duck: true,
}

const SEED = {
  state: {
    projectId: 's6audio', projectName: 'auto', projectType: 'film', projectStructure: {}, activeStage: 6,
    gateMode: 'auto',
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'y' }, true)]),
      2: stg('approved', 'v1', [ver('v1', { assets: [], shots: [], scenes: [] }, true)]),
      3: stg('approved', 'v1', [ver('v1', { assetStates: {} }, true)]),
      4: stg('approved', 'v1', [ver('v1', { sceneStates: {} }, true)]),
      5: stg('approved', 'v1', [ver('v1', { shots: [shot('SHOT_1'), shot('SHOT_2')] }, true)]),
      6: idle(),
    },
    // The music the user laid down in Stage 6 — persisted here, which is where
    // DeliveryView seeds its audioClips from on mount.
    finalCutEdit: { order: ['SHOT_1', 'SHOT_2'], clips: {}, audio: [BED], master: 1, overlays: [] },
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
    return { status: s6.status, versions: s6.versions.length, exportUrl: v?.data?.exportUrl ?? null }
  })

const boot = async (page: import('@playwright/test').Page, concept: string) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill(concept)
  await page.getByTestId('autopilot-start').click()
}

test('autopilot export carries the soundtrack the user laid down', async ({ page }) => {
  test.setTimeout(60_000)
  let body: Record<string, unknown> | null = null
  await page.route('**/api/edit/render', (r) => {
    body = r.request().postDataJSON()
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ output_path: '/tmp/auto/TakeOne_Final.mp4', filename: 'TakeOne_Final.mp4', audio_note: '' }) })
  })

  await boot(page, 'ship it with the music')
  await expect.poll(() => stage6(page).then((s) => s.status), { timeout: 30_000, intervals: [500] }).toBe('approved')

  const sent = body as unknown as { audio_clips?: Array<Record<string, number | string | boolean>>; master_volume?: number }
  expect(sent).not.toBeNull()
  expect(sent.audio_clips).toHaveLength(1)
  expect(sent.audio_clips![0]).toMatchObject({
    path: '/tmp/auto/music.wav', timeline_start: 0, in_point: 0, out_point: 12, volume: 0.7, duck: true,
  })
  expect(sent.master_volume).toBe(1)
  console.log('[autopilot] export payload carried audio_clips:', JSON.stringify(sent.audio_clips))
})

test('autopilot does NOT approve a film the render reports as silent', async ({ page }) => {
  test.setTimeout(60_000)
  await page.route('**/api/edit/render', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      output_path: '/tmp/auto/TakeOne_Final.mp4', filename: 'TakeOne_Final.mp4',
      audio_note: 'Nothing audible in this export — the whole programme measures as digital silence.',
    }),
  }))

  await boot(page, 'ship it silent')
  // The run stops here (paused), and the button goes back to idle.
  await expect(page.getByTestId('autopilot-button')).toHaveText('Autopilot', { timeout: 30_000 })
  const s6 = await stage6(page)
  // The cut is COMMITTED — the file exists and the version is how it is found again —
  // but not approved: a deliverable with a whole layer missing must not be signed off
  // by a machine.
  expect(s6.versions).toBeGreaterThan(0)
  expect(s6.exportUrl).toBe('/tmp/auto/TakeOne_Final.mp4')
  expect(s6.status).not.toBe('approved')
  console.log('[autopilot] silent export committed but NOT approved; stage status:', s6.status)
})
