import { test, expect } from './isolation'

// Item 0 acceptance (UI side): the PromptPanel on an asset, a storyboard, and a
// Seedance shot — open, read the auto prompt, edit, badge shows, generate (board
// runs a real render via the UI; asset/Seedance render paths are covered by the
// API acceptance scripts + prompt_review.spec).

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const BREAKDOWN = {
  assets: [],
  shots: [{
    id: 'SHOT_T1', sceneId: 'SC-T',
    action: 'Maya turns from the rack of servers and sprints for the exit, knocking over a chair',
    visualDescription: 'Maya mid-sprint through the lab', assetsUsed: [],
    cameraAngle: 'low tracking shot', lighting: 'cold fluorescent', estimatedDuration: 5, dialogue: [],
  }],
  scenes: [{ id: 'SC-T', heading: 'INT. TEST LAB - NIGHT', description: 'd', shotIds: ['SHOT_T1'] }],
}

const BOARD_STATE = {
  status: 'approved',
  shotBoards: {
    SHOT_T1: {
      status: 'approved', boardUrl: '',
      boardLocalPath: '/tmp/takeone_accept/Shots/SHOT_T1/Storyboard/Versions/v001.png',
      version: 1, rows: 1, cols: 1, notes: '',
      panels: [{ label: 'SHOT_T1', name: 'Sprint', shot_type: 'Low tracking shot.', desc: 'Maya turns and sprints for the exit, chair knocked over', red: 'sprint path to the door', blue: 'camera tracks left-to-right', green: 'full lab view', orange: 'dim night lab', purple: 'panic, hurry' }],
    },
  },
  qcResult: null, notes: '',
}

const seed = (activeStage: number, stage3: unknown, stage4: unknown) => ({
  state: {
    projectId: 'accept', projectName: 'accept', projectType: 'film', projectStructure: {}, activeStage,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', BREAKDOWN),
      3: stage3, 4: stage4, 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic lighting, 35mm film grain', negativePrompt: 'cartoon, anime', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_accept', approvedShotIds: [],
  },
  version: 3,
})

const ASSET_SEED = {
  ...seed(3, idle(), idle()),
}
// Stage 3 needs an asset to show a card
;(ASSET_SEED.state.stages[2] as { versions: Array<{ data: { assets: unknown[] } }> }).versions[0].data.assets = [{
  id: 'ASSET_001', name: 'Test Prop Lantern', type: 'prop',
  visualDescription: 'A battered brass storm lantern with a cracked glass pane and a frayed rope handle',
  sceneRefs: ['INT. TEST LAB - NIGHT'],
}]

test('stage 3: asset PromptPanel — auto prompt, edit → badge, negative, reset', async ({ page }) => {
  test.setTimeout(420_000)
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), ASSET_SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.locator('button', { hasText: 'Generate Test Prop Lantern' }).click()
  await expect(page.getByTestId('prompt-review')).toBeVisible({ timeout: 180_000 })
  const ta = page.getByTestId('prompt-review-panel-textarea')
  const auto = await ta.inputValue()
  console.log('[S3] auto prompt len:', auto.length)
  if (auto.length < 60) throw new Error('auto prompt too short')

  // negative prompt field present and editable
  await expect(page.getByTestId('prompt-review-panel-negative')).toHaveValue(/cartoon/)

  // edit → badge appears
  await ta.fill(auto + ' A single moth circles the lantern.')
  await expect(page.getByTestId('prompt-review-panel-edited-badge')).toBeVisible()
  await page.screenshot({ path: '/tmp/accept_s3_panel.png', fullPage: true })

  // reset to auto → badge gone (fresh Claude assembly)
  await page.getByTestId('prompt-review-panel-reset').click()
  await expect(page.getByTestId('prompt-review-panel-edited-badge')).toBeHidden({ timeout: 180_000 })
  console.log('[S3] PASS — panel, badge, negative, reset all live')
})

test('stage 4: board PromptPanel — assemble, edit, generate via UI, sent record', async ({ page }) => {
  test.setTimeout(600_000)
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)),
    seed(4, stg('approved', { assetStates: {} }), idle()))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.getByTestId('board-prompt-btn-SHOT_T1').click()
  await expect(page.getByTestId('board-prompt-panel-SHOT_T1')).toBeVisible({ timeout: 240_000 })
  const ta = page.getByTestId('board-prompt-panel-SHOT_T1-textarea')
  const auto = await ta.inputValue()
  console.log('[S4] auto board prompt len:', auto.length)

  const MARKER = 'A wall clock reading 3:07 hangs above the door.'
  await ta.fill(auto + ' ' + MARKER)
  await expect(page.getByTestId('board-prompt-panel-SHOT_T1-edited-badge')).toBeVisible()
  await page.screenshot({ path: '/tmp/accept_s4_panel.png', fullPage: true })

  await page.getByTestId('board-prompt-panel-SHOT_T1-generate').click()
  await expect(page.getByTestId('board-img-SHOT_T1')).toBeVisible({ timeout: 480_000 })
  // the read-only record shows the edit went out
  await expect(page.getByTestId('board-sent-prompt-SHOT_T1')).toContainText('user-edited')
  await page.screenshot({ path: '/tmp/accept_s4_board.png', fullPage: true })
  console.log('[S4] PASS — edited prompt rendered via UI, sent record visible')
})

test('stage 5: Seedance direction PromptPanel — vision dry-run, @Image refs, edit', async ({ page }) => {
  test.setTimeout(600_000)
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)),
    seed(5, stg('approved', { assetStates: {} }), stg('approved', { sceneStates: { 'SC-T': BOARD_STATE } })))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.getByTestId('prepare-direction-prompt').click()
  await expect(page.getByTestId('direction-prompt-panel')).toBeVisible({ timeout: 300_000 })
  const ta = page.getByTestId('direction-prompt-panel-textarea')
  const auto = await ta.inputValue()
  console.log('[S5] direction prompt len:', auto.length, '| @Image addressing:', /@Image/i.test(auto))
  if (auto.length < 100) throw new Error('direction prompt too short')

  // ordered reference list with roles is shown
  await expect(page.getByTestId('direction-prompt-panel-refs')).toContainText('storyboard')

  await ta.fill(auto + ' She never breaks eye contact with the exit door.')
  await expect(page.getByTestId('direction-prompt-panel-edited-badge')).toBeVisible()
  await page.screenshot({ path: '/tmp/accept_s5_panel.png', fullPage: true })
  console.log('[S5] PASS — vision-grounded prompt editable before any render')
})
