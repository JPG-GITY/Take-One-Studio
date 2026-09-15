import { test, expect } from './isolation'

// Etapa 6: "Upscale master" manda el EXPORT a AI MediaKit con lo elegido y presenta el máster.
//
// Se fija en la RED: qué recibe POST /api/edit/upscale (la ruta del export en disco, resolución,
// tier, estilo, preset aigc) y que la respuesta del sondeo acaba como enlace al máster. Y que un
// export 4K nativo, que el vendor no admite (entrada ≤2K), muestra la nota del servidor en vez
// del selector. Todo el backend va stub — no se paga nada y no se toca ningún proyecto.

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, activeVersionId: string, versions: unknown[]) =>
  ({ status, activeVersionId, versions, isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const serve = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`
const shot = (id: string) => ({
  shotId: id, thumbnailUrl: '', videoUrl: serve(`/tmp/upmaster/Shots/${id}/v.mp4`),
  videoLocalPath: `/tmp/upmaster/Shots/${id}/v.mp4`, duration: 5, status: 'approved', renderedResolution: '720p', seed: 1,
})
const SEED = (outputResolution: '1080p' | '4k') => ({
  state: {
    projectId: 'upmaster', projectName: 'upmaster', projectType: 'film', projectStructure: {}, activeStage: 6,
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'x', content: 'y' }, true)]),
      2: stg('approved', 'v1', [ver('v1', { assets: [], shots: [], scenes: [] }, true)]),
      3: stg('approved', 'v1', [ver('v1', { assetStates: {} }, true)]),
      4: stg('approved', 'v1', [ver('v1', { sceneStates: {} }, true)]),
      5: stg('approved', 'v1', [ver('v1', { shots: [shot('SHOT_1'), shot('SHOT_2')] }, true)]),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'cinematic', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution, localFolderRoot: '/tmp/upmaster', approvedShotIds: ['SHOT_1', 'SHOT_2'],
  },
  version: 5,
})

const EXPORT = '/tmp/upmaster/Exports/render_1_1080p.mp4'
const MASTER = '/tmp/upmaster/Exports/render_1_1080p_up4k_standard.mp4'
type Sent = { render_path?: string; resolution?: string; tier?: string; style?: string; scene?: string; project_path?: string }

const setup = async (page: import('@playwright/test').Page, outputResolution: '1080p' | '4k') => {
  const sent: Sent[] = []
  const native4k = outputResolution === '4k'
  await page.route('**/api/edit/render', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ output_path: EXPORT, filename: 'render_1_1080p.mp4', resolution: outputResolution }),
  }))
  await page.route('**/api/studio/upscale/quote', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(native4k
      ? { usd: 5.6, seconds: 203, width: 3840, height: 2160, input_note: 'AI MediaKit takes inputs up to 2K (2560×1440) — this file is 3840×2160. Export at 1080p to upscale it.' }
      : { usd: 0.3323, seconds: 12.063, width: 1920, height: 1080, input_note: '' }),
  }))
  await page.route('**/api/edit/upscale', (r) => {
    sent.push(r.request().postDataJSON() as Sent)
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'm1', seconds: 12.063, estimated_cost_usd: 0.3323, output_path: MASTER, filename: 'render_1_1080p_up4k_standard.mp4' }) })
  })
  await page.route('**/api/edit/upscale/m1', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'completed', task_id: 'm1', output_path: MASTER, filename: 'render_1_1080p_up4k_standard.mp4', resolution: '4k', tier: 'standard', seconds: 12.063, usd: 0.3323, fps: 24 }),
  }))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED(outputResolution))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // `activeStage` no está en `partialize`: se navega como el usuario.
  await page.getByRole('button', { name: /^6$|Final Cut/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /Render Final Cut/ }).click({ timeout: 20_000 })
  await expect(page.getByTestId('upscale-master')).toBeVisible({ timeout: 30_000 })
  return sent
}

test('el máster sale del EXPORT con 4K · Standard · Natural por defecto y queda enlazado con su precio', async ({ page }) => {
  test.setTimeout(90_000)
  const sent = await setup(page, '1080p')
  await expect(page.getByTestId('upscale-master-res-4k')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('upscale-master-tier-standard')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('upscale-master-style-natural')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('upscale-master-quote')).toContainText('$0.33', { timeout: 10_000 })

  await page.getByTestId('upscale-master-run').click()
  await expect.poll(() => sent.length, { timeout: 30_000, intervals: [300] }).toBe(1)
  console.log('[master] enviado →', JSON.stringify(sent[0]))
  expect(sent[0]).toMatchObject({ render_path: EXPORT, resolution: '4k', tier: 'standard', style: 'natural', scene: 'aigc', project_path: '/tmp/upmaster' })

  await expect(page.getByTestId('upscale-master-done')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('upscale-master-link')).toContainText('render_1_1080p_up4k_standard.mp4')
  await expect(page.getByTestId('upscale-master-done')).toContainText('$0.33')
})

test('un export 4K nativo enseña la nota del servidor y no ofrece el selector', async ({ page }) => {
  test.setTimeout(90_000)
  await setup(page, '4k')
  await expect(page.getByTestId('upscale-master-note')).toContainText('up to 2K', { timeout: 10_000 })
  await expect(page.getByTestId('upscale-master-run')).toHaveCount(0)
})
