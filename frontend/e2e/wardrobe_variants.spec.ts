import { test, expect } from './isolation'

// Phase-2 wardrobe VARIANTS (D1-D3). A character used to wear ONE costume for the whole
// film (Eli in pyjamas at school). A variant is an ordinary character asset carrying
// parentCharacterId + wardrobe + sceneRefs; the AG list groups it under its base and the
// editor lets the USER decide the looks and the scenes each is worn in.
// Pure UI/state — nothing is generated, so this spec spends nothing.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const BEDROOM = "INT. ELI'S BEDROOM - NIGHT"
const SCHOOL = 'INT. SCHOOL - HALLWAY - DAY'

const SEED = {
  state: {
    projectId: 'wardrobe1', projectName: 'wardrobe', projectType: 'film', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [
          { id: 'ASSET_001', name: 'Eli', type: 'character', visualDescription: 'boy, 6, dark eyes', sceneRefs: [BEDROOM, SCHOOL], wardrobe: 'pale pink pyjamas' },
          { id: 'ASSET_002', name: 'Eli · Day Clothes', type: 'character', visualDescription: 'same boy', sceneRefs: [SCHOOL], parentCharacterId: 'ASSET_001', wardrobe: 'navy jumper, grey trousers' },
          { id: 'ASSET_003', name: "Eli's Bedroom", type: 'environment', visualDescription: 'a room', sceneRefs: [BEDROOM] },
        ],
        shots: [
          { id: 'SHOT_001', sceneId: BEDROOM, action: 'draws', visualDescription: 'vd', assetsUsed: ['ASSET_001', 'ASSET_003'], estimatedDuration: 5, dialogue: [] },
          { id: 'SHOT_002', sceneId: SCHOOL, action: 'walks', visualDescription: 'vd', assetsUsed: ['ASSET_002'], estimatedDuration: 5, dialogue: [] },
        ],
        scenes: [
          { id: BEDROOM, heading: BEDROOM, description: 'd', shotIds: ['SHOT_001'] },
          { id: SCHOOL, heading: SCHOOL, description: 'd', shotIds: ['SHOT_002'] },
        ],
      }),
      3: idle(), 4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_wardrobe', approvedShotIds: [],
  },
  version: 5,
}

const breakdown = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s2 = st.state.stages['2']
    const v = s2.versions.find((x: { id: string }) => x.id === s2.activeVersionId)
    return v.data as {
      assets: Array<{ id: string; name: string; parentCharacterId?: string; wardrobe?: string; sceneRefs?: string[] }>
      shots: Array<{ id: string; sceneId: string; assetsUsed: string[] }>
    }
  })

test('AG groups wardrobe variants under their base and the editor drives shot assignment', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1800)

  // D1: the base character owns a wardrobe panel; the variant is NOT given one of its own
  await expect(page.getByTestId('wardrobe-panel-ASSET_001')).toBeVisible()
  expect(await page.getByTestId('wardrobe-panel-ASSET_002').count()).toBe(0)
  console.log('[D1] wardrobe panel lives on the base character only')

  // D2: open it — the default look (base) and the variant are both editable
  await page.getByTestId('wardrobe-panel-ASSET_001').click()
  await page.waitForTimeout(400)
  await expect(page.getByTestId('wardrobe-default-ASSET_001')).toHaveValue('pale pink pyjamas')
  await expect(page.getByTestId('wardrobe-label-ASSET_002')).toHaveValue('Day Clothes')
  await expect(page.getByTestId('wardrobe-desc-ASSET_002')).toHaveValue('navy jumper, grey trousers')
  console.log('[D2] default look + variant render with their costumes')

  // The variant claims SCHOOL only — SHOT_002 uses it, SHOT_001 stays on the base
  const before = await breakdown(page)
  expect(before.shots.find((s) => s.id === 'SHOT_001')!.assetsUsed).toContain('ASSET_001')
  expect(before.shots.find((s) => s.id === 'SHOT_002')!.assetsUsed).toContain('ASSET_002')

  // D2: UNassign the school scene → that shot must fall back to the BASE look
  await page.getByTestId(`wardrobe-scene-ASSET_002-${SCHOOL}`).click()
  await expect.poll(async () => (await breakdown(page)).shots.find((s) => s.id === 'SHOT_002')!.assetsUsed,
    { timeout: 10_000, intervals: [300] }).toEqual(['ASSET_001'])
  console.log('[D2] removing a scene sends its shot back to the default look')

  // …and re-assigning it puts the variant back (recomputation is reversible/idempotent)
  await page.getByTestId(`wardrobe-scene-ASSET_002-${SCHOOL}`).click()
  await expect.poll(async () => (await breakdown(page)).shots.find((s) => s.id === 'SHOT_002')!.assetsUsed,
    { timeout: 10_000, intervals: [300] }).toEqual(['ASSET_002'])
  console.log('[D2] re-assigning restores the variant')

  // D2: add a look — a new variant asset appears under the same base, unassigned
  await page.getByTestId('wardrobe-add-ASSET_001').click()
  await expect.poll(async () => (await breakdown(page)).assets.filter((a) => a.parentCharacterId === 'ASSET_001').length,
    { timeout: 10_000, intervals: [300] }).toBe(2)
  const added = (await breakdown(page)).assets.find((a) => a.parentCharacterId === 'ASSET_001' && a.id !== 'ASSET_002')!
  expect(added.name).toContain('Eli · ')
  expect(added.sceneRefs ?? []).toEqual([])
  console.log('[D2] "Add a look" creates an unassigned variant under the base:', added.id, added.name)

  // D2: delete it again — the breakdown must not keep an orphan reference
  await page.getByTestId(`wardrobe-remove-${added.id}`).click()
  await expect.poll(async () => (await breakdown(page)).assets.some((a) => a.id === added.id),
    { timeout: 10_000, intervals: [300] }).toBe(false)
  const after = await breakdown(page)
  expect(after.shots.every((s) => !s.assetsUsed.includes(added.id))).toBe(true)
  console.log('[D2] deleting a look removes it and leaves no dangling shot reference')
})
