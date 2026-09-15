'use client'

/**
 * Headless: when a project has a local folder (localFolderRoot), autosave the
 * pipeline snapshot to disk (debounced) so the project can be reopened later —
 * and, on boot, read it BACK when the browser copy is empty or stale.
 *
 * It writes the same shape the persist middleware keeps — both call the SAME
 * `partializeState`, so the on-disk copy and the in-browser copy never diverge
 * and `loadProjectState` consumes the identical shape on Open. Mounted once.
 *
 * The snapshot is built from the STORE, not read back out of localStorage: a
 * long-form project can outgrow the 5-10MB quota, and sourcing from localStorage
 * meant the browser's size limit silently decided what reached disk (a failed
 * write left nothing to copy). Disk has no such limit and is the durable copy.
 *
 * F2 — boot reconciliation. Writing to disk was only half the deal: `loadProjectState`
 * was reachable ONLY from the Open tab, so a plain page reload rehydrated from
 * localStorage and nothing else. When a long-form project outgrows the quota the
 * persist write fails and the storage adapter deliberately keeps the PREVIOUS entry
 * (an erased one is unrecoverable) — the browser copy then freezes while disk keeps
 * receiving every save, and the user reloads into a stale or empty project with a
 * complete newer one sitting on disk. Boot now compares the two and restores disk when
 * it wins, using the SAME planProjectLoad the Open tab uses so a booted project and an
 * opened project are identical.
 *
 * F2b — which folder to boot from. That reconciliation read the project root out of the
 * store, but the root is itself part of the persisted snapshot: with localStorage empty
 * there is no root, so boot could recover a stale copy and never an absent one. The root
 * now also lives in a standalone key (store: rememberProjectRoot) that the snapshot's
 * quota failures can't take down, and the comparison below refuses to act on an UNDATED
 * browser copy that holds work — "unknown age" is not "old".
 *
 * F2c — when there is no browser at all. Both keys above are localStorage, so cleared site
 * data, a fresh browser or an incognito window takes them BOTH: the project stayed on disk
 * and nothing could name it (/api/project/list existed, and a repo-wide grep found no
 * caller). The backend now records the project it last saw being worked on
 * (storage.remember_last_project, written on every autosave), and boot asks for it when the
 * browser holds nothing. That restore is the one the user did not point at, so it is
 * narrow and loud: only when localStorage holds NEITHER of this app's keys (see
 * hasLocalProjectMemory — an empty-but-present snapshot means "no project, on purpose"),
 * and the toast names the project, its folder and why it opened. Reset clears the backend
 * pointer too (TopBar), so "not this one" survives the next boot.
 */

import { useEffect, useRef } from 'react'
import { usePipelineStore, partializeState, recallProjectRoot, hasLocalProjectMemory } from '@/store/pipeline.store'
import type { ProjectSnapshot } from '@/store/pipeline.store'
import { planProjectLoad, type ProjectLoadResponse, type MediaHeal } from '@/lib/reconstructProject'
import { apiClient } from '@/lib/api/client'
import { pipelineApi } from '@/lib/api/pipeline.api'
import { useToast } from '@/components/ui/Toast'

/** Does this state hold any work at all? (No stage carries a single version.) Used
 *  both to refuse saving emptiness and to decide that boot may take the disk copy. */
const hasContent = (snap: Partial<ProjectSnapshot>): boolean =>
  Object.values(snap.stages ?? {}).some((st) => (st?.versions?.length ?? 0) > 0)

/** The disk copy's age in ms epoch. Prefers the snapshot-level `savedAt` (stamped by
 *  partializeState, same clock as the browser copy) and falls back to the backend's
 *  ISO `savedAt` for files written before that field existed. 0 = unknown. */
const diskSavedAt = (data: ProjectLoadResponse): number => {
  if (typeof data.state?.savedAt === 'number') return data.state.savedAt
  const t = data.savedAt ? Date.parse(data.savedAt) : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * How much newer disk must be before boot believes it. The two writers never fire
 * together: persist writes localStorage synchronously on every store change, this
 * component writes disk ~1.5s later — so a perfectly healthy disk copy is ALWAYS a
 * couple of seconds "newer" than the browser copy of the SAME state, and a bare `>`
 * would re-load (and toast) on every single reload. A browser copy that genuinely
 * stopped tracking falls behind by minutes, not seconds.
 */
const SAVE_SKEW_MS = 10_000

/** Apply the backend's media-pointer corrections to the LIVE store, whatever boot then
 *  decides about the snapshot.
 *
 *  Boot keeps a populated browser copy over the disk snapshot on purpose — it may hold
 *  unsaved work — and that same `return` was throwing away the healed pointers, so a tab
 *  that already had the project open went on naming a video that is not there. Measured
 *  on BLACKMIRROR 4's SHOT_004 (2026-08-31): the backend healed it on every load and the
 *  UI never saw it. A pointer is a fact about the disk, not work, so it is applied on its
 *  own path and touches nothing else on the shot. */
function applyMediaHeals(heals: MediaHeal[] | undefined): number {
  if (!heals?.length) return 0
  const store = usePipelineStore.getState()
  const stage = store.stages[5]
  const version = stage?.versions.find((v) => v.id === stage.activeVersionId)
    ?? stage?.versions[stage.versions.length - 1]
  const shots = (version?.data as { shots?: Array<Record<string, unknown>> } | undefined)?.shots
  if (!shots?.length) return 0
  const byId = new Map(heals.map((h) => [h.shot_id, h]))
  let applied = 0
  const next = shots.map((sh) => {
    const heal = byId.get(String(sh.shotId ?? ''))
    if (!heal) return sh
    applied++
    // KEY BY KEY, never the whole object. A heal may carry only the prompt (the
    // sidecar disagreed with the store's copy) and spreading it wholesale would set
    // videoLocalPath to undefined — a prompt correction that deletes the video.
    const patch: Record<string, unknown> = {}
    if (heal.video_local_path !== undefined) patch.videoLocalPath = heal.video_local_path
    if (heal.video_url !== undefined) patch.videoUrl = heal.video_url
    if (heal.assembled_prompt !== undefined) patch.assembledPrompt = heal.assembled_prompt
    // Only when the take is gone entirely: an empty path with a 'ready' status is the
    // exact lie this exists to stop.
    if (heal.video_local_path === '') { patch.previewUrl = ''; patch.status = heal.status ?? 'draft' }
    return { ...sh, ...patch }
  })
  if (applied) store.patchStageData(5, { shots: next })
  return applied
}

export function ProjectAutosave() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Boot runs once per mount (the ref also absorbs React StrictMode's double effect,
  // which would otherwise fire two /api/project/load requests).
  const bootStarted = useRef(false)
  // Gates the FIRST disk write until boot has DECIDED. Without it the debounced save
  // could land while boot is still in flight and overwrite the good disk copy with the
  // empty/stale memory state boot was about to replace.
  const bootDone = useRef(false)
  // Are we currently in a run of FAILED saves? Dedupes the warning below to one per
  // streak — the store ticks on every keystroke, so a per-failure toast would be a
  // stream of them. Cleared by the next save that succeeds, so a second outage warns
  // again.
  const saveFailing = useRef(false)
  const { info, warning } = useToast()

  // ── Boot: reconcile the browser copy against the disk copy ──────────────────
  useEffect(() => {
    if (bootStarted.current) return
    bootStarted.current = true

    // F2b — the store's root comes out of the SNAPSHOT, so reading only it made this
    // effect unreachable in the case it exists for: no snapshot, no root, no load. The
    // standalone key (see rememberProjectRoot) survives a cleared/never-written/quota-
    // failed snapshot, so fall back to it. `recalled` = the browser copy is ABSENT, not
    // merely behind — the toast below says so.
    const booted = usePipelineStore.getState()
    const root = booted.localFolderRoot ?? recallProjectRoot()
    if (!root) {
      // F2c — no root in either key. The only memory left is the backend's, but ask for
      // it ONLY when this browser holds nothing of ours at all: a rootless snapshot means
      // it HAS been here and has no project open on purpose (a Reset, a cleared project),
      // and a snapshot that rehydrated with work is the live copy even without a root.
      // Either way, replacing it with whatever this machine last touched would be the
      // worst kind of "help".
      if (hasLocalProjectMemory() || hasContent(booted)) { bootDone.current = true; return }
      pipelineApi.getLastProject()
        .then(({ project_path: lastPath, project_name: lastName }) => {
          if (!lastPath) return                     // no pointer, or its folder is gone
          // Same request, same plan, same store action the Open tab uses — a project
          // restored this way is indistinguishable from one the user opened by hand.
          return apiClient.get<ProjectLoadResponse>('/api/project/load', { params: { path: lastPath } })
            .then(({ data }) => {
              const plan = planProjectLoad(data, lastPath)
              if (!plan.snapshot) return            // folder exists but holds nothing to restore
              usePipelineStore.getState().loadProjectState(plan.snapshot)
              // Be explicit about what just happened and whose choice it was: this is the
              // one path that can open a project nobody in this browser asked for (shared
              // machine, several projects, a colleague's session).
              info(
                `Reopened ${data.manifest?.name || lastName || lastPath}`,
                `This browser had no saved project at all, so Take One Studio reopened the last project ` +
                `used on this computer — ${lastPath}. Not the one you wanted? Reset in the top ` +
                `bar clears it and stops it coming back.`,
              )
            })
        })
        // Fire-and-forget, same as the disk path below: a backend that isn't up must
        // never block the app, and the save gate opens either way.
        .catch(() => {})
        .finally(() => { bootDone.current = true })
      return
    }
    const recalled = booted.localFolderRoot == null

    apiClient.get<ProjectLoadResponse>('/api/project/load', { params: { path: root } })
      .then(({ data }) => {
        // First, and unconditionally: the pointer corrections. They must survive the
        // `return` below, which is the whole reason they arrive as their own field.
        const healed = applyMediaHeals(data.media_heals)
        if (healed) {
          info('Repaired this project\'s clip links',
               `${healed} shot(s) named a video that is not on disk, or the silent take beside its ` +
               `dubbed one. The links were corrected; nothing on disk was changed.`)
        }
        const plan = planProjectLoad(data, root)
        const snapshot = plan.snapshot
        if (!snapshot) return                       // disk holds nothing → keep memory

        const state = usePipelineStore.getState()
        const memHasContent = hasContent(state)
        // Both stamps must be REAL before a comparison means anything. `savedAt === 0` is
        // UNKNOWN, not ancient — a pre-F2 browser copy has no stamp at all, and reading it
        // as "older than any dated disk copy" made boot replace a populated live project on
        // every reload — and accounted for 20 of the 26 e2e failures measured 2026-08-01:
        // the specs seed an undated snapshot, their own unmocked autosave had left a dated
        // pipeline_state.json under the seeded root, and boot pulled it back over the state
        // they were asserting on (loadProjectState also resets activeStage to 1, which is
        // why so many failed on a missing stage-5 control). So: take disk when memory holds
        // NO work, or when both
        // copies are dated and disk genuinely leads. Undated-but-populated memory is left
        // alone; it self-corrects on the next reload, since the persist write stamps it.
        const disk = diskSavedAt(data)
        const diskIsNewer = disk > 0 && state.savedAt > 0 && disk > state.savedAt + SAVE_SKEW_MS
        // Memory is populated AND not provably behind → it is the live copy; never clobber
        // it (the user may have edited since the last successful disk write).
        if (memHasContent && !diskIsNewer) return

        state.loadProjectState(snapshot)
        const name = data.manifest?.name ?? root
        info(
          memHasContent ? 'Restored a newer copy from disk' : 'Project restored from disk',
          memHasContent
            ? `This tab's saved copy was behind the project folder — reloaded ${name}.`
            : recalled
              ? `This browser had no saved copy of ${name} — reopened it from its project folder.`
              : `${name} — the browser copy held no work, so the project folder was used.`,
        )
      })
      // Fire-and-forget: a backend that isn't up yet must not block the app. Memory
      // stays as-is, and the save gate opens either way.
      .catch(() => {})
      .finally(() => { bootDone.current = true })
  }, [info])

  // UNO EN VUELO. El guardado se rearma cada 1,5 s con cada cambio del store, y durante
  // un lote largo (tableros aterrizando uno tras otro) el store cambia sin parar. Sin
  // esta guarda, si un guardado se demoraba, los siguientes se apilaban detrás — cada
  // uno un POST más esperando su turno sobre el MISMO fichero — y el atasco se
  // alimentaba a sí mismo. Con ella, mientras hay uno en vuelo el siguiente cambio sólo
  // deja constancia; cuando el POST termina, si hubo cambios, se guarda UNA vez más con
  // el estado de ese momento. Nada se pierde: el último estado siempre llega.
  const inFlight = useRef(false)
  const dirtyWhileInFlight = useRef(false)

  useEffect(() => {
    const save = () => {
      // Never write before boot has decided — see bootDone.
      if (!bootDone.current) return
      if (inFlight.current) { dirtyWhileInFlight.current = true; return }
      const state = usePipelineStore.getState()
      const root = state.localFolderRoot
      if (!root) return
      let snapshot: ProjectSnapshot
      try {
        snapshot = partializeState(state)
      } catch { return }
      // Guard: never overwrite a project with an EMPTY snapshot (all stages have
      // zero versions). This happens right after opening a legacy project that
      // has no saved state — autosaving emptiness would mask its on-disk work.
      if (!hasContent(snapshot)) return
      // Non-blocking, but NOT silent. This used to end in `.catch(() => {})`, which is
      // how a real, reproducible backend fault stayed invisible: concurrent saves fought
      // over one fixed tmp filename and returned 500s (fixed in storage.py), and the only
      // symptom the user could ever have seen was a project folder that had quietly
      // stopped tracking their work. Disk is the DURABLE copy — the browser copy has a
      // quota a long-form project exceeds — so "not saving to disk" is precisely the
      // failure that must not be swallowed. A warning toast is sticky in this app (see
      // Toast.tsx: warnings and errors never auto-dismiss), which is the persistence
      // this needs; the ref above is what keeps it to one.
      inFlight.current = true
      dirtyWhileInFlight.current = false
      apiClient.post('/api/project/save-state', { project_path: root, state: snapshot })
        .then(() => { saveFailing.current = false })
        .catch((err: Error) => {
          if (saveFailing.current) return
          saveFailing.current = true
          warning(
            'Not saving to disk',
            `Take One Studio could not write this project to ${root} — ${err.message}. Your work is only ` +
            `in this browser tab right now. Keep the tab open, and check the backend is running ` +
            `and the folder is reachable; saving resumes on its own once it is.`,
          )
        })
        .finally(() => {
          inFlight.current = false
          // Hubo cambios mientras este guardado viajaba: se guarda UNA vez más, con el
          // estado de ahora, en vez de haber apilado un POST por cada cambio.
          if (dirtyWhileInFlight.current) { dirtyWhileInFlight.current = false; save() }
        })
    }

    // Debounce: the store changes on every keystroke/generation tick — coalesce
    // to one disk write ~1.5s after activity settles.
    const unsub = usePipelineStore.subscribe(() => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(save, 1500)
    })
    return () => {
      unsub()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [warning])   // stable (useCallback in ToastProvider) — this still subscribes once

  return null
}
