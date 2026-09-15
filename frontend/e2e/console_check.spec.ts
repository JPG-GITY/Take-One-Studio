import { test, expect } from './isolation'

const ROOT = `${process.env.HOME}/Documents/TakeOne/ConsistencyTest`
const CHAR = `${ROOT}/Assets/Characters/Detective Vael/Versions/v001.png`
const serveUrl = (p: string) => `http://localhost:8000/api/asset/serve?path=${encodeURIComponent(p)}`

const SHOTS = [{
  id: 'P2_SHOT_001', sceneId: 'INT. PRECINCT', action: 'Vael leans in', visualDescription: 'desc',
  assetsUsed: ['ASSET_001'], cameraAngle: 'slow dolly in', estimatedDuration: 5, dialogue: [],
}]
const BD = {
  assets: [{ id: 'ASSET_001', name: 'Detective Vael', type: 'character', visualDescription: 'detective', sceneRefs: [] }],
  shots: SHOTS,
  scenes: [{ id: 'SC-01', heading: 'INT. PRECINCT', description: '', shotIds: ['P2_SHOT_001'] }],
}
const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stage = (status: string, data: unknown) => ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false })

const SEED = {
  state: {
    projectId: 'console-check', projectName: 'ConsistencyTest', projectType: 'film',
    projectStructure: {}, activeStage: 3,
    stages: {
      1: stage('approved', { concept: 'x', content: 'y' }),
      2: stage('approved', BD),
      3: stage('pending_review', {
        assetStates: { ASSET_001: { imageUrls: [serveUrl(CHAR)], selectedUrl: serveUrl(CHAR), localPath: CHAR, headshotLocalPath: null, status: 'pending', qcResult: null } },
      }),
      4: stage('pending_review', {
        sceneStates: { 'SC-01': { status: 'pending', shotBoards: {}, qcResult: null, notes: '' } },
      }),
      5: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      6: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: ROOT, approvedShotIds: [],
  },
  version: 3,
}

test('console clean on AG and Storyboard (no setState-in-render)', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // AG renders with hydrated assetStates; clicking Select fires updateAsset
  await page.getByRole('button', { name: 'Select', exact: true }).first()
    .click({ timeout: 3000 }).catch(() => { /* no pending variation — render alone suffices */ })
  await page.waitForTimeout(800)

  // Storyboard renders with hydrated sceneStates; navigation exercises updateScene path
  await page.locator('button', { hasText: 'Storyboard' }).first().click()
  await page.waitForTimeout(1200)

  const renderErrors = errors.filter((e) => /Cannot update a component/.test(e))
  console.log('console errors total:', errors.length, '| setState-in-render:', renderErrors.length)
  if (errors.length) console.log(errors.slice(0, 4).join('\n---\n').slice(0, 600))
  expect(renderErrors).toHaveLength(0)
})
