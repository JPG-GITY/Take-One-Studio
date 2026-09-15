import { test, expect, noInheritedProject } from './isolation'

// Theme switcher in Settings: dark (default) / light / system. The choice sets
// <html data-theme> and persists to localStorage (its own key, no-flash script).

// Every test here boots with an empty localStorage on purpose — the state in which
// boot goes asking the backend for the last project on this machine.
test.beforeEach(async ({ page }) => { await noInheritedProject(page) })

const dataTheme = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'))
const stored = (page: import('@playwright/test').Page) =>
  page.evaluate(() => { try { return JSON.parse(localStorage.getItem('takeone-theme')!).state.theme } catch { return null } })

const outRes = (page: import('@playwright/test').Page) =>
  page.evaluate(() => { try { return JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state.outputResolution } catch { return null } })

test('Settings sets the final output size and persists it', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  await page.getByTestId('settings-button').click()
  await page.getByTestId('outres-4k').click()
  await expect.poll(() => outRes(page), { timeout: 5000, intervals: [200] }).toBe('4k')

  // survives reload
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  expect(await outRes(page)).toBe('4k')

  await page.getByTestId('settings-button').click()
  await page.getByTestId('outres-1080p').click()
  await expect.poll(() => outRes(page), { timeout: 5000, intervals: [200] }).toBe('1080p')
  console.log('[settings] output size 4k → persists → 1080p')
})

test('Settings switches theme and persists it', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.removeItem('takeone-theme'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  // Default is dark
  expect(await dataTheme(page)).toBe('dark')

  // Open Settings → choose Light
  await page.getByTestId('settings-button').click()
  await page.getByTestId('theme-light').click()
  await expect.poll(() => dataTheme(page), { timeout: 5000, intervals: [200] }).toBe('light')
  expect(await stored(page)).toBe('light')
  console.log('[theme] switched to light + persisted')

  // It survives a reload (no-flash script applies it before paint)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  expect(await dataTheme(page)).toBe('light')

  // Back to Dark
  await page.getByTestId('settings-button').click()
  await page.getByTestId('theme-dark').click()
  await expect.poll(() => dataTheme(page), { timeout: 5000, intervals: [200] }).toBe('dark')
  console.log('[theme] back to dark, persisted across reload')
})

test('System mode resolves to a concrete data-theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.removeItem('takeone-theme'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)

  await page.getByTestId('settings-button').click()
  await page.getByTestId('theme-system').click()
  // OS is emulated light → system resolves to light
  await expect.poll(() => dataTheme(page), { timeout: 5000, intervals: [200] }).toBe('light')
  expect(await stored(page)).toBe('system')

  // Flip the OS preference → system follows
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => dataTheme(page), { timeout: 5000, intervals: [200] }).toBe('dark')
  console.log('[theme] system follows the OS preference')
})
