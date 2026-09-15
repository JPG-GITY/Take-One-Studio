import { test, expect } from './isolation'

// Las referencias que el director elige a mano tienen que LLEGAR a la petición.
//
// La etapa 5 derivaba su lista entera —láminas, entorno, tablero, props—, la recortaba en
// silencio al tope del modelo y la enviaba sin enseñársela a nadie. `SceneReviewPanel` ya
// recibía `refMedia` y `onRefMediaChange` desde hacía tiempo, pero su firma no las
// desestructuraba, así que se caían al suelo: no había forma de añadir, quitar ni siquiera
// VER lo que se adjuntaba a un render que estaba a punto de pagarse.
//
// Este spec fija las dos mitades: la lista se ve, y lo que el usuario adjunta viaja de
// verdad en el POST — comprobado en la RED, no en el estado.

const ROOT = '/tmp/takeone_manualrefs'
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
// Un plano sin tablero no es rodable, y sin eso la etapa no ofrece el botón de generar.
const board = (sid: string) => ({
  status: 'approved', boardUrl: '', boardLocalPath: `${ROOT}/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'a', red: '', blue: '', green: '', orange: '', purple: '' }],
})

const SEED = {
  state: {
    projectId: 'manualrefs', projectName: 'manualrefs', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [],
        shots: [{ id: 'SHOT_001', sceneId: 'SC', action: 'A man sits down.', visualDescription: 'vd',
          assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [] }],
        scenes: [{ id: 'SC', heading: 'INT. ROOM - DAY', description: 'd', shotIds: ['SHOT_001'] }],
      }),
      3: stg('approved', { assetStates: {} }),
      4: stg('approved', { sceneStates: { SC: { status: 'approved', qcResult: null, notes: '',
        shotBoards: { SHOT_001: board('SHOT_001') } } } }),
      5: stg('pending_review', {
        shots: [{ shotId: 'SHOT_001', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued' }],
      }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '1080p',
    localFolderRoot: ROOT, approvedShotIds: [],
  },
  version: 5,
}

const load = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/video/registry**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
}

test('el panel de referencias de un plano existe y es operable', async ({ page }) => {
  await load(page)
  await page.getByTestId('strip-shot-SHOT_001').click({ timeout: 30_000 })
  // La sección se muestra SIEMPRE, no detrás de un interruptor: componer antes de generar
  // es el trabajo, no una opción avanzada.
  await expect(page.getByTestId('shot-references')).toBeVisible({ timeout: 30_000 })
})

test('una referencia adjuntada a mano viaja en el POST del render', async ({ page }) => {
  const MINE = 'https://example.invalid/mi-referencia.png'
  const posted: Array<{ url?: string }> = []
  await page.route('**/api/video/create', async (route) => {
    const b = route.request().postDataJSON() as { reference_images?: Array<{ url?: string }> }
    posted.push(...(b.reference_images ?? []))
    // Termina aquí: esto mide QUÉ se envía, no el render.
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  await load(page)

  // Sembrada como la deja un director que YA compuso sus referencias: en el store, que
  // es donde viven desde que dejaron de ser estado de una vista. Antes esto no se podía
  // hacer — se perdían al recargar — y ese era el defecto, no una dificultad del test.
  await page.evaluate((url) => {
    const raw = JSON.parse(localStorage.getItem('takeone-pipeline-v1') || '{}')
    raw.state.shotRefMedia = { SHOT_001: { images: [{ url, role: 'reference_image' }], videos: [], audio: null } }
    localStorage.setItem('takeone-pipeline-v1', JSON.stringify(raw))
  }, MINE)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  // `activeStage` no está en `partialize`, así que tras recargar la app abre en la etapa 1
  // — se navega a la 5 como haría el usuario, en vez de forzar el estado.
  await page.getByRole('button', { name: /^5$|SG/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  await page.getByTestId('strip-shot-SHOT_001').click({ timeout: 30_000 }).catch(() => {})
  await page.getByRole('button', { name: /Generate All Clips/ }).click({ timeout: 30_000 })
  await expect.poll(() => posted.length, { timeout: 30_000, intervals: [300] }).toBeGreaterThan(0)
  console.log('[manualrefs] enviadas →', JSON.stringify(posted.map((p) => p.url)))
  expect(posted.some((p) => p.url === MINE)).toBe(true)
})
