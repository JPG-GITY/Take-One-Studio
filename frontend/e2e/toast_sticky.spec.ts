import { test, expect } from './isolation'

// Error toasts must stay until dismissed — a failed generation's message used to
// vanish after 4s, before it could be read. Trigger a deterministic, client-side
// error (assemble a Seedance prompt for a keyframe-mode shot that has no keyframe)
// and assert the toast survives well past the old 4s window, then dismisses.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const board = (sid: string) => ({
  status: 'approved', boardUrl: '',
  boardLocalPath: '/tmp/takeone_toast/Shots/TST_1/Storyboard/Versions/v001.png',
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'action', red: '', blue: '', green: '', orange: '', purple: '' }],
})

const mkShot = (id: string) => ({
  id, sceneId: 'SC-T', action: `Action for ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [],
})

const SEED = {
  state: {
    projectId: 'toast', projectName: 'toast', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', { assets: [], shots: [mkShot('TST_1')], scenes: [{ id: 'SC-T', heading: 'INT. T - NIGHT', description: 'd', shotIds: ['TST_1'] }] }),
      3: stg('approved', { assetStates: {} }),
      4: stg('approved', { sceneStates: { 'SC-T': { status: 'approved', shotBoards: { TST_1: board('TST_1') }, qcResult: null, notes: '' } } }),
      // keyframe mode + no keyframe → assembling the direction prompt errors synchronously
      5: stg('pending_review', { shots: [{ shotId: 'TST_1', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued', mode: 'keyframe' }] }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_toast', approvedShotIds: [],
  },
  version: 3,
}

test('error toasts persist past the old 4s auto-dismiss and stay dismissible', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.getByTestId('strip-shot-TST_1').click()
  await page.waitForTimeout(300)

  // Deterministic client-side error (no backend): keyframe mode + no keyframe
  await page.getByTestId('prepare-direction-prompt').click()

  const toast = page.getByText(/Cannot assemble/i)
  await expect(toast).toBeVisible()

  // Old behaviour dismissed at 4s — it must still be here well after that
  await page.waitForTimeout(5000)
  await expect(toast).toBeVisible()
  console.log('[toast] error toast still visible after 5s (sticky)')

  // …and it remains dismissible
  await page.getByTestId('toast-dismiss').first().click()
  await expect(toast).toHaveCount(0)
  console.log('[toast] error toast dismissed on click')

  await page.screenshot({ path: '/tmp/toast_sticky.png', fullPage: true })
})
