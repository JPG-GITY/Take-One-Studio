import { test, expect } from './isolation'

// The dashboard reads /api/health on mount and warns up front when a key is
// missing (instead of failing opaquely on the first generation). Health is
// intercepted so the test is deterministic without touching the real backend.

test('config banner shows + is dismissible when a key is missing', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', claude: 'missing ANTHROPIC_API_KEY', byteplus: 'configured' }),
  }))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })

  const banner = page.getByTestId('config-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(/ANTHROPIC_API_KEY/i)
  console.log('[banner] shown for missing key')

  await banner.locator('button').click()
  await expect(banner).toHaveCount(0)
  console.log('[banner] dismissible')
})

test('no config banner when all keys are configured', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'ok', claude: 'configured', byteplus: 'configured' }),
  }))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1000)
  await expect(page.getByTestId('config-banner')).toHaveCount(0)
  console.log('[banner] hidden when configured')
})
