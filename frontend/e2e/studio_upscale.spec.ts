import { test, expect } from './isolation'

// Studio: "Upscale" manda un clip a AI MediaKit con lo que el director eligió, y el resultado
// entra en la galería como una tarjeta nueva.
//
// Se fija en la RED, que es lo único que importa: qué recibe POST /api/studio/upscale (fuente en
// DISCO cuando la hay, resolución, tier, estilo, preset aigc, y el proyecto donde el SERVIDOR
// guardará el clip) y que la respuesta del sondeo acaba como tarjeta con su precio. Todo el
// backend va stub — no se paga nada y no se toca ningún proyecto.
//
// El servidor es quien espera al vendor: el cliente sólo pregunta. Por eso una tarea pendiente
// sobrevive a una recarga — el último test la siembra ya persistida y espera la tarjeta sin
// pulsar nada. Antes el cliente se rendía a los 30 minutos ("Upscale timed out") y un clip
// pagado se perdía.

const ROOT = '/tmp/takeone_upscale'
const CLIP = `${ROOT}/Studio/Videos/studio_video_0001.mp4`
const OUT = `${ROOT}/Studio/Videos/studio_video_0002.mp4`
const SERVED = `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(CLIP)}`

const VIDEO_ITEM = {
  id: 'clip1', kind: 'video', prompt: 'a woman turns toward the window', model: 'Seedance 2.0',
  imageUrls: [], videoUrl: SERVED, audioUrl: null, posterUrl: null, refImages: [], createdAt: Date.now(),
  params: { mode: 't2v', ratio: '16:9', resolution: '720p', duration: 5, tier: 'base', genAudio: true },
  videoLocalPath: CLIP,
}

type Sent = { video?: string; resolution?: string; tier?: string; scene?: string; style?: string; duration_secs?: number; project_name?: string; project_path?: string }

const DONE = { status: 'completed', task_id: 'up1', kind: 'studio', local_path: OUT, filename: 'studio_video_0002.mp4', bytes: 1, resolution: '4k', fps: 24, tool_version: 'standard', seconds: 10, usd: 0.2755, tier: 'standard', elapsed: 168 }

const setup = async (page: import('@playwright/test').Page, seed: unknown) => {
  const sent: Sent[] = []
  let saves = 0
  await page.route('**/api/studio/upscale/quote', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ usd: 0.2755, coefficient: 8, base_usd_per_min: 0.2066, seconds: 0 }),
  }))
  await page.route('**/api/studio/upscale', (r) => {
    sent.push(r.request().postDataJSON() as Sent)
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_id: 'up1', seconds: 10, estimated_cost_usd: 0.2755 }) })
  })
  await page.route('**/api/studio/upscale/up1', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DONE) }))
  await page.route('**/api/studio/save', (r) => { saves++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ local_path: OUT }) }) })
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-studio-v1', JSON.stringify(v)), seed)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByTestId('studio-toggle').click({ timeout: 20_000 })
  await page.waitForTimeout(1200)
  return { sent, saves: () => saves }
}

test('Upscale envía el clip de disco con 4K · Standard · HD por defecto y crea la tarjeta con su precio', async ({ page }) => {
  const { sent, saves } = await setup(page, { state: { items: [VIDEO_ITEM] }, version: 1 })
  await page.getByTestId('studio-upscale-clip1').click({ timeout: 20_000 })
  await expect(page.getByTestId('studio-video-action')).toBeVisible()
  // Los defaults, visibles antes de pagar.
  await expect(page.getByTestId('studio-upscale-res-4k')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('studio-upscale-tier-standard')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('studio-upscale-style-hd')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('studio-upscale-quote')).toContainText('$0.28', { timeout: 10_000 })

  await page.getByTestId('studio-video-action-run').click()
  await expect.poll(() => sent.length, { timeout: 30_000, intervals: [300] }).toBe(1)
  console.log('[upscale] enviado →', JSON.stringify(sent[0]))
  expect(sent[0].video).toBe(CLIP)                    // la fuente es el fichero en DISCO, no la url
  expect(sent[0]).toMatchObject({ resolution: '4k', tier: 'standard', style: 'hd', scene: 'aigc', project_name: '_studio', project_path: '' })

  // El resultado es una tarjeta nueva, con el precio real y sin las acciones de render.
  await expect(page.getByText(/AI MediaKit · Standard 4K/).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/10\.0s · \$0\.27/).first()).toBeVisible()   // 0.2755 → toFixed(3) = "0.275" (binary rounding)
  // El servidor ya lo guardó en disco: el cliente no vuelve a guardarlo.
  await page.waitForTimeout(800)
  expect(saves()).toBe(0)
  // Y ya no queda nada pendiente.
  await expect(page.getByTestId(/studio-upscale-pending-/)).toHaveCount(0)
})

test('8K · Professional · Natural viaja tal cual', async ({ page }) => {
  const { sent } = await setup(page, { state: { items: [VIDEO_ITEM] }, version: 1 })
  await page.getByTestId('studio-upscale-clip1').click({ timeout: 20_000 })
  await page.getByTestId('studio-upscale-res-8k').click()
  await page.getByTestId('studio-upscale-tier-professional').click()
  await page.getByTestId('studio-upscale-style-natural').click()
  await page.getByTestId('studio-video-action-run').click()
  await expect.poll(() => sent.length, { timeout: 30_000, intervals: [300] }).toBe(1)
  console.log('[upscale] enviado →', JSON.stringify(sent[0]))
  expect(sent[0]).toMatchObject({ video: CLIP, resolution: '8k', tier: 'professional', style: 'natural', scene: 'aigc' })
})

test('una tarea pendiente sobrevive a la recarga: se reanuda sola y acaba en tarjeta', async ({ page }) => {
  const pending = { id: 'pend1', taskId: 'up1', sourceId: 'clip1', prompt: 'a woman turns toward the window', model: 'AI MediaKit · Standard 4K', ratio: '16:9', posterUrl: null, params: { resolution: '4k', tier: 'standard', style: 'hd' }, startedAt: Date.now() - 90_000 }
  const { sent } = await setup(page, { state: { items: [VIDEO_ITEM], pendingUpscales: [pending] }, version: 1 })
  // Nadie pulsa nada: la tarjeta del resultado aparece porque el sondeo se reanudó al montar.
  await expect(page.getByText(/AI MediaKit · Standard 4K/).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('studio-upscale-pending-pend1')).toHaveCount(0)
  expect(sent.length).toBe(0)                         // y no se volvió a enviar (ni a pagar)
})
