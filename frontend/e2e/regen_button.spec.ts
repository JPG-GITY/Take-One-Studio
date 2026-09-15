import { test, expect } from './isolation'

// Regen-with-notes must generate NEW images directly (no review-panel pause) —
// it previously only refreshed the prompt panel and looked like a dead button.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const IMG = 'http://localhost:8000/api/asset/serve?path=' +
  encodeURIComponent('/tmp/takeone_accept/Shots/SHOT_T1/Storyboard/Versions/v001.png')

const SEED = {
  state: {
    projectId: 'regen-test', projectName: 'accept', projectType: 'film', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [{ id: 'ASSET_001', name: 'Tin Lantern', type: 'prop', visualDescription: 'A battered brass storm lantern with a cracked glass pane', sceneRefs: ['INT. X'] }],
        shots: [], scenes: [{ id: 'SC-01', heading: 'INT. X', description: 'd', shotIds: [] }],
      }),
      3: stg('pending_review', {
        assetStates: {
          ASSET_001: {
            imageUrls: [IMG], selectedUrl: null, localPath: null, headshotLocalPath: null,
            status: 'pending', qcResult: null, lastPrompt: 'old prompt', lastAutoPrompt: 'old prompt', lastNegative: '',
          },
        },
      }),
      4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic lighting', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_accept', approvedShotIds: [],
  },
  version: 3,
}

test('Regen with notes generates new images without a review pause', async ({ page }) => {
  test.setTimeout(480_000)
  let asyncKicked = false
  let notesInBody = false
  page.on('request', (req) => {
    if (req.url().includes('/api/assets/generate-async') && req.method() === 'POST') {
      asyncKicked = true
      try { notesInBody = JSON.parse(req.postData() ?? '{}').final_prompt?.length > 0 } catch { /* noop */ }
    }
  })

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.locator('textarea[placeholder*="weathered"]').fill('warmer brass tones, lit candle inside')
  await page.getByTestId('regen-button').click()

  // The decisive assertion: generation STARTS from the Regen click alone —
  // the spinner appears without any interaction with the prompt panel.
  await expect(page.getByText('Generating with Seedream 5.0…')).toBeVisible({ timeout: 120_000 })
  console.log('[REGEN] generation started directly from Regen click')

  // And completes with a fresh variation set
  await expect(page.getByText('Generating with Seedream 5.0…')).toBeHidden({ timeout: 360_000 })
  const imgs = await page.locator('img[alt^="Variation"]').count()
  console.log('[REGEN] done — variations:', imgs, '| async kicked:', asyncKicked, '| prompt in body:', notesInBody)
  if (imgs < 1 || !asyncKicked) throw new Error('Regen did not produce a new generation')
  await page.screenshot({ path: '/tmp/regen_verify.png', fullPage: true })
})
