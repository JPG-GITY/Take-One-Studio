import { test, expect } from './isolation'

// The closing frame of the previous shot is what carries the SPATIAL state of a scene
// from one clip to the next — the text carry says what happened, not where anything is.
// planShot attaches it only when that previous shot is already `ready` with a
// lastFrameUrl, and it reads that from `shotsRef.current`, which a useEffect fills from
// `shots` AFTER React commits. Inside a chained pass the next shot plans before that
// commit, so the gate saw the previous shot still `animating` and attached nothing.
//
// Measured on BLACK MIRROR V3 before the fix: the closing frame existed on disk for all
// three cuts of the bedroom scene and reached none of the three prompts (5 of 16 across
// two films). On screen that is a man and his bedside table on the other side of the bed
// between two shots with nothing showing the move.
//
// This spec renders nothing — create/poll/save/QC are all stubbed — so it is free, and
// the instant stubs make the race MORE likely to fire, not less.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const IDS = ['SHOT_001', 'SHOT_002', 'SHOT_003']
const lastFrameOf = (taskId: string) => `https://cdn.example.invalid/closing-${taskId}.png`

const mkShot = (id: string) => ({
  id, sceneId: 'SC-001', action: `Action ${id}`, visualDescription: `vd ${id}`,
  assetsUsed: ['ASSET_001'], cameraAngle: 'medium', lighting: 'cool',
  estimatedDuration: 5, dialogue: [],
})

const seed = () => ({
  state: {
    projectId: 'carry', projectName: 'carry', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [{ id: 'ASSET_001', name: 'Eli', type: 'character', visualDescription: 'a young man' }],
        shots: IDS.map(mkShot),
        scenes: [{ id: 'SC-001', heading: 'INT. BEDROOM - DAWN', description: 'd', shotIds: IDS }],
      }),
      // Approved or Stage 5's asset gate blocks the pass before any mode is chosen.
      3: stg('approved', { assetStates: { ASSET_001: {
        status: 'approved', localPath: '/tmp/takeone_carry/Assets/eli.png',
      } } }),
      // Stage 5's second hard gate wants every shot's board APPROVED, and it checks the
      // status alone. Leaving each board without a path keeps shotBoardMap empty, so the
      // pass runs in plain storyboard mode with no board image — which is not what this
      // spec measures and would only add a reference to reason about.
      4: stg('approved', { sceneStates: { 'SC-001': {
        status: 'approved', qcResult: null, notes: '',
        shotBoards: Object.fromEntries(IDS.map((id) => [id, { status: 'approved' }])),
      } } }),
      5: stg('pending_review', {
        shots: IDS.map((shotId) => ({
          shotId, thumbnailUrl: '', duration: 5, status: 'queued',
          videoUrl: '', tier: 'preview', renderedResolution: '480p',
        })),
      }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '720p',
    localFolderRoot: '/tmp/takeone_carry', approvedShotIds: [],
  },
  version: 5,
})

/** Every wire the render path touches, answered locally: nothing is submitted to
 *  Seedance and no QC verdict is billed. Returns the captured create bodies. */
async function stubRenderWires(page: import('@playwright/test').Page) {
  const bodies: Array<Record<string, unknown>> = []
  await page.route('**/api/finalscene/qc', (r) => r.fulfill({ status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ passed: true, checks: [], summary: 'stub', persona: 'stub' }) }))
  await page.route('**/api/shot/save-video', (r) => r.fulfill({ status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ local_path: '/tmp/takeone_carry/v.mp4', last_frame_local_path: '' }) }))
  await page.route('**/api/video/poll/**', (r) => {
    const taskId = r.request().url().split('/').pop() ?? ''
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'completed', seed: 1, resolution: '720p',
        video_url: `https://cdn.example.invalid/${taskId}.mp4`,
        last_frame_url: lastFrameOf(taskId) }) })
  })
  await page.route('**/api/video/create', async (r) => {
    const body = JSON.parse(r.request().postData() ?? '{}')
    bodies.push(body)
    await r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ task_id: `task-${bodies.length}`, assembled_prompt: 'p' }) })
  })
  return bodies
}

test('a chained pass carries each shot\'s closing frame into the next prompt', async ({ page }) => {
  test.setTimeout(180_000)
  const bodies = await stubRenderWires(page)

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), seed())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  const go = page.getByRole('button', { name: /Generate All Clips \(\d+\)/ })
  await expect(go).toBeVisible({ timeout: 30_000 })
  await go.click({ timeout: 20_000 })

  // pollUntilDone sleeps 5s before its first poll, so three sequential shots need ~15s.
  await expect.poll(() => bodies.length, { timeout: 150_000, intervals: [500] }).toBe(3)

  // The first shot has nothing before it — it must NOT invent a continuity reference.
  const addressingOf = (i: number) => ((bodies[i].ref_addressing as string[] | undefined) ?? []).join('\n')
  expect(addressingOf(0)).not.toMatch(/closing frame of the shot immediately before/i)

  // Every later shot in the same scene carries the previous shot's closing frame, both
  // as an attached image and as the line that tells the model what to do with it.
  for (let i = 1; i < 3; i++) {
    const images = (bodies[i].reference_images as Array<{ url: string; kind?: string }> | undefined) ?? []
    expect(images.map((r) => r.url), `shot ${i + 1} must attach the previous closing frame`)
      .toContain(lastFrameOf(`task-${i}`))
    expect(addressingOf(i), `shot ${i + 1} must address it`)
      .toMatch(/closing frame of the shot immediately before/i)
    // The frame must arrive DECLARED. It is the only reference with no disk path to
    // classify it by, so the backend used to recover its role from the wording of the
    // addressing line — and rewriting that sentence silently un-classified it: the model
    // then got the picture under a bare label, with none of the CONTINUITY role text that
    // tells it the camera moved and the room did not. Nothing failed; the clips just
    // stopped matching (BLACK MIRROR V3 SHOT_008/SHOT_014).
    expect(images.find((r) => r.url === lastFrameOf(`task-${i}`))?.kind,
      `shot ${i + 1} must declare the frame as continuity, not leave it to be guessed`)
      .toBe('continuity')
  }
  console.log('[carry] closing frame reached 2 of 2 eligible prompts')
})
