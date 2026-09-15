import { test, expect } from './isolation'

// Regression: after a reload, an approved asset's CDN thumbnail is expired
// (BytePlus URLs live ~24h). The variation must fall back to the on-disk copy
// served via /api/asset/serve so the stage isn't full of broken images.
// Requires the backend on :8000 and the F-AI-L sample project on disk.

// The project folder, and the saved variation inside it. localFolderRoot used to be
// the REPOSITORY root, one level up — and localFolderRoot is what ProjectAutosave
// posts to /api/project/save-state, so every run of this spec wrote a real
// pipeline_state.json into the source tree and re-pointed the backend's "last project
// used on this computer" (storage.remember_last_project) at it. Boot reads that pointer
// back whenever a browser holds no project of its own, which is how one spec's state
// reaches the next one. A project's root is the project.
const ROOT = `${process.env.HOME}/Documents/TakeOne/F-AI-L`
const DISK = `${ROOT}/Assets/Characters/Detective Voss-7/Versions/v001.png`
const EXPIRED_CDN = 'https://ark-cdn.invalid/expired-board.png'

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 's3img', projectName: 'F-AI-L', projectType: 'vfx_shot', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [{ id: 'ASSET_001', name: 'Detective Voss-7', type: 'character', visualDescription: 'cyberpunk detective', sceneRefs: [] }],
        shots: [], scenes: [],
      }),
      3: stg('approved', {
        assetStates: {
          // Mirrors a reloaded locked project: the CDN url is dead, but the
          // approved variation was saved to disk (localPath).
          ASSET_001: { imageUrls: [EXPIRED_CDN], selectedUrl: EXPIRED_CDN, localPath: DISK, status: 'approved', qcResult: null },
        },
      }),
      4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'photoreal', label: 'Photoreal', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: ROOT, approvedShotIds: [],
  },
  version: 3,
}

test('stage 3: an approved asset shows the disk-served preview (no broken CDN grid) after reload', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // Option A: approved → single saved preview replaces the 4-variation grid
  const preview = page.getByTestId('approved-preview')
  await expect(preview).toBeVisible()
  await expect(page.locator('img[alt="Variation 1"]')).toHaveCount(0)
  console.log('[reload] approved → single preview, no variation grid')

  // The preview is served from disk (never expires), not the dead CDN url
  const img = preview.locator('img')
  const src = await img.getAttribute('src')
  console.log('[reload] approved preview src =', src)
  expect(src).toContain('/api/asset/serve')
  expect(src).not.toBe(EXPIRED_CDN)

  // …and it actually decodes (the backend returns the real PNG)
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000, intervals: [300] })
    .toBeGreaterThan(0)
  console.log('[reload] on-disk image decoded — naturalWidth > 0')

  await page.screenshot({ path: '/tmp/stage3_image_reload.png', fullPage: true })
})
