import { test, expect } from './isolation'

// A segment longer than Seedance's 15s-per-call ceiling.
//
// The backend REFUSES one (422) instead of clamping it, and it is right to: trimming a
// 21s segment to 15s drops its last shots, which is how dialogue got lost before. But
// the refusal used to arrive as a raw error mid-batch, one shot at a time, and only for
// shots the app had already decided to render. A LEGACY project reaches this: a shot
// planned before segments existed migrates verbatim (segments.ts keeps its length as a
// fact), and the planner's SEGMENT_MAX_SECS only ever capped segments it generated.
//
// So: named up front, skipped by the passes, never silently trimmed. Seeded at store
// version 5 so the real v6 shots→segments migration is what produces the 21s segment.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const mkShot = (id: string, secs: number) => ({
  id, sceneId: 'SC-T', action: `Action ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: secs, dialogue: [],
})
const board = (sid: string) => ({
  status: 'approved', boardUrl: '', boardLocalPath: `/tmp/takeone_overlong/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'a', red: '', blue: '', green: '', orange: '', purple: '' }],
})

const IDS = ['OK_1', 'LONG_1']
const SEED = {
  state: {
    projectId: 'overlong', projectName: 'overlong', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [], shots: [mkShot('OK_1', 5), mkShot('LONG_1', 21)],
        scenes: [{ id: 'SC-T', heading: 'INT. LAB - NIGHT', description: 'd', shotIds: IDS }],
      }),
      3: stg('approved', { assetStates: {} }),
      4: stg('approved', {
        sceneStates: { 'SC-T': { status: 'approved', qcResult: null, notes: '',
          shotBoards: Object.fromEntries(IDS.map((id) => [id, board(id)])) } },
      }),
      5: stg('pending_review', {
        shots: IDS.map((id) => ({ shotId: id, thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued' })),
      }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '1080p',
    localFolderRoot: '/tmp/takeone_overlong', approvedShotIds: [],
  },
  version: 5,   // ← pre-segments, so the store's v6 migration builds the segments
}

const load = async (page: import('@playwright/test').Page) => {
  // Nothing here may touch the real backend: the registry sweep and the queue poll
  // both fire on mount.
  await page.route('**/api/video/registry**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }),
  }))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

test('an over-length segment is named BEFORE any render pass', async ({ page }) => {
  await load(page)
  const banner = page.getByTestId('stage5-overlong-message')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('LONG_1 (21.0s)')
  await expect(banner).toContainText('15s')
  // The in-range shot is not accused of anything.
  await expect(banner).not.toContainText('OK_1')
  console.log('[overlong] banner →', (await banner.textContent())?.replace(/\s+/g, ' ').trim())
})

test('Render in Background queues the in-range shot and skips the over-length one', async ({ page }) => {
  const posted: Array<{ shot_id: string; duration_secs: number }> = []
  await page.route('**/api/render/queue', async (route) => {
    if (route.request().method() !== 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ running: false, queued: 0, submitted: 0, done: 0, failed: 0, entries: [] }) })
    }
    const body = route.request().postDataJSON() as { jobs: Array<{ shot_id: string; duration_secs: number }> }
    posted.push(...body.jobs.map((j) => ({ shot_id: j.shot_id, duration_secs: j.duration_secs })))
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ queue_id: 'q-test', queued: body.jobs.length }) })
  })
  await load(page)

  await page.getByTestId('queue-render-button').click()
  await expect.poll(() => posted.length, { timeout: 15_000, intervals: [300] }).toBeGreaterThan(0)

  // The enqueue POST carries ONLY the renderable shot. Sending LONG_1 would 422 the
  // WHOLE batch server-side (render_queue_enqueue), so OK_1 would never be queued either.
  expect(posted.map((j) => j.shot_id)).toEqual(['OK_1'])
  expect(posted[0].duration_secs).toBeLessThanOrEqual(15)
  // …and the skip is stated, with the number, not swallowed.
  await expect(page.getByText(/LONG_1 \(21\.0s — over the 15s Seedance limit/)).toBeVisible()
  console.log('[overlong] queued →', JSON.stringify(posted))
})

test('the in-tab batch renders the in-range shot and never submits the over-length one', async ({ page }) => {
  const created: Array<{ shot_id: string; duration_secs: number }> = []
  await page.route('**/api/video/create', async (route) => {
    const b = route.request().postDataJSON() as { shot_id: string; duration_secs: number }
    created.push({ shot_id: b.shot_id, duration_secs: b.duration_secs })
    // End the render here — this test is about WHAT gets submitted, not the poll.
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  await load(page)

  await page.getByRole('button', { name: /Generate All Clips/ }).click()
  // Named once, up front — not once per shot between renders, which is when nobody reads.
  await expect(page.getByText(/1 shot\(s\) are too long to render/)).toBeVisible()
  // …and the toast names it (the banner says so too, hence the toast-only text).
  await expect(page.getByText(/LONG_1 \(21\.0s\) — Seedance renders at most 15s per call/)).toBeVisible()

  await expect.poll(() => created.length, { timeout: 20_000, intervals: [300] }).toBeGreaterThan(0)
  await page.waitForTimeout(1500)   // let any second submit land before asserting there is none
  // The 21s shot never reaches Seedance: it would 422, and paying for the round trip to
  // find that out is exactly what the pre-flight check exists to avoid.
  expect(created.map((j) => j.shot_id)).toEqual(['OK_1'])
  console.log('[overlong] submitted →', JSON.stringify(created))
})
