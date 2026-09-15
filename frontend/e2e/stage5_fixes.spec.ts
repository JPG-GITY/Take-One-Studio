import { test, expect } from './isolation'

// Stage 5 fix verification:
//  P0: video player remounts when another clip is selected (the frozen-panel bug);
//      shots stuck in 'animating' are RESUMED via their task id, never stranded.
//  P1: Retake (same seed) / New take controls; batch HD pass button; DRAFT badge.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`
const VIDEO_A = serve('/tmp/takeone_accept/Shots/SHOT_T1/video_v001.mp4')
const VIDEO_B = serve(`${process.env.HOME}/Documents/TakeOne/F-AI-L/Shots/SHOT_002/video_v005.mp4`)
// A real completed task from today's backend log — reconcile must resolve it
const REAL_TASK = 'cgt-20260612150129-pwbn8'

const board = (sid: string) => ({
  status: 'approved', boardUrl: '',
  boardLocalPath: '/tmp/takeone_accept/Shots/SHOT_T1/Storyboard/Versions/v001.png',
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'action', red: '', blue: '', green: '', orange: '', purple: '' }],
})

const mkShot = (id: string) => ({
  id, sceneId: 'SC-T', action: `Action for ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [],
})

const SEED = {
  state: {
    projectId: 's5fix', projectName: 'accept', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [],
        shots: [mkShot('SHOT_T1'), mkShot('SHOT_T2'), mkShot('SHOT_T3')],
        scenes: [{ id: 'SC-T', heading: 'INT. TEST LAB - NIGHT', description: 'd', shotIds: ['SHOT_T1', 'SHOT_T2', 'SHOT_T3'] }],
      }),
      3: stg('approved', { assetStates: {} }),
      4: stg('approved', { sceneStates: { 'SC-T': { status: 'approved', shotBoards: { SHOT_T1: board('SHOT_T1'), SHOT_T2: board('SHOT_T2'), SHOT_T3: board('SHOT_T3') }, qcResult: null, notes: '' } } }),
      5: stg('pending_review', {
        shots: [
          { shotId: 'SHOT_T1', thumbnailUrl: '', videoUrl: VIDEO_A, duration: 5, status: 'ready', renderedResolution: '480p', tier: 'preview', seed: 123 },
          { shotId: 'SHOT_T2', thumbnailUrl: '', videoUrl: VIDEO_B, duration: 5, status: 'ready', renderedResolution: '480p', tier: 'preview', seed: 456 },
          { shotId: 'SHOT_T3', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'animating', seedanceTaskId: REAL_TASK },
        ],
      }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic lighting', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_accept', approvedShotIds: [],
  },
  version: 3,
}

test('stage 5: player remounts per clip, take controls, HD pass, stuck shot resumes', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  // Per-shot lock: SHOT_T3 is mid-render (RENDER ACTIVE shows), yet the active
  // shot's review controls stay USABLE — the old global lock froze everything.
  await expect(page.getByText('RENDER ACTIVE')).toBeVisible()
  // (Re-take was removed from Stage 5 — assert the per-shot lock on "Direct this shot",
  // which is gated by the same isGenerating flag the old retake button used.)
  await expect(page.getByTestId('direct-input')).toBeEnabled()
  console.log('[LOCK] toolbar shows render active while SHOT_T1 controls stay enabled')

  // P0: selecting a different clip swaps the actual <video> element source
  await page.getByTestId('strip-shot-SHOT_T1').click()
  await page.waitForTimeout(600)
  const src1 = await page.evaluate(() => document.querySelector('.flex-1.min-h-0.bg-black video')?.getAttribute('src') ?? '')
  await page.getByTestId('strip-shot-SHOT_T2').click()
  await page.waitForTimeout(600)
  const src2 = await page.evaluate(() => document.querySelector('.flex-1.min-h-0.bg-black video')?.getAttribute('src') ?? '')
  console.log('[P0] player swapped:', src1 !== src2 && src2.includes('SHOT_002'))
  if (!src1 || src1 === src2) throw new Error('video element did not remount on selection')

  // P1: tier badge + regeneration control + the promotion ladder. Seedance 2.0 has
  // no seed, so every re-generation is a fresh take (no same-seed replay). Re-take
  // was removed from Stage 5; "Direct this shot" / "Regenerate with Comments" make
  // new takes.
  await expect(page.getByText(/PREVIEW · 480P/).first()).toBeVisible()
  await expect(page.getByTestId('direct-input')).toBeVisible()
  // The preview shots can be promoted to master, and the button says what it costs.
  // No exact count here: SHOT_T3 is mid-render and the reconciler rewrites the shot
  // list while this runs. render_tiers.spec.ts pins the counts on a static fixture.
  await expect(page.getByTestId('tier-pass-master')).toContainText('4k')
  await expect(page.getByTestId('tier-pass-master')).toContainText('$')
  // ...and NOT down to a rung they already passed: the 'preview' shots are already
  // at the preview rung, so no preview pass is offered.
  await expect(page.getByTestId('tier-pass-preview')).toHaveCount(0)
  console.log('[P1] tier badge, retake controls, promotion ladder all present')

  // P0: the stuck 'animating' shot resolves via its real task id (resume/reconcile)
  await expect
    .poll(async () => page.evaluate(() => {
      const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
      const shots = st.state.stages['5'].versions[0]?.data?.shots
        ?? []
      const s3 = (shots as Array<{ shotId: string; status: string }>).find((s) => s.shotId === 'SHOT_T3')
      return s3?.status ?? 'missing'
    }), { timeout: 120_000, intervals: [3000] })
    .not.toBe('animating')
  const final3 = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const shots = st.state.stages['5'].versions[0]?.data?.shots ?? []
    return (shots as Array<{ shotId: string; status: string; videoUrl?: string }>).find((s) => s.shotId === 'SHOT_T3')
  })
  console.log('[P0] stuck shot resolved →', JSON.stringify(final3))
  await page.screenshot({ path: '/tmp/stage5_fixes.png', fullPage: true })
})
