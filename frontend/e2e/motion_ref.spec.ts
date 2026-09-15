import { test, expect } from './isolation'

// P4 verification: motion-reference mode.
//  - A reference video attached to a KEYFRAME-mode shot surfaces an honest
//    warning (i2v drops reference media) + a "use as motion reference" control.
//  - Switching to motion-reference mode sets shot.mode = 'motion_ref' (persisted),
//    which runs Seedance in reference mode (no keyframe) so the video is honored.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const board = (sid: string) => ({
  status: 'approved', boardUrl: '',
  boardLocalPath: '/tmp/takeone_motion/Shots/MOTION_T1/Storyboard/Versions/v001.png',
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'action', red: '', blue: '', green: '', orange: '', purple: '' }],
})

const mkShot = (id: string) => ({
  id, sceneId: 'SC-T', action: `Action for ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [],
})

const SEED = {
  state: {
    projectId: 'motionref', projectName: 'motion', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [],
        shots: [mkShot('MOTION_T1')],
        scenes: [{ id: 'SC-T', heading: 'INT. TEST LAB - NIGHT', description: 'd', shotIds: ['MOTION_T1'] }],
      }),
      3: stg('approved', { assetStates: {} }),
      4: stg('approved', { sceneStates: { 'SC-T': { status: 'approved', shotBoards: { MOTION_T1: board('MOTION_T1') }, qcResult: null, notes: '' } } }),
      5: stg('pending_review', {
        // explicit keyframe mode so effectiveMode = 'keyframe' (the i2v case where a
        // video ref is silently dropped without motion-reference mode)
        shots: [{ shotId: 'MOTION_T1', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued', mode: 'keyframe' }],
      }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic lighting', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_motion', approvedShotIds: [],
  },
  version: 3,
}

const shotMode = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
  const shots = st.state.stages['5'].versions[0]?.data?.shots ?? []
  return (shots as Array<{ shotId: string; mode?: string }>).find((s) => s.shotId === 'MOTION_T1')?.mode ?? 'unset'
})

test('stage 5: attaching a motion video offers + activates motion-reference mode', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // Focus the shot so the review panel targets it
  await page.getByTestId('strip-shot-MOTION_T1').click()
  await page.waitForTimeout(400)

  // The reference-media panel is collapsed by default — expand it
  if ((await page.getByTestId('ref-video-url').count()) === 0) {
    await page.getByRole('button', { name: /Reference Media/i }).first().click()
  }
  const videoInput = page.getByTestId('ref-video-url')
  await expect(videoInput).toBeVisible()

  // Attach a motion-reference video
  await videoInput.fill('https://example.com/motion.mp4')
  await page.getByTestId('ref-video-add').click()
  await page.waitForTimeout(300)

  // Honest warning: in keyframe (i2v) mode the video is ignored
  await expect(page.getByText(/In keyframe mode the video is ignored/i)).toBeVisible()
  const toggle = page.getByTestId('motion-ref-toggle')
  await expect(toggle).toContainText(/Use the attached video as a motion reference/i)
  expect(await shotMode(page)).toBe('keyframe')
  console.log('[P4] video attached in keyframe mode → ignored-warning + opt-in control shown')

  // Switch to motion-reference mode
  await toggle.click()
  await expect(page.getByTestId('motion-ref-toggle')).toContainText(/Motion-reference mode ON/i)
  await expect
    .poll(() => shotMode(page), { timeout: 10_000, intervals: [300] })
    .toBe('motion_ref')
  console.log('[P4] motion-reference mode active → shot.mode = motion_ref (persisted)')

  await page.screenshot({ path: '/tmp/motion_ref.png', fullPage: true })
})
