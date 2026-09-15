import os from 'node:os'
import { defineConfig } from '@playwright/test'

/**
 * Specs that drive REAL generation — they call Claude and Seedream/Seedance for
 * actual images and video, which is why their authors gave them 5-15 minute
 * timeouts. They cost money and take minutes.
 *
 * They are split out because mixing them with the deterministic specs made the
 * whole suite untrustworthy: under load (two dev servers, ffmpeg, a parallel
 * agent) whichever of them happened to be slow that run blew its timeout and was
 * reported as a failure. Measured on ONE unchanged commit, 2026-07-29:
 *
 *     3.9 min run →  8 failures        12.8 min run → 10 failures
 *     4.2 min run →  8 failures        12.8 min run → 12 failures
 *
 * The extras changed identity every run and every one of them passed when run
 * alone. A failure list that varies on identical code cannot answer "did I break
 * something", and answering it by hand cost seven isolation re-runs in one day.
 */
const LIVE_SPECS = [
  '**/prompt_review.spec.ts',
  '**/prompt_transparency.spec.ts',
  '**/regen_button.spec.ts',
  '**/stage5_fixes.spec.ts',
]

const live = process.env.E2E_LIVE === '1'

// Never silent about which half is running — a hidden test is worse than a slow one.
// On STDERR, not stdout: --reporter=json writes its payload to stdout and a stray
// line here makes the output unparseable.
process.stderr.write(live
  ? '[e2e] LIVE mode: only the real-generation specs (minutes, real spend).\n'
  : `[e2e] deterministic specs only. ${LIVE_SPECS.length} real-generation spec(s) skipped — run them with E2E_LIVE=1.\n`)

export default defineConfig({
  testDir: './e2e',
  // Was 30s, which several specs sat right on top of — the three slowest in the
  // deterministic set measured 43.3s, 31.1s and 30.0s, so any load spike tipped
  // whichever one was closest over the edge and it was reported as a failure.
  // A passing test finishes early and pays nothing for a longer ceiling; the only
  // thing this buys is that a slow machine stops looking like a broken one.
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
  },
  // Was 1. With pre-existing failures in the tree the run always stopped at the
  // first one, so the default command could never show whether anything NEW broke
  // — every useful run had to override it on the command line. 0 = no limit.
  maxFailures: 0,
  /**
   * Was unset, i.e. Playwright's default of HALF THE CORES — so the amount of
   * parallelism, and with it the failure list, changed with whatever machine ran
   * the suite. That is the whole reason "the baseline" kept moving.
   *
   * 31 call sites in e2e/ open the dashboard with `waitUntil: 'domcontentloaded'`
   * and then bet a fixed `waitForTimeout(500…1500)` on React having hydrated, and
   * a click on a not-yet-hydrated button SUCCEEDS in Playwright while doing nothing
   * in the app — so the test then waits out its full timeout. Measured on this
   * 8-core box, ms from domcontentloaded to the first click the app reacts to,
   * 24 fresh contexts per column (2026-08-02):
   *
   *     1 worker, idle      179 … 219   max  308
   *     4 workers, suite    187 … 324   max  496
   *     8 workers, suite    197 … 567   max 1115
   *
   * The shortest bet in the suite is 500ms. At 4 workers nothing reaches it and the
   * run is reproducible — 7 full runs, 7 identical failure lists. At 8 workers the
   * tail crosses it and a different forecast/theme/usage test fails each time.
   *
   * Trade-off, measured: 4 workers costs ~113s per full run against ~81s at 8. The
   * 32s buys a failure list that means something. Half the cores is kept for boxes
   * smaller than this one; the cap is what stops a 16-core machine from silently
   * running the flaky configuration.
   */
  workers: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
  projects: live
    ? [{ name: 'live', testMatch: LIVE_SPECS, timeout: 900_000 }]
    : [{ name: 'deterministic', testIgnore: LIVE_SPECS }],
})
