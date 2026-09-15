import { test, expect, noInheritedProject } from './isolation'
import { openAutopilot } from './hydration'

/**
 * A FAILED DOSSIER PASS MUST NOT REPORT SUCCESS.
 *
 * Measured 2026-08-06, 3/3 runs with a 502 injected on /api/character/enrich — the
 * literal error server.py:2507 raises, which fired for all 10 BLOOM characters that day
 * because of an SSL misconfiguration:
 *   · every character was swallowed by a bare `catch { }` in the enrich worker,
 *   · the shot pass then ran anyway with an EMPTY cast and wrote a performance onto
 *     every shot,
 *   · every dossier stayed at 0 chars,
 *   · and the Breakdown Agent panel read COMPLETED. No toast, no error status.
 * The early `if (!Object.keys(results).length) return` exited BEFORE any updateAgent
 * call, so the last thing anyone saw was the shot pass's own "completed".
 *
 * That is not cosmetic: an independent experiment put ~79% of the acting quality on the
 * cast's master profiles, so a silent empty cast is the whole value of the pass
 * evaporating while three layers say COMPLETED.
 *
 * POLICY ASSERTED HERE (see runDirectorPass): a cast was expected and NONE of it
 * materialised → the shot pass does not run at all. The shot merge never clobbers an
 * existing performance, so direction written without a cast would be written
 * PERMANENTLY and a later successful enrichment could not replace it. An empty
 * `performance` is repairable; a bad one is not.
 */

const readStore = async (page: import('@playwright/test').Page) =>
  await page.evaluate(() => JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state as {
    stages: Record<string, {
      status: string
      activeVersionId: string | null
      versions: Array<{ id: string; data: { assets?: Array<Record<string, string>>; shots?: Array<Record<string, string>> } }>
    }>
  })

// N>=3: one run cannot tell a fix from a coincidence.
for (const run of [1, 2, 3]) {
  test(`run ${run}: a 502 on /api/character/enrich is VISIBLE and does not fake a completed pass`, async ({ page }) => {
    await noInheritedProject(page)

    let enrichCalls = 0
    let enhanceCalls = 0

    await page.route('**/api/script/generate', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ content: 'FADE IN. KANE walks. MIRA waits. THE END.' }),
    }))
    await page.route('**/api/breakdown/generate', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        assets: [
          { id: 'ASSET_001', name: 'Detective Kane', type: 'character', visual_description: 'noir detective' },
          { id: 'ASSET_002', name: 'Mira', type: 'character', visual_description: 'a rogue AI' },
        ],
        shots: [
          { id: 'SHOT_001', scene: 'INT. CITY - NIGHT', action: 'walks', visual_description: 'walks', assets_used: ['ASSET_001'], duration_sec: 5 },
          { id: 'SHOT_002', scene: 'INT. CITY - NIGHT', action: 'turns', visual_description: 'stops', assets_used: ['ASSET_001', 'ASSET_002'], duration_sec: 5 },
        ],
        scenes: [],
      }),
    }))

    // THE INJECTION — byte-for-byte the shape server.py:2507 raises.
    await page.route('**/api/character/enrich', async (r) => {
      enrichCalls++
      await r.fulfill({
        status: 502, contentType: 'application/json',
        body: JSON.stringify({ detail: 'Character enrich failed: Connection error.' }),
      })
    })
    await page.route('**/api/shots/enhance', async (r) => {
      enhanceCalls++
      const body = r.request().postDataJSON() as { shots?: Array<{ id: string }> }
      const shots: Record<string, { action: string; visual: string; performance: string }> = {}
      for (const s of body?.shots ?? []) shots[s.id] = { action: `d ${s.id}`, visual: `l ${s.id}`, performance: `p ${s.id}` }
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shots }) })
    })
    await page.route('**/api/assets/generate*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"stubbed"}' }))

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)

    await openAutopilot(page)
    await page.getByTestId('autopilot-concept').fill('A neon-noir detective hunts a rogue AI')
    await page.getByTestId('autopilot-start').click()

    await expect.poll(async () => (await readStore(page)).stages['2']?.status,
      { timeout: 30_000, intervals: [400] }).toBe('approved')

    // ── 1. WHERE A HUMAN SEES IT (a): the Breakdown Agent card turns red and says
    //    "error" instead of "completed". This is the panel that read COMPLETED before.
    const breakdownCard = page.locator('div', { has: page.getByText('Take One Breakdown Agent', { exact: true }) }).last()
    await expect(breakdownCard.getByText('error', { exact: true })).toBeVisible({ timeout: 10_000 })

    // ── 2. WHERE A HUMAN SEES IT (b): a sticky error toast naming the failure and the
    //    backend's own message. Error toasts never auto-dismiss (Toast.tsx).
    await expect(page.getByText(/Director pass failed/i).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/Character enrich failed/i).first()).toBeVisible()

    // ── 3. THE POLICY: the shot pass did NOT run on an empty cast.
    expect(enrichCalls, 'both characters were attempted').toBe(2)
    expect(enhanceCalls, 'the shot pass must not run with a cast of nobody').toBe(0)

    // ── 4. AND THE DATA SAYS THE SAME THING: no dossiers, and no performance written
    //    onto any shot. An empty performance is repairable by a later run; a
    //    cast-less one would have been permanent.
    const st = await readStore(page)
    const s2 = st.stages['2']
    const data = s2.versions.find((v) => v.id === s2.activeVersionId)!.data
    const chars = (data.assets ?? []).filter((a) => a.type === 'character')
    const withPerf = (data.shots ?? []).filter((s) => (s.performance ?? '').trim().length > 0)
    console.log(`[run ${run}] enrich=${enrichCalls} enhance=${enhanceCalls} `
      + `dossiers=${chars.filter((c) => (c.personality ?? '').length > 0).length}/${chars.length} `
      + `shotsWithPerformance=${withPerf.length}/${(data.shots ?? []).length}`)
    expect(chars.filter((c) => (c.personality ?? '').length > 0).length).toBe(0)
    expect(withPerf.length).toBe(0)

    await page.getByTestId('autopilot-stop').click().catch(() => { /* already finished */ })
  })
}
