import { test, expect } from './isolation'

/**
 * The stage-2 sidebar has to be READABLE with a full QC verdict in it.
 *
 * What was true until 2026-08-13: the column is a flex child, its cards are flex items,
 * and flex items shrink before they overflow — so with 24 checks and a paragraph per
 * failure the column squeezed its tallest card and that card's own `overflow-hidden`
 * cut the sentence. "Auto-enhance shots after breakdown" was clipped mid-line under the
 * Generate button; the Producer verdict died in the middle of a word. Adding a scrollbar
 * to the column did NOT fix it, which is the trap: shrink-0 on every child is the half
 * that makes the scrollbar do anything.
 *
 * These assertions are geometric on purpose. "The notes are in the DOM" was true the
 * whole time they were invisible.
 */

const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })

const SEED = {
  state: {
    projectId: 'sidebar', projectName: 'sidebar', projectType: 'film', projectStructure: {}, activeStage: 2,
    stages: {
      1: stg('approved', { concept: 'two people at a table', content: 'INT. KITCHEN - NIGHT\n\nThey argue.\n' }),
      2: idle(), 3: idle(), 4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_sidebar', approvedShotIds: [],
  },
  version: 5,
}

const BREAKDOWN = {
  assets: [{ id: 'ASSET_001', name: 'Joel', type: 'character', visual_description: 'a man' }],
  shots: [{ id: 'SHOT_001', scene_id: 'SC-001', camera: 'wide', duration_sec: 6, assets_used: ['ASSET_001'], dialogue: [] }],
}

/** A REAL verdict's shape: 24 checks, five of them failing, each with a full sentence —
 *  the exact load that was clipping the card on DRAMA QUEEN 2. */
const CHECKS = [
  ...Array.from({ length: 19 }, (_, i) => ({ label: `Check ${i + 1}`, passed: true, notes: 'ok' })),
  { label: 'Runtime', passed: false, blocking: false, notes: '86s against a 60s target (43% off). Re-balance the shot durations.' },
  { label: 'Coverage', passed: false, blocking: false, notes: 'SC-01: 6 of 6 shots name no shot size — framing is being left to the render to invent.' },
  { label: 'Agency', passed: false, blocking: false, notes: '1/3 sequence(s) are resisted by something other than the protagonist themself. Self-resisted: SEQ_1, SEQ_3. A protagonist who is only ever stopped by their own hesitation cannot be beaten, so nothing they do costs anything.' },
  { label: 'Recurring adversary', passed: false, blocking: false, notes: "no single adversary appears in 2+ sequences (best: 'mara' × 1)." },
  { label: 'Footage share', passed: false, blocking: false, notes: 'SEQ_1 0s against 15s planned (25% of the film, -100%); SEQ_2 0s against 27s planned (45% of the film, -100%).' },
]

test('stage 2 sidebar: a full QC verdict is readable, and Approve stays reachable', async ({ page }) => {
  await page.route('**/api/health', (r) => r.fulfill({ status: 200, body: JSON.stringify({ claude: 'configured', byteplus: 'configured' }) }))
  await page.route('**/api/agents/stream', (r) => r.abort())
  await page.route('**/api/bible**', (r) => r.fulfill({ status: 200, body: JSON.stringify({ bible: {}, checks: [], approved: false }) }))
  await page.route('**/api/breakdown/generate', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BREAKDOWN) }))
  await page.route('**/api/breakdown/qc', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    passed: false, checks: CHECKS, summary: 'Five notes, nothing blocking.', regen_prompt: null, persona: 'Producer' }) }))
  await page.route('**/api/character/enrich', (r) => r.fulfill({ status: 200, body: JSON.stringify({ personality: 'x', backstory: 'y', wardrobe: 'z', acting: 'w' }) }))
  await page.route('**/api/shots/enhance', (r) => r.fulfill({ status: 200, body: JSON.stringify({ shots: {} }) }))
  page.on('dialog', (d) => void d.accept())

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  await page.getByRole('button', { name: 'Generate Breakdown' }).click()
  const notes = page.getByTestId('qc-failed-notes')
  await expect(notes).toBeVisible({ timeout: 30_000 })

  // 1. The verdict is not CLIPPED: the notes block renders at its full height rather
  //    than being squeezed by the column. scrollHeight > clientHeight here would mean
  //    text exists that no scrollbar of its own can reach.
  const clipped = await notes.evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(clipped).toBeLessThanOrEqual(1)          // sub-pixel rounding only

  // 2. The LAST note is fully rendered — the user's report was that the last issue
  //    "has no reading".
  await expect(notes).toContainText('Footage share')
  await expect(notes).toContainText('-100%')

  // 3. The column scrolls instead of compressing: with this much in it, the sidebar's
  //    content is taller than the sidebar.
  const sidebar = page.locator('[data-testid="qc-failed-notes"]').locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][last()]')
  const scrolls = await sidebar.evaluate((el) => el.scrollHeight > el.clientHeight)
  expect(scrolls).toBe(true)

  // 4. And the thing the verdict exists to inform — the approve button — is reachable.
  const approve = page.getByRole('button', { name: /Approve Breakdown/i })
  await approve.scrollIntoViewIfNeeded()
  await expect(approve).toBeVisible()

  // 5. The header counts what can actually stop the pipeline, not the sum of remarks.
  await expect(page.getByTestId('qc-summary')).toHaveText(/nothing blocking · 5 notes/i)
  console.log('[sidebar] 24-check verdict readable, last note intact, Approve reachable')
})
