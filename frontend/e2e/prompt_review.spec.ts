import { test, expect } from './isolation'

// Verifies the two director fixes from 2026-06-11:
//  1. The Seedream prompt is shown for review/edit BEFORE generation, and the
//     edited text reaches /api/assets/generate verbatim as final_prompt.
//  2. A full 4-board character generation completes in the UI — no more
//     "timeout of 120000ms exceeded" (generation calls now allow 10 min).

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 'prompt-review-test', projectName: 'PromptReview', projectType: 'film',
    projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [{
          id: 'ASSET_001', name: 'Maya - Human Form', type: 'character',
          visualDescription: 'Early 30s woman, tired IT technician. Dark hair pulled back, pale skin under fluorescent light, wearing a grey uniform. Holds a coffee cup. Exhausted eyes, slight shadows under them.',
          sceneRefs: ['INT. SERVER ROOM'],
        }],
        shots: [],
        scenes: [{ id: 'SC-01', heading: 'INT. SERVER ROOM', description: 'd', shotIds: [] }],
      }),
      3: idle(), 4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic lighting, 35mm film grain', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: null, approvedShotIds: [],
  },
  version: 3,
}

test('prompt review: prepare → edit → 4 boards render without 120s timeout', async ({ page }) => {
  test.setTimeout(900_000)

  let postedFinalPrompt = ''
  page.on('request', (req) => {
    if (req.url().includes('/api/assets/generate') && req.method() === 'POST') {
      try { postedFinalPrompt = JSON.parse(req.postData() ?? '{}').final_prompt ?? '' } catch { /* noop */ }
    }
  })

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // Step 1: Generate → Claude writes the identity-board prompt → review panel
  await page.locator('button', { hasText: 'Generate Maya - Human Form' }).click()
  await expect(page.getByTestId('prompt-review')).toBeVisible({ timeout: 240_000 })
  const ta = page.getByTestId('prompt-review-panel-textarea')
  const prepared = await ta.inputValue()
  console.log('PREPARED PROMPT len:', prepared.length)
  if (prepared.length < 200) throw new Error('prepared prompt suspiciously short — board template missing?')
  await page.screenshot({ path: '/tmp/prompt_review_panel.png', fullPage: true })

  // Step 2: edit the prompt — the user's modification must reach Seedream
  const MARKER = 'She holds a chipped white coffee mug with a faded red logo.'
  await ta.fill(`${prepared} ${MARKER}`)

  // Step 3: generate — 4 identity boards, well past the old 120s ceiling
  await page.getByTestId('prompt-review-panel-generate').click()
  await expect(page.getByText('Generating with Seedream 5.0…')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('Board 1')).toBeVisible({ timeout: 720_000 })

  const imgs = await page.locator('img[alt^="Variation"]').count()
  console.log('BOARD IMGS:', imgs, '| marker reached API:', postedFinalPrompt.includes(MARKER))
  if (imgs < 4) throw new Error(`expected 4 board images, got ${imgs}`)
  if (!postedFinalPrompt.includes(MARKER)) throw new Error('edited prompt did not reach /api/assets/generate as final_prompt')
  await page.screenshot({ path: '/tmp/prompt_review_boards.png', fullPage: true })
})
