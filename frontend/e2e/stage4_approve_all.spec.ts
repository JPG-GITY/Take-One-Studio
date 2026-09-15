import { test, expect } from './isolation'

// Stage 4 "Approve All": one click approves every existing board across scenes
// (the per-board Approve, batched) — useful for a reconstructed/finished project.
// The "Lock Storyboards → SG" button then appears.

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const board = (sid: string) => ({
  status: 'pending', boardUrl: '', boardLocalPath: `/tmp/auto/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1, panels: [], notes: '',
})

const SEED = {
  state: {
    projectId: 's4ap', projectName: 'ap', projectType: 'film', projectStructure: {}, activeStage: 4,
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'y' }, true)]),
      2: stg('approved', 'v1', [ver('v1', {
        assets: [],
        shots: [
          { id: 'SHOT_1', sceneId: 'INT. ROOM', action: 'a', visualDescription: 'v', assetsUsed: [], estimatedDuration: 5, dialogue: [] },
          { id: 'SHOT_2', sceneId: 'INT. ROOM', action: 'b', visualDescription: 'v', assetsUsed: [], estimatedDuration: 5, dialogue: [] },
        ],
        scenes: [{ id: 'INT. ROOM', heading: 'INT. ROOM', shotIds: ['SHOT_1', 'SHOT_2'] }],
      }, true)]),
      3: stg('approved', 'v1', [ver('v1', { assetStates: {} }, true)]),
      4: stg('pending_review', 'v1', [ver('v1', {
        sceneStates: { 'INT. ROOM': { status: 'pending', shotBoards: { SHOT_1: board('SHOT_1'), SHOT_2: board('SHOT_2') }, qcResult: null, notes: '' } },
      })]),
      5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'c', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '', approvedShotIds: [],
  },
  version: 4,
}

const boardStatuses = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s4 = st.state.stages['4']
    const v = s4.versions.find((x: { id: string }) => x.id === s4.activeVersionId) ?? s4.versions[s4.versions.length - 1]
    const sb = v?.data?.sceneStates?.['INT. ROOM']?.shotBoards ?? {}
    return Object.values(sb).map((b: unknown) => (b as { status: string }).status)
  })

test('Approve All approves every board, then Lock → SG appears', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  // Boards present but unapproved → Approve All is offered, Lock is not yet
  await expect(page.getByTestId('approve-all-boards')).toBeVisible({ timeout: 8000 })
  await expect(page.getByRole('button', { name: /Lock Storyboards/ })).toHaveCount(0)

  await page.getByTestId('approve-all-boards').click()

  // Every board is approved and the Lock button shows up
  await expect.poll(() => boardStatuses(page), { timeout: 8000, intervals: [300] }).toEqual(['approved', 'approved'])
  await expect(page.getByRole('button', { name: /Lock Storyboards/ })).toBeVisible({ timeout: 8000 })
  console.log('[approve-all] all boards approved in one click → Lock available')
})
