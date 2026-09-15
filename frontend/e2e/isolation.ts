import { test as base, expect } from '@playwright/test'
export { expect }
export type { Page } from '@playwright/test'

/**
 * THE SUITE MUST NOT BE ABLE TO TOUCH A REAL PROJECT. Import `test` from here, not from
 * '@playwright/test' — the fixture below is `auto`, so every spec gets it whether or not
 * its author thought about it.
 *
 * WHAT HAPPENED, 2026-08-13. Two of the developer's live projects (DRAMA QUEEN and DRAMA
 * QUEEN 2) were found with an active stage-2 breakdown of ONE shot whose only asset was
 * "Server Room — a vast neon server room", against scripts about two people in a kitchen.
 * That is `autopilot_assets.spec.ts`'s fixture, written into his folders at 08:06:48 and
 * 08:07:01 by a full-suite run against his own :3000/:8000 while he was working in the
 * app. His ~/.takeone/last_project.json read `/tmp/takeone_toast`. Nothing was lost —
 * every real version survives in the 20-entry ring — but the ACTIVE pointer of two
 * projects was a test fixture, and he reasonably read it as the pipeline being broken.
 *
 * THE CHAIN, and each link is documented in the project's "Isolation hazards" notes:
 *   1. a spec calls goto('/dashboard') before seeding localStorage;
 *   2. ProjectAutosave's boot sees no keys of this app and asks the BACKEND which
 *      project this computer last worked on (GET /api/project/last);
 *   3. the backend names a REAL project, which is loaded into the store — root and all;
 *   4. the spec's own seed then lands in that store, and the next autosave POSTs it to
 *      /api/project/save-state, which writes pipeline_state.json at the real path.
 *
 * `noInheritedProject` already existed for link 2 and was OPT-IN: 8 specs of 50 called
 * it, and 42 booted with an empty localStorage without it. Opt-in isolation is not
 * isolation — the one spec that forgets is the one that overwrites your film.
 *
 * So both links are cut here, for everyone:
 *   · GET /api/project/last  -> an empty pointer ("this machine has no last project"),
 *     which is the only state in which a spec's own seed is the only thing in the store;
 *   · POST /api/project/save-state -> answered, never performed. A test has no business
 *     writing a project to disk, and this is the exact call that did the damage.
 *
 * A spec that genuinely needs either wire (project_load.spec.ts tests reconstruction)
 * registers its own route: Playwright matches the most recently added route first, so a
 * spec's own handler wins over this one. Overriding is deliberate and visible; forgetting
 * is not possible any more.
 *
 * This is the BROWSER-side half, and it is the one that is verifiable from here: with it
 * in place a full suite run touched ZERO of the 40 real project files on this machine
 * (md5 + mtime, before and after). The other half is procedural and stronger, and no
 * amount of routing can substitute for it — run the stack under test with TAKEONE_HOME
 * pointed at a scratch directory, and then no endpoint, stubbed or not, can reach a real
 * project at all. the project's "Isolation hazards" notes says to measure that way; this file
 * exists because someone (me) did not.
 */
export const test = base.extend<{ projectIsolation: void }>({
  projectIsolation: [async ({ page }, use) => {
    await page.route('**/api/project/last', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ project_path: '', project_name: '', savedAt: '' }),
    }))
    // The shape ProjectAutosave expects back, so the app behaves exactly as it would
    // after a successful save — it is the DISK write that is refused, not the call.
    await page.route('**/api/project/save-state', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ path: '/dev/null/e2e-isolated' }),
    }))
    await use()
  }, { auto: true }],
})

/**
 * The original opt-in helper, kept because eight specs call it explicitly and the call
 * documents intent at the point of use. Now redundant — the fixture above does the same
 * thing for every spec — and harmless: registering the route twice is legal, and the
 * later registration simply wins.
 */
export async function noInheritedProject(page: import('@playwright/test').Page) {
  await page.route('**/api/project/last', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ project_path: '', project_name: '', savedAt: '' }),
  }))
}
