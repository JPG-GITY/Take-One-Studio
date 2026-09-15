import { test, expect, noInheritedProject } from './isolation'

/**
 * NON-REGRESSION for the MANUAL path after the director pass was moved out of
 * BreakdownView into features/stage2-breakdown/directorPass.ts.
 *
 * The move exists to end a duplicate: the two passes lived as closures in this view, so
 * the unattended path could not call them, and an earlier extraction left BOTH copies in
 * the tree (the extracted module was imported by zero files). One implementation now
 * serves both callers — which means the manual path is running NEW code and needs to be
 * shown doing exactly what it did before: enrich every character, then enhance the shots
 * with the enriched cast, in that order.
 *
 * It also pins the one behaviour the manual path has and the unattended one does not:
 * the "Auto-enhance shots after breakdown" toggle. Off → dossiers only, no shot pass.
 */

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 'mdp', projectName: 'mdp', projectType: 'film', projectStructure: {}, activeStage: 2,
    stages: {
      1: stg('approved', { concept: 'a diver finds a light', content: 'FADE IN. RUIZ dives. THE END.', wordCount: 6 }),
      2: idle(), 3: idle(), 4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '', approvedShotIds: [],
  },
  version: 3,
}

const BREAKDOWN = {
  assets: [
    { id: 'ASSET_001', name: 'Ruiz', type: 'character', visual_description: 'a diver' },
    { id: 'ASSET_002', name: 'The trench', type: 'environment', visual_description: 'black water' },
  ],
  shots: [
    { id: 'SHOT_001', scene: 'EXT. SEA - DAY', action: 'she dives', visual_description: 'dives', assets_used: ['ASSET_001'], duration_sec: 5 },
    { id: 'SHOT_002', scene: 'EXT. SEA - DAY', action: 'the trench glows', visual_description: 'glow', assets_used: ['ASSET_002'], duration_sec: 5 },
  ],
  scenes: [],
}

async function wire(page: import('@playwright/test').Page, log: { order: string[]; casts: unknown[] }) {
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
    log.order.push(`enrich:${b?.name}`)
    await r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ personality: `${b?.name} is stubborn.`, backstory: 'lost a brother', wardrobe: 'neoprene', acting: 'breathes low, moves late' }),
    })
  })
  await page.route('**/api/shots/enhance', async (r) => {
    const b = r.request().postDataJSON() as { shots?: Array<{ id: string; characters?: string[] }>; characters?: unknown[] }
    log.order.push('enhance')
    log.casts.push(b?.characters ?? [])
    const shots: Record<string, { action: string; visual: string; performance?: string }> = {}
    for (const s of b?.shots ?? []) {
      shots[s.id] = {
        action: `d ${s.id}`, visual: `l ${s.id}`,
        // same contract as the backend: "" only when the caller declared an empty cast
        performance: Array.isArray(s.characters) && s.characters.length === 0 ? '' : `p ${s.id}`,
      }
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ shots }) })
  })
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

const readShots = async (page: import('@playwright/test').Page) =>
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state
    const s2 = st.stages['2']
    const d = s2.versions.find((v: { id: string }) => v.id === s2.activeVersionId)?.data
    return { shots: d?.shots ?? [], assets: d?.assets ?? [] } as {
      shots: Array<{ id: string; performance?: string }>
      assets: Array<{ id: string; type: string; acting?: string; personality?: string }>
    }
  })

test('manual: Generate Breakdown still runs dossiers then shot direction, in that order', async ({ page }) => {
  const log = { order: [] as string[], casts: [] as unknown[] }
  await wire(page, log)

  await expect(page.getByTestId('auto-enhance-toggle')).toBeChecked()
  await page.getByRole('button', { name: 'Generate Breakdown' }).click()

  await expect.poll(() => log.order.filter((o) => o === 'enhance').length,
    { timeout: 20_000, intervals: [300] }).toBeGreaterThan(0)
  await page.waitForTimeout(600)

  console.log('[manual] call order:', log.order.join(' → '))
  console.log('[manual] cast sent:', JSON.stringify(log.casts))

  // ORDER — enrich before enhance, exactly as the in-view version did.
  expect(log.order.filter((o) => o.startsWith('enrich'))).toEqual(['enrich:Ruiz'])
  expect(log.order.indexOf('enhance')).toBeGreaterThan(log.order.lastIndexOf('enrich:Ruiz'))
  // …and the shot pass was handed the freshly-enriched acting profile.
  expect(log.casts[0]).toEqual([{ name: 'Ruiz', acting: 'breathes low, moves late' }])

  const { shots, assets } = await readShots(page)
  const ruiz = assets.find((a) => a.id === 'ASSET_001')!
  expect((ruiz.personality ?? '').length).toBeGreaterThan(0)
  expect((ruiz.acting ?? '').length).toBeGreaterThan(0)
  // SHOT_001 has the diver; SHOT_002's only asset is an environment → no acting direction.
  expect((shots.find((s) => s.id === 'SHOT_001')!.performance ?? '').length).toBeGreaterThan(0)
  expect((shots.find((s) => s.id === 'SHOT_002')!.performance ?? '').trim()).toBe('')
})

test('manual: the auto-enhance toggle still suppresses the shot pass (and only the shot pass)', async ({ page }) => {
  const log = { order: [] as string[], casts: [] as unknown[] }
  await wire(page, log)

  await page.getByTestId('auto-enhance-toggle').uncheck()
  await page.getByRole('button', { name: 'Generate Breakdown' }).click()

  await expect.poll(() => log.order.filter((o) => o.startsWith('enrich')).length,
    { timeout: 20_000, intervals: [300] }).toBe(1)
  await page.waitForTimeout(1500)   // long enough for a shot pass to have fired

  console.log('[manual/no-enhance] call order:', log.order.join(' → '))
  expect(log.order.filter((o) => o === 'enhance').length,
    'toggle off → dossiers only, no shot pass').toBe(0)

  // The dossier still landed: the toggle governs the SHOT pass, nothing else.
  const { assets } = await readShots(page)
  expect((assets.find((a) => a.id === 'ASSET_001')!.acting ?? '').length).toBeGreaterThan(0)
})
