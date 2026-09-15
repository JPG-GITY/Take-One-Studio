import { test, expect, noInheritedProject } from './isolation'

// item 1 clears localStorage, which is the state in which boot asks the backend for
// the last project on this machine and loads whatever another spec saved.
test.beforeEach(async ({ page }) => { await noInheritedProject(page) })

test('items 1+2: load script via paste, edit it, save — badge + persistence', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  // Item 1: paste a script and adopt it
  const SCRIPT = 'INT. TEST LAB - NIGHT\n\nA loaded script, not generated.\n\nVAEL\nThis came from a file.'
  await page.getByTestId('paste-script').fill(SCRIPT)
  await page.getByTestId('use-pasted-script').click()
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('script-editor')).toHaveValue(new RegExp('TEST LAB'))
  await expect(page.getByTestId('edited-badge')).toBeVisible()

  // Item 2: edit + save
  await page.getByTestId('script-editor').fill(SCRIPT + '\n\nVAEL\nAnd then I edited it.')
  await page.getByTestId('save-script-edits').click()
  await page.waitForTimeout(800)
  // Persisted to store: reload and confirm the edit survives
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await expect(page.getByTestId('script-editor')).toHaveValue(/edited it/)
  await expect(page.getByTestId('edited-badge')).toBeVisible()
  await page.screenshot({ path: '/tmp/dir_items12.png', fullPage: true })
})

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const BD_SEED = {
  state: {
    projectId: 'bd-edit', projectName: 'T', projectType: 'film', projectStructure: {}, activeStage: 2,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('pending_review', {
        assets: [{ id: 'ASSET_001', name: 'Detective Vael', type: 'character', visualDescription: 'A very long description that was previously clipped and unreadable in the table view, with critical wardrobe details: chrome jaw, white streak, crimson shirt, gold badge on lapel, charcoal trench coat.', sceneRefs: ['INT. X'] }],
        shots: [{ id: 'SHOT_001', sceneId: 'INT. X', action: 'A long action line that was clipped: Vael crouches over the body, her right knee lowering slowly to the chrome floor, eye pulsing twice, head tilting 15 degrees.', visualDescription: 'full vd', assetsUsed: ['ASSET_001'], cameraAngle: 'slow dolly in', lighting: 'cool neon', estimatedDuration: 6, dialogue: [{ characterId: 'ASSET_001', text: 'No forced entry.', emotion: 'flat' }] }],
        scenes: [{ id: 'SC-01', heading: 'INT. X', description: 'scene description text', shotIds: ['SHOT_001'] }],
      }),
      3: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      4: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      5: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      6: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
    },
    style: { id: 'cinematic', label: 'C', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: null, approvedShotIds: [],
  },
  version: 3,
}

test('items 3+4: expandable rows show full text; inline edits persist', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), BD_SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  // Assets tab: expand row, full text visible, edit description
  await page.getByTestId('asset-row-ASSET_001').click({ position: { x: 30, y: 10 } })
  await expect(page.getByTestId('asset-detail-ASSET_001')).toBeVisible()
  await expect(page.getByText('gold badge on lapel', { exact: false }).first()).toBeVisible()
  await page.getByTestId('asset-desc-edit-ASSET_001').fill('EDITED DESCRIPTION with all details intact.')
  await page.getByTestId('asset-detail-ASSET_001').click() // blur commits
  await page.waitForTimeout(500)

  // Shots tab: expand, full action + dialogue visible, edit action
  await page.locator('button', { hasText: 'Shots' }).first().click()
  await page.getByTestId('shot-row-SHOT_001').click({ position: { x: 30, y: 10 } })
  await expect(page.getByTestId('shot-detail-SHOT_001')).toBeVisible()
  await expect(page.getByText('No forced entry.', { exact: false })).toBeVisible()
  await page.getByTestId('shot-action-edit-SHOT_001').fill('EDITED ACTION line.')
  await page.getByTestId('shot-detail-SHOT_001').click()
  await page.waitForTimeout(500)

  // Persisted: reload, confirm edits in store
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const data = await page.evaluate(() => JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state.stages['2'].versions[0].data)
  console.log('asset desc:', data.assets[0].visualDescription.slice(0, 30), '| shot action:', data.shots[0].action.slice(0, 20))
  if (!data.assets[0].visualDescription.startsWith('EDITED DESCRIPTION')) throw new Error('asset edit lost')
  if (!data.shots[0].action.startsWith('EDITED ACTION')) throw new Error('shot edit lost')
  await page.screenshot({ path: '/tmp/dir_items34.png', fullPage: true })
})

const ROOT2 = `${process.env.HOME}/Documents/TakeOne/ConsistencyTest`
const SEED8 = (() => {
  const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`
  const CHAR = `${ROOT2}/Assets/Characters/Detective Vael/Versions/v001.png`
  const shots = [{ id: 'P2_SHOT_001', sceneId: 'INT. X', action: 'a', visualDescription: 'v', assetsUsed: ['ASSET_001'], cameraAngle: 'static', estimatedDuration: 5, dialogue: [] }]
  return {
    state: {
      projectId: 'i8', projectName: 'ConsistencyTest', projectType: 'film', projectStructure: {}, activeStage: 5,
      stages: {
        1: stg('approved', { concept: 'x', content: 'y' }),
        2: stg('approved', { assets: [{ id: 'ASSET_001', name: 'Detective Vael', type: 'character', visualDescription: 'd', sceneRefs: [] }], shots, scenes: [{ id: 'SC-01', heading: 'INT. X', description: '', shotIds: ['P2_SHOT_001'] }] }),
        3: stg('approved', { assetStates: { ASSET_001: { imageUrls: [serve(CHAR)], selectedUrl: serve(CHAR), localPath: CHAR, headshotLocalPath: null, status: 'approved', qcResult: null } } }),
        4: stg('approved', { sceneStates: { 'SC-01': { status: 'approved', shotBoards: { P2_SHOT_001: { status: 'approved', boardUrl: '', boardLocalPath: `${ROOT2}/Shots/P2_SHOT_001/Storyboard/Versions/v001.png`, version: 1, rows: 1, cols: 2, panels: [{ label: 'P2_SHOT_001-A', desc: 'x' }], notes: '' } }, qcResult: { passed: true, checks: [], summary: 's', regen_prompt: null }, notes: '' } } }),
        // one shot APPROVED WITHOUT VIDEO — the trap
        5: stg('approved', { shots: [{ shotId: 'P2_SHOT_001', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'approved' }] }),
        6: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      },
      style: { id: 'cinematic', label: 'C', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
      targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: ROOT2, approvedShotIds: [],
    },
    version: 3,
  }
})()

test('item 8: stranded warning at Stage 6 + un-approve at Stage 5 + board reopen', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED8)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  // Stage 6: warning lists the videoless approved shot; timeline excludes it
  await page.locator('button', { hasText: 'Final Cut & Export' }).first().click()
  await page.waitForTimeout(800)
  await expect(page.getByTestId('stranded-shots-warning')).toBeVisible()
  await expect(page.getByTestId('stranded-shots-warning')).toContainText('P2_SHOT_001')
  await expect(page.getByText('0 clips', { exact: false }).first()).toBeVisible()
  await page.screenshot({ path: '/tmp/dir_item8_stage6.png', fullPage: true })

  // Back to SG → un-approve the shot
  await page.getByTestId('back-to-sg').click()
  await page.waitForTimeout(800)
  await expect(page.getByTestId('unapprove-shot')).toBeVisible()
  await page.getByTestId('unapprove-shot').click()
  await page.waitForTimeout(600)
  await expect(page.getByTestId('unapprove-shot')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/dir_item8_sg.png', fullPage: true })

  // Stage 4: reopen an approved board
  await page.locator('button', { hasText: 'Storyboard' }).first().click()
  await page.waitForTimeout(800)
  await page.getByTestId('reopen-board-P2_SHOT_001').click()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('approve-board-P2_SHOT_001')).toBeVisible()
})

test('export size comes from Settings (native 4K 10-bit); no ProRes / MediaKit', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({ ...s, state: { ...s.state, outputResolution: '4k' } })), SEED8)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.locator('button', { hasText: 'Final Cut & Export' }).first().click()
  await page.waitForTimeout(800)
  // Legacy paths gone
  await expect(page.getByText('ProRes')).toHaveCount(0)
  await expect(page.getByText('AI MediaKit', { exact: false })).toHaveCount(0)
  // Output size reflects the Settings choice — native 4K 10-bit HEVC (no upscale)
  await expect(page.getByTestId('export-output-size')).toContainText('4K')
  await expect(page.getByTestId('export-output-size')).toContainText('10-bit HEVC')
})
