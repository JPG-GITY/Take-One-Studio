import { test, expect } from './isolation'
import { openAutopilot } from './hydration'

// Autopilot used to approve the breakdown the instant it arrived, with no QC at all —
// so every deterministic check was skipped in the ONE path that generates a whole
// episode unattended. Building 500 shots on a breakdown with missing scenes is the
// most expensive possible way to discover it was wrong.

const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })

const SEED = {
  state: {
    projectId: 'apgate', projectName: 'apgate', projectType: 'film', projectStructure: {}, activeStage: 1,
    stages: {
      1: stg('approved', { concept: 'two siblings clear out a house', content: 'INT. KITCHEN - DAY\n\nThey argue.\n' }),
      2: idle(), 3: idle(), 4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '1080p',
    gateMode: 'auto', localFolderRoot: '/tmp/apgate', approvedShotIds: [],
  },
  version: 5,
}

const BREAKDOWN = {
  assets: [{ id: 'ASSET_001', name: 'Eli', type: 'character', visual_description: 'a man' }],
  shots: [
    { id: 'SHOT_001', scene_id: 'SC-001', camera: 'wide', duration_sec: 6, assets_used: ['ASSET_001'], dialogue: [] },
    { id: 'SHOT_002', scene_id: 'SC-001', camera: 'medium shot', duration_sec: 5, assets_used: ['ASSET_001'], dialogue: [] },
    { id: 'SHOT_003', scene_id: 'SC-001', camera: 'close-up', duration_sec: 8, assets_used: ['ASSET_001'], dialogue: [] },
  ],
}

const qcResponse = (checks: Array<{ label: string; passed: boolean; notes: string; blocking?: boolean }>) => ({
  passed: checks.every((c) => c.passed), checks, summary: 's', regen_prompt: null,
})

/**
 * The unattended stage 2 runs the DIRECTOR PASS (character dossiers → acting direction)
 * between the QC gate and approveVersion, as of 2026-08-07 — before that it was skipped
 * entirely on this path, which is why every autopilot-generated film had no acting
 * direction anywhere. These specs are about the GATE, not the director, but they have to
 * stub what the path calls: unstubbed, both endpoints reach the real backend, stage 2
 * takes longer than the 20s poll and the gate assertions fail for a reason that has
 * nothing to do with the gate. (Measured: 4 specs went red exactly this way.)
 */
async function stubDirectorPass(page: import('@playwright/test').Page, calls: string[]) {
  await page.route('**/api/character/enrich', async (r) => {
    calls.push('enrich')
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ personality: 'guarded', backstory: 'a flood', wardrobe: 'wool', acting: 'holds stillness' }),
    })
  })
  await page.route('**/api/shots/enhance', async (r) => {
    calls.push('enhance')
    const body = r.request().postDataJSON() as { shots?: Array<{ id: string; characters?: string[] }> }
    const shots: Record<string, { action: string; visual: string; performance?: string }> = {}
    for (const s of body?.shots ?? []) {
      shots[s.id] = {
        action: `d ${s.id}`, visual: `l ${s.id}`,
        performance: Array.isArray(s.characters) && s.characters.length === 0 ? '' : `p ${s.id}`,
      }
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shots }) })
  })
}

/** The model each POST declared, so a test can assert the plan and the gate agree. */
const sentModels: { generate?: string; qc?: string } = {}

async function mount(page: import('@playwright/test').Page, checks: Array<{ label: string; passed: boolean; notes: string; blocking?: boolean }>) {
  const calls: string[] = []
  sentModels.generate = undefined
  sentModels.qc = undefined
  await page.route('**/api/breakdown/generate', async (r) => {
    calls.push('generate')
    sentModels.generate = (r.request().postDataJSON() as { model_choice?: string }).model_choice
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BREAKDOWN) })
  })
  await page.route('**/api/breakdown/qc', async (r) => {
    calls.push('qc')
    sentModels.qc = (r.request().postDataJSON() as { model_choice?: string }).model_choice
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(qcResponse(checks)) })
  })
  await stubDirectorPass(page, calls)
  // Nothing past stage 2 should be reached in these tests; if it is, the run continued
  // when it should not have.
  await page.route('**/api/assets/**', async (r) => {
    calls.push('stage3')
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('two siblings clear out a house')
  await page.getByTestId('autopilot-start').click()
  return calls
}

const stage2 = (page: import('@playwright/test').Page) => page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
  return st.state.stages['2'].status
})

test('a breakdown that fails its checks is NOT approved, and autopilot stops', async ({ page }) => {
  const calls = await mount(page, [
    { label: 'Scene coverage', passed: false, blocking: true, notes: '1 scene(s) broken down from 4 in the script.' },
    { label: 'Speakers', passed: true, notes: 'ok' },
  ])

  // The gate ran...
  await expect.poll(() => calls.includes('qc'), { timeout: 20_000, intervals: [400] }).toBe(true)
  // ...the stage was NOT approved...
  await expect.poll(() => stage2(page), { timeout: 20_000, intervals: [400] }).not.toBe('approved')
  // ...and the reason names the failing check, so it is actionable.
  await expect(page.getByText(/Scene coverage/i).first()).toBeVisible({ timeout: 15_000 })
  // ...and nothing downstream was started.
  expect(calls).not.toContain('stage3')
  console.log('[autopilot-gate] failing check → not approved, run stopped, reason surfaced')
})

test('a breakdown that passes its checks is approved and the run continues', async ({ page }) => {
  const calls = await mount(page, [
    { label: 'Scene coverage', passed: true, notes: 'ok' },
    { label: 'Speakers', passed: true, notes: 'ok' },
    { label: 'Runtime', passed: true, notes: 'ok' },
  ])

  await expect.poll(() => calls.includes('qc'), { timeout: 20_000, intervals: [400] }).toBe(true)
  await expect.poll(() => stage2(page), { timeout: 20_000, intervals: [400] }).toBe('approved')
  console.log('[autopilot-gate] passing checks → approved, run carries on')
})

test('the gate itself failing does not strand the run', async ({ page }) => {
  // If /api/breakdown/qc is down, autopilot must not hang or crash — a broken gate
  // is not the same as a failed check.
  const calls: string[] = []
  await page.route('**/api/breakdown/generate', async (r) => {
    calls.push('generate')
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BREAKDOWN) })
  })
  await page.route('**/api/breakdown/qc', (r) => r.fulfill({ status: 500, body: 'boom' }))
  await stubDirectorPass(page, calls)

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('two siblings clear out a house')
  await page.getByTestId('autopilot-start').click()

  await expect.poll(() => calls.includes('generate'), { timeout: 20_000, intervals: [400] }).toBe(true)
  await expect.poll(() => stage2(page), { timeout: 20_000, intervals: [500] }).toBe('approved')
  console.log('[autopilot-gate] unreachable gate → run continues rather than stranding')
})

test('a non-blocking check that fails is reported but does not stop the run', async ({ page }) => {
  // A cut that runs long is worth saying and worth seeing — it is not a reason to
  // abandon an unattended episode. A gate that fires on ordinary output only teaches
  // people to bypass the gate.
  const calls = await mount(page, [
    { label: 'Runtime', passed: false, blocking: false, notes: '178s against a 120s target (48% off).' },
    { label: 'Speakers', passed: true, blocking: true, notes: 'ok' },
  ])

  await expect.poll(() => calls.includes('qc'), { timeout: 20_000, intervals: [400] }).toBe(true)
  // The contract is that an advisory failure does not stop the run. Asserting the
  // toast is still on screen would be testing the toast library's dismiss timing —
  // by the time the stage is approved autopilot has already navigated onward.
  await expect.poll(() => stage2(page), { timeout: 20_000, intervals: [400] }).toBe('approved')
  await expect.poll(() => calls.includes('stage3'), { timeout: 20_000, intervals: [400] }).toBe(true)
  console.log('[autopilot-gate] advisory failure → run carries on into stage 3')
})

/**
 * The unattended run plans for the model the project actually renders with — and the
 * gate judges it against the same one.
 *
 * Until 2026-08-13 this call omitted the model, so every autopilot run planned against
 * the 2.0 default (15s per call) while stages 3-6 of that same run rendered with the
 * project's videoModel: a 2.5 project was cut into 15s pieces by a pipeline that can
 * hold 30s in one take. And the pair is the point — the QC's ceilings come from the
 * same field, so sending it to one of the two would recreate the disagreement that made
 * every 2.5 breakdown fail two blocking checks.
 */
test('autopilot plans and gates with the project\'s video model, and both agree', async ({ page }) => {
  const calls = await mount(page, [{ label: 'Speakers', passed: true, blocking: true, notes: 'ok' }])

  await expect.poll(() => calls.includes('qc'), { timeout: 20_000, intervals: [400] }).toBe(true)
  // SEED carries no videoModel, so this is the store's own default — the same value the
  // manual path would have sent, which is exactly the guarantee being made.
  const expected = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state.videoModel as string)
  expect(sentModels.generate).toBe(expected)
  expect(sentModels.qc).toBe(expected)
  console.log(`[autopilot-gate] plan and gate both declared model_choice=${sentModels.generate}`)
})
