import { test, expect } from './isolation'

// Las correcciones de puntero de medios deben sobrevivir a la decisión de arranque.
//
// El arranque conserva a propósito la copia del navegador cuando tiene trabajo y el disco
// no va por delante (`if (memHasContent && !diskIsNewer) return`) — correcto, porque esa
// copia puede tener cambios sin guardar. Pero ese mismo `return` estaba tirando a la
// basura los punteros sanados, así que una pestaña que YA tenía el proyecto abierto
// seguía nombrando un vídeo que no existe. Medido en BLACKMIRROR 4 (2026-08-31): el
// backend sanaba SHOT_004 en cada carga y la UI no se enteraba nunca.
//
// Un puntero no es trabajo: es un hecho del disco. Por eso viaja en su propio campo
// `media_heals` y se aplica en su propia ruta. Este spec fija justamente eso.

const ROOT = '/tmp/takeone_heal'
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '', approved: true })
const stg = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const shotsIn = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1') || '{}').state
    const s5 = st?.stages?.['5']
    const v = s5?.versions?.find((x: { id: string }) => x.id === s5.activeVersionId) ?? s5?.versions?.at(-1)
    return (v?.data?.shots ?? []) as Array<{ shotId: string; status: string; videoLocalPath?: string; videoUrl?: string; assembledPrompt?: string }>
  })

const seed = (savedAt: number) => ({
  state: {
    projectId: 'heal', projectName: 'heal', projectType: 'film', projectStructure: {}, activeStage: 5,
    savedAt,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [],
        shots: [{ id: 'SHOT_GONE', sceneId: 'SC', action: 'a', visualDescription: 'v', assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [] },
                { id: 'SHOT_MUTE', sceneId: 'SC', action: 'b', visualDescription: 'v', assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [] },
                { id: 'SHOT_KEEP', sceneId: 'SC', action: 'c', visualDescription: 'v', assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [] }],
        scenes: [{ id: 'SC', heading: 'INT. ROOM - DAY', description: 'd', shotIds: ['SHOT_GONE', 'SHOT_MUTE', 'SHOT_KEEP'] }],
      }),
      3: stg('approved', { assetStates: {} }),
      4: stg('approved', { sceneStates: {} }),
      5: stg('approved', {
        shots: [
          // Aprobado, apuntando a un fichero que no existe.
          { shotId: 'SHOT_GONE', status: 'approved', duration: 5, thumbnailUrl: '',
            videoLocalPath: `${ROOT}/Shots/SHOT_GONE/video_v001.mp4`, videoUrl: 'http://cdn/dead.mp4' },
          // Apuntando a la toma MUDA teniendo su doblaje al lado.
          { shotId: 'SHOT_MUTE', status: 'approved', duration: 5, thumbnailUrl: '',
            videoLocalPath: `${ROOT}/Shots/SHOT_MUTE/video_v001.mp4`, videoUrl: 'http://cdn/mute.mp4' },
          // Su vídeo está bien; lo que está rancio es el prompt que la UI muestra como enviado.
          { shotId: 'SHOT_KEEP', status: 'approved', duration: 5, thumbnailUrl: '',
            videoLocalPath: `${ROOT}/Shots/SHOT_KEEP/video_v001.mp4`, videoUrl: 'http://cdn/keep.mp4',
            assembledPrompt: 'el prompt viejo que nunca se envió' },
        ],
      }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', outputResolution: '1080p',
    localFolderRoot: ROOT, approvedShotIds: [],
  },
  version: 5,
})

test('las correcciones de medios llegan al store aunque el navegador conserve su copia', async ({ page }) => {
  const browserSavedAt = Date.now()

  await page.route('**/api/video/registry**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }))
  // El disco va POR DETRÁS del navegador: es la rama que hace `return` y descartaba todo.
  await page.route('**/api/project/load**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      state: { ...seed(browserSavedAt - 600_000).state },
      savedAt: new Date(browserSavedAt - 600_000).toISOString(),
      manifest: { name: 'heal' }, path: ROOT,
      media_heals: [
        { shot_id: 'SHOT_GONE', video_local_path: '', video_url: '', status: 'draft' },
        { shot_id: 'SHOT_MUTE', video_local_path: `${ROOT}/Shots/SHOT_MUTE/video_v001.dub.mp4`, video_url: '' },
        // PARCIAL: sólo el prompt. Aplicar el objeto entero pondría videoLocalPath a
        // undefined — una corrección de prompt que borra el vídeo.
        { shot_id: 'SHOT_KEEP', assembled_prompt: '[Generation Goal] el prompt de verdad' },
      ],
    }),
  }))

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((v) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(v)), seed(browserSavedAt))
  await page.reload({ waitUntil: 'domcontentloaded' })

  await expect.poll(async () => (await shotsIn(page)).find((s) => s.shotId === 'SHOT_GONE')?.status,
    { timeout: 30_000, intervals: [400] }).toBe('draft')

  const shots = await shotsIn(page)
  const gone = shots.find((s) => s.shotId === 'SHOT_GONE')!
  const mute = shots.find((s) => s.shotId === 'SHOT_MUTE')!

  // El plano sin fichero deja de decir que está aprobado, y sus punteros muertos se van.
  expect(gone.status).toBe('draft')
  expect(gone.videoLocalPath).toBe('')
  expect(gone.videoUrl).toBe('')

  // El que tenía doblaje al lado apunta a él, y conserva su estado: sí hay toma.
  expect(mute.videoLocalPath).toContain('video_v001.dub.mp4')
  expect(mute.status).toBe('approved')
  // La URL firmada nombraba el fichero mudo, así que no puede sobrevivir.
  expect(mute.videoUrl).toBe('')
  // El parcial: se corrige el prompt y NO se toca nada más del plano.
  const keep = shots.find((s) => s.shotId === 'SHOT_KEEP')!
  expect(keep.assembledPrompt).toBe('[Generation Goal] el prompt de verdad')
  expect(keep.videoLocalPath).toContain('SHOT_KEEP/video_v001.mp4')
  expect(keep.videoUrl).toBe('http://cdn/keep.mp4')
  expect(keep.status).toBe('approved')
  console.log('[heal]', JSON.stringify({ gone, mute, keep }))
})
