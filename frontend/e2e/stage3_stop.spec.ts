import { test, expect } from './isolation'

// Stage 3 "Generate All" is now interruptible: a Stop button appears during the
// batch and halts the loop before the next asset starts (a Seedream variation
// already in flight finishes). All generation endpoints are route-mocked.

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string | null, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 's3stop', projectName: 'stop', projectType: 'film', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'y' }, true)]),
      2: stg('approved', 'v1', [ver('v1', {
        assets: [
          { id: 'ENV_1', name: 'Alpha Room', type: 'environment', visual_description: 'a room' },
          { id: 'ENV_2', name: 'Beta Hall', type: 'environment', visual_description: 'a hall' },
        ],
        shots: [], scenes: [],
      }, true)]),
      3: stg('pending_review', 'v1', [ver('v1', { assetStates: {} })]),
      4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '', approvedShotIds: [],
  },
  version: 4,
}

const assetStatus = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate((aid) => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s3 = st.state.stages['3']
    const v = s3.versions.find((v: { id: string }) => v.id === s3.activeVersionId) ?? s3.versions[s3.versions.length - 1]
    return v?.data?.assetStates?.[aid]?.status ?? 'idle'
  }, id)

test('Generate All shows a Stop button and halting it leaves later assets ungenerated', async ({ page }) => {
  test.setTimeout(60_000)
  await page.route('**/api/assets/doctor-prompt', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ doctored_prompt: 'p', assembled_prompt: 'p' }) }))
  await page.route('**/api/assets/generate-async', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job_id: `job-${Date.now()}`, slot_count: 1 }) }))
  // First asset's job: 'running' on the first poll, 'done' on the next — long
  // enough to catch + click Stop before asset #2 would start.
  let polls = 0
  await page.route(/\/api\/assets\/job\//, (r) => {
    polls++
    const done = polls >= 2
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      done
        ? { status: 'done', slots: [{ url: 'http://localhost:8000/api/asset/serve?path=/tmp/a.png', error: null }], used_prompt: 'p' }
        : { status: 'running', slots: [] },
    ) })
  })
  await page.route('**/api/assets/qc', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passed: true, summary: 'ok', checks: [], drift_score: 0.2 }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await page.getByRole('button', { name: /Generate All/ }).click()

  // Stop button shows during the batch; click it before asset #2 starts
  await expect(page.getByTestId('stage3-stop-button')).toBeVisible({ timeout: 8000 })
  await page.getByTestId('stage3-stop-button').click()

  // The batch halts: asset #2 never enters generation, and the Stop button clears
  await expect(page.getByTestId('stage3-stop-button')).toBeHidden({ timeout: 15_000 })
  expect(await assetStatus(page, 'ENV_2')).toBe('idle')
  console.log('[stage3-stop] batch halted — ENV_2 never generated, ENV_1 status:', await assetStatus(page, 'ENV_1'))
})
