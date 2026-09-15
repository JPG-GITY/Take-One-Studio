import { test, expect } from './isolation'

// "Keep current work": the stale-upstream banner clears without regenerating,
// and the stage's pre-invalidation status is restored.

const ver = (data: unknown) => ({ id: 'v1', createdAt: Date.now(), data, qcResult: null, approvalNotes: '' })
const stg = (status: string, data: unknown, extra: Record<string, unknown> = {}) =>
  ({ status, activeVersionId: 'v1', versions: [ver(data)], isDirty: false, ...extra })
const idle = () => ({ status: 'idle', activeVersionId: null, versions: [], isDirty: false })

const SEED = {
  state: {
    projectId: 'stale-test', projectName: 'accept', projectType: 'film', projectStructure: {}, activeStage: 5,
    stages: {
      1: stg('approved', { concept: 'x', content: 'y' }),
      2: stg('approved', {
        assets: [],
        shots: [{ id: 'SHOT_T1', sceneId: 'SC-T', action: 'a', visualDescription: 'v', assetsUsed: [], cameraAngle: 'wide', lighting: 'cool', estimatedDuration: 5, dialogue: [] }],
        scenes: [{ id: 'SC-T', heading: 'INT. X', description: 'd', shotIds: ['SHOT_T1'] }],
      }),
      3: stg('approved', { assetStates: {} }),
      4: stg('approved', { sceneStates: {} }),
      // Stage 5 was APPROVED, then an upstream re-approval invalidated it
      5: stg('invalidated', { shots: [{ shotId: 'SHOT_T1', thumbnailUrl: '', videoUrl: '', duration: 5, status: 'queued' }] },
        { isDirty: true, prevStatus: 'approved' }),
      6: idle(),
    },
    style: { id: 'cinematic', label: 'C', promptSuffix: '', negativePrompt: '', anchorImageRefs: [] },
    targetDurationSecs: 60, aspectRatio: '16:9', localFolderRoot: null, approvedShotIds: [],
  },
  version: 3,
}

test('Keep current work clears the stale banner and restores the prior status', async ({ page }) => {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate((s) => localStorage.setItem('takeone-pipeline-v1', JSON.stringify(s)), SEED)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await expect(page.getByTestId('stale-banner')).toBeVisible()
  await page.getByTestId('keep-current-work').click()
  await expect(page.getByTestId('stale-banner')).toBeHidden()

  const stage5 = await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('takeone-pipeline-v1')!)
    const s = st.state.stages['5']
    return { status: s.status, isDirty: s.isDirty, prevStatus: s.prevStatus ?? null }
  })
  console.log('[KEEP] stage 5 after keep:', JSON.stringify(stage5))
  if (stage5.isDirty || stage5.status !== 'approved') throw new Error('keep-current-work did not restore the stage')
})
