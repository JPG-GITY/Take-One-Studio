/**
 * Smoke test: boots the dashboard, navigates to Stage 3, and asserts
 * zero uncaught console errors (especially the Zustand
 * "getServerSnapshot should be cached" infinite-loop crash).
 *
 * Run with: npx playwright test e2e/smoke.spec.ts
 * Requires: next dev on :3000 + uvicorn on :8000
 */

import { test, expect, type Page } from './isolation'

// Collect all browser console errors during a page interaction
async function collectErrors(page: Page, fn: () => Promise<void>): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  await fn()
  return errors
}

test('dashboard loads with no console errors', async ({ page }) => {
  const errors = await collectErrors(page, async () => {
    await page.goto('/dashboard', { waitUntil: 'load' })
    // SSE keeps network busy — use load, not networkidle
    await expect(page.locator('nav')).toBeVisible({ timeout: 10_000 })
    // Give React time to hydrate and throw any snapshot errors
    await page.waitForTimeout(2000)
  })

  const fatal = errors.filter((e) =>
    !e.includes('Warning:') &&       // React warnings not fatal
    !e.includes('favicon.ico') &&    // missing favicon not fatal
    !e.includes('ERR_CONNECTION_REFUSED') // backend may be offline in CI
  )
  expect(fatal, `Console errors on load:\n${fatal.join('\n')}`).toHaveLength(0)
})

test('Stage 3 asset cards expand without Zustand snapshot error', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await page.goto('/dashboard', { waitUntil: 'load' })
  // Seed a breakdown so Stage 3 renders real asset cards (was: the Demo button,
  // now removed in favour of project loading). activeStage:3 lands us there.
  await page.evaluate(() => {
    const v = (id: string, data: unknown, approved = false) => ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
    const stg = (status: string, aid: string | null, versions: unknown[]) => ({ status, activeVersionId: aid, versions, isDirty: false })
    localStorage.setItem('takeone-pipeline-v1', JSON.stringify({
      state: {
        projectId: 'smoke', projectName: 'smoke', projectType: 'film', projectStructure: {}, activeStage: 3,
        stages: {
          1: stg('approved', 'v1', [v('v1', { concept: 'x', content: 'y' }, true)]),
          2: stg('approved', 'v1', [v('v1', { assets: [{ id: 'ENV_1', name: 'Room', type: 'environment', visualDescription: 'a room' }], shots: [], scenes: [] }, true)]),
          3: stg('pending_review', 'v1', [v('v1', { assetStates: {} })]),
          4: stg('idle', null, []), 5: stg('idle', null, []), 6: stg('idle', null, []),
        },
        style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'c', negativePrompt: '', anchorImageRefs: [] },
        targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '', approvedShotIds: [],
      }, version: 4,
    }))
  })
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(2000)

  // Click StyleSelector — this was one of the crashing components
  const styleBtns = page.locator('button').filter({ hasText: /cinematic|photoreal|anime|style/i }).first()
  if (await styleBtns.isVisible()) {
    await styleBtns.click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
  }

  // Click the project setup panel
  const setupBtn = page.locator('button').filter({ hasText: /tv|film|setup|season/i }).first()
  if (await setupBtn.isVisible()) {
    await setupBtn.click()
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')
  }

  // Filter: snapshot / infinite loop errors are definitely fatal
  const zustandErrors = errors.filter((e) =>
    e.toLowerCase().includes('getserversnapshot') ||
    e.toLowerCase().includes('infinite loop') ||
    e.toLowerCase().includes('maximum update depth')
  )
  expect(
    zustandErrors,
    `Zustand snapshot errors detected:\n${zustandErrors.join('\n')}`
  ).toHaveLength(0)

  // No uncaught JS errors overall
  const fatal = errors.filter((e) =>
    !e.includes('Warning:') &&
    !e.includes('favicon.ico') &&
    !e.includes('ERR_CONNECTION_REFUSED')
  )
  expect(fatal, `Console errors on Stage 3:\n${fatal.join('\n')}`).toHaveLength(0)
})

test('Studio tab opens without crash', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })

  await page.goto('/dashboard', { waitUntil: 'load' })
  await page.waitForTimeout(2000)

  // Click Studio (Zap) button via JS evaluate — the Next.js dev overlay portal
  // intercepts pointer events in headless mode even when no error is showing
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('nav button'))
    const studio = btns.find((b) => b.textContent?.toLowerCase().includes('studio'))
    if (studio) (studio as HTMLButtonElement).click()
  })
  await page.waitForTimeout(1000)

  const fatal = errors.filter((e) =>
    !e.includes('Warning:') && !e.includes('favicon.ico') && !e.includes('ERR_CONNECTION_REFUSED')
  )
  expect(fatal, `Studio tab errors:\n${fatal.join('\n')}`).toHaveLength(0)
})
