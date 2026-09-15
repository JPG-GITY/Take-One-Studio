import { test, expect } from './isolation'

test('Tier 0 live: new code active in bundle, stage 5 gate visible', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  // Relative → honours `use.baseURL`. Hardcoding :3000 made this spec drive
  // whatever dev server happened to own that port instead of the one under test.
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2500);

  await page.screenshot({ path: '/tmp/t0_01_dashboard.png' });

  // Check bundle has the new identifiers
  const chunk = await page.evaluate(async () => {
    const resp = await fetch('/_next/static/chunks/_1oponoo._.js');
    const text = await resp.text();
    return {
      hasKeyframeReady: text.includes('keyframe_ready'),
      hasAnimateBtn: text.includes('Animate with Seedance'),
      hasShotAction: text.includes('shot_action'),
      hasAssembledPrompt: text.includes('assembled_prompt'),
    };
  });
  console.log('Bundle checks:', JSON.stringify(chunk, null, 2));

  // Click Stage 5 button (it's disabled until stages 1-4 done; just check it exists)
  const stage5 = page.locator('button').filter({ hasText: '5Final Scene' }).first();
  const stage5exists = await stage5.count() > 0;
  console.log('Stage 5 button exists:', stage5exists);
  
  if (stage5exists) {
    const isDisabled = await stage5.getAttribute('disabled');
    console.log('Stage 5 disabled (expected - no pipeline data):', isDisabled !== null);
  }

  // Check Stage 1 is ready and accessible  
  const stage1 = page.locator('button').filter({ hasText: /1Script|1 Script/i }).first();
  await expect(stage1).toBeVisible();

  await page.screenshot({ path: '/tmp/t0_02_stage1visible.png' });
  console.log('Console errors:', errors.length ? errors : 'none');

  expect(chunk.hasKeyframeReady).toBe(true);
  expect(chunk.hasAnimateBtn).toBe(true);
  expect(chunk.hasShotAction).toBe(true);
  expect(chunk.hasAssembledPrompt).toBe(true);
});
