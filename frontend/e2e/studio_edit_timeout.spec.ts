import { test, expect } from './isolation'

// Un timeout del NAVEGADOR no puede perder una toma ya pagada.
//
// Edit y Extend del Studio son renders completos de Seedance y pasan de largo el techo de 10
// minutos del cliente: axios aborta con "timeout of 600000ms exceeded" mientras el SERVIDOR
// sigue sondeando hasta su propio límite (~70 min), guarda la toma en Shots/<clipId>/ y cierra
// el registro. Antes eso se mostraba como un error y la toma quedaba en disco, pagada e
// invisible. Ahora el Studio se pone a vigilar el disco y la adopta cuando aparece.
//
// Se fija en la RED: el POST del render falla como falla de verdad, y el de recuperación es
// el que trae la toma.

const ROOT = '/tmp/takeone_edittimeout'
const CLIP = `${ROOT}/Studio/Videos/studio_video_0001.mp4`
const TAKE = `${ROOT}/Shots/Studio_x/video_v001.mp4`
const SERVED = `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(CLIP)}`

const ITEM = {
  id: 'clip1', kind: 'video', prompt: 'a woman turns toward the window', model: 'Seedance 2.0',
  imageUrls: [], videoUrl: SERVED, audioUrl: null, posterUrl: null, refImages: [], createdAt: Date.now(),
  params: { mode: 't2v', ratio: '16:9', resolution: '720p', duration: 5, tier: 'base', genAudio: true },
  videoLocalPath: CLIP,
}

const setup = async (page: import('@playwright/test').Page, opts: { recovers: boolean }) => {
  const calls = { edit: 0, recover: 0 }
  // El render muere como muere de verdad: el timeout de axios.
  await page.route('**/api/shot/edit', (r) => { calls.edit++; return r.abort('timedout') })
  await page.route('**/api/shot/extend-recover', (r) => {
    calls.recover++
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(opts.recovers
        ? { video_path: TAKE, duration: 5.0, added_seconds: 0, thumbnail_path: '', last_frame_local_path: `${TAKE}.lastframe.png` }
        : { video_path: '', duration: 0, added_seconds: 0, thumbnail_path: '' }),
    })
  })
  // La duración del clip fuente se mide en el navegador; sin un fichero real devuelve 0,
  // así que el probe del backend es el que contesta.
  await page.route('**/api/asset/duration**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ duration: 5 }) }))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-studio-v1', JSON.stringify(v)), { state: { items: [ITEM] }, version: 1 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByTestId('studio-toggle').click({ timeout: 20_000 })
  await page.waitForTimeout(1200)
  return calls
}

const runEdit = async (page: import('@playwright/test').Page) => {
  await page.getByTestId('studio-vedit-clip1').click({ timeout: 20_000 })
  await page.getByTestId('studio-vedit-note').fill('add three ships on the horizon')
  await page.getByTestId('studio-video-action-run').click()
}

test('el render sobrevive al timeout: la toma guardada se adopta y entra en la galería', async ({ page }) => {
  test.setTimeout(90_000)
  const calls = await setup(page, { recovers: true })
  await runEdit(page)

  // La toma entra sola, sin volver a pedir un render. (El aviso "sigue renderizando" no se
  // afirma aquí a propósito: con la toma ya en disco se sustituye por la tarjeta en el acto,
  // que es justo lo que debe pasar — el aviso se mide en el segundo test, donde permanece.)
  await expect(page.getByText(/add three ships on the horizon/).first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => calls.recover, { timeout: 20_000 }).toBeGreaterThan(0)
  console.log('[edit-timeout] renders pedidos:', calls.edit, '· recuperaciones:', calls.recover)
  expect(calls.edit).toBe(1)          // NUNCA se vuelve a pagar
})

test('si no hay nada que recuperar, lo dice en vez de fingir que se perdió', async ({ page }) => {
  test.setTimeout(90_000)
  const calls = await setup(page, { recovers: false })
  await runEdit(page)
  await expect(page.getByText(/still rendering on the server/)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => calls.recover, { timeout: 20_000 }).toBeGreaterThan(0)
  expect(calls.edit).toBe(1)
})
