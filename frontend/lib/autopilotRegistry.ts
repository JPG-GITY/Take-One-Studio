/**
 * P5c.2: per-stage Autopilot runner registry.
 *
 * Each stage's generation logic lives inside its own view, so a stage opts into
 * Autopilot by registering an async runner while it's mounted. The
 * AutopilotController drives the pipeline by navigating to a stage, awaiting its
 * registered runner, and advancing (or pausing) on the result.
 *
 * A plain module-level Map — functions don't belong in persisted zustand state.
 */

export type AutopilotResult = 'done' | 'paused' | 'error'
export type AutopilotRunner = () => Promise<AutopilotResult>

const runners = new Map<number, AutopilotRunner>()

/** Register a stage's runner; returns an unregister fn for the effect cleanup. */
export function registerAutopilotRunner(stage: number, fn: AutopilotRunner): () => void {
  runners.set(stage, fn)
  return () => { if (runners.get(stage) === fn) runners.delete(stage) }
}

export function getAutopilotRunner(stage: number): AutopilotRunner | undefined {
  return runners.get(stage)
}
