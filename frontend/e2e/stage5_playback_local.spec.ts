import { test, expect } from './isolation'

// Playback must come off DISK, not off the CDN link.
//
// Seedance hands back a SIGNED url that 403s after about 24 hours. Every render also
// writes a permanent copy and records it as `videoLocalPath`, and /api/asset/serve
// streams it. Stage 6 played the disk copy from the start; stage 5's player and its
// thumbnail strip read `previewUrl || videoUrl` and never looked at `videoLocalPath` —
// so BLACKMIRROR 4, reopened days after the shoot, showed twelve clips that all played
// BLACK while the twelve files sat on disk (reported 2026-08-26). The bug is invisible
// on the day you render, which is why it survived: `videoUrl` works for one day.
//
// This asserts at the NETWORK level, not on the src attribute: what matters is which
// URL the browser actually fetches. The CDN route is failed on purpose, the way an
// expired link behaves, so a regression cannot pass by falling back to it.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const DEAD_CDN = 'https://ark-cdn.example.com/expired/SHOT_001.mp4?sig=dead'
const LOCAL = '/tmp/takeone_playback/Shots/SHOT_001/video_v001.mp4'

const SEED = {
  state: {
    projectId: 'playback', projectName: 'playback', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [],
        shots: [{ id: 'SHOT_001', sceneId: 'SC-P', action: 'A man sits down.', visualDescription: 'vd',
          assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [] }],
        scenes: [{ id: 'SC-P', heading: 'INT. ROOM - DAY', description: 'd', shotIds: ['SHOT_001'] }],
      }),
      3: stg('approved', { assetStates: {} }),
      4: stg('approved', { sceneStates: { 'SC-P': { status: 'approved', qcResult: null, notes: '', shotBoards: {} } } }),
      // The state a finished shoot leaves behind: a permanent path AND a url that has
      // since expired. previewUrl is deliberately empty — the proxy is optional and its
      // absence is what used to drop the player onto the dead link.
      5: stg('pending_review', {
        shots: [{ shotId: 'SHOT_001', thumbnailUrl: '', videoUrl: DEAD_CDN, videoLocalPath: LOCAL,
          previewUrl: '', duration: 5, status: 'ready' }],
      }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '1080p',
    localFolderRoot: '/tmp/takeone_playback', approvedShotIds: ['SHOT_001'],
  },
  version: 5,
}

test('stage 5 plays the saved copy, never the expired CDN link', async ({ page }) => {
  const served: string[] = []
  let cdnHits = 0

  await page.route('**/api/video/registry**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }))
  // The disk copy: answered, and recorded.
  await page.route('**/api/asset/serve**', (r) => {
    served.push(new URL(r.request().url()).searchParams.get('path') ?? '')
    return r.fulfill({ status: 200, contentType: 'video/mp4', body: '' })
  })
  // The expired link: fails, exactly as the real one does after ~24h.
  await page.route(DEAD_CDN, (r) => { cdnHits++; return r.fulfill({ status: 403, body: '' }) })

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })

  // The player mounts a <video> whose source resolves through the serve endpoint.
  await expect.poll(() => served.filter((p) => p === LOCAL).length,
    { timeout: 30_000, intervals: [300] }).toBeGreaterThan(0)

  // …and nothing on the page ever reaches for the dead link.
  expect(cdnHits).toBe(0)

  // Belt and braces: no element on the page carries the CDN url as its source.
  const srcs = await page.evaluate(() =>
    [...document.querySelectorAll('video')].map((v) => v.getAttribute('src') ?? ''))
  expect(srcs.some((s) => s.includes('ark-cdn.example.com'))).toBe(false)
  expect(srcs.some((s) => s.includes('/api/asset/serve'))).toBe(true)
  console.log(`[playback] serve=${served.length} cdn=${cdnHits} srcs=${JSON.stringify(srcs)}`)
})
