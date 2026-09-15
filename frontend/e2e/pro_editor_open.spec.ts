import { test, expect } from './isolation'

// Abrir "Edit with Pro" no puede colgar la etapa.
//
// El editor deriva los assets aprobados del proyecto para ofrecerlos como referencia. Escrito
// de la forma obvia — toda la derivación dentro del selector de zustand — `flatMap` construye
// un array NUEVO en cada llamada, zustand compara por identidad, siempre difiere, y React
// avisa de que "the result of getSnapshot should be cached to avoid an infinite loop" antes de
// entrar en bucle. La etapa 3 quedaba inservible en cuanto se pulsaba el botón.
//
// Se fija a nivel de CONSOLA, que es donde el usuario lo vio: abrir el editor y no producir
// ese error. Un test que sólo comprobara que el panel se ve pasaría igual con el bug puesto.

const ROOT = '/tmp/takeone_proeditor'
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 'proeditor', projectName: 'proeditor', projectType: 'film', projectStructure: {}, activeStage: 3,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        // Dos aprobados y uno sin aprobar: la tira debe ofrecer sólo los dos.
        assets: [
          { id: 'A1', name: 'Jane Doe', type: 'character', visualDescription: 'a woman' },
          { id: 'A2', name: 'THE ROOM', type: 'environment', visualDescription: 'a room' },
          { id: 'A3', name: 'Coffee Mug', type: 'prop', visualDescription: 'a mug' },
        ],
        shots: [], scenes: [],
      }),
      3: stg('pending_review', {
        assetStates: {
          A1: { status: 'approved', localPath: `${ROOT}/Assets/Characters/Jane Doe/v001.png`, selectedUrl: `${ROOT}/Assets/Characters/Jane Doe/v001.png`, imageUrls: [`${ROOT}/Assets/Characters/Jane Doe/v001.png`] },
          A2: { status: 'approved', localPath: `${ROOT}/Assets/Environments/THE ROOM/v001.png`, selectedUrl: `${ROOT}/Assets/Environments/THE ROOM/v001.png`, imageUrls: [`${ROOT}/Assets/Environments/THE ROOM/v001.png`] },
          A3: { status: 'pending_review', localPath: `${ROOT}/Assets/Props/Coffee Mug/v001.png`, selectedUrl: `${ROOT}/Assets/Props/Coffee Mug/v001.png`, imageUrls: [`${ROOT}/Assets/Props/Coffee Mug/v001.png`] },
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

test('el editor Pro abre sin disparar el bucle de getSnapshot', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  // `activeStage` no está en `partialize`: se navega como el usuario.
  await page.getByRole('button', { name: /^3$|AG/ }).first().click({ timeout: 20_000 })
  await page.waitForTimeout(1500)

  const open = page.getByRole('button', { name: /Edit with Pro/ }).first()
  await expect(open).toBeVisible({ timeout: 30_000 })
  await open.click()
  // Tiempo de sobra para que un bucle se manifieste.
  await page.waitForTimeout(2500)

  const snapshot = consoleErrors.filter((t) => /getSnapshot|infinite loop|Maximum update depth/i.test(t))
  console.log(`[pro] errores de consola: ${consoleErrors.length} · de bucle: ${snapshot.length}`)
  if (snapshot.length) console.log('[pro]', snapshot[0].slice(0, 200))
  expect(snapshot).toHaveLength(0)

  // Y la tercera fuente está ahí, con SÓLO los aprobados.
  const toggle = page.getByTestId('editor-project-assets-toggle')
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  await toggle.click()
  await expect(page.getByTestId('editor-project-asset-A1')).toBeVisible()
  await expect(page.getByTestId('editor-project-asset-A2')).toBeVisible()
  await expect(page.getByTestId('editor-project-asset-A3')).toHaveCount(0)
})
