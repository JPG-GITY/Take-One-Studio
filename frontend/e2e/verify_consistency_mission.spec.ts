import { test, expect, type Page } from './isolation'

/**
 * Live verification — six-stage pipeline (Script · Breakdown · AG · Storyboard ·
 * SG · Final Cut & Export). Seeds the Zustand persist key with realistic state
 * pointing at the real ConsistencyTest assets + storyboard on disk.
 */

const ROOT = `${process.env.HOME}/Documents/TakeOne/ConsistencyTest`
const CHAR_LOCAL = `${ROOT}/Assets/Characters/Detective Vael/Versions/v001.png`
const CHAR_HEADSHOT = `${ROOT}/Assets/Characters/Detective Vael/Headshot/Versions/v001.png`
const ENV_LOCAL = `${ROOT}/Assets/Environments/Sky-City Precinct Interior/Versions/v001.png`
const SHOT_BOARD = (shotId: string) => `${ROOT}/Shots/${shotId}/Storyboard/Versions/v001.png`
const serveUrl = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`

const SHOTS = [
  {
    id: 'P2_SHOT_001', sceneId: 'INT. SKY-CITY PRECINCT - NIGHT',
    action: 'Vael slowly leans toward the holographic evidence display, eyes narrowing',
    visualDescription: 'Medium close-up of Detective Vael at her holographic desk, floating evidence display',
    assetsUsed: ['ASSET_001', 'ASSET_002'], cameraAngle: 'slow dolly in',
    lighting: 'cool teal hologram glow, warm amber practicals', estimatedDuration: 5, dialogue: [],
  },
  {
    id: 'P2_SHOT_002', sceneId: 'INT. SKY-CITY PRECINCT - NIGHT',
    action: 'Vael walks steadily down the central aisle, coat swaying gently with each step',
    visualDescription: 'Wide shot of Detective Vael walking the central aisle between holographic desks',
    assetsUsed: ['ASSET_001', 'ASSET_002'], cameraAngle: 'smooth tracking left',
    lighting: 'neon city light through rain-streaked windows', estimatedDuration: 5, dialogue: [],
  },
  {
    id: 'P2_SHOT_003', sceneId: 'INT. SKY-CITY PRECINCT - NIGHT',
    action: 'Vael gently raises her chin at the window, then turns to look back into the room',
    visualDescription: 'Profile shot of Detective Vael at the floor-to-ceiling window, neon cityscape beyond',
    assetsUsed: ['ASSET_001', 'ASSET_002'], cameraAngle: 'static medium profile',
    lighting: 'cool neon rim light from the window', estimatedDuration: 10,
    dialogue: [{ characterId: 'ASSET_001', text: 'Three bodies. One signature.', emotion: 'weary' }],
  },
]

const BREAKDOWN = {
  assets: [
    {
      id: 'ASSET_001', name: 'Detective Vael', type: 'character',
      visualDescription: 'Weathered female detective, 40s, polished chrome cybernetic jaw, short black bob with a white streak, sharp green eyes, charcoal trench coat over a deep crimson shirt, gold badge',
      sceneRefs: ['INT. SKY-CITY PRECINCT - NIGHT'],
    },
    {
      id: 'ASSET_002', name: 'Sky-City Precinct Interior', type: 'environment',
      visualDescription: 'Vast neo-noir police precinct hall, rain-streaked windows over a neon cityscape, holographic desks',
      sceneRefs: ['INT. SKY-CITY PRECINCT - NIGHT'],
    },
  ],
  shots: SHOTS,
  scenes: [{ id: 'SC-01', heading: 'INT. SKY-CITY PRECINCT - NIGHT', description: 'INT. SKY-CITY PRECINCT - NIGHT', shotIds: SHOTS.map((s) => s.id) }],
}

const shotBoard = (shotId: string, approved: boolean) => ({
  status: approved ? 'approved' : 'pending',
  boardUrl: '',
  boardLocalPath: SHOT_BOARD(shotId),
  version: 1, rows: 1, cols: 2,
  panels: [
    { label: `${shotId}-A`, desc: 'beat A' },
    { label: `${shotId}-B`, desc: 'beat B' },
  ],
  notes: '',
})

function makeState(opts: { charApproved: boolean; storyboardApproved?: boolean; activeStage?: number }) {
  const sbApproved = opts.storyboardApproved ?? true
  const ver = (id: string, data: unknown) => ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
  const stage = (status: string, data: unknown) => ({
    status, activeVersionId: 'v1', versions: [ver('v1', data)], isDirty: false,
  })
  const assetState = (approved: boolean, localPath: string, headshot?: string) => ({
    imageUrls: [serveUrl(localPath)],
    selectedUrl: serveUrl(localPath),
    localPath,
    headshotLocalPath: headshot ?? null,
    status: approved ? 'approved' : 'pending',
    qcResult: null,
  })
  return {
    state: {
      projectId: 'e2e-restructure',
      projectName: 'ConsistencyTest',
      projectType: 'film',
      projectStructure: { act: '1', scene: '01' },
      activeStage: opts.activeStage ?? 5,
      stages: {
        1: stage('approved', { concept: 'neo-noir detective', content: 'INT. SKY-CITY PRECINCT - NIGHT...' }),
        2: stage('approved', BREAKDOWN),
        3: stage('approved', {
          assets: {
            ASSET_001: { selectedUrl: serveUrl(CHAR_LOCAL), imageUrls: [serveUrl(CHAR_LOCAL)], localPath: CHAR_LOCAL },
            ASSET_002: { selectedUrl: serveUrl(ENV_LOCAL), imageUrls: [serveUrl(ENV_LOCAL)], localPath: ENV_LOCAL },
          },
          assetStates: {
            ASSET_001: assetState(opts.charApproved, CHAR_LOCAL, CHAR_HEADSHOT),
            ASSET_002: assetState(true, ENV_LOCAL),
          },
        }),
        4: stage(sbApproved ? 'approved' : 'pending_review', {
          sceneStates: {
            'SC-01': {
              status: sbApproved ? 'approved' : 'pending',
              shotBoards: {
                P2_SHOT_001: shotBoard('P2_SHOT_001', sbApproved),
                P2_SHOT_002: shotBoard('P2_SHOT_002', sbApproved),
                P2_SHOT_003: shotBoard('P2_SHOT_003', sbApproved),
              },
              qcResult: { passed: true, checks: [], summary: 'seeded', regen_prompt: null },
              notes: '',
            },
          },
        }),
        5: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
        6: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      },
      style: {
        id: 'cinematic', label: 'Cinematic',
        promptSuffix: 'cinematic film still, anamorphic lens, teal and amber palette, volumetric lighting, 35mm film grain',
        negativePrompt: 'cartoon, anime, flat colors',
        anchorImageRefs: [],
      },
      targetDurationSecs: 60,
      aspectRatio: '16:9',
      localFolderRoot: ROOT,
      approvedShotIds: [],
    },
    version: 3,
  }
}

async function seed(page: Page, state: unknown) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), state)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
}

// ── Acceptance 1: six renamed stages + v0→v2 migration ───────────────────────

test('nav shows the six renamed stages', async ({ page }) => {
  await seed(page, makeState({ charApproved: true }))
  for (const label of ['Script', 'Breakdown', 'AG', 'Storyboard', 'SG', 'Final Cut & Export']) {
    await expect(page.locator('button', { hasText: label }).first()).toBeVisible()
  }
  await page.screenshot({ path: '/tmp/restructure_nav.png', fullPage: true })
})

test('migration: old v0 state (text Scene Breakdown in stage 4) loads cleanly', async ({ page }) => {
  const old = makeState({ charApproved: true, activeStage: 4 }) as { state: Record<string, unknown>; version: number }
  // Old format: version 0, stage 4 held {approvedShots, shots}, no aspectRatio
  old.version = 0
  ;(old.state.stages as Record<number, unknown>)[4] = {
    status: 'approved', activeVersionId: 'v1', isDirty: false,
    versions: [{ id: 'v1', createdAt: Date.now(), data: { approvedShots: SHOTS.map((s) => s.id), shots: SHOTS }, qcResult: null, approvalNotes: '' }],
  }
  delete (old.state as Record<string, unknown>).aspectRatio
  await seed(page, old)
  // App loads, stage 4 is the (reset) Storyboard stage — no corrupted state
  await expect(page.getByText('No board yet').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Generate Boards/ })).toBeVisible()
  // Stages 1-3 survived: AG keeps its approved assets
  const migrated = await page.evaluate(() => JSON.parse(localStorage.getItem('takeone-pipeline-v1')!))
  // The CURRENT schema version — this assertion is the only guard that every migration
  // step actually ran, so it moves with each bump. It was left at 3 through v4 and v5
  // and sat red; v6 (segments) is the one where a silent miss costs a whole project.
  expect(migrated.version).toBe(6)
  expect(migrated.state.stages['3'].status).toBe('approved')
  // v6 ran: stage 2 now carries segments, and they kept the shots' own ids.
  const bd = migrated.state.stages['2'].versions[0].data
  expect(Array.isArray(bd.segments)).toBe(true)
  expect(bd.segments.map((s: { id: string }) => s.id)).toEqual(bd.shots.map((s: { id: string }) => s.id))
  await page.screenshot({ path: '/tmp/restructure_migration.png', fullPage: true })
})

// ── Acceptance 3: SG gates ────────────────────────────────────────────────────

test('SG asset gate names the unapproved asset', async ({ page }) => {
  await seed(page, makeState({ charApproved: false }))
  const gate = page.getByTestId('stage5-gate-message')
  await expect(gate).toBeVisible()
  await expect(gate).toContainText('Detective Vael')
  await expect(page.getByRole('button', { name: /Generate All Clips/ })).toBeDisabled()
})

test('SG storyboard gate names the blocking scene', async ({ page }) => {
  await seed(page, makeState({ charApproved: true, storyboardApproved: false }))
  const gate = page.getByTestId('stage5-gate-message')
  await expect(gate).toBeVisible()
  await expect(gate).toContainText('SC-01')
  await expect(page.getByRole('button', { name: /Generate All Clips/ })).toBeDisabled()
  await page.screenshot({ path: '/tmp/restructure_sb_gate.png', fullPage: true })
})

test('SG unlocks when assets + storyboards are approved', async ({ page }) => {
  await seed(page, makeState({ charApproved: true, storyboardApproved: true }))
  await expect(page.getByTestId('stage5-gate-message')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Generate All Clips/ })).toBeEnabled()
})

// ── Acceptance 2 (UI side): Storyboard stage displays the board + shot data ──

test('Storyboard stage: per-shot boards visible with camera/dialogue + per-shot approve', async ({ page }) => {
  await seed(page, makeState({ charApproved: true, storyboardApproved: false, activeStage: 4 }))
  // Every shot row shows ITS OWN rendered board image
  for (const sid of ['P2_SHOT_001', 'P2_SHOT_002', 'P2_SHOT_003']) {
    const img = page.getByTestId(`board-img-${sid}`)
    await expect(img).toBeVisible()
    // the image actually LOADED (no broken <img>)
    const ok = await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 50)
    expect(ok).toBe(true)
  }
  await expect(page.getByText('slow dolly in').first()).toBeVisible()
  await expect(page.getByText('Three bodies. One signature.', { exact: false })).toBeVisible()
  await expect(page.getByTestId('approve-board-P2_SHOT_001')).toBeVisible()
  await page.screenshot({ path: '/tmp/issue4_storyboard.png', fullPage: true })
})

test('per-shot board approval persists across reload', async ({ page }) => {
  await seed(page, makeState({ charApproved: true, storyboardApproved: false, activeStage: 4 }))
  await page.getByTestId('approve-board-P2_SHOT_001').click()
  await page.waitForTimeout(800)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // activeStage isn't persisted (by design) — navigate back to Storyboard
  await page.locator('button', { hasText: 'Storyboard' }).first().click()
  await page.waitForTimeout(800)
  // shot 1 approved (button gone), shots 2/3 still pending
  await expect(page.getByTestId('approve-board-P2_SHOT_001')).toHaveCount(0)
  await expect(page.getByTestId('approve-board-P2_SHOT_002')).toBeVisible()
})
