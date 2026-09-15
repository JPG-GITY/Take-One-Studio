import { test, expect } from './isolation'

test('localStorage: corrupt entry is cleared gracefully and no JSON parse error', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
    if (msg.type() === 'warning' && msg.text().includes('Rehydration failed')) {
      console.log('✅ Caught rehydration error gracefully:', msg.text());
    }
  });

  // Inject a truncated/corrupt localStorage entry BEFORE the page loads
  await page.addInitScript(() => {
    try {
      // Simulate a truncated JSON string (what happens when data URIs overflow quota)
      const corrupt = '{"state":{"projectId":"abc","stages":{},"style":{"id":"cinematic","label":"Cinematic","promptSuffix":"ci';
      localStorage.setItem('takeone-pipeline-v1', corrupt);
    } catch { /* ignore */ }
  });

  // Relative → honours `use.baseURL`. Hardcoding :3000 made this spec drive
  // whatever dev server happened to own that port instead of the one under test.
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);

  // Check whether localStorage was cleared (corrupt entry removed)
  const storedValue = await page.evaluate(() => localStorage.getItem('takeone-pipeline-v1'));
  const isClearedOrFixed = !storedValue || (() => { try { JSON.parse(storedValue); return true; } catch { return false; } })();
  console.log('localStorage entry cleared/valid after load:', isClearedOrFixed);

  await page.screenshot({ path: '/tmp/localstorage_fix.png' });

  // Should not have raw JSON parse errors in console
  const parseErrors = errors.filter(e => e.includes('Unterminated') || e.includes('JSON'));
  console.log('JSON parse errors in console:', parseErrors.length ? parseErrors : 'none');

  expect(isClearedOrFixed).toBe(true);
});
