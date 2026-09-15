import { test, expect } from './isolation'

// Long-form guard: a 30-60 min episode carries a 20-entry version ring buffer per
// stage (MAX_VERSIONS), which outgrows the 5-10MB localStorage quota. The OLD
// behaviour on QuotaExceededError was `localStorage.removeItem(name)` — it deleted
// the WHOLE project from the browser over a size limit, with only a console.warn.
//
// Now the storage shim prunes the version history (which lives on disk via
// ProjectAutosave) and retries; if even the pruned snapshot doesn't fit, the
// PREVIOUS entry is left intact rather than erased.

const KEY = 'takeone-pipeline-v1'

const ver = (id: string, filler: number, approved?: boolean) => ({
  id, createdAt: Date.now(), data: { pad: 'x'.repeat(filler) },
  qcResult: null, approvalNotes: '', ...(approved ? { approved: true } : {}),
})

// Stage 2 carries an active version, an older approved one, and 4 disposable
// takes — pruning must keep exactly the first two.
const seed = () => ({
  state: {
    projectId: 'q', projectName: 'quota', projectType: 'film', projectStructure: {}, activeStage: 2,
    stages: {
      1: { status: 'approved', activeVersionId: 'a1', versions: [ver('a1', 10)], isDirty: false },
      2: {
        status: 'pending_review', activeVersionId: 'live', isDirty: false,
        versions: [
          ver('old1', 120_000), ver('kept', 120_000, true), ver('old2', 120_000),
          ver('old3', 120_000), ver('old4', 120_000), ver('live', 120_000),
        ],
      },
      3: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      4: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      5: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
      6: { status: 'idle', activeVersionId: null, versions: [], isDirty: false },
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 2700, aspectRatio: '16:9', outputResolution: '1080p',
    gateMode: 'manual', localFolderRoot: '/tmp/quota', approvedShotIds: [],
  },
  version: 5,
})

/** Make localStorage.setItem throw QuotaExceededError for the pipeline key once
 *  armed. `limit` is the byte ceiling the fake quota allows (0 = always throw). */
const armQuota = (limit: number) => `
  (() => {
    const raw = Storage.prototype.setItem
    const rm = Storage.prototype.removeItem
    window.__removed = []
    Storage.prototype.setItem = function (k, v) {
      if (window.__quotaArmed && k === '${KEY}' && String(v).length > ${limit}) {
        const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e
      }
      return raw.call(this, k, v)
    }
    Storage.prototype.removeItem = function (k) {
      window.__removed.push(k)
      return rm.call(this, k)
    }
  })()
`

const readPersisted = (page: import('@playwright/test').Page) => page.evaluate((key) => {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  const st = JSON.parse(raw).state
  const s2 = st.stages['2']
  return {
    outputResolution: st.outputResolution,
    versionIds: (s2.versions as Array<{ id: string }>).map((v) => v.id),
    activeVersionId: s2.activeVersionId,
  }
}, KEY)

test('quota overflow prunes version history instead of deleting the project', async ({ page }) => {
  // Allow the pruned snapshot (~2 versions) but reject the full one (~6).
  await page.addInitScript(armQuota(400_000))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(([key, s]) => localStorage.setItem(key as string, JSON.stringify(s)), [KEY, seed()] as const)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  // Arm the fake quota, then cause a store write.
  await page.evaluate(() => { (window as unknown as { __quotaArmed: boolean }).__quotaArmed = true })
  await page.getByTestId('settings-button').click()
  await page.getByTestId('outres-4k').click()

  // The project is still there, and the live write landed.
  await expect.poll(() => readPersisted(page), { timeout: 8000, intervals: [250] })
    .toMatchObject({ outputResolution: '4k' })

  const after = await readPersisted(page)
  expect(after).not.toBeNull()
  // Pruned to the active version + the ever-approved one; the 4 disposable
  // takes are dropped (they remain on disk via ProjectAutosave).
  expect(after!.versionIds.sort()).toEqual(['kept', 'live'])
  expect(after!.activeVersionId).toBe('live')

  const removed = await page.evaluate(() => (window as unknown as { __removed: string[] }).__removed)
  expect(removed).not.toContain(KEY)
  console.log('[quota] pruned 6 → 2 versions, project survived, key never removed')
})

test('unprunable overflow keeps the previous entry rather than erasing it', async ({ page }) => {
  // limit 0 → even the pruned snapshot is rejected.
  await page.addInitScript(armQuota(0))
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(([key, s]) => localStorage.setItem(key as string, JSON.stringify(s)), [KEY, seed()] as const)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  await page.evaluate(() => { (window as unknown as { __quotaArmed: boolean }).__quotaArmed = true })
  await page.getByTestId('settings-button').click()
  await page.getByTestId('outres-4k').click()
  await page.waitForTimeout(1200)

  // The write could not be persisted — but the prior snapshot is intact, so a
  // reload recovers the project instead of finding nothing.
  const after = await readPersisted(page)
  expect(after).not.toBeNull()
  expect(after!.versionIds).toHaveLength(6)

  const removed = await page.evaluate(() => (window as unknown as { __removed: string[] }).__removed)
  expect(removed).not.toContain(KEY)
  console.log('[quota] unprunable overflow left the previous entry intact')
})
