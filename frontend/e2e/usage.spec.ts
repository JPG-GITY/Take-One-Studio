import { test, expect } from './isolation'

// Settings → "Usage & cost" opens a per-project panel that reads
// /api/project/usage and shows token/image/video counts + an estimated cost.

const idleStages = () => Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, { status: 'idle', activeVersionId: null, versions: [], isDirty: false }]))

test('Usage panel shows the project consumption', async ({ page }) => {
  await page.route(/\/api\/project\/usage/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    llm: { calls: 12, tokens_in: 34000, tokens_out: 12000 },
    vision: { calls: 3, tokens_in: 5000, tokens_out: 800 },
    images: { count: 9 },
    videos: { count: 7, tokens: 2500000, byResolution: { '1080p': { count: 5, tokens: 1500000 }, '4k': { count: 2, tokens: 1000000 } } },
    estimatedCostUsd: 18.42,
  }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((stages) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({
    state: { projectName: 'NEON CITY', projectType: 'film', localFolderRoot: '/p/Neon', stages },
    version: 4,
  })), idleStages())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  await page.getByTestId('settings-button').click()
  await page.getByTestId('open-usage').click()

  const panel = page.getByTestId('usage-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('$18.42')).toBeVisible()        // estimated cost headline
  await expect(panel).toContainText('NEON CITY')               // project name
  await expect(panel).toContainText('34,000 in · 12,000 out')  // llm tokens, formatted
  await expect(panel).toContainText('1080p')                   // video-by-resolution breakdown
  await expect(panel).toContainText('4k')
  console.log('[usage] panel rendered project consumption + cost')

  await page.getByTestId('usage-close').click()
  await expect(page.getByTestId('usage-panel')).toHaveCount(0)
})

// The panel used to price EVERY image at one flat $0.03 — BLOOM's 765 boards came back
// as $22.95 against a true figure of up to $68.85, because the model in use bills $0.09
// above 2.61 MP. Images are now priced per (model, pixel tier) and anything with no
// published rate is left OUT of the headline. Left out SILENTLY it would be the same
// defect with the opposite sign, so this test is about what the operator can SEE: the
// unpriced count, the model that caused it, and the per-line breakdown.
test('Usage panel names the images it could not price', async ({ page }) => {
  await page.route(/\/api\/project\/usage/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    llm: { calls: 0, tokens_in: 0, tokens_out: 0 },
    vision: { calls: 0, tokens_in: 0, tokens_out: 0 },
    images: {
      count: 12, refsBilled: 4,
      byModel: {
        'dola-seedream-5-0-pro-260628': { count: 10, refsBilled: 4, byTier: { '>2.61MP': 10 } },
        'seedream-5-0-260128': { count: 2, refsBilled: 0, byTier: { '>2.61MP': 2 } },
      },
    },
    videos: { count: 0, tokens: 0, byResolution: {} },
    estimatedCostUsd: 0.91,
    costBreakdown: {
      llmUsd: 0, imagesUsd: 0.9, imageRefsUsd: 0.01, videosUsd: 0,
      unpricedImages: 2, unpricedModels: ['seedream-5-0-260128 @ >2.61MP'],
    },
  }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((stages) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({
    state: { projectName: 'BLOOM', projectType: 'film', localFolderRoot: '/p/Bloom', stages },
    version: 4,
  })), idleStages())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  await page.getByTestId('settings-button').click()
  await page.getByTestId('open-usage').click()

  const unpriced = page.getByTestId('usage-unpriced')
  await expect(unpriced).toBeVisible()
  await expect(unpriced).toContainText('2 images')                       // the count that is missing
  await expect(unpriced).toContainText('seedream-5-0-260128 @ >2.61MP')  // and which model it was
  await expect(unpriced).toContainText('rate unknown')                   // said in words, not implied

  const breakdown = page.getByTestId('usage-breakdown')
  await expect(breakdown).toContainText('Input reference images')
  await expect(breakdown).toContainText('$0.90')

  // The two things the price actually depends on, per model.
  const byModel = page.getByTestId('usage-images-by-model')
  await expect(byModel).toContainText('dola-seedream-5-0-pro-260628')
  await expect(byModel).toContainText('10 @ >2.61MP')
  await expect(byModel).toContainText('4 ref')
  console.log('[usage] unpriced images are named, not hidden and not guessed')
})

test('Usage panel prompts to open a project when none is set', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((stages) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({
    state: { projectName: 'UNTITLED', localFolderRoot: null, stages },
    version: 4,
  })), idleStages())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  await page.getByTestId('settings-button').click()
  await page.getByTestId('open-usage').click()
  await expect(page.getByTestId('usage-panel')).toContainText('Open or create a project')
  console.log('[usage] no-project state prompts to open one')
})
