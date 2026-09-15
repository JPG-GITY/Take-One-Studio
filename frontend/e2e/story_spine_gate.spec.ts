import { test, expect, type Page } from './isolation'

// F1 verification: the story spine can be DERIVED and APPROVED before the shot list is
// written, and the approval is a real gate on generating the breakdown.
//
// What used to be true: bible.json only came into existence as a side effect inside
// /api/breakdown/generate, so the Story tab could never show a spine that had not
// already been used to write the shots — and `spine_approved` was stored and read only
// for display, so approving (or not) changed nothing.
//
// The backend is stubbed: this asserts the WIRING (which call goes out when, and what
// the UI does with the answer), never a real derivation — a real one costs a Claude pass.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SCRIPT = 'INT. KITCHEN - NIGHT\n\nMARA stares at the door.\n'

const seed = (projectId: string) => ({
  state: {
    projectId, projectName: 'spine', projectType: 'film', projectStructure: {}, activeStage: 2,
    stages: {
      1: stg('approved', { concept: 'a door that will not open', content: SCRIPT }),
      2: idle(), 3: idle(), 4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: '/tmp/takeone_spine', approvedShotIds: [],
  },
  version: 3,
})

const SEQUENCES = [
  { id: 'SEQ_1', covers: 'INT. KITCHEN - NIGHT', question_opened: 'Will she open it?',
    answers: [], value_in: 'safe', value_out: 'exposed', direction: 'down', obstacle: 'the lock' },
  { id: 'SEQ_2', covers: 'EXT. STREET - NIGHT', question_opened: 'Who was waiting?',
    answers: ['SEQ_1'], value_in: 'exposed', value_out: 'free', direction: 'up', obstacle: 'the man on the step' },
]
const CHECKS = [{ label: 'Obstacle', passed: true, notes: 'every sequence has one', blocking: true }]

/** Counters the tests assert on: what actually left the browser.
 *  `putBodies` holds the PUT payloads (the counter alone cannot show WHAT was written,
 *  and the re-derive test is entirely about a PUT that carries approved:false).
 *  `acceptDialogs` flips the confirm handler — the destructive path has to be taken, not
 *  only offered. */
interface Calls {
  derive: number; put: number; generate: number; dialogs: string[]
  putBodies: unknown[]; acceptDialogs?: boolean
}

async function stubBackend(page: Page, calls: Calls, bible: () => object) {
  // Registered first so the specific handlers below take precedence (Playwright matches
  // the most recently added route first).
  await page.route('**/localhost:8000/**', (r) => r.fulfill({ status: 200, body: '{}' }))
  await page.route('**/api/health', (r) => r.fulfill({ status: 200, body: JSON.stringify({ claude: 'configured', byteplus: 'configured' }) }))
  await page.route('**/api/agents/stream', (r) => r.abort())
  await page.route('**/api/bible?**', (r) => r.fulfill({ status: 200, body: JSON.stringify(bible()) }))
  await page.route('**/api/bible', (r) => {
    if (r.request().method() === 'PUT') {
      calls.put += 1
      const sent = JSON.parse(r.request().postData() ?? '{}')
      calls.putBodies.push(sent)
      return r.fulfill({ status: 200, body: JSON.stringify({
        bible: { ...sent.bible, spine_approved: !!sent.approved }, checks: CHECKS, approved: !!sent.approved }) })
    }
    return r.fulfill({ status: 200, body: JSON.stringify(bible()) })
  })
  await page.route('**/api/bible/derive', (r) => {
    calls.derive += 1
    return r.fulfill({ status: 200, body: JSON.stringify({
      bible: { logline: 'She opens the door.', tone: 'cold', sequences: SEQUENCES },
      checks: CHECKS, approved: false }) })
  })
  await page.route('**/api/breakdown/generate', (r) => {
    calls.generate += 1
    return r.fulfill({ status: 200, body: JSON.stringify({ assets: [], shots: [], scenes: [] }) })
  })
  await page.route('**/api/breakdown/qc', (r) => r.fulfill({ status: 200, body: JSON.stringify(
    { passed: true, checks: [], summary: 'ok', regen_prompt: null }) }))
  page.on('dialog', (d) => {
    calls.dialogs.push(d.message())
    void (calls.acceptDialogs ? d.accept() : d.dismiss())
  })
}

async function boot(page: Page, projectId: string) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), seed(projectId))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

/** The same project one step earlier: a script GENERATED but not approved, sitting on
 *  stage 1 — the state the auto-derive is triggered from. */
const seedUnapproved = (projectId: string) => {
  const s = seed(projectId)
  s.state.activeStage = 1
  s.state.stages[1] = stg('pending_review', { concept: 'a door that will not open', content: SCRIPT })
  return s
}

async function bootStage1(page: Page, projectId: string) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), seedUnapproved(projectId))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

test('story spine: derive before the breakdown, and approval gates the generate', async ({ page }) => {
  const calls: Calls = { derive: 0, put: 0, generate: 0, dialogs: [], putBodies: [] }
  // Empty until the derive lands — exactly what a project that never ran a breakdown has.
  let stored: object = { bible: {}, checks: [], approved: false }
  await stubBackend(page, calls, () => stored)
  await boot(page, 'spine-derive')

  // Nothing generated yet → the stage opens on Story, not on an empty Assets table.
  await expect(page.getByTestId('spine-empty')).toBeVisible()
  await expect(page.getByTestId('spine-gate-state')).toHaveText(/not written/i)
  console.log('[F1] no bible → Story tab is the landing tab, sidebar says "Not written"')

  // Derive it — from the SCRIPT, with no breakdown anywhere.
  await page.getByTestId('spine-derive').click()
  await expect(page.getByTestId('story-spine-panel')).toBeVisible()
  expect(calls.derive).toBe(1)
  expect(calls.generate).toBe(0)          // the shot list has NOT been written
  await expect(page.getByTestId('spine-seq-0')).toBeVisible()
  await expect(page.getByTestId('spine-approval-state')).toHaveText(/not approved/i)
  await expect(page.getByTestId('spine-gate-state')).toHaveText(/not approved/i)
  await expect(page.getByTestId('story-tab-dot')).toBeVisible()
  console.log('[F1] derived a 2-sequence spine with 0 breakdown calls')

  // The gate: generating with an unapproved spine warns, and cancelling goes to Story.
  stored = { bible: { sequences: SEQUENCES }, checks: CHECKS, approved: false }
  await page.getByRole('button', { name: 'Generate Breakdown' }).click()
  await page.waitForTimeout(500)
  expect(calls.dialogs.length).toBe(1)
  expect(calls.dialogs[0]).toContain('NOT been approved')
  expect(calls.generate).toBe(0)
  await expect(page.getByTestId('story-spine-panel')).toBeVisible()   // cancel → Story tab
  console.log('[F1] unapproved spine: generate warned and was cancelled →', JSON.stringify(calls.dialogs[0].slice(0, 48)))

  // Approve it, then the same click goes straight through.
  await page.getByTestId('spine-approve').click()
  await expect(page.getByTestId('spine-gate-approved')).toBeVisible()
  expect(calls.put).toBe(1)
  await page.getByRole('button', { name: 'Generate Breakdown' }).click()
  await page.waitForTimeout(800)
  expect(calls.dialogs.length).toBe(1)      // no second warning
  expect(calls.generate).toBe(1)
  console.log('[F1] approved spine: generate ran with no warning')
})

test('story spine: an empty or failed derive says so instead of going blank', async ({ page }) => {
  const calls: Calls = { derive: 0, put: 0, generate: 0, dialogs: [], putBodies: [] }
  await stubBackend(page, calls, () => ({ bible: {}, checks: [], approved: false }))
  // A 200 with nothing in it, then a 500 — the two ways the derivation can leave the
  // user on the same empty screen with no explanation.
  await page.route('**/api/bible/derive', (r) => {
    calls.derive += 1
    return calls.derive === 1
      ? r.fulfill({ status: 200, body: JSON.stringify({ bible: {}, checks: [], approved: false }) })
      : r.fulfill({ status: 500, body: JSON.stringify({ detail: 'Claude timed out' }) })
  })
  await boot(page, 'spine-empty-derive')

  await page.getByTestId('spine-derive').click()
  await expect(page.getByTestId('spine-empty')).toBeVisible()
  await expect(page.getByText(/returned no sequences/i)).toBeVisible()
  console.log('[F1] empty derive → the empty state explains itself, buttons still live')

  await page.getByTestId('spine-derive').click()
  await expect(page.getByTestId('spine-empty')).toBeVisible()
  // .first(): the message lands twice on purpose — in the panel and in a toast.
  await expect(page.getByText('Claude timed out').first()).toBeVisible()
  await expect(page.getByTestId('spine-derive')).toBeEnabled()
  console.log('[F1] failed derive → error shown, retry still available')
})

/**
 * 2026-08-12: the derivation is no longer a button to be discovered.
 *
 * It was reachable only from the Story tab of stage 2 — a tab a user has no reason to
 * open before the breakdown exists — so in practice the spine kept being born INSIDE the
 * breakdown, after the shot list it decides had already been written. Approving the
 * script now requests it, and this asserts the whole chain: request → stage 2 → Story tab
 * → one POST /api/bible/derive, with no click anywhere near it.
 */
test('story spine: approving the script derives the spine, with no button to find', async ({ page }) => {
  const calls: Calls = { derive: 0, put: 0, generate: 0, dialogs: [], putBodies: [] }
  await stubBackend(page, calls, () => ({ bible: {}, checks: [], approved: false }))
  await bootStage1(page, 'spine-auto')

  // Stage 1, script written, nothing derived: the trigger is the approval and only it.
  expect(calls.derive).toBe(0)
  await page.getByRole('button', { name: 'Approve Script' }).click()

  // Stage 2 opens on Story — even though this project has no breakdown, that is the
  // default; what matters is that the request is already out.
  await expect(page.getByTestId('story-spine-panel')).toBeVisible()
  await expect(page.getByTestId('spine-seq-0')).toBeVisible()
  expect(calls.derive).toBe(1)
  expect(calls.generate).toBe(0)          // the shot list has NOT been written
  await expect(page.getByTestId('spine-approval-state')).toHaveText(/not approved/i)
  console.log('[spine] script approved → 1 derive, 0 clicks, spine on screen unapproved')

  // And it does not fire twice: the request is consumed, not re-read on every render.
  await page.getByTestId('spine-reload').click()
  await page.waitForTimeout(500)
  expect(calls.derive).toBe(1)
  console.log('[spine] the request is one-shot — still 1 derive after a reload')
})

/** The other half of the same rule: the approval REQUESTS a spine, it does not impose
 *  one. A project that already has one keeps it — the spine may be hand-edited and
 *  approved, and an automatic derivation would replace every sequence in it. */
test('story spine: approving the script never overwrites a spine that already exists', async ({ page }) => {
  const calls: Calls = { derive: 0, put: 0, generate: 0, dialogs: [], putBodies: [] }
  await stubBackend(page, calls, () => ({
    bible: { logline: 'Clara opens the door.', sequences: SEQUENCES }, checks: CHECKS, approved: false,
  }))
  await bootStage1(page, 'spine-auto-kept')

  await page.getByRole('button', { name: 'Approve Script' }).click()
  await expect(page.getByTestId('spine-seq-0')).toBeVisible()
  await page.waitForTimeout(600)
  expect(calls.derive).toBe(0)
  // And it says so, rather than looking like the approval did nothing.
  await expect(page.getByText(/already has one/i)).toBeVisible()
  console.log('[spine] existing spine + script approved → 0 derives, and the panel says why')
})

/**
 * The escape hatch. Until now the derive button only existed in the empty state — on
 * purpose, so a derivation could not silently discard an edited spine — which also meant
 * a spine that was simply WRONG could never be redone. (DRAMA QUEEN 2: a spine about
 * CLARA and DANIEL over a script about JOEL and MARA, 10/12 gates passing.)
 *
 * Two things have to be true: it asks first, and — because POST /api/bible/derive answers
 * 409 on an approved spine — accepting withdraws the approval BEFORE deriving.
 */
test('story spine: an existing spine can be re-derived, with a warning that withdraws the approval', async ({ page }) => {
  const calls: Calls = { derive: 0, put: 0, generate: 0, dialogs: [], putBodies: [] }
  await stubBackend(page, calls, () => ({
    bible: { logline: 'Clara opens the door.', sequences: SEQUENCES, spine_approved: true },
    checks: CHECKS, approved: true,
  }))
  await boot(page, 'spine-rederive')

  await expect(page.getByTestId('spine-approval-state')).toHaveText(/^approved$/i)

  // Cancelling changes NOTHING — no write, no derivation.
  await page.getByTestId('spine-rederive').click()
  await page.waitForTimeout(400)
  expect(calls.dialogs.length).toBe(1)
  expect(calls.dialogs[0]).toContain('REPLACES')
  expect(calls.dialogs[0]).toContain('APPROVED')      // it names the approval it would withdraw
  expect(calls.derive).toBe(0)
  expect(calls.put).toBe(0)
  console.log('[spine] re-derive cancelled → 0 writes.', JSON.stringify(calls.dialogs[0].slice(0, 64)))

  // Accepting: un-approve first (else the backend 409s), then derive.
  calls.acceptDialogs = true
  await page.getByTestId('spine-rederive').click()
  await expect(page.getByTestId('spine-approval-state')).toHaveText(/not approved/i)
  expect(calls.put).toBe(1)
  expect((calls.putBodies[0] as { approved?: boolean }).approved).toBe(false)
  expect(calls.derive).toBe(1)
  await expect(page.getByTestId('spine-seq-0')).toBeVisible()
  console.log('[spine] re-derive accepted → PUT approved:false, then 1 derive')
})

/**
 * The gate strip used to read "11/14 passing" for a spine with NOTHING blocking wrong
 * with it — three advisory notes counted exactly like a blocking failure. The advisory
 * gates are calibrated on 13 feature-length scripts, so a three-sequence short collects
 * notes it cannot always act on; presenting those as a score teaches the user to ignore
 * the strip, which is where the one gate that matters lives.
 */
test('story spine: the gate summary separates blocking failures from advisory notes', async ({ page }) => {
  const calls: Calls = { derive: 0, put: 0, generate: 0, dialogs: [], putBodies: [] }
  const MIXED = [
    { label: 'Obstacle', passed: true, blocking: false, notes: 'all good' },
    { label: 'Tonal range', passed: false, blocking: false, notes: '2 mode(s) across 3 sequence(s)' },
    { label: 'Agency', passed: false, blocking: false, notes: '0/3 resisted by anything else' },
  ]
  await stubBackend(page, calls, () => ({
    bible: { logline: 'x', sequences: SEQUENCES }, checks: MIXED, approved: false,
  }))
  await boot(page, 'spine-summary')

  // Two advisory failures, none blocking → not a score, and not red.
  await expect(page.getByTestId('spine-gate-summary')).toHaveText(/nothing blocking · 2 notes/i)
  console.log('[spine] 2 advisory failures →', await page.getByTestId('spine-gate-summary').innerText())

  // One blocking failure → the count is stated, and the passing tally comes back with it.
  await page.route('**/api/bible?**', (r) => r.fulfill({ status: 200, body: JSON.stringify({
    bible: { logline: 'x', sequences: SEQUENCES }, approved: false,
    checks: [...MIXED, { label: 'Cast matches the script', passed: false, blocking: true, notes: 'MARA is missing' }],
  }) }))
  await page.getByTestId('spine-reload').click()
  await expect(page.getByTestId('spine-gate-summary')).toHaveText(/1 blocking · 1\/4 passing/i)
  console.log('[spine] 1 blocking failure →', await page.getByTestId('spine-gate-summary').innerText())
})

test('story spine: a project with no bible at all is never blocked', async ({ page }) => {
  const calls: Calls = { derive: 0, put: 0, generate: 0, dialogs: [], putBodies: [] }
  await stubBackend(page, calls, () => ({ bible: {}, checks: [], approved: false }))
  await boot(page, 'spine-legacy')

  await page.getByRole('button', { name: 'Generate Breakdown' }).click()
  await page.waitForTimeout(800)
  expect(calls.dialogs).toEqual([])         // no confirm at all
  expect(calls.generate).toBe(1)
  console.log('[F1] no bible → generate ran unchanged, 0 dialogs')
})
