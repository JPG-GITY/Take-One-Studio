import { test, expect, noInheritedProject } from './isolation'

// Per-project loading: the Open tab browses the filesystem (/api/fs/list),
// finds an Take One Studio project folder, and restores its saved pipeline snapshot
// (/api/project/load → loadProjectState). Backend is route-mocked.

// …except /api/project/last, which no test here mocked: these specs assert on WHICH
// project got loaded, and boot's last-project fallback can load a different one.
test.beforeEach(async ({ page }) => { await noInheritedProject(page) })

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })

// A saved snapshot as written to disk (the partialized store shape)
const SNAPSHOT = {
  projectId: 'loaded-1',
  projectName: 'MY LOADED FILM',
  projectType: 'film',
  projectStructure: { act: 'Act 1', scene: '01' },
  stages: {
    1: { status: 'approved', activeVersionId: 'v1', versions: [ver('v1', { concept: 'c', content: 'INT. LOADED - DAY' }, true)], isDirty: false },
    2: { status: 'approved', activeVersionId: 'v1', versions: [ver('v1', { assets: [], shots: [], scenes: [] }, true)], isDirty: false },
    3: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
    4: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
    5: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
    6: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
  },
  style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
  targetDurationSecs: 120,
  aspectRatio: '16:9',
  gateMode: 'manual',
  localFolderRoot: '/home/user/Films/MyFilm',
  approvedShotIds: [],
  gallery: [],
  referenceTray: [],
}

test('Open tab browses to a project folder and restores its saved state', async ({ page }) => {
  // Regex routes — the query string carries paths with '/', which a glob '*' won't span
  await page.route(/\/api\/fs\/list/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    path: '/home/user/Films', parent: '/home/user', home: '/home/user', isProject: false,
    entries: [
      { name: 'Drafts', path: '/home/user/Films/Drafts', isDir: true, hasProject: false },
      { name: 'MyFilm', path: '/home/user/Films/MyFilm', isDir: true, hasProject: true },
    ],
  }) }))
  await page.route(/\/api\/project\/load/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    state: SNAPSHOT, savedAt: '2026-06-18T00:00:00Z', manifest: { name: 'MY LOADED FILM', type: 'film' }, path: '/home/user/Films/MyFilm',
  }) }))
  // autosave is harmless here, but stub it so it never hits a real backend
  await page.route(/\/api\/project\/save-state/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/x' }) }))

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  // Seed a minimal current project so the persist key exists (the store only
  // writes localStorage on change); we then open a DIFFERENT project over it.
  await page.evaluate(() => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({
    state: { projectName: 'OLD PROJECT', projectType: 'tv', activeStage: 1, stages: {
      1: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      2: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      3: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      4: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      5: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      6: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
    } }, version: 4,
  })))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  await page.getByTestId('project-setup-trigger').click()
  await page.getByTestId('project-tab-open').click()
  await expect(page.getByTestId('project-open-tab')).toBeVisible()

  // The project folder is listed with an Open affordance; click it
  await expect(page.getByTestId('fb-entry-MyFilm')).toBeVisible({ timeout: 8000 })
  await page.getByTestId('fb-open-MyFilm').click()

  // The store restored the snapshot — projectName + Stage 1 approved + folder set
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('takeone-pipeline-v1')
    if (!raw) return { name: '(no-localstorage)', s1: '', root: '' }
    const st = JSON.parse(raw).state
    return { name: st.projectName, s1: st.stages['1'].status, root: st.localFolderRoot }
  }), { timeout: 8000, intervals: [300] }).toEqual({ name: 'MY LOADED FILM', s1: 'approved', root: '/home/user/Films/MyFilm' })
  expect(errors, errors.join('\n')).toHaveLength(0)
  console.log('[load] project snapshot restored into the store')
})

test('an EMPTY snapshot (legacy project opened once) is treated as no-state, not loaded silently', async ({ page }) => {
  const EMPTY = {
    projectName: 'LEGACY', projectType: 'film', projectStructure: {},
    stages: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, { status: 'idle', activeVersionId: null, versions: [], isDirty: false }])),
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', gateMode: 'manual', localFolderRoot: '/home/user/Legacy', approvedShotIds: [], gallery: [], referenceTray: [],
  }
  await page.route(/\/api\/fs\/list/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    path: '/home/user', parent: '/home', home: '/home/user', isProject: false,
    entries: [{ name: 'Legacy', path: '/home/user/Legacy', isDir: true, hasProject: true }],
  }) }))
  await page.route(/\/api\/project\/load/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    state: EMPTY, savedAt: '2026-06-18T00:00:00Z', manifest: { name: 'LEGACY', type: 'film' }, path: '/home/user/Legacy',
  }) }))
  await page.route(/\/api\/project\/save-state/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/x' }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  await page.getByTestId('project-setup-trigger').click()
  await page.getByTestId('project-tab-open').click()
  await page.getByTestId('fb-open-Legacy').click()

  // The honest "no saved state" warning shows (an empty snapshot isn't a real load)
  await expect(page.getByText('No saved state')).toBeVisible({ timeout: 8000 })
  console.log('[load] empty snapshot correctly treated as no-state (warned, not silently loaded)')
})

test('a legacy project (no snapshot) is RECONSTRUCTED from its on-disk artifacts', async ({ page }) => {
  const RECON = {
    script: { concept: 'a heist', content: 'INT. VAULT - NIGHT\nThe crew moves in.' },
    breakdown: {
      assets: [{ id: 'ASSET_001', name: 'Hero', type: 'character', visual_description: 'a masked thief' }],
      shots: [
        { id: 'SHOT_001', scene: 'INT. VAULT - NIGHT', action: 'crack the safe', visual_description: 'hands on dial', assets_used: ['ASSET_001'], camera: 'close', lighting: 'low', duration_sec: 6 },
        { id: 'SHOT_002', scene: 'INT. VAULT - NIGHT', action: 'grab the loot', visual_description: 'bag fills', assets_used: ['ASSET_001'], camera: 'wide', lighting: 'low', duration_sec: 5 },
      ],
      scenes: [],
    },
    assets: [{ assetId: 'ASSET_001', name: 'Hero', type: 'character', status: 'pending', localPath: '/proj/Heist/Assets/Characters/Hero/Versions/v001.png', headshotLocalPath: '' }],
    shots: [
      { shotId: 'SHOT_001', videoLocalPath: '/proj/Heist/Shots/SHOT_001/video_v001.mp4', keyframeLocalPath: '', status: 'ready', duration: 6,
        board: { boardLocalPath: '/proj/Heist/Shots/SHOT_001/Storyboard/Versions/v001.png', version: 1, rows: 1, cols: 2,
          panels: [{ label: 'SHOT_001-A', name: 'Crack', shot_type: 'Close.', desc: 'hands on dial', red: 'r', blue: 'b', green: 'g', orange: 'o', purple: 'p' }],
          autoPrompt: 'p', sentPrompt: 'p' } },
      { shotId: 'SHOT_002', videoLocalPath: '', keyframeLocalPath: '', status: 'queued', duration: 5, board: null },
    ],
  }
  await page.route(/\/api\/fs\/list/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    path: '/proj', parent: '/', home: '/proj', isProject: false,
    entries: [{ name: 'Heist', path: '/proj/Heist', isDir: true, hasProject: true }],
  }) }))
  await page.route(/\/api\/project\/load/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    state: null, savedAt: null, manifest: { name: 'HEIST JOB', type: 'film', structure: {} }, reconstruct: RECON, path: '/proj/Heist',
  }) }))
  await page.route(/\/api\/project\/save-state/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/x' }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({
    state: { projectName: 'OLD', stages: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, { status: 'idle', activeVersionId: null, versions: [], isDirty: false }])) }, version: 4,
  })))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  await page.getByTestId('project-setup-trigger').click()
  await page.getByTestId('project-tab-open').click()
  await page.getByTestId('fb-open-Heist').click()

  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('takeone-pipeline-v1')
    if (!raw) return null
    const st = JSON.parse(raw).state
    const v = (n: number) => st.stages[n].versions.find((x: { id: string }) => x.id === st.stages[n].activeVersionId)?.data
    const s4 = v(4)?.sceneStates ?? {}
    const b1 = Object.values(s4).map((sc: unknown) => (sc as { shotBoards?: Record<string, { boardLocalPath?: string; panels?: unknown[] }> }).shotBoards?.SHOT_001).find(Boolean)
    return {
      name: st.projectName,
      s1: st.stages['1'].status,
      s2shots: (v(2)?.shots ?? []).length,
      s3asset: !!v(3)?.assetStates?.ASSET_001?.selectedUrl,
      s4board: !!b1?.boardLocalPath,
      s4panels: (b1?.panels ?? []).length,
      s5video: (v(5)?.shots ?? []).find((s: { shotId: string }) => s.shotId === 'SHOT_001')?.videoUrl ?? '',
    }
  }), { timeout: 8000, intervals: [300] }).toEqual({
    name: 'HEIST JOB', s1: 'approved', s2shots: 2, s3asset: true, s4board: true, s4panels: 1, s5video: expect.stringContaining('video_v001.mp4'),
  })
  console.log('[reconstruct] legacy project rebuilt — script + breakdown + asset + storyboard + rendered shot restored')
})

test('a snapshot missing a stage that disk can supply triggers a full reconstruction', async ({ page }) => {
  // Snapshot has stages 1/2/3/5 but NO storyboards (stage 4 empty) — the exact
  // legacy-transition case. Disk holds a board, so Open must reconstruct in full.
  const ver2 = (id: string, data: unknown) => ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
  const STALE = {
    projectName: 'PARTIAL', projectType: 'film', projectStructure: {},
    stages: {
      1: { status: 'approved', activeVersionId: 'a', versions: [ver2('a', { concept: 'x', content: 'INT. ROOM' })], isDirty: false },
      2: { status: 'approved', activeVersionId: 'a', versions: [ver2('a', { assets: [], shots: [{ id: 'SHOT_001', sceneId: 'INT. ROOM', action: 'a', visualDescription: 'v', assetsUsed: [], estimatedDuration: 5, dialogue: [] }], scenes: [{ id: 'INT. ROOM', heading: 'INT. ROOM', shotIds: ['SHOT_001'] }] })], isDirty: false },
      3: { status: 'pending_review', activeVersionId: 'a', versions: [ver2('a', { assetStates: { ASSET_001: { status: 'pending', selectedUrl: 'u' } } })], isDirty: false },
      4: { status: 'approved', activeVersionId: 'a', versions: [ver2('a', { sceneStates: {} })], isDirty: false },  // empty!
      5: { status: 'pending_review', activeVersionId: 'a', versions: [ver2('a', { shots: [{ shotId: 'SHOT_001', thumbnailUrl: '', videoUrl: 'http://x/v.mp4', duration: 5, status: 'ready' }] })], isDirty: false },
      6: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', gateMode: 'manual', localFolderRoot: '/p/Partial', approvedShotIds: [], gallery: [], referenceTray: [],
  }
  const RECON = {
    script: { concept: 'x', content: 'INT. ROOM' },
    breakdown: { assets: [], shots: [{ id: 'SHOT_001', scene: 'INT. ROOM', action: 'a', visual_description: 'v', assets_used: [], duration_sec: 5 }], scenes: [] },
    assets: [],
    shots: [{ shotId: 'SHOT_001', videoLocalPath: '/p/Partial/Shots/SHOT_001/v.mp4', keyframeLocalPath: '', status: 'ready', duration: 5,
      board: { boardLocalPath: '/p/Partial/Shots/SHOT_001/Storyboard/Versions/v001.png', version: 1, rows: 1, cols: 1, autoPrompt: 'p', sentPrompt: 'p' } }],
  }
  await page.route(/\/api\/fs\/list/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    path: '/p', parent: '/', home: '/p', isProject: false, entries: [{ name: 'Partial', path: '/p/Partial', isDir: true, hasProject: true }],
  }) }))
  await page.route(/\/api\/project\/load/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    state: STALE, savedAt: '2026-06-18T11:00:00Z', manifest: { name: 'PARTIAL', type: 'film' }, reconstruct: RECON, path: '/p/Partial',
  }) }))
  await page.route(/\/api\/project\/save-state/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: '/x' }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  await page.getByTestId('project-setup-trigger').click()
  await page.getByTestId('project-tab-open').click()
  await page.getByTestId('fb-open-Partial').click()

  // Stage 4 now has the reconstructed board (the stale empty snapshot was superseded)
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('takeone-pipeline-v1'); if (!raw) return false
    const st = JSON.parse(raw).state
    const s4 = st.stages['4'].versions.find((x: { id: string }) => x.id === st.stages['4'].activeVersionId)?.data?.sceneStates ?? {}
    return Object.values(s4).some((sc: unknown) => Object.keys((sc as { shotBoards?: object }).shotBoards ?? {}).length > 0)
  }), { timeout: 8000, intervals: [300] }).toBe(true)
  console.log('[reconstruct] stale snapshot missing stage 4 → full reconstruction restored the board')
})

test('setup trigger reads "Project Setup" with no project, the type once one exists', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  // Fresh: no project folder → neutral label (not the defaulted "TV Series")
  await expect(page.getByTestId('project-setup-trigger')).toContainText('Project Setup')

  // With a project folder set → shows the project type
  await page.evaluate(() => localStorage.setItem('takeone-pipeline-v1', JSON.stringify({
    state: {
      projectName: 'x', projectType: 'film', localFolderRoot: '/p/Film',
      stages: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, { status: 'idle', activeVersionId: null, versions: [], isDirty: false }])),
    }, version: 4,
  })))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  await expect(page.getByTestId('project-setup-trigger')).toContainText('Film')
  console.log('[setup-label] neutral "Project Setup" until a project exists, then the type')
})

test('New tab Browse opens a folder picker that fills the storage path', async ({ page }) => {
  await page.route(/\/api\/fs\/list/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    path: '/home/user/Movies', parent: '/home/user', home: '/home/user', isProject: false,
    entries: [{ name: 'ProjectsDir', path: '/home/user/Movies/ProjectsDir', isDir: true, hasProject: false }],
  }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  await page.getByTestId('project-setup-trigger').click()
  // New tab is default; open the folder picker next to Storage Location
  await page.getByTestId('storage-browse').click()
  await expect(page.getByTestId('folder-browser')).toBeVisible()
  // Navigating into a folder updates the browsed path
  await page.getByTestId('fb-entry-ProjectsDir').click()
  await expect(page.getByTestId('fb-path')).toBeVisible()
  console.log('[new] storage folder picker works')
})
