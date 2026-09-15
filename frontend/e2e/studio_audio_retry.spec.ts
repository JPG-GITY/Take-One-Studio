import { test, expect } from './isolation'

// Seedance rejects the soundtrack IT was about to invent and fails the WHOLE paid render:
//   "The request failed because the output audio may be related to copyright restrictions."
// Studio used to answer that by resubmitting once with audio off. On a talking shot that is
// not a recovery — the silent take is the wrong clip, and it was being saved to the gallery
// as if it were the right one (measured 2026-09-02: 3 submissions, 3 rejections, 3 silent
// takes saved and paid for). Two things are locked here — that the muted resubmit does NOT
// happen, and the default that stops most of these from arising at all (audio is opt-in).
//
// Fully route-mocked: no render is submitted and nothing is billed.

const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const SEED = {
  state: {
    items: [{
      id: 'g1', kind: 'image', prompt: 'a product on a plinth', model: 'Seedream 5.0 Lite',
      imageUrls: [PX], videoUrl: null, posterUrl: PX, createdAt: Date.now(), params: {},
    }],
  },
  version: 1,
}

const COPYRIGHT_BLOCK =
  'The request failed because the output audio may be related to copyright restrictions. ' +
  'Request id: 02178634452045500000000000000000000ffffc0a8b32cefc59d'

async function openAnimate(page: import('@playwright/test').Page) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-studio-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  // Click until the panel mounts — same hydration guard studio_gallery.spec uses.
  await expect(async () => {
    if (!(await page.getByTestId('studio-gallery').isVisible())) {
      await page.getByTestId('studio-toggle').click({ force: true })
    }
    await expect(page.getByTestId('studio-gallery')).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 12_000 })
  await expect(async () => {
    await page.getByTestId('studio-animate-g1-0').click({ force: true })
    await expect(page.getByTestId('animate-panel')).toBeVisible({ timeout: 1500 })
  }).toPass({ timeout: 12_000 })
}

test('Animate asks for NO audio by default', async ({ page }) => {
  await openAnimate(page)
  // Audio ON is what asks Seedance to compose a score for a still that carries no audio
  // direction — the request that trips its own copyright filter. It must be opt-in.
  await expect(page.getByTestId('animate-audio')).toHaveText('Audio off')
})

test('an audio copyright block is NOT retried muted — it fails loudly', async ({ page }) => {
  await openAnimate(page)

  const submits: boolean[] = []   // generate_audio, per submit, in order
  await page.route('**/api/studio/video', async (route) => {
    const body = route.request().postDataJSON() as { generate_audio?: boolean }
    submits.push(Boolean(body.generate_audio))
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ task_id: body.generate_audio ? 'T_AUDIO' : 'T_MUTE' }),
    })
  })
  await page.route('**/api/studio/video/T_AUDIO', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'failed', error: COPYRIGHT_BLOCK }),
  }))
  // Kept deliberately: if a muted resubmit ever comes back, this route answers it and the
  // `submits` assertion below is what catches the regression.
  await page.route('**/api/studio/video/T_MUTE', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'completed', video_url: 'https://example.invalid/clip.mp4', tokens: 1, resolution: '720p' }),
  }))

  await page.getByTestId('animate-prompt').fill('the camera pushes slowly in')
  await page.getByTestId('animate-audio').click()          // opt IN, so the filter can trip
  await expect(page.getByTestId('animate-audio')).toHaveText('Audio on')
  await page.getByTestId('animate-generate').click()

  // Every attempt is exhausted, then the operator is told the render died and that nothing
  // was saved.
  await expect(page.getByText(/failed the whole render/i)).toBeVisible({ timeout: 90_000 })

  // 1 + AUDIO_FILTER_RETRIES submits, and EVERY ONE kept audio on. Two regressions are
  // pinned here at once. A `false` anywhere in this array is the muted resubmit coming
  // back: it "succeeded" without ever producing the shot, because for a line of dialogue
  // the silent take is not a degraded result, it is the wrong clip — and it landed in the
  // gallery looking like the right one. A LENGTH of 1 is the retry being dropped: the
  // block is a lottery, not a property of the prompt (measured live 2026-09-02 — 5 of 6
  // audio-ON attempts at one talking close-up blocked, across the original prose prompt,
  // BytePlus's own 2.5 {} dialogue form, and Seedance 2.0), so resubmitting the SAME
  // request is the only lever that has ever produced the shot.
  expect(submits).toEqual([true, true, true, true])
})

test('a failure that is NOT the audio filter is not retried', async ({ page }) => {
  await openAnimate(page)

  let submitCount = 0
  await page.route('**/api/studio/video', async (route) => {
    submitCount++
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'T_DEAD' }) })
  })
  await page.route('**/api/studio/video/T_DEAD', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'failed', error: 'Seedance is over capacity' }),
  }))

  await page.getByTestId('animate-prompt').fill('the camera pushes slowly in')
  await page.getByTestId('animate-audio').click()
  await page.getByTestId('animate-generate').click()

  await expect(page.getByText(/over capacity/i)).toBeVisible({ timeout: 30_000 })
  // Retrying an unrelated failure would burn a second paid render for nothing.
  expect(submitCount).toBe(1)
})
