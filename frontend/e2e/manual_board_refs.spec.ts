import { test, expect } from './isolation'

// Con qué se dibuja un tablero: verlo, y poder cambiarlo.
//
// La etapa 4 elegía las referencias del tablero entera en el servidor, las recortaba al tope
// y las enviaba sin enseñárselas a nadie. `/api/storyboard/assemble` —el ensayo cuyo trabajo
// entero es "enséñame lo que vas a hacer"— devolvía prompt y viñetas y ni una imagen, y la
// única huella era una línea de log que llegaba DESPUÉS de pagar el tablero.
//
// Se fija lo mismo que en la etapa 5: la lista se ve, y lo que el director adjunta viaja de
// verdad en el POST — comprobado en la RED, no en el estado.

const ROOT = '/tmp/takeone_boardrefs'
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 'boardrefs', projectName: 'boardrefs', projectType: 'film', projectStructure: {}, activeStage: 4,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [{ id: 'A1', name: 'Jane Doe', type: 'character', visualDescription: 'a woman' }],
        shots: [{ id: 'SHOT_001', sceneId: 'SC', action: 'She sits down.', visualDescription: 'vd',
          assetsUsed: ['A1'], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [] }],
        scenes: [{ id: 'SC', heading: 'INT. ROOM - DAY', description: 'd', shotIds: ['SHOT_001'] }],
      }),
      3: stg('approved', { assetStates: { A1: { status: 'approved', localPath: `${ROOT}/Assets/Characters/Jane Doe/v001.png` } } }),
      4: stg('pending_review', { sceneStates: {} }),
      5: idle(),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '1080p',
    localFolderRoot: ROOT, approvedShotIds: [],
  },
  version: 5,
}

/** La respuesta del ensayo, con la forma real: prompt + las referencias que usaría. */
const ASSEMBLE = {
  scene_id: 'SC',
  max_refs: 6,
  items: [{
    shot_id: 'SHOT_001', prompt: 'un prompt de tablero', auto_prompt: 'un prompt de tablero',
    beats: [], rows: 1, cols: 1, width: 1024, height: 576,
    references: [
      { label: 'Jane Doe', url: `${ROOT}/Assets/Characters/Jane Doe/v001.png`, source: 'derived', dropped: false },
      { label: 'THE ROOM (angle sheet)', url: `${ROOT}/Assets/Environments/THE ROOM/Angles/v001.png`, source: 'derived', dropped: false },
      { label: 'Coffee Mug', url: `${ROOT}/Assets/Props/Coffee Mug/v001.png`, source: 'derived', dropped: true },
    ],
  }],
}

const load = async (page: import('@playwright/test').Page) => {
  await page.route('**/api/storyboard/assemble', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(ASSEMBLE) }))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // `activeStage` no está en `partialize`, así que tras recargar la app abre en la etapa 1.
  await page.getByRole('button', { name: /^4$|Storyboard/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1200)
  await page.getByTestId('board-prompt-btn-SHOT_001').click({ timeout: 30_000 })
}

test('la tarjeta del tablero dice con qué se va a dibujar, y qué se quedó fuera', async ({ page }) => {
  await load(page)
  await expect(page.getByTestId('board-references-SHOT_001')).toBeVisible({ timeout: 30_000 })
  // Lo que entra, en el orden en que se envía.
  await expect(page.getByTestId('board-refs-SHOT_001')).toContainText('Jane Doe')
  await expect(page.getByTestId('board-refs-SHOT_001')).toContainText('THE ROOM (angle sheet)')
  // Y lo que NO entra, que es lo que antes desaparecía sin dejar rastro.
  const dropped = page.getByTestId('board-refs-dropped-SHOT_001')
  await expect(dropped).toContainText('Coffee Mug')
  await expect(dropped).toContainText('over the 6 limit')
})

test('una referencia adjuntada a mano viaja en el POST del tablero', async ({ page }) => {
  const MINE = 'https://example.invalid/mi-referencia.png'
  const posted: Array<{ extra_refs?: string[]; exclude_refs?: string[] }> = []
  await page.route('**/api/storyboard/generate', async (route) => {
    const b = route.request().postDataJSON() as { shots?: Array<{ extra_refs?: string[]; exclude_refs?: string[] }> }
    posted.push(...(b.shots ?? []))
    // Termina aquí: esto mide QUÉ se envía, no el tablero.
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'stub' }) })
  })
  await load(page)

  // Sembrada como la deja un director que ya compuso: en el store, que es donde viven.
  await page.evaluate((url) => {
    const raw = JSON.parse(localStorage.getItem('takeone-pipeline-v1') || '{}')
    raw.state.boardRefMedia = { SHOT_001: { images: [{ url, role: 'reference_image' }], videos: [], audio: null } }
    localStorage.setItem('takeone-pipeline-v1', JSON.stringify(raw))
  }, MINE)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: /^4$|Storyboard/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1200)
  await page.getByTestId('board-prompt-btn-SHOT_001').click({ timeout: 30_000 })

  // Retirar una derivada, que es la otra mitad del control.
  await page.getByTestId('board-ref-drop-SHOT_001').first().click({ timeout: 20_000 })
  await page.getByTestId('board-prompt-panel-SHOT_001-generate').click({ timeout: 30_000 })

  await expect.poll(() => posted.length, { timeout: 30_000, intervals: [300] }).toBeGreaterThan(0)
  console.log('[boardrefs] enviado →', JSON.stringify(posted[0]?.extra_refs), JSON.stringify(posted[0]?.exclude_refs))
  expect(posted[0]?.extra_refs).toContain(MINE)
  expect(posted[0]?.exclude_refs?.length).toBeGreaterThan(0)
})
