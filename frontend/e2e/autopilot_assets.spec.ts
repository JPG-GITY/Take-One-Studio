import { test, expect } from './isolation'
import { openAutopilot } from './hydration'

// P5c.2: Autopilot now reaches Stage 3 — it auto-generates the assets (via the
// registered runner → handleGenerateAll) and PAUSES for review. An environment
// asset is used so prompt prep skips the character/prop board-prompt path. The
// whole generate chain is route-mocked (no real Seedream spend).

const assetStatus = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((aid) => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s3 = st.state.stages['3']
    const v = s3.versions.find((v: { id: string }) => v.id === s3.activeVersionId) ?? s3.versions[s3.versions.length - 1]
    return v?.data?.assetStates?.[aid]?.status
  }, id)

test('autopilot generates the assets then pauses at Stage 3 for review', async ({ page }) => {
  await page.route('**/api/script/generate', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: 'INT. SERVER ROOM - NIGHT. Hum of machines.' }) }))
  await page.route('**/api/breakdown/generate', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    assets: [{ id: 'ENV_1', name: 'Server Room', type: 'environment', visual_description: 'a vast neon server room' }],
    shots: [{ id: 'SHOT_001', scene: 'INT. SERVER ROOM - NIGHT', action: 'pan across servers', visual_description: 'servers', assets_used: ['ENV_1'], duration_sec: 5 }],
    scenes: [],
  }) }))
  await page.route('**/api/assets/doctor-prompt', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ doctored_prompt: 'a vast neon server room, cinematic', assembled_prompt: 'a vast neon server room, cinematic' }) }))
  await page.route('**/api/assets/generate-async', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job_id: 'job-1', slot_count: 4 }) }))
  await page.route('**/api/assets/job/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'done', slots: [{ url: 'http://localhost:8000/api/asset/serve?path=/tmp/a.png', error: null }], used_prompt: 'p' }) }))
  await page.route('**/api/assets/qc', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passed: true, summary: 'ok', checks: [], drift_score: 0.2 }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('A heist inside a neon server room')
  await page.getByTestId('autopilot-start').click()

  // Autopilot drove past script/breakdown into Stage 3 and generated the asset
  await expect.poll(() => assetStatus(page, 'ENV_1'), { timeout: 25_000, intervals: [500] }).toBe('pending')
  console.log('[autopilot] reached Stage 3 and generated the asset')

  // …then it PAUSED (running stopped) — the button drops the "…" running marker
  await expect(page.getByTestId('autopilot-button')).toHaveText('Autopilot', { timeout: 10_000 })
  await expect(page.getByText(/Asset Generation/i).first()).toBeVisible()
  console.log('[autopilot] paused at Stage 3 for review')
})
