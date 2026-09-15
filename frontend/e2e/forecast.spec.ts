import { test, expect } from './isolation'

// Pre-generation cost forecast: shown in Project Setup (under Target Length,
// live with duration + resolution) and in the Autopilot panel before Start.

const idleStages = () => Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, { status: 'idle', activeVersionId: null, versions: [], isDirty: false }]))
const seed = (page: import('@playwright/test').Page, durationSecs: number, outputResolution: string) =>
  page.evaluate(({ d, r, stages }) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({
    state: { projectName: 'X', projectType: 'film', targetDurationSecs: d, outputResolution: r, aspectRatio: '16:9', stages },
    version: 4,
  })), { d: durationSecs, r: outputResolution, stages: idleStages() })

test('Project Setup forecasts cost from duration + resolution; updates live', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await seed(page, 60, '1080p')   // 12 shots × $1.87 ≈ $24
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  await page.getByTestId('project-setup-trigger').click()
  await expect(page.getByTestId('cost-forecast')).toContainText('12 shots')
  await expect(page.getByTestId('forecast-cost')).toHaveText('~$24')

  // Change duration → forecast updates live (3 min = 180s → 36 shots ≈ $71)
  await page.getByRole('button', { name: '3 min', exact: true }).click()
  await expect(page.getByTestId('forecast-cost')).toHaveText('~$71')
  console.log('[forecast] Project Setup live forecast: 1min→$24, 3min→$71')
})

test('4K roughly doubles the forecast vs 1080p', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await seed(page, 60, '4k')   // 12 shots × $3.89 ≈ $48
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  await page.getByTestId('project-setup-trigger').click()
  await expect(page.getByTestId('cost-forecast')).toContainText('(4k)')
  await expect(page.getByTestId('forecast-cost')).toHaveText('~$48')
  console.log('[forecast] 4K 1min → $48 (≈2× 1080p)')
})

test('Autopilot panel shows the forecast before Start', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await seed(page, 60, '1080p')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  await page.getByTestId('autopilot-button').click()
  await expect(page.getByTestId('autopilot-forecast')).toContainText('~$24')
  await expect(page.getByTestId('autopilot-forecast')).toContainText('12 shots')
  console.log('[forecast] Autopilot start forecast ~$24')
})
