import { test, expect } from './isolation'

// Continuity mode: a shot opens on the PREVIOUS shot's closing frame so the cut
// matches exactly. Seedance's modes are mutually exclusive — a first frame cannot
// be combined with reference_image — so turning it on must also drop this shot's
// character/board references. Both halves of that trade are asserted here.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`

const PREV_LAST_FRAME_DISK = '/tmp/takeone_chain/Shots/SHOT_001/last_frame.png'
const PREV_LAST_FRAME_CDN = 'https://cdn.example.invalid/expires-in-24h.png'

const mkShot = (id: string) => ({
  id, sceneId: 'SC-001', action: `Action ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: ['ASSET_001'], cameraAngle: 'medium', lighting: 'cool',
  estimatedDuration: 5, dialogue: [],
})
const board = (sid: string) => ({
  status: 'approved', boardUrl: '', boardLocalPath: `/tmp/takeone_chain/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'a', red: '', blue: '', green: '', orange: '', purple: '' }],
})

/** prevReady=false leaves SHOT_001 unrendered, so SHOT_002 has nothing to chain from. */
function seed(prevReady: boolean) {
  const ids = ['SHOT_001', 'SHOT_002']
  return {
    state: {
      projectId: 'chain', projectName: 'chain', projectType: 'film', projectStructure: {}, activeStage: 5,
      stages: {
        1: stg('approved', { concept: 'x', content: 'y' }),
        2: stg('approved', {
          assets: [{ id: 'ASSET_001', name: 'Eli', type: 'character', visualDescription: 'a young man' }],
          shots: ids.map(mkShot),
          scenes: [{ id: 'SC-001', heading: 'INT. LAB - NIGHT', description: 'd', shotIds: ids }],
        }),
        // The character must be APPROVED or Stage 5's hard asset gate blocks every
        // shot before mode selection is ever reached.
        3: stg('approved', { assetStates: { ASSET_001: {
          status: 'approved', localPath: '/tmp/takeone_chain/Assets/eli.png',
        } } }),
        4: stg('approved', {
          sceneStates: { 'SC-001': { status: 'approved', qcResult: null, notes: '',
            shotBoards: Object.fromEntries(ids.map((id) => [id, board(id)])) } },
        }),
        5: stg('pending_review', {
          shots: [
            {
              shotId: 'SHOT_001', thumbnailUrl: '', duration: 5,
              status: prevReady ? 'ready' : 'queued',
              videoUrl: prevReady ? serve('/tmp/takeone_chain/Shots/SHOT_001/video_v1.mp4') : '',
              tier: 'preview', renderedResolution: '480p',
              // Both are present: the chain must prefer the DISK path, because the
              // CDN url expires in ~24h and a project reopened tomorrow would chain
              // from a dead link.
              ...(prevReady ? { lastFrameLocalPath: PREV_LAST_FRAME_DISK, lastFrameUrl: PREV_LAST_FRAME_CDN } : {}),
            },
            {
              shotId: 'SHOT_002', thumbnailUrl: '', duration: 5, status: 'ready',
              videoUrl: serve('/tmp/takeone_chain/Shots/SHOT_002/video_v1.mp4'),
              tier: 'preview', renderedResolution: '480p',
            },
          ],
        }),
        6: idle(),
      },
      style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
      targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '1080p',
      localFolderRoot: '/tmp/takeone_chain', approvedShotIds: [],
    },
    version: 5,
  }
}

/** Capture the /api/video/create body without ever reaching Seedance. */
async function captureCreate(page: import('@playwright/test').Page) {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/video/create', async (r) => {
    bodies.push(JSON.parse(r.request().postData() ?? '{}'))
    await r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ task_id: 'task-chain-1', assembled_prompt: 'p' }) })
  })
  await page.route('**/api/video/poll/**', (r) => r.fulfill({ status: 200,
    contentType: 'application/json', body: JSON.stringify({ status: 'running' }) }))
  return bodies
}

const load = async (page: import('@playwright/test').Page, s: unknown) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), s)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
}

const modeOf = (page: import('@playwright/test').Page, shotId: string) =>
  page.evaluate((sid) => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s5 = st.state.stages['5']
    const v = s5.versions.find((v: { id: string }) => v.id === s5.activeVersionId) ?? s5.versions.at(-1)
    return (v?.data?.shots as Array<{ shotId: string; mode?: string }>)?.find((s) => s.shotId === sid)?.mode ?? null
  }, shotId)

test('the toggle switches a shot into continuity mode', async ({ page }) => {
  await load(page, seed(true))
  await page.getByTestId('strip-shot-SHOT_002').click()
  await page.waitForTimeout(400)

  const toggle = page.getByTestId('continuity-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect.poll(() => modeOf(page, 'SHOT_002'), { timeout: 5000, intervals: [200] }).toBe('continuity')

  // ...and back off, without stranding the shot in a dead mode.
  await toggle.uncheck()
  await expect.poll(() => modeOf(page, 'SHOT_002'), { timeout: 5000, intervals: [200] }).toBe('storyboard')
  console.log('[continuity] toggle on → continuity, off → storyboard')
})

test('a chained shot opens on the previous shot\'s DISK frame and sends no references', async ({ page }) => {
  const bodies = await captureCreate(page)
  await load(page, seed(true))
  await page.getByTestId('strip-shot-SHOT_002').click()
  await page.waitForTimeout(400)
  await page.getByTestId('continuity-toggle').check()
  await page.waitForTimeout(300)

  await page.getByTestId('regenerate-with-comments').click()
  await expect.poll(() => bodies.length, { timeout: 15_000, intervals: [300] }).toBeGreaterThan(0)

  const body = bodies[0]
  // The first frame is the previous shot's closing frame — the disk copy, not the
  // CDN url that expires in a day.
  expect(String(body.image_url)).toContain('last_frame.png')
  expect(String(body.image_url)).not.toContain('cdn.example.invalid')
  // And the trade is honoured: no reference images alongside a first frame.
  expect((body.reference_images as unknown[] | undefined) ?? []).toHaveLength(0)
  console.log('[continuity] chained from disk frame, zero reference images')
})

test('a shot with nothing to chain from refuses instead of rendering blind', async ({ page }) => {
  const bodies = await captureCreate(page)
  await load(page, seed(false))          // SHOT_001 never rendered
  await page.getByTestId('strip-shot-SHOT_002').click()
  await page.waitForTimeout(400)
  await page.getByTestId('continuity-toggle').check()
  await page.waitForTimeout(300)

  await page.getByTestId('regenerate-with-comments').click()
  await page.waitForTimeout(2500)

  // Nothing was submitted — rendering with neither a first frame nor references
  // would be the worst of both trades, so it must not happen silently.
  expect(bodies).toHaveLength(0)
  await expect(page.getByText(/Cannot chain SHOT_002/i)).toBeVisible()
  console.log('[continuity] refused with no previous frame, nothing submitted')
})
