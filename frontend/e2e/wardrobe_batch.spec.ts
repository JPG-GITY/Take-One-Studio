import { test, expect } from './isolation'

// Un vestuario en lote tiene que esperar a su personaje — y decirlo.
//
// Una variante de vestuario (`parentCharacterId`) no es un text-to-image nuevo: es la edición
// i2i de la lámina APROBADA de su personaje, que es lo que conserva la cara y la cadena de
// confianza biométrica. A mano el despachador lo sabe y avisa "Approve X first". El lote no
// pasaba por el despachador: su filtro sólo miraba `dependsOn` (otra dependencia distinta), la
// variante entraba en la cola y el worker la mandaba por el prompt t2i — otra cara, sin aviso.
//
// Se fija en la RED: qué endpoint recibe la variante, y cuándo.

const ROOT = '/tmp/takeone_wardrobe'
const BASE_URL = `${ROOT}/Assets/Characters/Eli/v001.png`
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 'wardrobe', projectName: 'wardrobe', projectType: 'film', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [
          { id: 'A1', name: 'Eli', type: 'character', visualDescription: 'a young man' },
          // La variante: mismo tipo, con padre. Sin imágenes todavía.
          { id: 'A2', name: 'Eli · Day Clothes', type: 'character', visualDescription: 'Eli in day clothes',
            parentCharacterId: 'A1', wardrobe: 'denim jacket, white tee' },
        ],
        shots: [], scenes: [],
      }),
      // El padre tiene imágenes pero NO está aprobado: la variante debe esperar.
      3: stg('pending_review', {
        assetStates: {
          A1: { status: 'pending', localPath: BASE_URL, selectedUrl: BASE_URL, imageUrls: [BASE_URL] },
        },
      }),
      4: idle(), 5: idle(), 6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '1080p',
    localFolderRoot: ROOT, approvedShotIds: [],
  },
  version: 5,
}

type Posted = { t2i: string[]; edit: Array<{ tool?: string; base_image?: string }> }

const load = async (page: import('@playwright/test').Page): Promise<Posted> => {
  const posted: Posted = { t2i: [], edit: [] }
  await page.route('**/api/assets/generate-async', (r) => {
    posted.t2i.push(r.request().postData() ?? '')
    return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  await page.route('**/api/assets/edit', (r) => {
    const b = r.request().postDataJSON() as { tool?: string; base_image?: string }
    posted.edit.push({ tool: b.tool, base_image: b.base_image })
    return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  // Aprobar guarda la versión y pide ángulos/headshot: todo eso se contesta sin escribir.
  await page.route('**/api/asset/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ local_path: BASE_URL, url: BASE_URL, version: 1 }) }))
  await page.route('**/api/assets/**', (r) => {
    const u = r.request().url()
    if (/generate-async|\/edit$/.test(u)) return r.fallback()
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  // Registradas DESPUÉS del catch-all para ganar (Playwright prueba la más reciente primero),
  // y con la FORMA real de cada respuesta. Un personaje pasa por board-prompt y lee
  // `data.board_prompt`; con el `{ok:true}` del catch-all salía undefined, la tarjeta
  // montaba <PromptPanel value={undefined}> y la etapa entera caía con "Cannot read
  // properties of undefined (reading 'trim')" — un fallo del stub, no de la app.
  await page.route('**/api/assets/doctor-prompt', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ doctored_prompt: 'a young man, character sheet', raw: 'a young man', assembled_prompt: 'a young man, character sheet, cinematic' }) }))
  await page.route('**/api/assets/board-prompt', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ board_prompt: 'IDENTITY BOARD — a young man, four views, cinematic' }) }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /^3$|AG/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  return posted
}

test('en lote, un vestuario con padre sin aprobar no se genera, y el aviso lo nombra', async ({ page }) => {
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)) })
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String((e as Error).stack ?? e).split('\n').slice(0, 7).join(' ⏎ ')))
  const posted = await load(page)
  const btn = page.getByRole('button', { name: /Generate All \(\d+\)|Generate \d+ remaining/ })
  await btn.click({ timeout: 30_000 })
  await page.waitForTimeout(2500)
  console.log('[wardrobe] errores:', JSON.stringify(errs.slice(0, 5)))
  console.log(`[wardrobe] t2i=${posted.t2i.length} · edit=${posted.edit.length} · t2i ids=${JSON.stringify(posted.t2i.map((b) => (b.match(/"asset_id":"([^"]+)"/) ?? [])[1]))}`)

  // El aviso, con el nombre de la variante y el porqué.
  await expect(page.getByText(/wardrobe look\(s\) wait for their character/)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/Eli · Day Clothes/).first()).toBeVisible()

  // Y en la red: NADA para la variante, por ningún camino.
  const t2iForVariant = posted.t2i.filter((b) => /Day Clothes|"A2"/.test(b))
  console.log(`[wardrobe] t2i=${posted.t2i.length} (variante: ${t2iForVariant.length}) · edit=${posted.edit.length}`)
  expect(t2iForVariant).toHaveLength(0)
  expect(posted.edit).toHaveLength(0)
})

test('aprobar al personaje dispara su vestuario como edición i2i de la lámina aprobada', async ({ page }) => {
  const posted = await load(page)
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)) })
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e).slice(0, 160)))
  // La tarjeta del padre ya está abierta con su variación seleccionada; se aprueba.
  await page.getByRole('button', { name: /Approve Identity Board/ }).click({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  if (errs.length) console.log('[wardrobe] errores:', JSON.stringify(errs.slice(0, 4)))

  await expect.poll(() => posted.edit.length, { timeout: 30_000, intervals: [300] }).toBeGreaterThan(0)
  console.log('[wardrobe] edit →', JSON.stringify(posted.edit))
  const call = posted.edit[0]
  expect(call.tool).toBe('wardrobe')
  expect(call.base_image).toContain('Assets/Characters/Eli/v001.png')
  // Y sigue sin pasar por el prompt t2i.
  expect(posted.t2i.filter((b) => /Day Clothes|"A2"/.test(b))).toHaveLength(0)
})
