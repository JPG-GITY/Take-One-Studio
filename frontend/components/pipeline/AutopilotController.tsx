'use client'

/**
 * P5c.1: Autopilot controller (no UI). When autopilot.running flips true it
 * auto-runs the pure-Claude TEXT stages — Script → Breakdown — committing and
 * approving each, then lands the user at Stage 3 with a draft ready. Reuses the
 * existing generate endpoints + store actions; mounted once in the dashboard.
 * Later phases extend the chain down the pipeline (assets/storyboard/shots).
 */

import { useEffect, useRef } from 'react'
import { usePipelineStore } from '@/store/pipeline.store'
import { useAgentsStore } from '@/store/agents.store'
import { useToast } from '@/components/ui/Toast'
import { pipelineApi, type QCResponse } from '@/lib/api/pipeline.api'
import { measureScriptRuntime } from '@/lib/scriptRuntime'
import { normalizeBreakdown, storyConceptOf } from '@/features/stage2-breakdown/BreakdownView'
import { runDirectorPass } from '@/features/stage2-breakdown/directorPass'
import { getAutopilotRunner, type AutopilotRunner } from '@/lib/autopilotRegistry'
import type { ScriptData, BreakdownData, StageId } from '@/lib/types/pipeline.types'

const STAGE_PHASE: Record<number, string> = {
  3: 'Generating assets…', 4: 'Generating storyboards…',
  5: 'Generating shots…', 6: 'Assembling the cut…',
}

// A stage's runner registers only after its view mounts (post-navigation),
// so wait briefly for it to appear.
async function waitForRunner(stage: number, isStopped: () => boolean, timeoutMs = 8000): Promise<AutopilotRunner | undefined> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (isStopped()) return undefined
    const r = getAutopilotRunner(stage)
    if (r) return r
    await new Promise((res) => setTimeout(res, 200))
  }
  return getAutopilotRunner(stage)
}

export function AutopilotController() {
  const running = usePipelineStore((s) => s.autopilot.running)
  const { updateAgent } = useAgentsStore()
  const { success, error: toastError } = useToast()
  const busy = useRef(false)

  useEffect(() => {
    if (!running || busy.current) return
    busy.current = true
    const get = usePipelineStore.getState
    const stopped = () => !get().autopilot.running

    // Read a stage's active-version data (for resuming past already-done work).
    const activeData = <T,>(stage: StageId): T | null => {
      const st = get().stages[stage]
      const v = st.versions.find((v) => v.id === st.activeVersionId)
      return (v?.data as T) ?? null
    }

    void (async () => {
      const concept = get().autopilot.concept
      const projectName = get().projectName
      const projectPath = get().localFolderRoot ?? ''
      const target = get().targetDurationSecs
      // The model the film is FOR. Read once, here, and used by both the planner and the
      // gate below — they must never be told different ceilings.
      const videoModel = get().videoModel
      try {
        // P5c.3: resume-aware — re-running autopilot after a pause must NOT
        // regenerate already-approved stages. We skip any approved stage and
        // pick up at the first one still pending.

        // 1) Script — generate only if not already approved
        let scriptContent: string
        if (get().stages[1].status !== 'approved') {
          if (!concept.trim()) throw new Error('No concept provided')
          get().setAutopilotPhase('Writing script…')
          updateAgent('story', { status: 'active', detail: 'Autopilot: writing script…' })
          // PAIRED with ScriptIngestionView.handleGenerate — the other caller of this
          // endpoint. It cannot share a builder because its concept is assembled from
          // UI state this controller has no access to ("Develop idea" output + answered
          // selection questions + director feedback); here the box IS the whole concept.
          // Anything ADDED to the body belongs in both, or the unattended run reverts to
          // a reduced version of the same call.
          const scriptData = await pipelineApi.generateScript(concept, projectName, projectPath, target)
          if (stopped()) return
          const words = scriptData.content.split(/\s+/).length
          // The runtime an unattended run records is the backend's duration maths, the
          // same one the breakdown sizes its shots with — words/130 read roughly 2× the
          // film. measureScriptRuntime never rejects (it falls back to that rule, flagged),
          // so an unreachable estimate cannot strand the run before stage 2.
          const rt = await measureScriptRuntime(scriptData.content)
          if (stopped()) return
          const sid = get().commitVersion<ScriptData>(1, {
            concept, content: scriptData.content, wordCount: words,
            estimatedRuntime: Math.round(rt.seconds / 60),
            estimatedRuntimeSecs: rt.seconds, runtimeApprox: rt.approx,
          })
          get().approveVersion(1, sid)
          updateAgent('story', { status: 'completed', detail: 'Script ready' })
          scriptContent = scriptData.content
        } else {
          scriptContent = activeData<ScriptData>(1)?.content ?? ''
          updateAgent('story', { status: 'completed', detail: 'Script already approved — resuming' })
        }

        // 2) Breakdown — generate only if not already approved
        if (get().stages[2].status !== 'approved') {
          if (!scriptContent.trim()) throw new Error('No script to break down')
          get().setAutopilotPhase('Breaking down assets + shots…')
          updateAgent('breakdown', { status: 'active', detail: 'Autopilot: breaking down…', progress: 10 })
          // The premise from the SAME derivation the manual path uses (storyConceptOf),
          // not this run's autopilot box: on a resumed run the script was written by
          // hand, possibly from a developed concept, and the box holds whatever was
          // typed to restart the run. Falls back to the box when stage 1 holds nothing
          // — which is exactly the fresh-run case, where the two are the same string.
          const premise = storyConceptOf(get().stages[1]) || concept
          // WITH the video model, since 2026-08-13. Omitting it planned every unattended
          // run against the 2.0 default — 15s takes — while stages 3-6 of the same run
          // render with the project's actual model (FinalGenView reads videoModel and
          // computes segMaxSecs from it), so a v25 project got a film cut into 15s pieces
          // by a pipeline that could have held 30s in one take. The long take is the whole
          // reason to pick 2.5: fewer cuts, and continuity that does not have to survive
          // one. The manual path has always sent it (BreakdownView), so this only closes
          // the gap between attended and unattended.
          const bd = await pipelineApi.generateBreakdown(scriptContent, projectName, projectPath,
                                                         target, premise, videoModel)
          if (stopped()) return
          const normalised = normalizeBreakdown(bd)
          const bid = get().commitVersion<BreakdownData>(2, normalised)

          // Run the gate. Autopilot used to approve the breakdown the instant it
          // arrived, without QC — so every deterministic check (runtime against
          // target, speakers resolving to real characters, durations in range,
          // scenes covered) was skipped in the ONE path that generates a whole
          // episode unattended. Building 500 shots on a breakdown with missing
          // scenes is the most expensive way to find out it was wrong.
          updateAgent('breakdown', { status: 'active', detail: 'Autopilot: checking breakdown…', progress: 80 })
          let qc: QCResponse | null = null
          try {
            // PAIRED with BreakdownView's own QC call. Identical body except
            // deterministicOnly, which is true here on purpose (the subjective LLM pass
            // cannot change an unattended run's outcome, and it is not free).
            //
            // The SAME `videoModel` the plan above was built with, and that is the whole
            // contract: the defect this parameter exists to fix was a planner and a QC
            // disagreeing about how long one call may be. They move together or not at
            // all — passing it to one of the two is worse than passing it to neither.
            qc = await pipelineApi.qcBreakdown(normalised, scriptContent, target, true,
              { name: projectName, path: projectPath }, videoModel)
          } catch {
            qc = null   // the gate itself failing must not strand the run
          }
          if (stopped()) return
          // Stop only on checks that make the breakdown UNBUILDABLE — dialogue with no
          // voice anchor, shots outside Seedance's range, scenes a failed batch dropped.
          // A cut that runs long or sits on one shot size is worth saying and worth
          // seeing in the UI, but it is not a reason to abandon an unattended run: a
          // gate that fires on ordinary output just teaches people to bypass the gate.
          const failed = (qc?.checks ?? []).filter((c) => !c.passed && c.blocking)
          if (failed.length) {
            get().setStageStatus(2, 'pending_review')
            throw new Error(
              `Breakdown did not pass its checks — stopping before ${normalised.shots.length} shots `
              + `are built on it. ${failed.map((c) => `${c.label}: ${c.notes}`).join(' · ')}`,
            )
          }
          const advisory = (qc?.checks ?? []).filter((c) => !c.passed)
          if (advisory.length) {
            toastError('Breakdown notes',
              advisory.map((c) => `${c.label}: ${c.notes}`).join(' · ').slice(0, 300))
          }

          // THE DIRECTOR PASS. Until 2026-08-07 the unattended stage 2 was five calls —
          // generate, normalise, commit, QC, approve — and nothing else, so the two passes
          // that write the character dossiers and every shot's acting `performance` never
          // ran: they lived in BreakdownView's component body, and the view is never
          // mounted during an unattended run. Measured on BLOOM (autopilot-generated):
          // 10/10 characters with an empty dossier and 41/41 shots with no performance,
          // while every layer reported success. `performance` is read downstream by the
          // storyboard beat writer and by the render (as directorNotes), so the film was
          // built with no acting direction at all.
          //
          // AFTER the QC gate on purpose: a breakdown that fails a blocking check throws
          // above and is never built on, so this does not spend a Seed call on it.
          // BEFORE approveVersion on purpose: patchStageData writes into the ACTIVE
          // version, which is `bid`, so approving afterwards approves the directed
          // breakdown. Approve first and stage 2 would be signed off in the state the
          // director had not touched yet.
          //
          // enhanceShots is TRUE with no toggle to read: the manual path exposes that
          // switch for very long films, but an unattended run has no one to flip it and a
          // film with no acting direction is the worse default.
          get().setAutopilotPhase('Director: dossiers + acting direction…')
          const director = await runDirectorPass(normalised, { enhanceShots: true })
          if (stopped()) return
          // Visible, both ways: the agent panel is already red (runDirectorPass sets it)
          // and the toast survives the navigation to stage 3.
          if (director.error) toastError('Director pass failed', director.error)
          else if (director.warning) toastError('Director pass incomplete', director.warning)

          get().approveVersion(2, bid)
          // A WARNING IS NOT A SUCCESS, and this line used to say it was. runDirectorPass
          // sets the Breakdown Agent card red with the incomplete detail; this call fires
          // straight afterwards and, reading only `error`, painted it COMPLETED again.
          // Measured 2026-08-07 with 3 of 10 dossiers failing, 3/3 autopilot runs: the
          // card read "COMPLETED · Breakdown complete + checked · 10 shot(s) directed"
          // while three characters had no acting profile at all — the toast was the ONLY
          // surviving signal, and this is the panel a returning operator looks at first.
          // The manual path never had the bug: it sets no terminal state of its own.
          const degraded = director.error ?? director.warning
          updateAgent('breakdown', {
            status: degraded ? 'error' : 'completed',
            detail: director.error
              ? `Breakdown checked, but the director pass failed — ${director.error}`
              : director.warning
                ? `Breakdown checked · ${director.warning}`
                : `Breakdown complete + checked · ${director.enhance.shotsDirected} shot(s) directed`,
            progress: 100,
          })
        } else {
          updateAgent('breakdown', { status: 'completed', detail: 'Breakdown already approved — resuming' })
        }

        // 3) Drive the heavy stages via their registered runners (P5c.2+).
        // Each stage view registers a runner on mount; we navigate, await it,
        // and advance — or pause when a stage needs human review.
        for (let stage = 3; stage <= 6; stage++) {
          if (stopped()) return
          // Resume past stages already approved in a prior autopilot pass
          if (get().stages[stage as StageId].status === 'approved') continue
          get().setAutopilotPhase(STAGE_PHASE[stage] ?? `Stage ${stage}…`)
          get().goToStage(stage as StageId)
          const runner = await waitForRunner(stage, stopped)
          if (stopped()) return
          if (!runner) {
            get().setAutopilotPhase(`Stage ${stage}: not yet automated — finish manually`)
            break
          }
          const result = await runner()
          if (stopped()) return
          if (result === 'paused') {
            get().setAutopilotPhase('Paused — review & approve to continue')
            success('Autopilot paused', `Review & approve Stage ${stage}, then carry on`)
            break
          }
          if (result === 'error') throw new Error(`Autopilot failed at stage ${stage}`)
          // 'done' → continue to the next stage
        }
        get().stopAutopilot()
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Autopilot failed'
        get().setAutopilotError(msg)
        updateAgent('story', { status: 'error', detail: msg })
        toastError('Autopilot stopped', msg)
      } finally {
        busy.current = false
      }
    })()
  }, [running, updateAgent, success, toastError])

  return null
}
