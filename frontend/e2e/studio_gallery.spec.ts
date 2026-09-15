import { test, expect } from './isolation'

// The Studio is fully INDEPENDENT of the pipeline: its history lives in its own
// persisted store (`takeone-studio-v1`), never the pipeline gallery. It survives
// reload, and removing an item sticks.

const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const item = (id: string, prompt: string) => ({
  id, kind: 'image', prompt, model: 'Seedream 5.0 Lite',
  imageUrls: [PX], videoUrl: null, posterUrl: PX, createdAt: Date.now(), params: {},
})

const SEED = { state: { items: [item('g1', 'a red car'), item('g2', 'a dog running')] }, version: 1 }

// Click the toggle until the Studio panel actually mounts — robust against the
// brief window after a reload where React hasn't hydrated the click handler yet.
async function openStudio(page: import('@playwright/test').Page) {
  await expect(async () => {
    // Only click while still closed → no on/off oscillation across retries.
    if (!(await page.getByTestId('studio-gallery').isVisible())) {
      await page.getByTestId('studio-toggle').click({ force: true })
    }
    await expect(page.getByTestId('studio-gallery')).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 12_000 })
}

test('Studio history persists in its own store across reload', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-studio-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })

  await openStudio(page)
  await expect(page.getByTestId('studio-item-g1')).toBeVisible()
  await expect(page.getByTestId('studio-item-g2')).toBeVisible()
  console.log('[studio] seeded history visible')

  // Remove g1 → gone, g2 stays
  await page.getByTestId('studio-item-g1').hover()
  await page.getByTestId('studio-remove-g1').click()
  await expect(page.getByTestId('studio-item-g1')).toHaveCount(0)
  await expect(page.getByTestId('studio-item-g2')).toBeVisible()

  // Persisted across reload (own store, independent of the pipeline)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openStudio(page)
  await expect(page.getByTestId('studio-item-g2')).toBeVisible()
  await expect(page.getByTestId('studio-item-g1')).toHaveCount(0)
  console.log('[studio] history persisted in its own store; pipeline store untouched')
})

test('one image can be removed from a multi-image generation (the rest stay)', async ({ page }) => {
  const multi = {
    id: 'm1', kind: 'image', prompt: 'multi gen', model: 'Seedream 5.0 Lite',
    imageUrls: [PX, PX], videoUrl: null, posterUrl: PX, createdAt: Date.now(), params: {},
  }
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-studio-v1', JSON.stringify(s)), { state: { items: [multi] }, version: 1 })
  await page.reload({ waitUntil: 'domcontentloaded' })

  await openStudio(page)
  // The feed renders the entry; two images → two per-image delete buttons.
  await expect(page.getByTestId('studio-preview-del-m1-1')).toBeVisible()

  // Delete one → the generation stays, now a single image (no multi-grid)
  await page.getByTestId('studio-preview-del-m1-0').click()
  await expect(page.getByTestId('studio-item-m1')).toBeVisible()
  await expect(page.getByTestId('studio-preview-del-m1-1')).toHaveCount(0)
  console.log('[studio] removed one image from a multi-gen; the generation survived')
})

// The gallery mixes images, videos and audio, so it filters by kind — and the trash
// icon is scoped to what you are LOOKING at. A global wipe while the gallery showed
// only videos would destroy images the user never saw on screen.
const mixed = (id: string, kind: 'image' | 'video' | 'audio') => ({
  id, kind, prompt: `${kind} ${id}`, model: 'm',
  imageUrls: kind === 'image' ? [PX] : [],
  videoUrl: kind === 'video' ? 'http://localhost:8000/v.mp4' : null,
  audioUrl: kind === 'audio' ? 'http://localhost:8000/a.mp3' : null,
  posterUrl: kind === 'image' ? PX : null, refImages: [], createdAt: Date.now(), params: {},
})

test('gallery filters by kind and the trash clears ONLY the visible kind', async ({ page }) => {
  const seed = { state: { items: [mixed('i1', 'image'), mixed('v1', 'video'), mixed('a1', 'audio')] }, version: 1 }
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-studio-v1', JSON.stringify(s)), seed)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openStudio(page)

  // All → the three kinds together
  for (const id of ['i1', 'v1', 'a1']) await expect(page.getByTestId(`studio-item-${id}`)).toBeVisible()
  console.log('[gallery] All shows every kind')

  // Videos → only the video
  await page.getByTestId('gallery-tab-video').click()
  await expect(page.getByTestId('studio-item-v1')).toBeVisible()
  await expect(page.getByTestId('studio-item-i1')).toHaveCount(0)
  await expect(page.getByTestId('studio-item-a1')).toHaveCount(0)
  console.log('[gallery] Videos tab filters to videos only')

  // Trash while on Videos → the video goes, the image and audio SURVIVE
  await page.getByTestId('studio-gallery-clear').click()
  await expect(page.getByTestId('studio-item-v1')).toHaveCount(0)
  await page.getByTestId('gallery-tab-all').click()
  await expect(page.getByTestId('studio-item-i1')).toBeVisible()
  await expect(page.getByTestId('studio-item-a1')).toBeVisible()
  console.log('[gallery] scoped clear removed only the videos')

  // …and that survives a reload (it went through the persisted store)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openStudio(page)
  await expect(page.getByTestId('studio-item-i1')).toBeVisible()
  await expect(page.getByTestId('studio-item-v1')).toHaveCount(0)
})
