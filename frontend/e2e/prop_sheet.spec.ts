import { test, expect } from './isolation'

// P2: a prop is generated like a character — through the multi-view SHEET path.
// preparePrompt routes type 'prop' to /api/assets/board-prompt with kind='prop'
// (the prop-sheet template), shown in the review panel before any spend.
// Backend prompt calls are mocked so the test is deterministic (no live spend).

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 'p2', projectName: 'p2', projectType: 'film', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [{ id: 'PROP_1', name: 'Plasma Pistol', type: 'prop', visualDescription: 'a sleek plasma pistol', sceneRefs: [] }],
        shots: [], scenes: [],
      }),
      3: stg('pending_review', { assetStates: {} }),
      4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'photoreal', label: 'Photoreal', promptSuffix: 'photoreal', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: null, approvedShotIds: [],
  },
  version: 4,
}

test('a prop routes through the prop-sheet template (board-prompt kind=prop)', async ({ page }) => {
  let capturedKind = ''
  await page.route('**/api/assets/doctor-prompt', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ doctored_prompt: 'a sleek plasma pistol, photoreal', assembled_prompt: 'a sleek plasma pistol' }),
  }))
  await page.route('**/api/assets/board-prompt', async (route) => {
    capturedKind = route.request().postDataJSON()?.kind ?? ''
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ board_prompt: 'PROP SHEET PROMPT — multi-view object design sheet of one plasma pistol' }),
    })
  })

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  // Prop card is under the Props tab / All; the card is expanded by default
  await page.getByRole('button', { name: /Generate Plasma Pistol/i }).click()

  // Routed to the prop-sheet template, and the prompt reaches the review panel
  await expect.poll(() => capturedKind, { timeout: 8000 }).toBe('prop')
  await expect(page.getByTestId('prompt-review')).toBeVisible()
  console.log('[P2] prop → board-prompt kind=prop; prompt-review shown')
})
