'use client'

import { useEffect, useState } from 'react'
import { pipelineApi } from '@/lib/api/pipeline.api'

/**
 * How long a SCRIPT will run. The number belongs to the backend
 * (claude_agents.estimate_script_seconds, POST /api/script/runtime): dialogue at
 * speaking rate, action at 4.5 words/sec — the same maths phase 2 sizes its shots
 * with, so phase 1 and phase 2 stop disagreeing about the same film.
 *
 * Phase 1 used to answer this locally with `words / 130`, the screenplay page rule.
 * That rule assumes a Courier-formatted page whose action is spread over sparse
 * lines; these scripts are dense prose, and over the 16 projects on disk it missed
 * their real summed shot durations by a median 114% (ROBOTECH: 569s claimed against
 * 294s of shots) where the backend maths misses by 14%.
 *
 * The page rule survives here as the OFFLINE fallback ONLY, and everything it
 * produces carries `approx` so the UI can never show it as the real number.
 */

export interface ScriptRuntime {
  seconds: number
  words: number
  dialogueSeconds: number
  actionSeconds: number
  /** true = the backend was unreachable and this is the words/130 guess. */
  approx: boolean
}

const countWords = (script: string) => script.trim().split(/\s+/).filter(Boolean).length

/** The page rule. The ONE copy left — it used to be written out at five call sites. */
export function approxScriptRuntime(script: string): ScriptRuntime {
  const words = countWords(script)
  return { seconds: Math.round((words / 130) * 60), words, dialogueSeconds: 0, actionSeconds: 0, approx: true }
}

/** Last measured script → its answer. Adopting a script measures it, and the badge's
 *  hook measures the SAME text a moment later; the maths is pure, so one round trip
 *  serves both. Only a real answer is remembered (see below). */
let cached: { script: string; runtime: Promise<ScriptRuntime> } | null = null

/**
 * Ask the backend; fall back to the page rule when it cannot be reached. NEVER
 * rejects: a runtime estimate is a label, and a label must not be able to kill a
 * generate, a save or an unattended autopilot run.
 */
export async function measureScriptRuntime(script: string): Promise<ScriptRuntime> {
  if (!script.trim()) return { seconds: 0, words: 0, dialogueSeconds: 0, actionSeconds: 0, approx: false }
  if (cached?.script === script) return cached.runtime
  const runtime = requestRuntime(script)
  cached = { script, runtime }
  // A fallback is not worth remembering: the backend may be up again by the next
  // call, and a cached guess would keep this script approximate for the session.
  void runtime.then((r) => { if (r.approx && cached?.runtime === runtime) cached = null })
  return runtime
}

async function requestRuntime(script: string): Promise<ScriptRuntime> {
  try {
    const r = await pipelineApi.scriptRuntime(script)
    return {
      seconds: Math.round(r.seconds),
      words: r.words,
      dialogueSeconds: r.dialogue_seconds,
      actionSeconds: r.action_seconds,
      approx: false,
    }
  } catch (e) {
    console.warn('[script/runtime] estimate unavailable — falling back to words/130:', e)
    return approxScriptRuntime(script)
  }
}

/**
 * Live estimate for the script in the editor: debounced (the call is over the
 * network and the user is typing), never on the render path, and self-cancelling so
 * a slow answer for old text cannot land on top of a newer one. Returns null until
 * the first answer arrives — showing nothing beats showing a wrong number.
 */
export function useScriptRuntime(script: string, delayMs = 600): ScriptRuntime | null {
  const [runtime, setRuntime] = useState<ScriptRuntime | null>(null)
  useEffect(() => {
    if (!script.trim()) return
    let live = true
    const t = setTimeout(() => {
      void measureScriptRuntime(script).then((r) => { if (live) setRuntime(r) })
    }, delayMs)
    return () => { live = false; clearTimeout(t) }
  }, [script, delayMs])
  // An emptied editor has no runtime — derived, not set in the effect body, which
  // would cascade a render on every keystroke that clears the box.
  return script.trim() ? runtime : null
}
