import { test, expect } from './isolation'

// Stage 5 "unstick" debug (the four escape-hatch gaps the user hit):
//   F1 — rollback/restore actually re-syncs the displayed shots (the local
//        useState was seeded once and never re-read the restored version).
//   F2 — Stop aborts the in-flight poll AND releases the shot to its last-good
//        take instead of wiping it / leaving it stuck on 'animating'.
// Everything is route-mocked — no real Seedance/Seedream spend.

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`
const VIDEO_A = serve('/tmp/takeone_unstick/Shots/SHOT_T1/video_v1.mp4')
const VIDEO_B = serve('/tmp/takeone_unstick/Shots/SHOT_T1/video_v2.mp4')
const KEYFRAME = serve('/tmp/takeone_unstick/Shots/SHOT_T1/keyframe.png')

const mkShot = (id: string) => ({
  id, sceneId: 'SC-T', action: `Action ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [],
})

const board = (sid: string) => ({
  status: 'approved', boardUrl: '',
  boardLocalPath: `/tmp/takeone_unstick/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'action', red: '', blue: '', green: '', orange: '', purple: '' }],
})

function seed(stage5: unknown) {
  return {
    state: {
      projectId: 's5unstick', projectName: 'unstick', projectType: 'film', projectStructure: {}, activeStage: 5,
      stages: {
        1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'y' }, true)]),
        2: stg('approved', 'v1', [ver('v1', {
          assets: [],
          shots: [mkShot('SHOT_T1'), mkShot('SHOT_T2')],
          scenes: [{ id: 'SC-T', heading: 'INT. LAB - NIGHT', description: 'd', shotIds: ['SHOT_T1', 'SHOT_T2'] }],
        }, true)]),
        3: stg('approved', 'v1', [ver('v1', { assetStates: {} }, true)]),
        4: stg('approved', 'v1', [ver('v1', {
          sceneStates: { 'SC-T': { status: 'approved', shotBoards: { SHOT_T1: board('SHOT_T1'), SHOT_T2: board('SHOT_T2') }, qcResult: null, notes: '' } },
        }, true)]),
        5: stage5,
        6: idle(),
      },
      style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
      targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_unstick', approvedShotIds: [],
    },
    version: 4,
  }
}

const playerSrc = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.querySelector('.flex-1.min-h-0.bg-black video')?.getAttribute('src') ?? '')

const activeShot = (page: import('@playwright/test').Page, shotId: string) =>
  page.evaluate((sid) => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s5 = st.state.stages['5']
    const v = s5.versions.find((v: { id: string }) => v.id === s5.activeVersionId) ?? s5.versions[s5.versions.length - 1]
    return (v?.data?.shots as Array<{ shotId: string; status: string; videoUrl?: string }> | undefined)?.find((s) => s.shotId === sid) ?? null
  }, shotId)

// ── F1: rollback re-syncs the displayed shots ─────────────────────────────────
test('F1: restoring an older version re-syncs the displayed shot (not a no-op)', async ({ page }) => {
  test.setTimeout(120_000)
  const v1data = { shots: [
    { shotId: 'SHOT_T1', thumbnailUrl: '', videoUrl: VIDEO_A, duration: 5, status: 'ready', renderedResolution: '480p', seed: 111 },
    { shotId: 'SHOT_T2', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued' },
  ] }
  const v2data = { shots: [
    { shotId: 'SHOT_T1', thumbnailUrl: '', videoUrl: VIDEO_B, duration: 5, status: 'ready', renderedResolution: '480p', seed: 222 },
    { shotId: 'SHOT_T2', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued' },
  ] }

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)),
    seed(stg('pending_review', 'v2', [ver('v1', v1data, true), ver('v2', v2data, true)])))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // Active version is v2 → SHOT_T1 plays VIDEO_B
  await page.getByTestId('strip-shot-SHOT_T1').click()
  await page.waitForTimeout(500)
  await expect.poll(() => playerSrc(page), { timeout: 10_000, intervals: [400] }).toContain('video_v2.mp4')
  console.log('[F1] mounted on v2 — player shows VIDEO_B')

  // Open History → Restore v1 (the only non-active version)
  await page.getByRole('button', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Restore this version' }).click()
  await page.waitForTimeout(800)

  // The displayed shot must now reflect v1 (re-synced) — VIDEO_A, not the stale VIDEO_B
  await expect.poll(() => playerSrc(page), { timeout: 10_000, intervals: [400] }).toContain('video_v1.mp4')
  expect(await playerSrc(page)).not.toContain('video_v2.mp4')
  console.log('[F1] after Restore — player re-synced to VIDEO_A (rollback is no longer a no-op)')
})

// ── F2: Stop aborts + preserves the prior take ────────────────────────────────
test('F2: Stop releases an in-flight re-render to its prior take (not stuck, not wiped)', async ({ page }) => {
  test.setTimeout(120_000)

  // Seedance task that never finishes — so the shot stays 'animating' until Stop
  await page.route('**/api/video/create', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'task-stuck-1', assembled_prompt: 'p' }) }))
  await page.route('**/api/video/poll/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'running' }) }))
  await page.route('**/api/video/cancel/**', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'task already running' }) }))
  await page.route('**/api/shot/save-video', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, path: '', local_path: '', bytes: 2_000_000 }) }))

  const v1data = { shots: [
    { shotId: 'SHOT_T1', thumbnailUrl: KEYFRAME, keyframeLocalPath: '', videoUrl: VIDEO_A, duration: 5, status: 'ready', renderedResolution: '480p', seed: 111 },
    { shotId: 'SHOT_T2', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued' },
  ] }

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)),
    seed(stg('pending_review', 'v1', [ver('v1', v1data, true)])))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.getByTestId('strip-shot-SHOT_T1').click()
  await page.waitForTimeout(400)

  // Kick a re-render via "Regenerate with Comments" — the submitAndPoll /
  // pollUntilDone / Stop path. (Re-take was removed from Stage 5, 2026-07-27.)
  await expect(page.getByTestId('regenerate-with-comments')).toBeEnabled()
  await page.getByTestId('regenerate-with-comments').click()

  // The render goes live (RENDER ACTIVE + Stop appear)
  await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => activeShot(page, 'SHOT_T1').then((s) => s?.status), { timeout: 10_000, intervals: [300] }).toBe('animating')
  console.log('[F2] re-render is live — SHOT_T1 on "animating"')

  // Stop must immediately release the shot back to its PRIOR good take
  await page.getByTestId('stop-button').click()
  await expect.poll(() => activeShot(page, 'SHOT_T1').then((s) => s?.status), { timeout: 10_000, intervals: [300] }).toBe('ready')
  const after = await activeShot(page, 'SHOT_T1')
  expect(after?.videoUrl).toBe(VIDEO_A)   // prior 480p take preserved, not wiped
  console.log('[F2] Stop released SHOT_T1 → ready, prior take preserved:', after?.videoUrl)

  // …and it stays released (the aborting poll must not re-stick or wipe it)
  await page.waitForTimeout(7000)
  const settled = await activeShot(page, 'SHOT_T1')
  expect(settled?.status).toBe('ready')
  expect(settled?.videoUrl).toBe(VIDEO_A)
  console.log('[F2] still released after the poll aborts:', settled?.status, settled?.videoUrl)
})
