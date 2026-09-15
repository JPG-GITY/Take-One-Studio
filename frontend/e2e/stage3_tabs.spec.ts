import { test, expect } from './isolation'

// P1 verification: Stage 3 asset-type tabs filter the asset list.
//  - All tab shows every asset; per-type tabs show only that type.
//  - 'fx' assets surface under the FX (vfx) tab.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const asset = (id: string, name: string, type: string) => ({
  id, name, type, visualDescription: `${name} — ${type}`, sceneRefs: ['SC-T'],
})

const SEED = {
  state: {
    projectId: 's3tabs', projectName: 'tabs', projectType: 'film', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [
          asset('char1', 'Detective Vael', 'character'),
          asset('prop1', 'Plasma Pistol', 'prop'),
          asset('env1',  'Neon Alley', 'environment'),
          asset('fx1',   'Smoke Plume', 'fx'),
        ],
        shots: [],
        scenes: [{ id: 'SC-T', heading: 'INT. TEST - NIGHT', description: 'd', shotIds: [] }],
      }),
      3: stg('pending_review', { assetStates: {} }),
      4: idle(),
      5: idle(),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic lighting', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_tabs', approvedShotIds: [],
  },
  version: 3,
}

test('stage 3: type tabs filter the asset list (fx → FX tab)', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // Every type tab is present
  for (const t of ['all', 'character', 'prop', 'environment', 'vfx']) {
    await expect(page.getByTestId(`asset-tab-${t}`)).toBeVisible()
  }
  console.log('[P1] all type tabs rendered')

  // Default (All): all four cards visible
  await expect(page.getByTestId('asset-card-char1')).toBeVisible()
  await expect(page.getByTestId('asset-card-prop1')).toBeVisible()
  await expect(page.getByTestId('asset-card-env1')).toBeVisible()
  await expect(page.getByTestId('asset-card-fx1')).toBeVisible()

  // Props tab → only the prop card
  await page.getByTestId('asset-tab-prop').click()
  await expect(page.getByTestId('asset-card-prop1')).toBeVisible()
  await expect(page.getByTestId('asset-card-char1')).toHaveCount(0)
  await expect(page.getByTestId('asset-card-env1')).toHaveCount(0)
  await expect(page.getByTestId('asset-card-fx1')).toHaveCount(0)
  console.log('[P1] Props tab isolates the prop asset')

  // FX tab → the 'fx'-typed asset surfaces under the vfx tab
  await page.getByTestId('asset-tab-vfx').click()
  await expect(page.getByTestId('asset-card-fx1')).toBeVisible()
  await expect(page.getByTestId('asset-card-prop1')).toHaveCount(0)
  console.log('[P1] FX tab surfaces the fx-typed asset')

  // Back to All → everything visible again
  await page.getByTestId('asset-tab-all').click()
  await expect(page.getByTestId('asset-card-char1')).toBeVisible()
  await expect(page.getByTestId('asset-card-fx1')).toBeVisible()

  await page.screenshot({ path: '/tmp/stage3_tabs.png', fullPage: true })
})
