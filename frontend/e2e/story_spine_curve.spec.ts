import { test, expect, type Page } from './isolation'

// A3 verification: the spine editor shows the SHAPE of the film, not just its text.
//
// What used to be true: the panel rendered the spine as prose and the gates as verdicts,
// so "my film is flat" was a thing you could only discover by watching the finished
// render. The drama layer (tension, mode, obstacle_type/owner, event, cost_level,
// seconds_share) existed on the backend and had no editor and no picture at all.
//
// The backend is stubbed: this asserts what the UI draws from a given bible and what
// leaves the browser when it is edited — never a real proposal, which costs an LLM pass.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SCRIPT = 'INT. KITCHEN - NIGHT\n\nMARA stares at the door.\n'
const CONCEPT = 'a lighthouse keeper who will not open the door'
/** 45 minutes, so a share reads as a runtime a human recognises (0.09 → 4:03). */
const TARGET = 2700

const seed = (projectId: string) => ({
  state: {
    projectId, projectName: 'curve', projectType: 'film', projectStructure: {}, activeStage: 2,
    stages: {
      1: stg('approved', { concept: CONCEPT, content: SCRIPT }),
      2: idle(), 3: idle(), 4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: TARGET, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_curve', approvedShotIds: [],
  },
  version: 3,
})

/** THE TOMORROW WAR, by sequence: 3,6,6,7,6,8,10,7,9,5,6,10,4,6,9 — the curve the
 *  drama layer was measured off. Both 10s drop immediately (to 7 and to 4) and the
 *  sequence before the finale is COMEDY. The shares are deliberately uneven. */
const TW_TENSION = [3, 6, 6, 7, 6, 8, 10, 7, 9, 5, 6, 10, 4, 6, 9]
const TW_MODE = ['quiet', 'procedural', 'dread', 'action', 'reveal', 'action', 'horror',
  'grief', 'action', 'quiet', 'procedural', 'action', 'comedy', 'reveal', 'action']
const TW_SHARE = [0.04, 0.05, 0.06, 0.07, 0.05, 0.08, 0.09, 0.06, 0.08, 0.04, 0.05, 0.10, 0.03, 0.08, 0.12]

const TOMORROW_WAR = TW_TENSION.map((t, i) => ({
  id: `SEQ_${i + 1}`,
  covers: `SEQUENCE ${i + 1}`,
  question_opened: `Q${i + 1}?`,
  answers: i === 0 ? [] : [`SEQ_${i}`],
  value_in: `in ${i + 1}`, value_out: `out ${i + 1}`,
  direction: i % 2 ? 'up' : 'down',
  obstacle: 'the Whitespikes',
  obstacle_type: 'external_agent', obstacle_owner: 'the Whitespikes',
  tension: t, mode: TW_MODE[i], cost_level: Math.min(3, Math.floor(i / 4)),
  seconds_share: TW_SHARE[i],
  ...(t >= 8 ? { event: { irreversible: true, who: 'Dan', loses: `what he cannot get back #${i + 1}` } } : {}),
}))

/** FARO's REAL spine, verbatim from TakeOne-Project/FARO/Script/bible.json — six
 *  sequences, five of whose obstacles ARE the protagonist's own passivity, and NOT ONE
 *  drama field anywhere. It is the backward-compatibility case and the flat case at once. */
const FARO = [
  { id: 'SEQ_1', covers: 'EXT. LIGHTHOUSE — ROCKY SHORE — NIGHT', question_opened: 'Will Elias ever break his lonely unchanging routine?', answers: [], value_in: 'Alone, ordered, numb', value_out: 'Still alone, unbroken routine', direction: 'unchanged', obstacle: 'NONE' },
  { id: 'SEQ_2', covers: 'EXT. LIGHTHOUSE — ROCKS — NIGHT', question_opened: 'Will Elias rescue the woman on the rocks?', answers: ['SEQ_1'], value_in: 'Still alone, unbroken routine', value_out: 'Has brought stranger inside', direction: 'up', obstacle: 'Elias holds the door bolt unmoving' },
  { id: 'SEQ_3', covers: 'INT. LIGHTHOUSE — GROUND FLOOR', question_opened: 'Will Elias connect with Mara at all?', answers: ['SEQ_2'], value_in: 'Has brought stranger inside', value_out: 'Silent, distant, guarded', direction: 'down', obstacle: 'Elias retreats upstairs without speaking' },
  { id: 'SEQ_4', covers: 'INT. LIGHTHOUSE — GROUND FLOOR — LATER', question_opened: 'Will the lighthouse mechanism fail completely?', answers: ['SEQ_3'], value_in: 'Silent, distant, guarded', value_out: 'Mechanism broken, urgent crisis', direction: 'down', obstacle: 'Salt water leaks through the lantern seam' },
  { id: 'SEQ_5', covers: 'INT. LIGHTHOUSE — LANTERN ROOM', question_opened: 'Will Elias let Mara help repair the light?', answers: ['SEQ_4'], value_in: 'Mechanism broken, urgent crisis', value_out: 'Light restored, trust tentative', direction: 'up', obstacle: 'Elias orders Mara back downstairs' },
  { id: 'SEQ_6', covers: 'INT. LIGHTHOUSE — GROUND FLOOR — DAWN', question_opened: 'Will Elias open himself to connection?', answers: ['SEQ_5'], value_in: 'Light restored, trust tentative', value_out: 'Open, present, no longer alone', direction: 'up', obstacle: 'Elias hesitates at the open door' },
]
/** FARO's stored story_checks, verbatim — the four gates, no drama gates at all. */
const FARO_CHECKS = [
  { label: 'Obstacle', passed: true, blocking: false, notes: 'all 6 sequences have an obstacle.' },
  { label: 'Value change', passed: true, blocking: false, notes: '5/6 sequences change the protagonist\'s situation.' },
  { label: 'Rhythm of reversals', passed: true, notes: '3 reversal(s) across 5 sequences.' },
  { label: 'Questions answered', passed: true, blocking: false, notes: 'every question opened is answered later.' },
]

interface Calls { put: unknown[]; propose: unknown[] }

async function stubBackend(page: Page, calls: Calls, payload: () => object) {
  await page.route('**/localhost:8000/**', (r) => r.fulfill({ status: 200, body: '{}' }))
  await page.route('**/api/health', (r) => r.fulfill({ status: 200, body: JSON.stringify({ claude: 'configured', byteplus: 'configured' }) }))
  await page.route('**/api/agents/stream', (r) => r.abort())
  await page.route('**/api/bible?**', (r) => r.fulfill({ status: 200, body: JSON.stringify(payload()) }))
  await page.route('**/api/bible', (r) => {
    if (r.request().method() === 'PUT') {
      const sent = JSON.parse(r.request().postData() ?? '{}')
      calls.put.push(sent.bible)
      return r.fulfill({ status: 200, body: JSON.stringify({
        bible: sent.bible, checks: [], approved: !!sent.approved }) })
    }
    return r.fulfill({ status: 200, body: JSON.stringify(payload()) })
  })
  await page.route('**/api/bible/propose', (r) => {
    calls.propose.push(JSON.parse(r.request().postData() ?? '{}'))
    return r.fulfill({ status: 200, body: JSON.stringify({
      bible: { logline: 'She opens the door.', tone: 'cold', sequences: TOMORROW_WAR },
      checks: [], approved: false }) })
  })
  await page.route('**/api/breakdown/qc', (r) => r.fulfill({ status: 200, body: JSON.stringify(
    { passed: true, checks: [], summary: 'ok', regen_prompt: null }) }))
  page.on('dialog', (d) => void d.dismiss())
}

async function boot(page: Page, projectId: string) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), seed(projectId))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

test('spine curve: a real curve is drawn, and a flat spine is visibly flat', async ({ page }) => {
  const calls: Calls = { put: [], propose: [] }
  await stubBackend(page, calls, () => ({
    bible: { logline: 'Dan is drafted into a war 30 years from now.', tone: 'loud, then quiet',
      sequences: TOMORROW_WAR },
    checks: [], approved: false,
  }))
  await boot(page, 'curve-tw')

  await expect(page.getByTestId('spine-curve')).toBeVisible()
  // The chart carries the tension it was given, bar by bar — no rounding, no defaults.
  const drawn = await page.$$eval('[data-testid^="spine-curve-bar-"]',
    (els) => els.map((e) => (e as HTMLElement).dataset.tension))
  expect(drawn).toEqual(TW_TENSION.map(String))
  console.log('[A3] curve drawn:', drawn.join(','))

  // Height IS the tension: the 10s are the tallest bars and the 3 is the shortest.
  const heights = await page.$$eval('[data-testid^="spine-curve-bar-"] > div',
    (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
  console.log('[A3] bar heights px:', heights.join(','))
  expect(heights[6]).toBeGreaterThan(heights[0])          // 10 over 3
  expect(heights[6]).toEqual(heights[11])                 // both 10s equal
  expect(heights[12]).toBeLessThan(heights[11])           // the drop after a peak, 10 → 4

  // Width IS the share: SEQ_15 (0.12) is the widest block, SEQ_13 (0.03) the narrowest.
  const widths = await page.$$eval('[data-testid^="spine-footage-block-"]',
    (els) => els.map((e) => Math.round(e.getBoundingClientRect().width)))
  console.log('[A3] footage widths px:', widths.join(','))
  expect(Math.max(...widths)).toEqual(widths[14])
  expect(Math.min(...widths)).toEqual(widths[12])

  // …and it is labelled in m:ss, not in fractions. 0.12 × 45:00 = 5:24.
  await expect(page.getByTestId('spine-footage-block-14')).toHaveText('5:24')
  await expect(page.getByTestId('spine-footage-total')).toContainText('45:00 planned')
  await expect(page.getByTestId('spine-footage-total')).toContainText('sum to 1.00')
  await expect(page.getByTestId('spine-curve-summary')).toContainText('peak 10 at SEQ_12')
  console.log('[A3] footage strip: 15 blocks, widest 5:24, total 45:00, shares sum to 1.00')

  // ── The same screen, FARO's real spine: six sequences, not one drama field. ──
  await page.route('**/api/bible?**', (r) => r.fulfill({ status: 200, body: JSON.stringify(
    { bible: { logline: 'A lighthouse keeper lets someone in.', tone: 'cold', sequences: FARO },
      checks: FARO_CHECKS, approved: false }) }))
  await page.getByTestId('spine-reload').click()
  await expect(page.getByTestId('spine-seq-5')).toBeVisible()
  const faro = await page.$$eval('[data-testid^="spine-curve-bar-"]',
    (els) => els.map((e) => (e as HTMLElement).dataset.tension))
  expect(faro).toEqual(['', '', '', '', '', ''])
  await expect(page.getByTestId('spine-curve-summary')).toContainText('no sequence declares a tension')
  await expect(page.getByTestId('spine-footage-total')).toContainText('no share declared')
  // The drama gates stay SILENT on it — exactly the four it has on disk today. The
  // wording is the summary chip's ("all 4 passing", not "4/4"): it now distinguishes a
  // blocking failure from an advisory note, and with nothing failing it says so plainly.
  await expect(page.getByTestId('spine-gate-summary')).toContainText('all 4 passing')
  console.log('[A3] FARO: 6 sequences, 0 tensions declared, 4/4 gates — unchanged')
})

test('spine curve: a failing gate says WHICH sequence, and jumps to it', async ({ page }) => {
  const calls: Calls = { put: [], propose: [] }
  // Two failures with the two shapes the backend emits: one that NAMES sequences, and
  // one that names none at all ("no sequence reaches tension 8") — the second is the
  // one that used to leave the user with nowhere to go.
  const flat = TOMORROW_WAR.map((s) => ({ ...s, tension: 5, event: undefined }))
  await stubBackend(page, calls, () => ({
    bible: { sequences: flat },
    checks: [
      // blocking:false since 2026-08-12 and the fixture follows the backend: this gate
      // judges the STORY, and while it was blocking it reached the autopilot's stage-2
      // stop condition — a flat 60-second short halted an unattended run before a single
      // asset existed. A fixture that cannot occur is a test lying quietly.
      { label: 'Irreversible peak', passed: false, blocking: false,
        notes: 'no sequence reaches tension 8 — the highest is 5. A film with no peak has nothing to cost the protagonist.' },
      { label: 'Relief', passed: false,
        notes: '2 peak(s) are never let go of (SEQ_7, SEQ_12) — nothing in the two sequences after them is comedy, quiet or wonder.' },
    ],
    approved: false,
  }))
  await boot(page, 'curve-gates')

  // The gate that names nothing now says where it expected the peak — from the shares.
  const where = page.getByTestId('spine-gate-where-Irreversible peak')
  await expect(where).toContainText('last quarter')
  await expect(where).toContainText('SEQ_15')
  await expect(page.getByTestId('spine-gate-help-Irreversible peak')).toContainText('loses')
  console.log('[A3] "no peak" failure now answers "where, then?":', (await where.textContent())?.slice(0, 90))

  // The gate that DOES name sequences turns them into jumps.
  const chips = page.getByTestId('spine-gate-seqs-Relief').getByRole('button')
  await expect(chips).toHaveCount(2)
  await chips.first().click()
  await expect(page.getByTestId('spine-seq-6')).toHaveClass(/ring-cyan/)
  console.log('[A3] gate chip → SEQ_7 scrolled into view and flashed')
})

test('spine curve: the drama fields are editable, and clearing one REMOVES the key', async ({ page }) => {
  const calls: Calls = { put: [], propose: [] }
  await stubBackend(page, calls, () => ({ bible: { sequences: FARO }, checks: FARO_CHECKS, approved: false }))
  await boot(page, 'curve-edit')

  // FARO has no drama layer. Give SEQ_1 one, the way a director would.
  await page.getByTestId('spine-seq-tension-0').fill('9')
  await page.getByTestId('spine-seq-mode-0').selectOption('dread')
  await page.getByTestId('spine-seq-obstacle-type-0').selectOption('external_agent')
  await page.getByTestId('spine-seq-owner-0').fill('the sea')
  await page.getByTestId('spine-seq-cost-0').selectOption('2')
  await page.getByTestId('spine-seq-share-0').fill('25')
  await page.getByTestId('spine-seq-irreversible-0').check()
  await page.getByTestId('spine-seq-loses-0').fill('the light')
  await page.getByTestId('spine-save').click()
  await page.waitForTimeout(400)

  const seq1 = (calls.put.at(-1) as { sequences: Array<Record<string, unknown>> }).sequences[0]
  console.log('[A3] PUT SEQ_1 =', JSON.stringify(seq1))
  expect(seq1.tension).toBe(9)
  expect(seq1.mode).toBe('dread')
  expect(seq1.obstacle_type).toBe('external_agent')
  expect(seq1.obstacle_owner).toBe('the sea')
  expect(seq1.cost_level).toBe(2)
  expect(seq1.seconds_share).toBe(0.25)            // typed as 25%, stored as a fraction
  expect(seq1.event).toEqual({ irreversible: true, who: '', loses: 'the light' })
  // …and the other five are untouched: no invented defaults anywhere.
  const rest = (calls.put.at(-1) as { sequences: Array<Record<string, unknown>> }).sequences.slice(1)
  expect(rest.some((s) => 'tension' in s || 'mode' in s || 'seconds_share' in s)).toBe(false)

  // Clearing has to DELETE the key: an empty string or a 0 would switch a whole gate on
  // for the spine, which is what keeps every bible written before today scoring the same.
  await page.getByTestId('spine-seq-tension-0').fill('')
  await page.getByTestId('spine-seq-mode-0').selectOption('')
  await page.getByTestId('spine-seq-share-0').fill('')
  await page.getByTestId('spine-seq-irreversible-0').uncheck()
  await page.getByTestId('spine-seq-loses-0').fill('')
  await page.getByTestId('spine-save').click()
  await page.waitForTimeout(400)
  const cleared = (calls.put.at(-1) as { sequences: Array<Record<string, unknown>> }).sequences[0]
  console.log('[A3] after clearing =', JSON.stringify(cleared))
  expect('tension' in cleared).toBe(false)
  expect('mode' in cleared).toBe(false)
  expect('seconds_share' in cleared).toBe(false)
  expect('event' in cleared).toBe(false)
  expect(cleared.obstacle).toBe('NONE')            // the text fields are untouched
})

/**
 * The inverse of the test this replaces, and it is the finding of 2026-08-12.
 *
 * "Design the spine from the concept" wrote a spine for THE DIVORCE DRAMA QUEEN 2 about
 * CLARA and DANIEL while the script was about JOEL and MARA — 10/12 gates passing —
 * because the endpoint deliberately never sees the script. The route is out of the UI;
 * /api/bible/propose stays on the backend, documented and unreachable.
 *
 * The stub is KEPT as a tripwire: it counts anything that still calls it. The assertion
 * is that nothing does, and that the only route offered here reads the script.
 */
test('spine curve: the concept route is GONE — nothing designs a spine without the script', async ({ page }) => {
  const calls: Calls = { put: [], propose: [] }
  await stubBackend(page, calls, () => ({ bible: {}, checks: [], approved: false }))
  await boot(page, 'curve-propose')

  await expect(page.getByTestId('spine-empty')).toBeVisible()
  await expect(page.getByTestId('spine-propose')).toHaveCount(0)
  await expect(page.getByTestId('spine-tone-hint')).toHaveCount(0)
  // What IS offered: the script route, and it is enabled — this seed has an approved one.
  await expect(page.getByTestId('spine-derive')).toBeEnabled()

  await page.waitForTimeout(600)
  expect(calls.propose.length).toBe(0)
  console.log('[spine] no design-from-concept control, and 0 calls to /api/bible/propose')
})
