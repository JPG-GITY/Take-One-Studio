import { test, expect } from './isolation'

// Reset = true fresh start: name falls back to UNTITLED, every stage clears, the
// project folder is dropped, and the stage views remount (no stale local state
// like the Script concept/draft lingering).

const ver = (id: string, data: unknown, approved = false) =>
  ({ id, createdAt: Date.now(), data, qcResult: null, approvalNotes: approved ? 'ok' : '' })
const stg = (status: string, aid: string | null, versions: unknown[]) => ({ status, activeVersionId: aid, versions, isDirty: false })

const SEED = {
  state: {
    projectId: 'old', projectName: 'F-AI-L_EP2', projectType: 'film', projectStructure: { act: 'Act 1' }, activeStage: 1,
    localFolderRoot: '/p/FAIL',
    stages: {
      1: stg('approved', 'v1', [ver('v1', { concept: 'a humanoid robot', content: 'FADE IN:\nINT. CHAMBER - NIGHT' }, true)]),
      2: stg('approved', 'v1', [ver('v1', { assets: [], shots: [], scenes: [] }, true)]),
      3: stg('idle', null, []), 4: stg('idle', null, []), 5: stg('idle', null, []), 6: stg('idle', null, []),
    },
    style: { id: 'cinematic', label: 'Cinematic', promptSuffix: 'c', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 300, aspectRatio: '9:16', gateMode: 'auto', approvedShotIds: ['x'], gallery: [], referenceTray: [],
  },
  version: 4,
}

test('Reset falls back to UNTITLED and clears everything for a fresh start', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  // The old project shows (name + script content)
  await expect(page.locator('text=F-AI-L_EP2').first()).toBeVisible()

  // Reset → confirm
  await page.getByRole('button', { name: 'Reset' }).click()
  await page.getByRole('button', { name: 'Yes' }).click()
  await page.waitForTimeout(600)

  // Store is a clean slate
  const after = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!).state
    return {
      name: st.projectName,
      root: st.localFolderRoot,
      type: st.projectType,
      gateMode: st.gateMode,
      aspect: st.aspectRatio,
      approvedShots: st.approvedShotIds.length,
      stageVersions: Object.values(st.stages).map((s: unknown) => (s as { versions: unknown[] }).versions.length),
    }
  })
  expect(after).toEqual({
    name: 'UNTITLED', root: null, type: 'tv', gateMode: 'manual', aspect: '16:9', approvedShots: 0,
    stageVersions: [0, 0, 0, 0, 0, 0],
  })

  // The setup button is neutral again, and the old script content is gone (view remounted)
  await expect(page.getByTestId('project-setup-trigger')).toContainText('Project Setup')
  await expect(page.locator('text=INT. CHAMBER - NIGHT')).toHaveCount(0)
  console.log('[reset] UNTITLED + all stages cleared + folder dropped + view remounted')
})
