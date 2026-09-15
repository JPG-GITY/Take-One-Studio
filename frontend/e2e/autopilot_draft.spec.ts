import { test, expect } from './isolation'
import { openAutopilot } from './hydration'

// P5c.1: Autopilot auto-drafts the text stages. From a concept it generates the
// script and the breakdown, commits + approves both, and lands at Stage 3.
// The two generate endpoints are route-mocked for determinism.

const stageStatus = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((sid) => JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state.stages[sid]?.status, id)

test('autopilot auto-drafts script + breakdown and lands at Stage 3', async ({ page }) => {
  await page.route('**/api/script/generate', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ content: 'FADE IN. A neon city at night. A detective walks the flooded streets. THE END.' }),
  }))
  await page.route('**/api/breakdown/generate', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      assets: [{ id: 'ASSET_001', name: 'Detective Kane', type: 'character', visual_description: 'noir detective in a trench coat' }],
      shots: [{ id: 'SHOT_001', scene: 'INT. CITY - NIGHT', action: 'walks toward the camera', visual_description: 'detective walks', assets_used: ['ASSET_001'], duration_sec: 5 }],
      scenes: [],
    }),
  }))
  // The unattended stage 2 also runs the DIRECTOR PASS (dossiers → acting direction)
  // before it approves, as of 2026-08-07 — it used to skip it, which is why every
  // autopilot-generated film had an empty `performance` on every shot. This spec is
  // about the DRAFT reaching stage 3, so the two extra endpoints are stubbed for the
  // same reason the two generate endpoints are: unstubbed they hit the real backend and
  // stage 2 no longer lands inside the 15s poll.
  await page.route('**/api/character/enrich', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ personality: 'guarded', backstory: 'a flood', wardrobe: 'wet wool', acting: 'holds stillness' }),
  }))
  await page.route('**/api/shots/enhance', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ shots: { SHOT_001: { action: 'walks in', visual: 'lit wide', performance: 'holds the look' } } }),
  }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  // Open Autopilot, describe the film, Start
  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('A neon-noir detective hunts a rogue AI in a flooded megacity')
  await page.getByTestId('autopilot-start').click()

  // Script + breakdown auto-committed and approved
  await expect.poll(() => stageStatus(page, '1'), { timeout: 15_000, intervals: [400] }).toBe('approved')
  await expect.poll(() => stageStatus(page, '2'), { timeout: 15_000, intervals: [400] }).toBe('approved')
  console.log('[autopilot] stages 1 + 2 auto-approved')

  // Landed at Stage 3 (Asset Generation)
  await expect(page.getByText(/Asset Generation/i).first()).toBeVisible({ timeout: 5000 })
  console.log('[autopilot] landed at Stage 3 with a draft ready')
})
