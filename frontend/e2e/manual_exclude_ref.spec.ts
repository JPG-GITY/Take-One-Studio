import { test, expect } from './isolation'

// La etapa 5 deja QUITAR una referencia derivada de un plano — "en este plano la jarra no
// viaja" — y la decisión se guarda con el proyecto.
//
// La lista de referencias se arma en un único sitio (`planShot`) y es la que va al POST, la
// que numera los @Image N y la que escribe los roles. Antes era de sólo lectura: se podía
// AÑADIR una imagen, nunca quitar una derivada. Se fija en la RED, que es lo que cuenta: el
// POST del render ya no lleva la excluida y las siguientes se renumeran; y en el STORE: la
// exclusión sobrevive a recargar.

const ROOT = '/tmp/takeone_excluderef'
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })
const board = (sid: string) => ({
  status: 'approved', boardUrl: '', boardLocalPath: `${ROOT}/Shots/${sid}/board.png`,
  version: 1, rows: 1, cols: 1, notes: '',
  panels: [{ label: sid, name: 'Beat', shot_type: 'Wide.', desc: 'a', red: '', blue: '', green: '', orange: '', purple: '' }],
})
const SHEET = `${ROOT}/Assets/Characters/Jane Doe/v001.png`
const ROOM = `${ROOT}/Assets/Environments/THE ROOM/v001.png`
const JAR = `${ROOT}/Assets/Props/Glass jar/v001.png`
const approved = (localPath: string) => ({ status: 'approved', localPath, selectedUrl: localPath, imageUrls: [localPath] })

const SEED = {
  state: {
    projectId: 'excluderef', projectName: 'excluderef', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [
          { id: 'A1', name: 'Jane Doe', type: 'character', visualDescription: 'a woman' },
          { id: 'A2', name: 'THE ROOM', type: 'environment', visualDescription: 'a room' },
          { id: 'A3', name: 'Glass jar', type: 'prop', visualDescription: 'a jar' },
        ],
        shots: [{ id: 'SHOT_001', sceneId: 'SC', action: 'Jane lifts the jar.', visualDescription: 'vd',
          assetsUsed: ['A1', 'A2', 'A3'], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [] }],
        scenes: [{ id: 'SC', heading: 'INT. ROOM - DAY', description: 'd', shotIds: ['SHOT_001'] }],
      }),
      3: stg('approved', { assetStates: { A1: approved(SHEET), A2: approved(ROOM), A3: approved(JAR) } }),
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

type Posted = { reference_images?: Array<{ url?: string }>; ref_addressing?: string[]; dry_run?: boolean }

const load = async (page: import('@playwright/test').Page) => {
  const posted: Posted[] = []
  const dryRuns: Posted[] = []
  await page.route('**/api/video/registry**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }))
  await page.route('**/api/video/create', (route) => {
    const body = route.request().postDataJSON() as Posted
    // La preparación de la dirección es un dry run del mismo POST: se contesta con un
    // prompt y se cuenta aparte. Un render de verdad termina aquí — esto mide QUÉ se envía.
    if (body.dry_run) {
      dryRuns.push(body)
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ assembled_prompt: `PROMPT v${dryRuns.length}`, assembled_negative: 'blurry' }) })
    }
    posted.push(body)
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // `activeStage` no está en `partialize`: se navega como el usuario.
  await page.getByRole('button', { name: /^5$|SG/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  await page.getByTestId('strip-shot-SHOT_001').click({ timeout: 30_000 }).catch(() => {})
  await expect(page.getByTestId('shot-refs')).toBeVisible({ timeout: 30_000 })
  return { posted, dryRuns }
}

test('quitar la jarra: desaparece del POST, las demás se renumeran, y la decisión sobrevive a recargar', async ({ page }) => {
  test.setTimeout(120_000)
  const { posted } = await load(page)
  const list = page.getByTestId('shot-refs')
  // La lista derivada, en su orden: lámina, entorno, tablero, jarra.
  await expect(list).toContainText('Glass jar')
  const items = list.locator('li')
  const n = await items.count()
  const jarIdx = (await items.allTextContents()).findIndex((t) => /Glass jar/.test(t))
  expect(jarIdx).toBeGreaterThanOrEqual(0)
  await page.getByTestId(`shot-refs-exclude-${jarIdx}`).click()
  await expect(list.locator('li')).toHaveCount(n - 1)
  await expect(page.getByTestId('shot-refs-excluded')).toContainText('Glass jar')
  console.log('[exclude] lista tras quitar →', JSON.stringify(await list.locator('li').allTextContents()))

  // Sobrevive a recargar: vive en el store, no en la vista.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /^5$|SG/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  await page.getByTestId('strip-shot-SHOT_001').click({ timeout: 30_000 }).catch(() => {})
  await expect(page.getByTestId('shot-refs-excluded')).toContainText('Glass jar', { timeout: 30_000 })
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('takeone-pipeline-v1') || '{}').state?.shotRefMedia?.SHOT_001?.excluded)
  expect(stored).toEqual(['Assets/Props/Glass jar'])

  // Y en la RED: el POST no lleva la jarra, y sí la lámina, el entorno y el tablero.
  await page.getByRole('button', { name: /Generate All Clips/ }).click({ timeout: 30_000 })
  await expect.poll(() => posted.length, { timeout: 30_000, intervals: [300] }).toBeGreaterThan(0)
  const urls = (posted[0].reference_images ?? []).map((r) => r.url)
  console.log('[exclude] enviadas →', JSON.stringify(urls))
  expect(urls.some((u) => u?.includes('Glass jar'))).toBe(false)
  expect(urls.some((u) => u?.includes('Jane Doe'))).toBe(true)
  expect(urls.some((u) => u?.includes('THE ROOM'))).toBe(true)
  expect(urls.some((u) => u?.includes('board.png'))).toBe(true)
  // Renumeradas: las líneas de rol (`ref_addressing`, de las que el backend escribe
  // [Reference Material Roles]) son exactamente una por imagen enviada, 1..N sin hueco,
  // y ninguna nombra la jarra.
  const roles = posted[0].ref_addressing ?? []
  console.log('[exclude] roles →', JSON.stringify(roles))
  expect(roles.length).toBe(urls.length)
  roles.forEach((line, i) => expect(line).toMatch(new RegExp(`(@Image |<Image_|Image_)${i + 1}\\b`)))
  expect(roles.some((l) => /Glass jar/.test(l))).toBe(false)
})

test('restore devuelve la referencia a la lista', async ({ page }) => {
  test.setTimeout(90_000)
  await load(page)
  const list = page.getByTestId('shot-refs')
  const jarIdx = (await list.locator('li').allTextContents()).findIndex((t) => /Glass jar/.test(t))
  await page.getByTestId(`shot-refs-exclude-${jarIdx}`).click()
  await expect(page.getByTestId('shot-refs-excluded')).toBeVisible()
  await page.getByTestId('shot-refs-restore-0').click()
  await expect(page.getByTestId('shot-refs-excluded')).toHaveCount(0)
  await expect(list).toContainText('Glass jar')
})

test('con la dirección preparada, la × de la tira excluye y el prompt se reconstruye solo', async ({ page }) => {
  test.setTimeout(120_000)
  const { dryRuns } = await load(page)
  await page.getByTestId('prepare-direction-prompt').click({ timeout: 30_000 })
  const panel = page.getByTestId('direction-prompt-panel')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => dryRuns.length, { timeout: 30_000 }).toBe(1)
  // La tira del editor: 4 referencias, la jarra la última.
  await expect(page.getByTestId('direction-prompt-panel-ref-3')).toContainText('Glass jar')
  await page.getByTestId('direction-prompt-panel-ref-remove-3').click()
  // Se reconstruye sin que nadie pulse "Reset to auto": segundo dry run, sin la jarra.
  await expect.poll(() => dryRuns.length, { timeout: 30_000, intervals: [300] }).toBe(2)
  const urls = (dryRuns[1].reference_images ?? []).map((r) => r.url)
  console.log('[strip] segundo dry run →', JSON.stringify(urls))
  expect(urls.some((u) => u?.includes('Glass jar'))).toBe(false)
  expect(urls.length).toBe(3)
  await expect(page.getByTestId('direction-prompt-panel-ref-3')).toHaveCount(0)
  await expect(page.getByTestId('direction-prompt-panel-refs-excluded')).toContainText('Glass jar')
  // Y las dos vistas dicen lo mismo.
  await expect(page.getByTestId('shot-refs-excluded')).toContainText('Glass jar')
  // Restaurar desde la tira: tercer dry run, la jarra vuelve.
  await page.getByTestId('direction-prompt-panel-ref-restore-0').click()
  await expect.poll(() => dryRuns.length, { timeout: 30_000, intervals: [300] }).toBe(3)
  expect((dryRuns[2].reference_images ?? []).some((r) => r.url?.includes('Glass jar'))).toBe(true)
})

test('un prompt editado a mano pregunta antes de reconstruirse', async ({ page }) => {
  test.setTimeout(120_000)
  const { dryRuns } = await load(page)
  await page.getByTestId('prepare-direction-prompt').click({ timeout: 30_000 })
  await expect.poll(() => dryRuns.length, { timeout: 30_000 }).toBe(1)
  const ta = page.getByTestId('direction-prompt-panel').locator('textarea').first()
  await ta.fill('my own words')
  await expect(page.getByTestId('direction-prompt-panel-edited-badge')).toBeVisible()
  // Primero se rechaza: nada se reconstruye y el texto sigue siendo el mío.
  page.once('dialog', (d) => { void d.dismiss() })
  await page.getByTestId('direction-prompt-panel-ref-remove-3').click()
  await page.waitForTimeout(1200)
  expect(dryRuns.length).toBe(1)
  await expect(ta).toHaveValue('my own words')
  // La exclusión sí quedó hecha (es una decisión sobre el plano, no sobre el texto).
  await expect(page.getByTestId('shot-refs-excluded')).toContainText('Glass jar')
  // Ahora se acepta al restaurar: se reconstruye y el texto vuelve a ser el automático.
  page.once('dialog', (d) => { void d.accept() })
  await page.getByTestId('shot-refs-restore-0').click()
  await expect.poll(() => dryRuns.length, { timeout: 30_000, intervals: [300] }).toBe(2)
  await expect(ta).toHaveValue('PROMPT v2')
})

test('añadir un asset del proyecto desde el panel: viaja al final del POST', async ({ page }) => {
  test.setTimeout(120_000)
  // La jarra NO está en el plano: es lo que el director quiere añadir "en su lugar".
  const seed = JSON.parse(JSON.stringify(SEED)) as typeof SEED
  ;(seed.state.stages[2].versions[0].data as { shots: Array<{ assetsUsed: string[] }> }).shots[0].assetsUsed = ['A1', 'A2']
  const posted: Posted[] = []
  await page.route('**/api/video/registry**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }))
  await page.route('**/api/video/create', (route) => {
    const body = route.request().postDataJSON() as Posted
    if (body.dry_run) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assembled_prompt: 'P', assembled_negative: '' }) })
    posted.push(body)
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), seed)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /^5$|SG/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1500)
  await page.getByTestId('strip-shot-SHOT_001').click({ timeout: 30_000 }).catch(() => {})
  // El panel está ABIERTO y dice lo que hace; la fuente del proyecto se ve sin pulsar nada.
  await expect(page.getByText('Add a reference · upload, URL or project')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('ref-project-assets')).toBeVisible()
  await page.getByTestId('ref-project-add-A3').click()
  await expect(page.getByTestId('ref-image-count')).toContainText('1/4')
  // Y en la lista de lo que se envía, al final.
  await expect(page.getByTestId('shot-refs')).toContainText('a reference the director attached')

  await page.getByRole('button', { name: /Generate All Clips/ }).click({ timeout: 30_000 })
  await expect.poll(() => posted.length, { timeout: 30_000, intervals: [300] }).toBeGreaterThan(0)
  const urls = (posted[0].reference_images ?? []).map((r) => r.url)
  console.log('[project-ref] enviadas →', JSON.stringify(urls))
  expect(urls[urls.length - 1]).toContain('Glass jar')
  expect(urls.filter((u) => u?.includes('Glass jar')).length).toBe(1)
})
