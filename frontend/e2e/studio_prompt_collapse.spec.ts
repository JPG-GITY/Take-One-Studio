import { test, expect } from './isolation'

// The prompt above a Studio gallery card used to be printed whole, in one paragraph with
// no line breaks. A structured Seedance 2.5 prompt is thirty lines; the feed became a
// wall of grey text between the reader and the media. Three things are locked here:
// a short prompt shows no toggle at all, a long one is clamped with a "Prompt" toggle,
// and expanding it restores the prompt's own line breaks and offers Copy.
//
// Fully seeded from localStorage — nothing is generated, nothing is billed.

const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const SHORT = 'a red car'
const LONG = [
  '[Generation Goal]',
  'Generate one continuous medium close-up in which a woman in her early sixties looks into the lens and speaks a single line to camera.',
  '',
  '[Reference Material Roles]',
  '@Image 1 defines the woman\'s facial features, curly grey hair, skin texture, and clothing.',
  '',
  '[Event Script]',
  'Opening state: the woman faces the lens with her arms folded, holding steady eye contact.',
  'Primary event: she speaks in English: {At my age it\'s better to be safe than sorry.}',
  'Ending state: her mouth closes and she settles into stillness.',
  '',
  '[Camera]',
  'One continuous take with no cuts. A slow, smooth push-in on the woman.',
].join('\n')

const item = (id: string, prompt: string) => ({
  id, kind: 'image', prompt, model: 'Seedream 5.0 Lite',
  imageUrls: [PX], videoUrl: null, posterUrl: PX, createdAt: Date.now(), params: {},
})
const SEED = { state: { items: [item('s1', SHORT), item('l1', LONG)] }, version: 1 }

async function openStudio(page: import('@playwright/test').Page) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-studio-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(async () => {
    if (!(await page.getByTestId('studio-gallery').isVisible())) {
      await page.getByTestId('studio-toggle').click({ force: true })
    }
    await expect(page.getByTestId('studio-gallery')).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 12_000 })
}

test('a short prompt shows no toggle; a long one is clamped and toggles open with its line breaks', async ({ page }) => {
  await openStudio(page)

  // Short: the text is there, and no button was grown for it.
  await expect(page.getByTestId('studio-prompt-s1')).toContainText(SHORT)
  await expect(page.getByTestId('studio-prompt-toggle-s1')).toHaveCount(0)

  // Long: clamped (the paragraph is shorter than its own content) and a toggle exists.
  const block = page.getByTestId('studio-prompt-l1')
  await expect(block).toHaveAttribute('data-open', '0')
  const toggle = page.getByTestId('studio-prompt-toggle-l1')
  await expect(toggle).toBeVisible()
  const clamped = await block.locator('p').evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(clamped).toBe(true)
  console.log('[studio] long prompt clamped, toggle present; short prompt has none')

  // Open: the clamp is gone, the section breaks are real line breaks, Copy appears.
  await toggle.click()
  await expect(block).toHaveAttribute('data-open', '1')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const open = await block.locator('p').evaluate((el) => ({
    overflow: el.scrollHeight > el.clientHeight + 1,
    preWrap: getComputedStyle(el).whiteSpace,
  }))
  expect(open.overflow).toBe(false)
  expect(open.preWrap).toBe('pre-wrap')
  await expect(page.getByTestId('studio-prompt-copy-l1')).toBeVisible()
  console.log('[studio] expanded: no overflow, pre-wrap, copy offered')

  // Close again: back to the clamp.
  await toggle.click()
  await expect(block).toHaveAttribute('data-open', '0')
})
