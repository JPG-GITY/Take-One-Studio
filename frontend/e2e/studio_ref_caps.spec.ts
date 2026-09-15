import { test, expect } from './isolation'

// Studio's reference budget is PER MODEL — Seedream takes 14, Seedance 2.0 takes 9 (the API
// says so itself: "expected at most 9 reference images but got 10 instead"), 2.5 takes 30 —
// but the function that accepted files hardcoded 4 while every button, tooltip and thumbnail
// strip already read the real number. So the 5th of 5 images was dropped on the floor with
// no message, and the prompt went out still addressing a reference the model never saw.
//
// No generation is submitted here; this only exercises attach-time behaviour.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const files = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `ref${i + 1}.png`, mimeType: 'image/png', buffer: PNG }))

async function openStudio(page: import('@playwright/test').Page) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await expect(async () => {
    if (!(await page.getByTestId('studio-gallery').isVisible())) {
      await page.getByTestId('studio-toggle').click({ force: true })
    }
    await expect(page.getByTestId('studio-gallery')).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 12_000 })
}

test('more than 4 image references attach (Seedream takes 14, not 4)', async ({ page }) => {
  await openStudio(page)
  await page.getByTestId('studio-ref-input').setInputFiles(files(6))
  // 4 was the old ceiling — the whole point is that the 5th and 6th survive.
  await expect(page.getByTestId('studio-ref-thumb')).toHaveCount(6, { timeout: 10_000 })
})

test('past the ceiling the overflow is REPORTED, not dropped in silence', async ({ page }) => {
  await openStudio(page)
  await page.getByTestId('studio-ref-input').setInputFiles(files(20))
  await expect(page.getByTestId('studio-ref-thumb')).toHaveCount(14, { timeout: 15_000 })
  // Silence is what made this look like a display bug rather than a truncation.
  await expect(page.getByText(/kept 14, dropped 6/i)).toBeVisible({ timeout: 10_000 })
})

test('a big reference set costs batch slots (Seedream: refs + generated <= 15)', async ({ page }) => {
  await openStudio(page)
  const count = page.locator('select').filter({ hasText: 'img' }).first()
  await expect(count).toBeVisible()
  await expect(count.locator('option')).toHaveCount(4)      // 1-4 with nothing attached

  await page.getByTestId('studio-ref-input').setInputFiles(files(13))
  await expect(page.getByTestId('studio-ref-thumb')).toHaveCount(13, { timeout: 15_000 })
  // 13 refs + 2 generated = 15, the documented hard cap. Offering 3 or 4 here buys a 400
  // at submit time.
  await expect(count.locator('option')).toHaveCount(2)
})
