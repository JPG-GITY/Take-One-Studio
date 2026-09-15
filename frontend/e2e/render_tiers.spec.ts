import { test, expect } from './isolation'

// The render cost ladder (preview 480p → edit 720p → master at the project's output
// size) and the two guards that keep it from becoming an expensive accident.
//
// Money at stake: a 5s shot costs $0.35 at 480p and $3.89 at 4k, so a wrongly-offered
// "promote everything" over a 540-shot episode is a ~$2,100 click. Both guards below
// were real defects found in the shipped code.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`

const mkShot = (id: string) => ({
  id, sceneId: 'SC-T', action: `Action ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [],
})
const board = (sid: string) => ({
  status: 'approved', boardUrl: '', boardLocalPath: `/tmp/takeone_tiers/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'a', red: '', blue: '', green: '', orange: '', purple: '' }],
})

/** shots: [shotId, tier|undefined, renderedResolution]
 *  `videoModel` is pinned to base 2.0 by default: every dollar figure in this file is
 *  the documented 2.0 price, and since 2026-09-04 the ladder prices per MODEL (2.5 is
 *  $0.514 at 480p, not $0.35), so a seed that inherited the store's 2.5 default would
 *  quote a different — and equally correct — number. */
function seed(shots: Array<[string, string | undefined, string | undefined]>, outputResolution: string, videoModel = 'base') {
  const ids = shots.map(([id]) => id)
  return {
    state: {
      projectId: 'tiers', projectName: 'tiers', projectType: 'film', projectStructure: {}, activeStage: 5,
      stages: {
        1: stg('approved', { concept: 'x', content: 'y' }),
        2: stg('approved', {
          assets: [], shots: ids.map(mkShot),
          scenes: [{ id: 'SC-T', heading: 'INT. LAB - NIGHT', description: 'd', shotIds: ids }],
        }),
        3: stg('approved', { assetStates: {} }),
        4: stg('approved', {
          sceneStates: { 'SC-T': { status: 'approved', qcResult: null, notes: '',
            shotBoards: Object.fromEntries(ids.map((id) => [id, board(id)])) } },
        }),
        5: stg('pending_review', {
          shots: shots.map(([id, tier, res]) => ({
            shotId: id, thumbnailUrl: '', duration: 5, status: 'ready',
            videoUrl: serve(`/tmp/takeone_tiers/Shots/${id}/video_v1.mp4`),
            ...(tier ? { tier } : {}), ...(res ? { renderedResolution: res } : {}),
          })),
        }),
        6: idle(),
      },
      style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
      targetDurationSecs: 60, aspectRatio: '16:9', outputResolution, videoModel,
      localFolderRoot: '/tmp/takeone_tiers', approvedShotIds: [],
    },
    version: 5,
  }
}

const load = async (page: import('@playwright/test').Page, s: unknown) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), s)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

test('the ladder offers each rung only to shots below it', async ({ page }) => {
  await load(page, seed([
    ['SHOT_A', 'preview', '480p'],
    ['SHOT_B', 'edit', '720p'],
    ['SHOT_C', 'master', '4k'],
  ], '4k'))

  // A and B are below master; C is already there.
  await expect(page.getByTestId('tier-pass-master')).toContainText('(2)')
  // Only A is below edit.
  await expect(page.getByTestId('tier-pass-edit')).toContainText('(1)')
  // Nothing is below preview — the lowest rung is never offered.
  await expect(page.getByTestId('tier-pass-preview')).toHaveCount(0)
  console.log('[tiers] master(2), edit(1), preview(0) — ranked, not string-compared')
})

test('lowering the output size never offers to re-render finished shots DOWNWARD', async ({ page }) => {
  // The shipped bug: hdCandidates tested `renderedResolution !== outputResolution`,
  // which is true in BOTH directions. With three shots already mastered at 4k and
  // Settings lowered to 720p, the old code offered to re-render all three — at full
  // price, presented as an upgrade.
  await load(page, seed([
    ['SHOT_A', 'master', '4k'],
    ['SHOT_B', 'master', '4k'],
    ['SHOT_C', 'master', '4k'],
  ], '720p'))

  await expect(page.getByTestId('tier-pass-master')).toHaveCount(0)
  await expect(page.getByTestId('tier-pass-edit')).toHaveCount(0)
  await expect(page.getByTestId('tier-pass-preview')).toHaveCount(0)
  console.log('[tiers] output size lowered to 720p → zero candidates (no downgrade pass)')
})

test('shots of unknown tier are never offered for promotion', async ({ page }) => {
  // Every project that predates the ladder, and everything rebuilt from disk, has no
  // tier. Disk cannot tell what a clip was rendered at, so guessing "draft" would put
  // a whole episode one click from a full re-render. Unknown ranks as master.
  await load(page, seed([
    ['SHOT_A', undefined, undefined],
    ['SHOT_B', undefined, '1080p'],
  ], '4k'))

  await expect(page.getByTestId('tier-pass-master')).toHaveCount(0)
  await expect(page.getByTestId('tier-pass-edit')).toHaveCount(0)
  console.log('[tiers] legacy/unknown-tier shots are not promotable')
})

test('the promotion button states the cost before it is clicked', async ({ page }) => {
  await load(page, seed([
    ['SHOT_A', 'preview', '480p'],
    ['SHOT_B', 'preview', '480p'],
  ], '4k'))

  // 2 shots x 5s at 4k = 2 x $3.89.
  const btn = page.getByTestId('tier-pass-master')
  await expect(btn).toContainText('(2)')
  await expect(btn).toContainText('$7.78')
  await expect(btn).toContainText('4k')
  // And it must not promise an upscale — Seedance 2.0 has no seed.
  await expect(btn).toHaveAttribute('title', /FRESH take, not an upscale/)
  console.log('[tiers] master pass labelled 2 shots / $7.78 / fresh-take warning')
})

// The FIRST pass had no rung selector at all: handleGenerateAll called generateShot
// with no opts, so animateShot's `opts?.tier ?? 'master'` fired every time. The ladder
// could only be climbed AFTER paying the top price once — which is the one thing it
// exists to avoid. These cover the control that makes the cheap pass reachable.

/** Same shape as seed(), but the shot has NEVER rendered (no videoUrl), which is the
 *  only state in which a FIRST pass exists to be priced. */
function seedUnrendered(outputResolution: string, videoModel = 'base') {
  const ids = ['SHOT_A']
  return {
    state: {
      projectId: 'tiers', projectName: 'tiers', projectType: 'film', projectStructure: {}, activeStage: 5,
      stages: {
        1: stg('approved', { concept: 'x', content: 'y' }),
        2: stg('approved', {
          assets: [], shots: ids.map(mkShot),
          scenes: [{ id: 'SC-T', heading: 'INT. LAB - NIGHT', description: 'd', shotIds: ids }],
        }),
        3: stg('approved', { assetStates: {} }),
        4: stg('approved', {
          sceneStates: { 'SC-T': { status: 'approved', qcResult: null, notes: '',
            shotBoards: Object.fromEntries(ids.map((id) => [id, board(id)])) } },
        }),
        5: stg('pending_review', {
          shots: ids.map((id) => ({
            shotId: id, thumbnailUrl: '', duration: 5, status: 'queued', videoUrl: '',
          })),
        }),
        6: idle(),
      },
      style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
      targetDurationSecs: 60, aspectRatio: '16:9', outputResolution, videoModel,
      localFolderRoot: '/tmp/takeone_tiers', approvedShotIds: [],
    },
    version: 5,
  }
}

test('the first pass can be rendered at the cheap rung, and defaults to it', async ({ page }) => {
  await load(page, seedUnrendered('4k'))

  await expect(page.getByTestId('pass-tier')).toBeVisible()
  for (const t of ['preview', 'edit', 'master']) {
    await expect(page.getByTestId(`pass-tier-${t}`)).toBeVisible()
  }
  // Cheap by default — the expensive rung must be a deliberate click, never a fallthrough.
  await expect(page.getByTestId('pass-tier-preview')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('pass-tier-master')).toHaveAttribute('aria-pressed', 'false')
  // And it says what the pass costs before it is started: 1 shot x 5s at 480p.
  await expect(page.getByTestId('pass-tier-preview')).toHaveAttribute('title', /\$0\.35/)
  console.log('[tiers] first pass defaults to preview/480p, priced before the click')

  // The price follows the MODEL, not just the resolution: the same pass on a Seedance
  // 2.5 project is $0.514 (live pricing page, 2026-09-04). Before the table learned
  // about models it quoted 2.5 renders at the 2.0 price, 34 % under what was billed.
  await load(page, seedUnrendered('4k', 'v25'))
  await expect(page.getByTestId('pass-tier-preview')).toHaveAttribute('title', /\$0\.51/)
  console.log('[tiers] a 2.5 project is priced at the 2.5 rate')
})

test('choosing a rung for the pass moves the selection', async ({ page }) => {
  await load(page, seedUnrendered('4k'))

  await page.getByTestId('pass-tier-edit').click()
  await expect(page.getByTestId('pass-tier-edit')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('pass-tier-preview')).toHaveAttribute('aria-pressed', 'false')
  console.log('[tiers] the pass rung is selectable')
})
