import { test, expect, type Page, noInheritedProject } from './isolation'
import { openAutopilot } from './hydration'

/**
 * A PARTIAL DOSSIER FAILURE MUST NAME THE CHARACTERS IT LOST.
 *
 * A TOTAL enrich failure is already visible (director_pass_failure.spec.ts: red card +
 * sticky toast, 3/3). A PARTIAL one was not, and it is the more likely shape — enrich
 * runs 4-concurrent per character, so a rate limit, a dropped socket or one bad name
 * takes SOME of the cast, not all of it.
 *
 * MEASURED BEFORE THE FIX (2026-08-07, 10 characters with 3 injected 502s, 3/3 runs on
 * both paths):
 *   · dossiers landed 7/10, the shot pass RAN and was handed a 7-name cast,
 *   · every per-shot `characters` still named all ten,
 *   · the only thing a human was shown was the count — "Director pass INCOMPLETE — 7/10
 *     character dossier(s) written — 3 failed (Character enrich failed: …)". Which three
 *     appeared NOWHERE: not in the toast, not on the Breakdown Agent card, not in the
 *     console. Three characters were performing without a profile and the operator had
 *     no way to learn which, so no way to re-run just them.
 *   · and the silent sibling: when enrich answers 200 with an EMPTY `acting` field,
 *     enrich.failed is 0, so there was no message AT ALL — measured 0 toasts.
 *
 * WHY THIS IS WORTH A NAME AND NOT JUST A COUNT: an independent 3-arm experiment put
 * ~79% of the acting quality on the cast's master profiles. A missing profile is that
 * character's performance reverting to generic. And the shot merge never clobbers an
 * existing `performance`, so the generic direction is written PERMANENTLY — a later
 * successful enrichment cannot replace it. The operator's only repair is to re-run the
 * dossier for the specific characters that failed, which requires knowing their names.
 *
 * POLICY (runDirectorPass): PROCEED with a partial cast, and name the missing. Refusing
 * would throw away the 7 profiles that DID land — 70% of a ~79% effect — to protect the
 * 3 that did not, and it would leave the whole film with no acting direction where the
 * partial run leaves 7 characters correctly directed. Proceeding is only defensible if
 * the damage is legible, which is what this spec pins.
 */

const FAIL = ['Mira', 'Vex', 'Sorrel']          // the three the backend refuses
const NAMES = ['Kane', 'Mira', 'Tomas', 'Vex', 'Beni', 'Sorrel', 'Ada', 'Rook', 'Nell', 'Jun']

const assets = () => NAMES.map((n, i) => ({
  id: `ASSET_${String(i + 1).padStart(3, '0')}`, name: n, type: 'character',
  visual_description: `${n}, weathered`,
}))

const BREAKDOWN = {
  assets: [...assets(), { id: 'ASSET_900', name: 'The east field', type: 'environment', visual_description: 'dusk' }],
  shots: NAMES.map((n, i) => ({
    id: `SHOT_${String(i + 1).padStart(3, '0')}`, scene: 'EXT. FIELD - DUSK',
    action: `${n} sets the auger down`, visual_description: 'wide, dusk',
    assets_used: [`ASSET_${String(i + 1).padStart(3, '0')}`], duration_sec: 5,
  })),
  scenes: [],
}

interface Log { enrich: string[]; failed: string[]; enhance: number; casts: string[][]; shotCasts: string[] }

/** `emptyActing`: the SILENT sibling — a 200 whose `acting` is "". enrich.failed stays 0. */
async function wireApi(page: Page, log: Log, opts: { emptyActing?: boolean } = {}) {
  await noInheritedProject(page)
  await page.route('**/api/breakdown/generate', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(BREAKDOWN),
  }))
  await page.route('**/api/breakdown/qc', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ passed: true, summary: 'ok', checks: [] }),
  }))
  await page.route('**/api/character/enrich', async (r) => {
    const b = r.request().postDataJSON() as { name?: string }
    const name = b?.name ?? ''
    log.enrich.push(name)
    if (FAIL.includes(name)) {
      log.failed.push(name)
      // Byte-for-byte the shape server.py:2507 raises.
      await r.fulfill({ status: 502, contentType: 'application/json',
        body: JSON.stringify({ detail: 'Character enrich failed: Connection error.' }) })
      return
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      personality: `${name} is stubborn.`, backstory: 'lost a brother', wardrobe: 'canvas',
      acting: opts.emptyActing ? '' : `${name} breathes low, moves late`,
    }) })
  })
  await page.route('**/api/shots/enhance', async (r) => {
    const b = r.request().postDataJSON() as {
      shots?: Array<{ id: string; characters?: string[] }>; characters?: Array<{ name: string }>
    }
    log.enhance++
    log.casts.push((b?.characters ?? []).map((c) => c.name))
    for (const s of b?.shots ?? []) for (const n of s.characters ?? []) log.shotCasts.push(n)
    const shots: Record<string, { action: string; visual: string; performance?: string }> = {}
    for (const s of b?.shots ?? []) {
      shots[s.id] = { action: `d ${s.id}`, visual: `l ${s.id}`,
        performance: Array.isArray(s.characters) && s.characters.length === 0 ? '' : `p ${s.id}` }
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shots }) })
  })
  await page.route('**/api/assets/generate*', (r) => r.fulfill({
    status: 500, contentType: 'application/json', body: '{"detail":"stubbed"}' }))
}

const newLog = (): Log => ({ enrich: [], failed: [], enhance: 0, casts: [], shotCasts: [] })

/** Every toast on screen, title + message, as one string per toast. */
const toasts = async (page: Page) => await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="toast-dismiss"]')]
    .map((b) => (b.parentElement?.innerText ?? '').replace(/\s+/g, ' ').trim()))

/** The Breakdown Agent card, expanded. The detail line only renders when the card is
 *  open (AgentStatusMonitor.tsx:110) and the card's `expanded` is seeded ONCE from
 *  status==='active' at mount, so on a page that booted with the agent 'inactive' it is
 *  closed and one click is what opens it. Returns the card's whole text: the STATUS word
 *  (always on screen) and the detail line (one click away). */
async function breakdownCardText(page: Page): Promise<string> {
  const card = page.locator('div.rounded-lg.border', {
    has: page.getByText('Take One Breakdown Agent', { exact: true }) }).last()
  await card.getByRole('button').first().click().catch(() => { /* already open */ })
  await page.waitForTimeout(150)
  return (await card.innerText()).replace(/\s+/g, ' ').trim()
}

// ── the seeded manual path ────────────────────────────────────────────────────
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const SEED = {
  state: {
    projectId: 'dpc', projectName: 'dpc', projectType: 'film', projectStructure: {}, activeStage: 2,
    stages: {
      1: stg('approved', { concept: 'ten farmhands', content: 'FADE IN. THE END.', wordCount: 4 }),
      2: idle(), 3: idle(), 4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '', approvedShotIds: [],
  },
  version: 3,
}

type RunOpts = { emptyActing?: boolean; afterWire?: (p: Page) => Promise<void> }

async function runManual(page: Page, log: Log, opts: RunOpts = {}) {
  await wireApi(page, log, opts)
  await opts.afterWire?.(page)
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: 'Generate Breakdown' }).click()
  await expect.poll(() => log.enrich.length, { timeout: 30_000, intervals: [300] }).toBe(NAMES.length)
  await page.waitForTimeout(2500)   // the shot pass + the terminal agent state
}

async function runAutopilot(page: Page, log: Log, opts: RunOpts = {}) {
  await wireApi(page, log, opts)
  await opts.afterWire?.(page)
  await page.route('**/api/script/generate', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ content: 'FADE IN. Ten farmhands. THE END.' }) }))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await openAutopilot(page)
  await page.getByTestId('autopilot-concept').fill('ten farmhands bring a field back')
  await page.getByTestId('autopilot-start').click()
  await expect.poll(() => log.enrich.length, { timeout: 45_000, intervals: [300] }).toBe(NAMES.length)
  await page.waitForTimeout(2500)
}

for (const path of ['manual', 'autopilot'] as const) {
  // N>=3 per path: one run cannot tell a fix from a coincidence.
  for (const run of [1, 2, 3]) {
    test(`${path} run ${run}: a partial dossier failure NAMES the characters left without a profile`, async ({ page }) => {
      const log = newLog()
      if (path === 'manual') await runManual(page, log)
      else await runAutopilot(page, log)

      const ts = await toasts(page)
      const detail = await breakdownCardText(page)
      console.log(`[${path}/${run}] enrich=${log.enrich.length} failed=${JSON.stringify(log.failed)} `
        + `enhanceBatches=${log.enhance} castSent=${log.casts[0]?.length ?? 0}/${NAMES.length} `
        + `shotCastNames=${new Set(log.shotCasts).size}`)
      console.log(`[${path}/${run}] AGENT CARD: ${detail}`)
      console.log(`[${path}/${run}] TOASTS: ${JSON.stringify(ts)}`)

      // The measured setup that motivates all of this.
      expect(log.failed.sort()).toEqual([...FAIL].sort())
      expect(log.enhance, 'POLICY: proceed with the partial cast').toBeGreaterThan(0)
      expect(log.casts[0]?.length, 'the shot pass got the 7 profiles that landed').toBe(7)
      expect(new Set(log.shotCasts).size, 'while the per-shot cast still names all ten').toBe(10)

      // ── THE PIXEL (a): the Breakdown Agent card's detail line
      //    (AgentStatusMonitor.tsx:125). It must NAME them, not just count them.
      for (const n of FAIL) expect(detail, `card names ${n}`).toContain(n)

      // ── THE PIXEL (b): the sticky toast. Errors and warnings never auto-dismiss
      //    (Toast.tsx), so this is still on screen when the autopilot has moved on.
      const joined = ts.join(' || ')
      expect(joined).toMatch(/Director pass incomplete/i)
      for (const n of FAIL) expect(joined, `toast names ${n}`).toContain(n)
      // …and it says WHAT the consequence is, not only that something failed.
      expect(joined).toMatch(/no acting profile|generic/i)
    })
  }

  test(`${path}: a 200 with an EMPTY acting profile is reported too (enrich.failed === 0)`, async ({ page }) => {
    const log = newLog()
    if (path === 'manual') await runManual(page, log, { emptyActing: true })
    else await runAutopilot(page, log, { emptyActing: true })

    const ts = await toasts(page)
    const detail = await breakdownCardText(page)
    console.log(`[${path}/emptyActing] castSent=${log.casts[0]?.length ?? 0} AGENT CARD: ${detail}`)
    console.log(`[${path}/emptyActing] TOASTS: ${JSON.stringify(ts)}`)

    // Every character now lacks a profile: the 3 that 502'd and the 7 that returned "".
    expect(log.casts[0]?.length ?? 0).toBe(0)
    // castAvailable === 0 with a cast expected → the TOTAL-failure policy, unchanged.
    expect(log.enhance, 'no cast at all → the shot pass must not run').toBe(0)
    expect(ts.join(' || ')).toMatch(/Director pass failed/i)
    expect(detail).toMatch(/0\/10|no character dossiers/i)
  })

  /**
   * THE OTHER HALF OF THE SAME DAY'S FIX — /api/shots/enhance now answers 422 with a
   * message naming the shot and the key when the batch is malformed, instead of a 502
   * carrying a raw Python string ("Shot enhance failed: 'str' object has no attribute
   * 'get'"). A 4xx is only worth choosing over a log if it lands somewhere a human
   * reads, so this walks the last two links: client.ts passes a STRING `detail` straight
   * into the Error message, autoEnhanceShots records it as firstError, and
   * runDirectorPass quotes it in the sticky toast. Without this the rejection is
   * technically visible and practically invisible.
   */
  test(`${path}: a 422 from /api/shots/enhance is quoted verbatim to the operator`, async ({ page }) => {
    const log = newLog()
    const REJECT = "Malformed shot payload — shot SHOT_004: 'characters' is a dict, not a list."
    const wire = async (p: Page) => {
      await p.route('**/api/shots/enhance', (r) => r.fulfill({
        status: 422, contentType: 'application/json', body: JSON.stringify({ detail: REJECT }) }))
    }
    // Registered AFTER wireApi inside run*, so re-route here to win: Playwright uses the
    // most recently added matching handler.
    const runner = path === 'manual' ? runManual : runAutopilot
    await runner(page, log, { afterWire: wire })

    const ts = await toasts(page)
    const detail = await breakdownCardText(page)
    console.log(`[${path}/422] AGENT CARD: ${detail}`)
    console.log(`[${path}/422] TOASTS: ${JSON.stringify(ts)}`)

    // The backend's own words, not a generic "something failed".
    expect(ts.join(' || ')).toContain("'characters' is a dict, not a list")
    expect(ts.join(' || ')).toContain('SHOT_004')
    expect(detail).toContain('SHOT_004')
    expect(detail).toMatch(/shot batch\(es\) failed/i)
  })
}
