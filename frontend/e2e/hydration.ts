import { expect, type Page } from '@playwright/test'

/**
 * Open the Autopilot panel — click the toggle until the panel actually mounts.
 *
 * The Autopilot button ships in the server-rendered HTML, so Playwright happily
 * clicks it before React has attached the handler: the click SUCCEEDS, nothing
 * happens, and the test then waits the full timeout for a panel nobody was told
 * to open. Every autopilot spec used to bet a fixed `waitForTimeout(800)` on
 * hydration being done by then. Measured on this machine (8-core), time from
 * domcontentloaded to the first click the app reacts to:
 *
 *     idle, 1 worker      157 / 169 / 175 / 176 / 184 / 203 ms
 *     full suite, 8 wkrs  175 / 181 / 186 / 199 / 220 / 1463 ms
 *
 * One cold context in six blew past the 800ms guess, which is why the first test
 * of each autopilot file — the one that pays for a fresh browser — was the one
 * that timed out under load, six times across three 8-worker runs, and passed
 * alone every time.
 *
 * Same shape as openStudio() in studio_gallery.spec.ts, which hit this first.
 */
export async function openAutopilot(page: Page) {
  await expect(async () => {
    // Only click while still closed → no on/off oscillation across retries.
    if ((await page.getByTestId('autopilot-concept').count()) === 0) {
      await page.getByTestId('autopilot-button').click()
    }
    await expect(page.getByTestId('autopilot-concept')).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 15_000 })
}
