'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Milestone, ShieldCheck, CheckCircle, AlertTriangle, RefreshCw, Save,
  Plus, Trash2, ChevronUp, ChevronDown, TrendingUp, TrendingDown, Minus, Sparkles,
  Activity, Clock,
} from 'lucide-react'
import { useProjectGuard } from '@/lib/useProjectGuard'
import { Button } from '@/components/ui/Button'
import { usePipelineStore } from '@/store/pipeline.store'
import { useToast } from '@/components/ui/Toast'
import { pipelineApi, type BibleResponse, type BibleSequence, type FilmBible, type SpineCheck } from '@/lib/api/pipeline.api'
import { cn } from '@/lib/utils'

/** `answers` is a LIST on disk, but bibles written before that carry a bare string and
 *  check_story_spine still accepts one — so every read normalises and every write emits
 *  a list. Editing a legacy bible must not be what finally breaks it. */
const answersOf = (s: BibleSequence): string[] =>
  Array.isArray(s.answers) ? s.answers.map(String) : s.answers ? [String(s.answers)] : []

/** Does this bible actually SAY anything? GET /api/bible never 404s by design — a project
 *  that has not run a breakdown answers 200 with `{}` — and an empty object is TRUTHY, so
 *  the `!bible` empty state below never rendered on a successful load: those projects got
 *  the full editor over a document that does not exist. Test the CONTENT, not the object.
 *  The keys the server stamps on save (savedAt, story_checks, spine_approved) are
 *  bookkeeping about a bible, not a bible. */
const hasBibleContent = (b: FilmBible | null): b is FilmBible =>
  !!b && (
    (b.sequences?.length ?? 0) > 0 ||
    (b.characters?.length ?? 0) > 0 ||
    !!(b.logline ?? '').trim() ||
    !!(b.tone ?? '').trim()
  )

/** The three states `direction` can hold. Only 'up'/'down' are counted by the Value
 *  change gate; anything else (the model is told to write "unchanged") reads as the
 *  protagonist ending where they started. */
const DIRECTIONS: Array<{ value: string; label: string }> = [
  { value: 'up',        label: 'Up — better off' },
  { value: 'down',      label: 'Down — worse off' },
  { value: 'unchanged', label: 'Unchanged — nothing moves' },
]

/** claude_agents.SEQ_MODES, verbatim and in the same order — the gates match these exact
 *  strings and read anything else as ABSENT, so a "melancholy" typed here would silently
 *  stop counting towards the tonal range.
 *
 *  The colours are LITERAL, not theme tokens, and that is deliberate: the palette has
 *  four hues (cyan/orange/green/red) and a chart that means "mode" needs nine. They are
 *  all mid-tone so they read on the light theme and the dark one without switching. */
const MODES: Array<{ value: string; label: string; color: string }> = [
  { value: 'action',     label: 'action',     color: '#FF6B1A' },
  { value: 'dread',      label: 'dread',      color: '#7C6CF0' },
  { value: 'horror',     label: 'horror',     color: '#FF3B5C' },
  { value: 'comedy',     label: 'comedy',     color: '#F5B301' },
  { value: 'quiet',      label: 'quiet',      color: '#6B7A8F' },
  { value: 'wonder',     label: 'wonder',     color: '#00D4FF' },
  { value: 'grief',      label: 'grief',      color: '#C06C84' },
  { value: 'reveal',     label: 'reveal',     color: '#00E5A0' },
  { value: 'procedural', label: 'procedural', color: '#4E9BD8' },
]
/** claude_agents.SEQ_RELIEF_MODES — the valve. A peak with none of these within two
 *  sequences is what the Relief gate reports. */
const RELIEF_MODES = new Set(['comedy', 'quiet', 'wonder'])
const modeColor = (m?: string) => MODES.find((x) => x.value === m)?.color ?? ''

/** claude_agents.SEQ_OBSTACLE_TYPES. 'self' is the one that produced FARO. */
const OBSTACLE_TYPES: Array<{ value: string; label: string }> = [
  { value: 'external_agent', label: 'external agent — someone with their own agenda' },
  { value: 'environment',    label: 'environment — the place itself' },
  { value: 'rule',           label: 'rule — a law, an order, a physical limit' },
  { value: 'self',           label: 'self — their own hesitation (max twice in a film)' },
]

/** The tension at which _check_drama_layer starts calling a sequence a PEAK — and starts
 *  demanding it cost something irreversible. Drawn on the chart so "my film never gets
 *  there" is visible without reading a single gate. */
const PEAK_TENSION = 8

const COST_LEVELS: Array<{ value: number; label: string }> = [
  { value: 0, label: '0 — nothing given up yet' },
  { value: 1, label: '1 — something small, and it stays gone' },
  { value: 2, label: '2 — something that hurts' },
  { value: 3, label: '3 — everything they came in with' },
]

/** The sequence's cost as an object, whatever shape it is stored in. Mirrors
 *  claude_agents._seq_event: a bare string is half the model's answers and reads as the
 *  thing lost, so throwing it away would blank a cost the spine did state. */
const eventOf = (s: BibleSequence): { irreversible?: boolean; who?: string; loses?: string } => {
  const ev = s.event
  if (typeof ev === 'string') return ev.trim() ? { irreversible: true, loses: ev.trim() } : {}
  return ev ?? {}
}

/** This sequence's DECLARED share of the runtime, or null. Mirrors _seq_share, including
 *  the "> 1 means a percentage" rule — a bible written by the model often says 12 for
 *  12%, and showing that as 12× the film would be a lie the user cannot decode. */
const shareOf = (s: BibleSequence): number | null => {
  const raw = s.seconds_share
  if (raw === undefined || raw === null || (raw as unknown) === '') return null
  const f = Number(raw)
  if (!Number.isFinite(f)) return null
  const v = f > 1 ? f / 100 : f
  return v > 0 ? v : null
}

/** Tension as a number in 1-10, or null. Mirrors _seq_tension: absent and 1 are
 *  DIFFERENT facts and the chart has to show the difference — inventing a middle value
 *  for "not declared" is the `or 5.0` mistake that disarmed three gates in this app. */
const tensionOf = (s: BibleSequence): number | null => {
  const t = Number(s.tension)
  if (!Number.isFinite(t)) return null
  return Math.max(1, Math.min(10, Math.round(t)))
}

/** Widths for the chart, normalised to sum to 1 — the LAYOUT copy of
 *  claude_agents.spine_shares (declared shares as given, undeclared take the mean of the
 *  declared, nothing declared = equal stretches).
 *
 *  This is presentation only. The RUNTIME SHARE GATE reads the raw declared numbers on
 *  the backend and must keep doing so: if the verdict were computed from these it could
 *  never fail, and the whole point of the strip below is to show a plan that does not
 *  add up as one that does not add up. */
function layoutShares(seqs: BibleSequence[]): number[] {
  const n = seqs.length
  if (!n) return []
  const declared = seqs.map(shareOf)
  const known = declared.filter((d): d is number => d !== null)
  const fill = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1 / n
  const vals = declared.map((d) => (d === null ? fill : d))
  const total = vals.reduce((a, b) => a + b, 0)
  return total > 0 ? vals.map((v) => v / total) : vals.map(() => 1 / n)
}

/** Where each sequence FALLS in the finished film, 0-1, at the MIDPOINT of its stretch —
 *  claude_agents.spine_positions, for the same reason: a long finale "is at" the middle
 *  of its own stretch. Used here only to say WHERE a gate expected something. */
function layoutPositions(seqs: BibleSequence[]): number[] {
  let acc = 0
  return layoutShares(seqs).map((w) => { const at = acc + w / 2; acc += w; return at })
}

/** m:ss — the only unit an editor thinks in. Seconds alone made a 0.18 share unreadable. */
const clock = (secs: number) => {
  const s = Math.max(0, Math.round(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Which of THIS spine's sequences a gate's notes name. Matched against the real ids
 *  rather than by pattern, so a renamed sequence still lights up and SEQ_1 never matches
 *  inside SEQ_10. The backend already names them in the prose; this only makes them
 *  clickable — a gate that says "SEQ_7 costs nothing" is useless if finding SEQ_7 in a
 *  15-sequence spine is a scroll hunt. */
function idsNamedIn(notes: string, seqs: BibleSequence[]): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return seqs.map((s) => s.id).filter((id) =>
    !!id && new RegExp(`(^|[^A-Za-z0-9_])${esc(id)}([^A-Za-z0-9_]|$)`).test(notes))
}

/** What to DO about a failing gate, one line, per gate label. The backend notes say what
 *  is wrong and are quoted verbatim; these say which field to touch. Shown only on
 *  failures — on a passing gate it would be noise. Keys are the labels
 *  claude_agents._check_drama_layer emits; a gate with no entry simply shows nothing. */
const GATE_HELP: Record<string, string> = {
  'Irreversible peak': 'Tick “costs something irreversible” on a sequence at tension 8+ and name the thing in “loses”. It has to stay lost.',
  'Peak placement': 'The highest tension belongs in the last quarter of the runtime — raise a late sequence, or give the late ones a bigger share.',
  'Relief': 'Set mode to comedy, quiet or wonder on one of the two sequences after each peak. In The Tomorrow War the sequence before the finale is comedy.',
  'Tonal range': 'Use at least 4 different modes and keep no single one above 40% of the film. The 13 produced scripts use 8 of the 9 each.',
  'Agency': 'Change obstacle_type away from “self” on the sequences below: a protagonist only ever stopped by their own hesitation cannot be beaten.',
  'Recurring adversary': 'Name the same obstacle_owner in 3 or more sequences so a threat can build across the film.',
  'Escalation': 'cost_level never returns to 0 once it has risen — every sequence in the final third must be at 1 or more.',
  'Runtime share': 'The shares must sum to 1.00 and must NOT be even: the third act is not the size of the first in any of the 13.',
}

/** What the stage needs to know about the spine to gate on it, reported up from every
 *  SERVER answer this panel gets. `hasSpine` is about DISK — a sequence typed in but
 *  not saved is not something anyone can approve, and a project with no spine at all
 *  must not be gated (see BreakdownView.handleGenerate). */
export interface SpineStatus {
  hasSpine: boolean
  approved: boolean
}

/**
 * The STORY SPINE — the one part of the film bible the user is meant to argue with.
 *
 * derive_film_bible writes {logline, tone, characters, sequences} to Script/bible.json
 * during the breakdown, check_story_spine scores the sequences with four arithmetic
 * gates, and until now BOTH were read only by the batch prompts: the person who has to
 * live with the film could not see, let alone change, the document that decides what it
 * is about. This panel is the way in — Take One Studio writes the spine, the director edits it
 * and approves it.
 *
 * Edits are LOCAL until Save/Approve. The gates shown are the ones the BACKEND computed
 * over what is on disk (contract C4 recomputes on PUT), never a second implementation of
 * the same arithmetic in TypeScript — two copies of a rule is how they drift apart. While
 * there are unsaved edits the gate strip is marked stale instead of lying.
 *
 * F1: the spine can now also be DERIVED from here (POST /api/bible/derive). Until that
 * existed the bible only came into being inside the phase-2 breakdown, so the first time
 * this panel had anything to show, the shot list had already been written from it —
 * approval after the fact is not approval.
 *
 * 2026-08-12 — TWO CHANGES, both from the same finding. A spine for THE DIVORCE DRAMA
 * QUEEN 2 read 10/12 gates PASSING while describing a different film (script: JOEL and
 * MARA; spine: CLARA, with DANIEL owning four obstacles and no entry in `characters`),
 * because it had been written by "Design the spine from the concept" — an endpoint that
 * deliberately never sees the script, so the model invented both names and nothing
 * checked. So:
 *
 *   · The DESIGN route is gone from this panel. /api/bible/propose still exists and is
 *     documented as unreachable; the two cast gates added the same day are what would
 *     have caught it, and derivation cannot invent a cast in the first place.
 *   · Deriving is no longer a button to be discovered. Approving the script requests it
 *     (pendingSpineDerive), this panel honours the request ONCE and only where there is
 *     nothing to lose, and re-deriving over an existing spine is an explicit, confirmed,
 *     destructive action in the header.
 */
export function StorySpinePanel({ onStatusChange }: { onStatusChange?: (s: SpineStatus) => void } = {}) {
  const projectName     = usePipelineStore((s) => s.projectName)
  const localFolderRoot = usePipelineStore((s) => s.localFolderRoot)
  const targetDurationSecs = usePipelineStore((s) => s.targetDurationSecs)
  // The approved script — the only input the derivation takes. Read from the store the
  // same way BreakdownView reads it for the breakdown itself, so both see one text.
  const script = usePipelineStore((s) => {
    const s1 = s.stages[1]
    if (!s1.activeVersionId) return ''
    return (s1.versions.find((v) => v.id === s1.activeVersionId)?.data as { content?: string } | undefined)?.content ?? ''
  })
  // Stage 1 asking for a derivation. Read as a value (not through getState) so honouring
  // it is an effect on a real dependency: this panel is often mounted by the very
  // navigation the approval fires.
  const pendingSpineDerive = usePipelineStore((s) => s.pendingSpineDerive)
  const clearSpineDerive   = usePipelineStore((s) => s.clearSpineDerive)
  const { success, error: toastError, warning } = useToast()
  const isCurrentProject = useProjectGuard()

  const [bible,   setBible]   = useState<FilmBible | null>(null)
  const [checks,  setChecks]  = useState<SpineCheck[]>([])
  const [approved, setApproved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [deriving, setDeriving] = useState(false)
  const [dirty,   setDirty]   = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Bumped on every SERVER response. The row fields are uncontrolled (defaultValue +
  // onBlur), so nothing would repaint them when the backend hands back a normalised
  // bible — folding this into the row key remounts them with the stored text instead
  // of leaving the user editing a copy the server already rewrote.
  const [rev,     setRev]     = useState(0)

  const sequences = bible?.sequences ?? []

  // The stage gates "Generate Breakdown" on the approval state, and this panel only
  // exists while the Story tab is open — so every SERVER answer is reported up, not
  // just the first one. Through a ref: an inline arrow from the parent would change
  // `load`'s identity on every parent render and re-fire the effect that calls it.
  const statusRef = useRef(onStatusChange)
  useEffect(() => { statusRef.current = onStatusChange }, [onStatusChange])
  const report = useCallback((res: BibleResponse) => {
    statusRef.current?.({ hasSpine: (res.bible?.sequences?.length ?? 0) > 0, approved: !!res.approved })
  }, [])

  /** Adopt a server answer — the shape GET, PUT and POST /derive all return. */
  const adopt = useCallback((res: BibleResponse) => {
    setBible(res.bible ?? {})
    setChecks(res.checks ?? [])
    setApproved(!!res.approved)
    setDirty(false)
    setRev((r) => r + 1)
    report(res)
  }, [report])

  const load = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const res = await pipelineApi.getBible({ projectName, projectPath: localFolderRoot ?? '' })
      if (!isCurrentProject()) return
      adopt(res)
    } catch (e: unknown) {
      // A project that never ran a breakdown has no bible.json — that is the normal
      // empty state, not a failure, so it renders as a message rather than a red box.
      if (!isCurrentProject()) return
      setBible(null)
      setChecks([])
      setErrorMsg(e instanceof Error ? e.message : 'Could not read the film bible')
    } finally {
      setLoading(false)
    }
  }, [projectName, localFolderRoot, isCurrentProject, adopt])

  // Deferred one microtask so load()'s opening setLoading isn't a synchronous setState
  // inside the effect body — the same shape the script view uses for its rollback sync,
  // and what the react-hooks lint rule rejects outright.
  useEffect(() => { void Promise.resolve().then(load) }, [load])

  /** Write the spine back. `approve` undefined leaves bible.spine_approved untouched. */
  const persist = async (next: FilmBible, approve?: boolean) => {
    setSaving(true)
    setErrorMsg(null)
    try {
      // story_checks is deliberately NOT sent. server.py's breakdown QC prefers the
      // stored copy over recomputing (`bible.get("story_checks") or check_story_spine(...)`),
      // so shipping the gates we were handed at load time would freeze a verdict about a
      // spine the user just rewrote. Dropping the key leaves the backend free to write
      // fresh ones — and if it doesn't, the QC recomputes them itself.
      const payload: FilmBible = { ...next }
      delete payload.story_checks
      const res = await pipelineApi.saveBible({
        projectName, projectPath: localFolderRoot ?? '',
        bible: payload, ...(approve === undefined ? {} : { approved: approve }),
      })
      if (!isCurrentProject()) return
      adopt({ ...res, bible: res.bible ?? payload })
      // Same split as the gate strip's chip: a toast that counts advisory notes as
      // failures teaches the user to read every save as a setback.
      const _blocking = (res.checks ?? []).filter((c) => !c.passed && c.blocking).length
      const _notes    = (res.checks ?? []).filter((c) => !c.passed).length - _blocking
      success(approve ? 'Story spine approved ✓' : 'Story spine saved',
        _blocking ? `${_blocking} blocking issue(s) · ${_notes} note(s)`
        : _notes  ? `nothing blocking · ${_notes} note(s)`
        : `all ${res.checks?.length ?? 0} gates passing`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed'
      setErrorMsg(msg)
      toastError('Story spine save failed', msg)
    } finally {
      setSaving(false)
    }
  }

  /**
   * F1: ask Take One Studio for a spine NOW, from the script alone — no breakdown needed.
   *
   * This is the whole point of the endpoint: the document that decides what the film
   * is ABOUT has to exist while it can still be argued with. What comes back is never
   * approved (the backend derives, it does not vote), so the user still has to read it
   * and press Approve — which is what the breakdown then gates on.
   *
   * Fired without a click from the stage-1 approval (see the effect below) and from the
   * empty states. Over an EXISTING spine it is only reachable through `rederive`, which
   * asks first: a derivation replaces `sequences` wholesale, so an unguarded one silently
   * discards whatever the user wrote.
   */
  const derive = useCallback(async () => {
    if (!script.trim() || deriving) return
    setDeriving(true)
    setErrorMsg(null)
    try {
      const res = await pipelineApi.deriveBible({
        projectName, projectPath: localFolderRoot ?? '', script, targetDurationSecs,
      })
      if (!isCurrentProject()) return
      adopt(res)
      const n = res.bible?.sequences?.length ?? 0
      if (n === 0) {
        // A 200 with nothing in it is still a dead end — say so instead of dropping the
        // user back onto the same empty screen with no explanation.
        setErrorMsg('Take One Studio returned no sequences for this script. Try again, or start the spine by hand.')
      } else {
        success('Story spine ready', `${n} sequence(s) — read it, change it, then approve`)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not derive the story spine'
      if (!isCurrentProject()) return
      setErrorMsg(msg)
      toastError('Story spine derivation failed', msg)
    } finally {
      setDeriving(false)
    }
  }, [script, deriving, projectName, localFolderRoot, targetDurationSecs,
      isCurrentProject, adopt, success, toastError])

  /**
   * Honour a derivation requested by the stage-1 approval — once, and only on a project
   * with nothing to lose.
   *
   * The flag is cleared BEFORE the request goes out, not after it lands: a failed
   * derivation must not re-fire on the next render, and the empty state below still
   * offers the button. `sequences.length` is the guard that matters — re-deriving over an
   * existing spine is `rederive`'s job, and it asks first.
   *
   * Deferred a microtask like `load`: the async body's first line is a setState, and an
   * effect that can reach one synchronously is what the react-hooks rule rejects.
   */
  useEffect(() => {
    if (!pendingSpineDerive || loading || deriving) return
    clearSpineDerive()
    if (!script.trim()) return
    // Declining is not the same as doing nothing quietly. Re-approving a script the user
    // has just rewritten asks for a spine over one that already exists — keeping it is
    // right (it may be hand-edited and approved), but leaving the approval to look like it
    // did nothing is how the spine ends up describing the previous draft.
    if (sequences.length > 0) {
      void Promise.resolve().then(() => warning(
        'Story spine kept',
        'This project already has one, so nothing was overwritten. If the script has '
        + 'changed, use Re-derive.',
      ))
      return
    }
    void Promise.resolve().then(derive)
  }, [pendingSpineDerive, loading, deriving, sequences.length, script,
      clearSpineDerive, derive, warning])

  /**
   * Re-derive over a spine that already exists — the escape hatch this panel did not have.
   *
   * Deriving replaces `sequences` wholesale, so the button was deliberately confined to
   * the empty states. That protected the user's edits and left no way at all to redo a
   * spine that is simply WRONG — which is how a bible describing a different film survived
   * ten gates. So the action exists, and it is destructive out loud: it names what it
   * discards, and it names the approval it withdraws.
   *
   * The un-approve is not optional bookkeeping: POST /api/bible/derive answers 409 on an
   * approved spine (server.py:2350) precisely so nothing can replace an approved document
   * behind the user's back. Withdrawing the approval IS the user's answer to that, so it
   * goes out first — and if it fails, the derivation is not attempted.
   */
  const rederive = async () => {
    if (!script.trim() || deriving || saving) return
    if (typeof window !== 'undefined' && !window.confirm(
      'Re-deriving reads the approved script again and REPLACES every sequence in this '
      + 'spine — including anything you edited here'
      + (dirty ? ', and the edits you have not saved yet' : '')
      + '.\n\n'
      + (approved ? 'This spine is APPROVED. Re-deriving withdraws that approval — you will '
                  + 'have to read the new one and approve it again.\n\n' : '')
      + 'Re-derive it?'
    )) return
    if (approved) {
      // Not persist(): its toast says "saved", which is not what just happened, and the
      // derivation below adopts the server's answer anyway.
      setSaving(true)
      try {
        const res = await pipelineApi.saveBible({
          projectName, projectPath: localFolderRoot ?? '', bible: bible ?? {}, approved: false,
        })
        if (!isCurrentProject()) return
        // Adopted BEFORE the derivation, not after it. The approval is already withdrawn
        // on disk at this point; if the derive below then fails, a panel still showing
        // "Approved" would be describing a project state that no longer exists.
        adopt({ ...res, bible: res.bible ?? bible ?? {} })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Could not withdraw the approval'
        setErrorMsg(msg)
        toastError('Re-derive stopped', msg)
        return
      } finally {
        setSaving(false)
      }
    }
    await derive()
  }

  // ── Jumping from a gate (or a bar) to the sequence it is about ─────────────
  // A failing gate names ids in its prose; in a 15-sequence spine that is a scroll hunt,
  // which is how a gate stops being read at all. The chips and the chart bars scroll the
  // row into view and flash it.
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [focusSeq, setFocusSeq] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealSeq = useCallback((id: string) => {
    rowRefs.current[id]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFocusSeq(id)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFocusSeq(null), 2000)
  }, [])
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  // ── Local edits ────────────────────────────────────────────────────────────
  /**
   * Every edit is an UPDATER over the sequences in state, never an array built from the
   * render's `sequences`.
   *
   * It used to take the finished array, and that silently lost edits as soon as two of
   * them landed in one React flush: both were computed from the same stale snapshot and
   * the second overwrote the first. Nothing in the old panel triggered it — every field
   * was a textarea that commits on blur, one at a time. The drama strip mixes
   * commit-on-blur inputs with selects and a checkbox that commit immediately, so
   * clicking the "costs something irreversible" box straight after typing a share is the
   * ordinary case, and MEASURED (e2e story_spine_curve) the checkbox refused to tick:
   * the share's blur update and the checkbox's change update were both derived from the
   * pre-edit array, so the one that landed last erased the other.
   */
  const mutate = (update: (seqs: BibleSequence[]) => BibleSequence[]) => {
    setBible((b) => ({ ...(b ?? {}), sequences: update(b?.sequences ?? []) }))
    setDirty(true)
  }

  const patchSeq = (index: number, patch: Partial<BibleSequence>) =>
    mutate((seqs) => seqs.map((s, i) => (i === index ? { ...s, ...patch } : s)))

  /**
   * Set — or REMOVE — one drama field. Removal is the load-bearing half.
   *
   * PUT /api/bible merges what it is sent over what is stored and re-scores that; it
   * does not run normalise_sequence_drama, so whatever this writes is what the gates
   * read. Every one of the eight drama gates is guarded by "does ANY sequence declare
   * the field I read", which is what keeps them off the bibles written before the layer
   * existed — so writing "" or 0 for "I don't want to say" would switch a whole gate on
   * for the entire spine. Clearing a field has to delete the key.
   */
  const patchDrama = (index: number, key: keyof BibleSequence, value: unknown) =>
    mutate((seqs) => seqs.map((s, i) => {
      if (i !== index) return s
      const next = { ...s }
      if (value === undefined || value === null || value === '') delete next[key]
      else (next as Record<string, unknown>)[key] = value
      return next
    }))

  /** The cost object, edited one key at a time and normalised to the stored shape — a
   *  legacy bare string is read through eventOf and written back as {irreversible, who,
   *  loses}. An event that says nothing is removed, not left as an empty husk the peak
   *  gate would still have to inspect. The merge happens INSIDE the updater: ticking the
   *  box and typing what is lost are two separate edits, and reading the other half off
   *  the last render is how the first of them disappears. */
  const patchEvent = (index: number, patch: { irreversible?: boolean; who?: string; loses?: string }) =>
    mutate((seqs) => seqs.map((s, i) => {
      if (i !== index) return s
      const merged = { ...eventOf(s), ...patch }
      const alive = !!merged.irreversible || !!(merged.loses ?? '').trim() || !!(merged.who ?? '').trim()
      const next = { ...s }
      if (alive) {
        next.event = { irreversible: !!merged.irreversible, who: (merged.who ?? '').trim(), loses: (merged.loses ?? '').trim() }
      } else {
        delete next.event
      }
      return next
    }))

  /** Renaming a sequence rewrites every `answers` reference to it. The gate matches ids
   *  by exact string, so without this a rename silently turns "closed" questions back
   *  into dangling ones — the failure would only surface as a gate flipping on save. */
  const renameSeq = (index: number, nextId: string) => {
    if ((nextId.trim() || sequences[index]?.id) === sequences[index]?.id) return
    mutate((seqs) => {
      const prevId = seqs[index]?.id ?? ''
      const id = nextId.trim() || prevId
      if (id === prevId) return seqs
      return seqs.map((s, i) => ({
        ...s,
        ...(i === index ? { id } : {}),
        answers: answersOf(s).map((a) => (a === prevId ? id : a)),
      }))
    })
  }

  const toggleAnswer = (index: number, targetId: string) =>
    mutate((seqs) => seqs.map((s, i) => {
      if (i !== index) return s
      const cur = answersOf(s)
      return { ...s, answers: cur.includes(targetId) ? cur.filter((a) => a !== targetId) : [...cur, targetId] }
    }))

  const moveSeq = (index: number, delta: number) =>
    mutate((seqs) => {
      const to = index + delta
      if (to < 0 || to >= seqs.length) return seqs
      const next = [...seqs]
      const [row] = next.splice(index, 1)
      next.splice(to, 0, row)
      return next
    })

  const addSeq = () =>
    mutate((seqs) => {
      // Ids must be unique — derive_film_bible dedupes for the same reason: a duplicate
      // collapses in the gates' set arithmetic and "Questions answered" passes with
      // nothing actually answered.
      const taken = new Set(seqs.map((s) => s.id))
      let n = seqs.length + 1
      while (taken.has(`SEQ_${n}`)) n += 1
      return [...seqs, {
        id: `SEQ_${n}`, covers: '', question_opened: '', answers: [],
        value_in: '', value_out: '', direction: 'unchanged', obstacle: '',
      }]
    })

  const removeSeq = (index: number) =>
    mutate((seqs) => {
      const gone = seqs[index]?.id
      return seqs
        .filter((_, i) => i !== index)
        // Drop references to the deleted sequence, for the same reason renameSeq rewrites
        // them: an answer pointing at nothing is counted as no answer at all.
        .map((s) => ({ ...s, answers: answersOf(s).filter((a) => a !== gone) }))
    })

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-text-muted text-sm">
        <span className="w-3.5 h-3.5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
        Reading the film bible…
      </div>
    )
  }

  // No bible on disk (or unreadable). Calm, and it says what produces one. Keyed on the
  // CONTENT because a bible-less project answers 200 with `{}`, not 404 — see
  // hasBibleContent: this branch used to be unreachable except on a thrown request.
  if (!hasBibleContent(bible)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center" data-testid="spine-empty">
        <Milestone size={22} className="text-text-dim" />
        <p className="text-sm text-text-muted max-w-md leading-relaxed">
          No film bible for <span className="font-mono text-text-primary">{projectName}</span> yet.
          Take One Studio reads one out of the approved script — logline, characters and the story
          spine — so you can change it and approve it <span className="text-text-primary">before</span> the
          shot list is written from it.
        </p>
        {/* Normally nobody reads this: approving the script fires the derivation and this
            state is replaced by the spinner below within a second. It stays because the
            request can fail, and because a project can reach this tab by other routes. */}
        {/* The call is a full LLM pass: minutes on a long script, and this empty state is
            the only thing on screen. Say what is happening rather than leaving a button
            spinning over a blank panel. */}
        {deriving && (
          <p className="text-[11px] text-cyan flex items-center gap-2" data-testid="spine-deriving">
            <span className="w-3 h-3 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
            Take One Studio is reading the script and working out the spine…
          </p>
        )}
        {errorMsg && <p className="text-[11px] text-text-dim font-mono max-w-md">{errorMsg}</p>}
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <Button variant="primary" size="sm" icon={<Sparkles size={12} />}
            loading={deriving} disabled={!script.trim()}
            title={script.trim() ? 'Read the approved script and write its spine'
                                 : 'There is no script yet — write or load one in Stage 1'}
            onClick={() => void derive()} data-testid="spine-derive">
            Derive it from the script
          </Button>
          <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />} disabled={deriving}
            onClick={() => void load()}>
            Check again
          </Button>
          {/* Hand-authoring stays reachable: before this branch was fixed an empty `{}`
              bible fell through to the editor, so writing a spine without a breakdown was
              possible. addSeq seeds `sequences` on the null bible and this branch yields
              to the editor on the next render. */}
          <Button variant="ghost" size="sm" icon={<Plus size={12} />} onClick={addSeq} disabled={deriving}
            data-testid="spine-empty-add">
            Start the spine by hand
          </Button>
        </div>
        {!script.trim() && (
          <p className="text-[10px] text-text-dim" data-testid="spine-derive-noscript">
            The spine is derived from the script — write or load one in Stage 1 first.
          </p>
        )}
      </div>
    )
  }

  const failing = checks.filter((c) => !c.passed)
  const blocking = failing.filter((c) => c.blocking)

  // Every sequence a FAILING gate names, so the chart can ring the bars the verdict is
  // actually about. Passing gates name sequences too ("SEQ_4 costs a hand"); ringing
  // those would turn the mark into decoration.
  const flagged = new Set(failing.flatMap((c) => idsNamedIn(c.notes ?? '', sequences)))

  // WHERE a gate expected to find something. The positions are the same midpoint
  // arithmetic the backend measured with (spine_positions), so "the last quarter" here
  // is the last quarter the gate used — but the VERDICT stays the backend's; this only
  // answers "in which sequence did you expect it, then?", which a failure that names no
  // sequence at all ("no sequence reaches tension 8") otherwise leaves the user to guess.
  const posn = layoutPositions(sequences)
  const idsFrom = (from: number) => sequences.filter((_, i) => posn[i] >= from).map((s) => s.id)
  const expectedIn = (label: string): string => {
    if (label === 'Irreversible peak' || label === 'Peak placement') {
      const late = idsFrom(0.75)
      return late.length
        ? `Expected in the last quarter of the runtime — with these shares that is ${late.join(', ')}. Across the 13 produced scripts the last 9+ peak sits at 0.88 of the runtime (median 0.93).`
        : 'With these shares no sequence reaches the last quarter of the runtime, so there is nowhere for the peak to land — the shares themselves are the problem.'
    }
    if (label === 'Escalation') {
      const late = idsFrom(2 / 3)
      return late.length ? `The final third of this runtime is ${late.join(', ')} — the cost is read there.` : ''
    }
    return ''
  }

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="story-spine-panel">
      {/* ── Header: what this document is, and its approval state ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <Milestone size={14} className="text-cyan shrink-0" />
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-widest">
          Story spine
        </span>
        <span className={cn(
          'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono',
          approved ? 'text-green border-green/40 bg-green/10' : 'text-orange border-orange/40 bg-orange/10'
        )} data-testid="spine-approval-state">
          {approved ? 'Approved' : 'Not approved'}
        </span>
        {dirty && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono text-amber border-amber/40 bg-amber/10">
            Unsaved edits
          </span>
        )}
        {deriving && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono text-cyan border-cyan/40 bg-cyan/10 flex items-center gap-1.5"
            data-testid="spine-deriving">
            <span className="w-2.5 h-2.5 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
            Re-deriving
          </span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />}
            onClick={() => void load()} disabled={saving} data-testid="spine-reload">
            Reload
          </Button>
          {/* THE ESCAPE HATCH. Deriving replaces every sequence, so it used to be confined
              to the empty states — which protected an edited spine and left no way to redo
              a WRONG one. `rederive` asks first, names what it discards, and withdraws the
              approval the backend would otherwise 409 on. */}
          <Button variant="ghost" size="sm" icon={<Sparkles size={12} />}
            loading={deriving} disabled={!script.trim() || saving}
            title={script.trim() ? 'Read the script again and replace this spine'
                                 : 'There is no script to derive from — write or load one in Stage 1'}
            onClick={() => void rederive()} data-testid="spine-rederive">
            Re-derive
          </Button>
          <Button variant="secondary" size="sm" icon={<Save size={12} />}
            loading={saving} disabled={!dirty}
            onClick={() => void persist(bible)} data-testid="spine-save">
            Save &amp; re-run gates
          </Button>
          {/* No spine, no approval. There is nothing to approve in a bible with no
              sequences, and the PUT that approval fires used to re-score it — writing the
              blocking "no spine" failure into story_checks, which the breakdown QC prefers
              over recomputing. One click here bricked that gate for the project. The
              backend now guards it too; this keeps the button from lying about being
              available. */}
          <Button variant="approve" size="sm" icon={<CheckCircle size={12} />}
            loading={saving} disabled={sequences.length === 0}
            title={sequences.length === 0 ? 'There is no spine to approve yet' : undefined}
            onClick={() => void persist(bible, true)} data-testid="spine-approve">
            Aprobar espina
          </Button>
        </div>
        {sequences.length === 0 && (
          <p className="w-full text-[10px] text-text-dim leading-relaxed" data-testid="spine-approve-blocked">
            Nothing to approve yet — the spine needs at least one sequence.
          </p>
        )}
      </div>

      {/* The logline/tone are the bible's own header — read-only here on purpose: this
          panel owns the SPINE, and a second editor for the same fields in two places is
          how they end up disagreeing. */}
      {(bible.logline || bible.tone) && (
        <div className="text-[11px] text-text-muted leading-relaxed border-l-2 border-cyan/30 pl-2.5">
          {bible.logline}
          {bible.tone && <span className="text-text-dim"> · {bible.tone}</span>}
        </div>
      )}

      {errorMsg && (
        <div className="text-xs text-red bg-red/10 border border-red/30 rounded px-3 py-2">
          {errorMsg}
        </div>
      )}

      {/* ── A3: THE SHAPE OF THE FILM. Everything else on this screen is prose about the
             story; this is the story's silhouette, and it is the only thing here that
             answers "is my film flat?" before a frame is paid for. ── */}
      {sequences.length > 0 && (
        <SpineCurve sequences={sequences} targetSecs={targetDurationSecs}
          flagged={flagged} onPick={revealSeq} />
      )}

      {/* ── The four gates. These are the whole point: every other story judgement in
             this pipeline is a label an LLM wrote about itself; these are countable. ── */}
      <div className={cn(
        'rounded-lg border overflow-hidden',
        checks.length === 0 ? 'border-border bg-surface'
        : blocking.length   ? 'border-red/50 bg-red/5'
        : failing.length    ? 'border-amber/40 bg-amber/5'
        :                     'border-green/40 bg-green/5'
      )} data-testid="spine-gates">
        <div className="flex items-center gap-2 px-3 py-2">
          <ShieldCheck size={13} className={cn('shrink-0',
            blocking.length ? 'text-red' : failing.length ? 'text-amber' : 'text-green')} />
          <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted flex-1">
            Story gates
          </span>
          {dirty && (
            <span className="text-[9px] font-semibold text-amber uppercase tracking-wider">
              stale — save to re-run
            </span>
          )}
          {/* "11/14 passing" counted a note and a blocking failure as the same thing, so a
              spine with nothing actually wrong with it read as broken. The gates are two
              different instruments: `blocking` marks the ones that make a film illegible
              (claude_agents: "blocking marks the ones that make a film illegible rather
              than merely weaker"); the rest are ADVISORY by design and calibrated on 13
              feature-length scripts, so a short film collects notes it cannot always act
              on. Say which of the two you are looking at. */}
          {checks.length > 0 && (
            <span className={cn(
              'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border',
              blocking.length ? 'text-red border-red/40 bg-red/10'
              : failing.length ? 'text-amber border-amber/40 bg-amber/10'
              : 'text-green border-green/40 bg-green/10'
            )} data-testid="spine-gate-summary">
              {blocking.length
                ? `${blocking.length} blocking · ${checks.length - failing.length}/${checks.length} passing`
                : failing.length
                  ? `nothing blocking · ${failing.length} note${failing.length > 1 ? 's' : ''}`
                  : `all ${checks.length} passing`}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border/60 border-t border-border">
          {checks.length === 0 ? (
            <p className="col-span-full bg-surface px-3 py-3 text-[11px] text-text-muted">
              No gates reported — there is nothing to score until the spine has sequences.
            </p>
          ) : checks.map((c) => {
            // The ids this verdict is about, as buttons. The backend already names them in
            // the prose (it has always named them) — what was missing is that in a
            // 15-sequence spine "SEQ_11, SEQ_13" is a scroll hunt, so the gate got read as
            // a mood rather than as a list of things to go and fix.
            const named = c.passed ? [] : idsNamedIn(c.notes ?? '', sequences)
            // Only when the verdict names NOTHING: "no sequence reaches tension 8" is true
            // and useless on its own — the next question is always "then where was it
            // supposed to be?", and that is answerable from the shares.
            const where = !c.passed && named.length === 0 ? expectedIn(c.label) : ''
            return (
            <div key={c.label} className="bg-surface px-3 py-2.5 flex flex-col gap-1" data-testid={`spine-gate-${c.label}`}>
              <div className="flex items-center gap-1.5">
                {c.passed
                  ? <CheckCircle size={11} className="text-green shrink-0" />
                  : <AlertTriangle size={11} className={cn('shrink-0', c.blocking ? 'text-red' : 'text-orange')} />}
                <span className="text-[11px] font-semibold text-text-primary">{c.label}</span>
                <span className={cn(
                  'ml-auto text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border font-mono',
                  c.passed ? 'text-green border-green/40 bg-green/10'
                  : c.blocking ? 'text-red border-red/40 bg-red/10'
                  : 'text-orange border-orange/40 bg-orange/10'
                )}>
                  {c.passed ? 'pass' : c.blocking ? 'fail · blocking' : 'fail'}
                </span>
              </div>
              <p className="text-[10px] text-text-muted leading-relaxed">{c.notes}</p>
              {named.length > 0 && (
                <div className="flex flex-wrap items-center gap-1" data-testid={`spine-gate-seqs-${c.label}`}>
                  <span className="text-[9px] text-text-dim uppercase tracking-wider">go to</span>
                  {named.map((id) => (
                    <button key={id} onClick={() => revealSeq(id)}
                      title={`Jump to ${id}`}
                      className="px-1.5 py-0.5 rounded border border-orange/40 bg-orange/10 text-orange text-[10px] font-mono hover:border-orange">
                      {id}
                    </button>
                  ))}
                </div>
              )}
              {where && (
                <p className="text-[10px] text-text-dim leading-relaxed" data-testid={`spine-gate-where-${c.label}`}>
                  {where}
                </p>
              )}
              {!c.passed && GATE_HELP[c.label] && (
                <p className="text-[10px] text-cyan/80 leading-relaxed" data-testid={`spine-gate-help-${c.label}`}>
                  → {GATE_HELP[c.label]}
                </p>
              )}
            </div>
            )
          })}
        </div>
      </div>

      {/* ── The sequences ── */}
      {sequences.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center" data-testid="spine-no-sequences">
          <p className="text-sm text-text-muted max-w-md leading-relaxed">
            This bible has no sequences — it was written before the story spine existed.
            Have Take One Studio read one out of the script, or start it here.
          </p>
          {deriving && (
            <p className="text-[11px] text-cyan flex items-center gap-2">
              <span className="w-3 h-3 border-2 border-cyan border-t-transparent rounded-full animate-spin" />
              Take One Studio is reading the script and working out the spine…
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap justify-center">
            {/* Unguarded here and only here: there is no spine to overwrite. The header's
                Re-derive is the same call with a confirmation in front of it. */}
            <Button variant="primary" size="sm" icon={<Sparkles size={12} />}
              loading={deriving} disabled={!script.trim()}
              title={script.trim() ? undefined : 'There is no script yet — write or load one in Stage 1'}
              onClick={() => void derive()} data-testid="spine-derive-empty-seqs">
              Derive it from the script
            </Button>
            <Button variant="ghost" size="sm" icon={<Plus size={12} />} onClick={addSeq} disabled={deriving}>
              Add the first sequence
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sequences.map((seq, i) => {
            const answers = answersOf(seq)
            // Only an EARLIER sequence can be answered — the gate enforces the same
            // ordering, so offering later ones would only invite an edit that scores zero.
            const earlier = sequences.slice(0, i)
            const prevOut = i > 0 ? (sequences[i - 1].value_out ?? '').trim() : ''
            const seam = i > 0 && prevOut && (seq.value_in ?? '').trim() !== prevOut
            return (
              <div key={`${rev}_${seq.id || `row_${i}`}`}
                ref={(el) => { rowRefs.current[seq.id] = el }}
                className={cn('rounded-lg border bg-surface overflow-hidden transition-colors',
                  focusSeq === seq.id ? 'border-cyan ring-1 ring-cyan/40' : 'border-border')}
                data-testid={`spine-seq-${i}`}>
                {/* Row header: id · direction · reorder · delete */}
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-elevated/40">
                  <input
                    defaultValue={seq.id}
                    onBlur={(e) => renameSeq(i, e.target.value)}
                    className="w-28 bg-elevated border border-border rounded px-2 py-1 text-[11px] font-mono text-cyan focus:outline-none focus:border-cyan/50"
                    data-testid={`spine-seq-id-${i}`}
                  />
                  <select
                    value={DIRECTIONS.some((d) => d.value === seq.direction) ? seq.direction : 'unchanged'}
                    onChange={(e) => patchSeq(i, { direction: e.target.value })}
                    className="bg-elevated border border-border rounded px-2 py-1 text-[10px] text-text-primary focus:outline-none focus:border-cyan/50"
                    data-testid={`spine-seq-direction-${i}`}
                  >
                    {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                  {seq.direction === 'up' ? <TrendingUp size={12} className="text-green" />
                    : seq.direction === 'down' ? <TrendingDown size={12} className="text-orange" />
                    : <Minus size={12} className="text-text-dim" />}
                  <span className="ml-auto flex items-center gap-0.5">
                    <button onClick={() => moveSeq(i, -1)} disabled={i === 0} title="Move earlier"
                      className="text-text-dim hover:text-cyan disabled:opacity-30 disabled:hover:text-text-dim p-1"
                      data-testid={`spine-seq-up-${i}`}>
                      <ChevronUp size={13} />
                    </button>
                    <button onClick={() => moveSeq(i, 1)} disabled={i === sequences.length - 1} title="Move later"
                      className="text-text-dim hover:text-cyan disabled:opacity-30 disabled:hover:text-text-dim p-1"
                      data-testid={`spine-seq-down-${i}`}>
                      <ChevronDown size={13} />
                    </button>
                    <button onClick={() => removeSeq(i)} title="Delete sequence"
                      className="text-text-dim hover:text-red p-1"
                      data-testid={`spine-seq-remove-${i}`}>
                      <Trash2 size={12} />
                    </button>
                  </span>
                </div>

                <div className="p-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {/* ── A3: the drama layer. These six fields are what the eight new gates
                         read, and every one of them is optional: cleared, the key is
                         REMOVED (see patchDrama) and the gate that reads it goes quiet
                         again for the whole spine — which is what keeps every bible
                         written before today scoring exactly what it scores today. ── */}
                  <div className="lg:col-span-2 flex flex-wrap items-end gap-2 pb-3 border-b border-border/60"
                    data-testid={`spine-seq-drama-${i}`}>
                    <MiniNum label="Tension" width="w-14"
                      hint="1-10. 8 or more is a PEAK, and a peak has to take something the protagonist can never get back. Empty = this sequence declares no tension."
                      value={tensionOf(seq)} min={1} max={10} step={1}
                      onCommit={(v) => patchDrama(i, 'tension', v)}
                      testid={`spine-seq-tension-${i}`} />
                    <MiniSel label="Mode" width="w-32" value={seq.mode ?? ''}
                      hint="The register this stretch is written in. Comedy, quiet and wonder are the relief valve after a peak."
                      swatch={modeColor(seq.mode)}
                      options={MODES.map((m) => ({ value: m.value, label: m.label }))}
                      onChange={(v) => patchDrama(i, 'mode', v)}
                      testid={`spine-seq-mode-${i}`} />
                    <MiniSel label="Resisted by" width="w-36" value={seq.obstacle_type ?? ''}
                      hint="WHO resists. 'self' is legitimate at most twice in a film: a protagonist only ever stopped by their own hesitation cannot be beaten."
                      options={OBSTACLE_TYPES}
                      onChange={(v) => patchDrama(i, 'obstacle_type', v)}
                      testid={`spine-seq-obstacle-type-${i}`} />
                    <MiniTxt label="Who resists" width="w-40" value={seq.obstacle_owner ?? ''}
                      hint="The named adversary. The same name in 3+ sequences is what lets a threat build."
                      placeholder="name"
                      onCommit={(v) => patchDrama(i, 'obstacle_owner', v.trim())}
                      testid={`spine-seq-owner-${i}`} />
                    <MiniSel label="Cost so far" width="w-32" value={seq.cost_level === undefined ? '' : String(seq.cost_level)}
                      hint="0-3, CUMULATIVE — how much they have given up by the END of this sequence. It never goes back down."
                      options={COST_LEVELS.map((c) => ({ value: String(c.value), label: c.label }))}
                      onChange={(v) => patchDrama(i, 'cost_level', v === '' ? undefined : Number(v))}
                      testid={`spine-seq-cost-${i}`} />
                    {/* Stored as a FRACTION (the gate reads 0.12), typed as a percentage —
                        nobody plans a film in fractions, and the backend reads a bare 12 as
                        12% anyway, so letting both meanings into the field would be a
                        number the user cannot decode. */}
                    <MiniNum label="Share %" width="w-16"
                      hint="This sequence's slice of the runtime. The shares sum to 100%, and they are uneven on purpose — the third act is not the size of the first."
                      value={shareOf(seq) === null ? null : Math.round((shareOf(seq) as number) * 1000) / 10}
                      min={0} max={100} step={0.5}
                      suffix={shareOf(seq) === null ? '' : clock((shareOf(seq) as number) * targetDurationSecs)}
                      onCommit={(v) => patchDrama(i, 'seconds_share',
                        v === undefined ? undefined : Math.round((v / 100) * 10000) / 10000)}
                      testid={`spine-seq-share-${i}`} />
                    <label className="flex items-center gap-1.5 text-[10px] text-text-muted cursor-pointer select-none pb-1.5"
                      title="A loud sequence that costs nothing is the single most common way a film reads as a series of events instead of a story.">
                      <input type="checkbox" className="accent-cyan"
                        checked={!!eventOf(seq).irreversible}
                        onChange={(e) => patchEvent(i, { irreversible: e.target.checked })}
                        data-testid={`spine-seq-irreversible-${i}`} />
                      costs something irreversible
                    </label>
                    <MiniTxt label="Loses — and never gets back" grow value={eventOf(seq).loses ?? ''}
                      hint="Name the thing: a person, a body part, a belief, the way home. It stays lost."
                      placeholder="what is gone for good"
                      onCommit={(v) => patchEvent(i, { loses: v })}
                      testid={`spine-seq-loses-${i}`} />
                  </div>

                  <Field label="Covers (scene headings)" testid={`spine-seq-covers-${i}`}
                    value={seq.covers ?? ''} rows={1} onCommit={(v) => patchSeq(i, { covers: v })} />
                  <Field label="Obstacle — what a camera can see resisting them" testid={`spine-seq-obstacle-${i}`}
                    value={seq.obstacle ?? ''} rows={2} onCommit={(v) => patchSeq(i, { obstacle: v })}
                    placeholder="NONE if nothing resists them" />

                  <Field label="Value in — entering the sequence" testid={`spine-seq-valuein-${i}`}
                    value={seq.value_in ?? ''} rows={1} onCommit={(v) => patchSeq(i, { value_in: v })} />
                  <Field label="Value out — leaving it" testid={`spine-seq-valueout-${i}`}
                    value={seq.value_out ?? ''} rows={1} onCommit={(v) => patchSeq(i, { value_out: v })} />

                  {/* Not a gate — a hint. The value chain has to be continuous, and
                      walking it backwards between sequences is the most common way this
                      document lies about the story. Nothing counts it, so it is stated
                      here rather than dressed up as a fifth check. */}
                  {seam && (
                    <p className="lg:col-span-2 text-[10px] text-amber flex items-start gap-1.5">
                      <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                      Value seam — the previous sequence left them at “{prevOut}”.
                    </p>
                  )}

                  <Field label="Question opened" testid={`spine-seq-question-${i}`}
                    value={seq.question_opened ?? ''} rows={2}
                    onCommit={(v) => patchSeq(i, { question_opened: v })} />

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">
                      Answers — earlier questions this one closes
                    </label>
                    {earlier.length === 0 ? (
                      <p className="text-[10px] text-text-dim italic">
                        The first sequence has nothing earlier to answer.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {earlier.map((e) => {
                          const on = answers.includes(e.id)
                          return (
                            <button key={e.id} onClick={() => toggleAnswer(i, e.id)}
                              title={e.question_opened || 'No question opened here'}
                              className={cn(
                                'px-1.5 py-0.5 rounded border text-[10px] font-mono transition-colors',
                                on ? 'bg-cyan/15 text-cyan border-cyan/40'
                                   : 'bg-elevated text-text-muted border-border hover:border-cyan/30 hover:text-cyan'
                              )}
                              data-testid={`spine-seq-answer-${i}-${e.id}`}>
                              {e.id}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          <Button variant="ghost" size="sm" icon={<Plus size={12} />} onClick={addSeq}
            className="self-start" data-testid="spine-add-seq">
            Add sequence
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * THE SHAPE OF THE FILM: tension by sequence, and the runtime each sequence claims.
 *
 * This is the one thing on the screen that can be read without reading anything. The
 * measured problem is not that Take One Studio writes bad sentences — it is that it writes FLAT
 * films: ROBOTECH's 16 scenes with nothing spent, FARO's 1229 words with no laugh in
 * them, and a spine whose own document could describe the flatness perfectly while
 * nothing on screen ever showed it. The Tomorrow War, by sequence, is
 * 3,6,6,7,6,8,10,7,9,5,6,10,4,6,9 — two 10s that drop immediately to 7 and to 4, and a
 * COMEDY right before the finale. Drawn side by side with a spine that is 5,5,5,5,5 the
 * difference needs no explanation, and it is visible before a single frame is paid for.
 *
 * Inline CSS bars, no charting dependency. Height is tension (10 = full), width is the
 * sequence's share of the runtime, colour is the mode. A sequence that declares NO
 * tension is drawn as a dashed empty column — never as a short bar: "not stated" and
 * "low" are different facts, and the whole drama layer is built on keeping them apart.
 */
function SpineCurve({ sequences, targetSecs, flagged, onPick }: {
  sequences: BibleSequence[]
  targetSecs: number
  /** Sequence ids a FAILING gate named — ringed, so the verdict and the shape agree. */
  flagged: Set<string>
  onPick: (id: string) => void
}) {
  const widths   = layoutShares(sequences)
  const tensions = sequences.map(tensionOf)
  const shares   = sequences.map(shareOf)
  const gotT     = tensions.filter((t): t is number => t !== null)
  const gotS     = shares.filter((s): s is number => s !== null)
  const peak     = gotT.length ? Math.max(...gotT) : 0
  const peakId   = peak ? (sequences[tensions.lastIndexOf(peak)]?.id ?? '') : ''
  const total    = gotS.reduce((a, b) => a + b, 0)
  const modesUsed = MODES.filter((m) => sequences.some((s) => s.mode === m.value))
  const relief   = sequences.filter((s) => RELIEF_MODES.has(s.mode ?? '')).length

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden" data-testid="spine-curve">
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <Activity size={13} className="text-cyan shrink-0" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
          Tension curve
        </span>
        <span className="text-[10px] text-text-dim" data-testid="spine-curve-summary">
          {gotT.length === 0
            ? 'no sequence declares a tension — this spine has no curve, and the drama gates stay silent until one does'
            : `peak ${peak} at ${peakId} · ${gotT.length}/${sequences.length} declare one · range ${Math.min(...gotT)}–${peak} · ${relief} relief sequence(s)`}
        </span>
      </div>

      <div className="px-3 pb-3 border-t border-border pt-3">
        {/* The bars. h-24 is enough to tell a 6 from an 8 at a glance and short enough
            that the sequence editors stay on the same screen. */}
        <div className="relative h-24" data-testid="spine-curve-bars">
          {/* The line the gates measure from: at 8 a sequence becomes a PEAK and owes an
              irreversible cost. A curve that never crosses it is the "loud, not costly"
              film, and this is where you see that it never crosses it. */}
          {/* z-10: the bars paint over anything below them, and on a film that DOES reach
              8 the line and its label vanished behind the peak that crosses it — which is
              the one curve where the threshold matters most. */}
          <div className="absolute left-0 right-0 z-10 border-t border-dashed border-orange/50 pointer-events-none"
            style={{ top: `${(1 - PEAK_TENSION / 10) * 100}%` }}>
            {/* On its own chip: orange text over an orange (action) bar is invisible, and
                the bars that reach this line are exactly the ones most likely to be it. */}
            <span className="absolute -top-3 right-0 px-1 rounded bg-surface/85 text-[8px] font-mono text-orange/90">
              peak {PEAK_TENSION}+
            </span>
          </div>
          <div className="flex items-end gap-px h-full">
            {sequences.map((s, i) => {
              const t = tensions[i]
              const c = modeColor(s.mode)
              const secs = shares[i] === null ? null : (shares[i] as number) * targetSecs
              return (
                <button key={`${s.id}_${i}`} onClick={() => onPick(s.id)}
                  style={{ width: `${widths[i] * 100}%` }}
                  className="relative h-full flex flex-col justify-end min-w-[3px] hover:opacity-80"
                  data-testid={`spine-curve-bar-${i}`}
                  data-tension={t ?? ''}
                  title={[
                    s.id,
                    t === null ? 'no tension declared' : `tension ${t}/10`,
                    s.mode || 'no mode',
                    secs === null ? 'no share declared' : clock(secs),
                    s.obstacle_owner ? `resisted by ${s.obstacle_owner}` : '',
                    eventOf(s).irreversible ? `loses ${eventOf(s).loses || '(unnamed)'}` : '',
                  ].filter(Boolean).join(' · ')}>
                  {t === null ? (
                    <div className="w-full h-full border border-dashed border-border rounded-sm flex items-end justify-center pb-0.5">
                      <span className="text-[8px] font-mono text-text-dim">—</span>
                    </div>
                  ) : (
                    <div className={cn('relative w-full rounded-t-sm', flagged.has(s.id) && 'ring-1 ring-red')}
                      style={{ height: `${t * 10}%`, backgroundColor: c || 'var(--color-border)' }}>
                      <span className="absolute -top-3 left-0 right-0 text-center text-[8px] font-mono text-text-muted">
                        {t}
                      </span>
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Ids under the bars — truncated on purpose: the tooltip and the row below carry
            the detail, and a rotated label wall is not readable at 15 sequences. */}
        <div className="flex gap-px mt-1">
          {sequences.map((s, i) => (
            <div key={`${s.id}_${i}`} style={{ width: `${widths[i] * 100}%` }} className="overflow-hidden">
              <div className="text-[8px] font-mono text-text-dim truncate text-center px-px">{s.id}</div>
            </div>
          ))}
        </div>

        {/* ── The footage share. Same widths, so the two rows are one picture: a fat
               block IS a long stretch of film. The label is m:ss because that is the unit
               an editor thinks in — 0.18 of the runtime means nothing at a glance. ── */}
        <div className="flex items-center gap-1.5 mt-3 mb-1">
          <Clock size={11} className="text-text-dim shrink-0" />
          <span className="text-[9px] font-bold uppercase tracking-widest text-text-muted">Footage share</span>
          <span className="text-[9px] text-text-dim font-mono" data-testid="spine-footage-total">
            {gotS.length === 0
              ? 'no share declared — the blocks below are equal stretches, which is a guess, not a plan'
              : `${clock(total * targetSecs)} of ${clock(targetSecs)} planned · shares sum to ${total.toFixed(2)}`
                + (gotS.length < sequences.length ? ` · ${sequences.length - gotS.length} declare none` : '')}
          </span>
        </div>
        <div className="flex gap-px h-5" data-testid="spine-footage">
          {sequences.map((s, i) => {
            const c = modeColor(s.mode)
            const secs = shares[i] === null ? null : (shares[i] as number) * targetSecs
            return (
              <button key={`${s.id}_${i}`} onClick={() => onPick(s.id)}
                style={{ width: `${widths[i] * 100}%`, backgroundColor: c ? `${c}2E` : undefined }}
                className={cn('flex items-center justify-center rounded-sm border overflow-hidden min-w-[3px] hover:opacity-80',
                  flagged.has(s.id) ? 'border-red/60' : 'border-border/60')}
                data-testid={`spine-footage-block-${i}`}
                title={`${s.id} · ${secs === null ? 'no share declared' : `${clock(secs)} of ${clock(targetSecs)}`}`}>
                <span className="text-[8px] font-mono text-text-muted truncate px-0.5">
                  {secs === null ? '—' : clock(secs)}
                </span>
              </button>
            )
          })}
        </div>

        {/* The legend only lists the modes this film actually uses — which is itself the
            reading: one swatch is the flat film the Tonal range gate is about. */}
        {modesUsed.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-2" data-testid="spine-curve-legend">
            {modesUsed.map((m) => (
              <span key={m.value} className="flex items-center gap-1 text-[9px] text-text-muted">
                <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: m.color }} />
                {m.label}
                {RELIEF_MODES.has(m.value) && <span className="text-text-dim">(relief)</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Compact number editor for the drama layer. EMPTY is a real answer — it commits
 *  `undefined`, which deletes the key (see patchDrama) instead of writing a 0 that would
 *  switch a gate on for the whole spine. Out-of-range input is clamped in the field as
 *  well as in the commit, so what is on screen is what was stored. */
function MiniNum({ label, hint, value, min, max, step = 1, width = 'w-16', suffix, onCommit, testid }: {
  label: string
  hint?: string
  value: number | null
  min: number
  max: number
  step?: number
  width?: string
  suffix?: string
  onCommit: (v: number | undefined) => void
  testid?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest" title={hint}>{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="number" defaultValue={value ?? ''} min={min} max={max} step={step} title={hint}
          data-testid={testid}
          onBlur={(e) => {
            const raw = e.target.value.trim()
            const n = Number(raw)
            if (raw === '' || !Number.isFinite(n)) { onCommit(undefined); e.target.value = ''; return }
            const clamped = Math.max(min, Math.min(max, n))
            e.target.value = String(clamped)
            onCommit(clamped)
          }}
          className={cn(width, 'bg-elevated border border-border rounded px-1.5 py-1 text-[11px] text-text-primary focus:outline-none focus:border-cyan/50')}
        />
        {/* Fixed width, ALWAYS rendered. It used to appear only once there was something
            to say, and the appearing element reflowed the whole wrapped strip — on the
            blur that commits the value, i.e. while the user is already pressing the next
            control. MEASURED: typing a share and then clicking "costs something
            irreversible" moved the checkbox out from under the pointer between mousedown
            and mouseup, so the click never landed on it (e2e story_spine_curve). A field
            that moves when you commit it is unusable however correct the state is. */}
        {suffix !== undefined && (
          <span className="w-10 shrink-0 text-[9px] font-mono text-text-dim">{suffix}</span>
        )}
      </div>
    </div>
  )
}

/** Compact select. The empty option is first and means ABSENT, not a default — and a
 *  stored value outside the vocabulary is shown as itself, marked as ignored, because
 *  the gates read it as absent and a field the gates ignore while the editor displays it
 *  as valid is the worst of both. */
function MiniSel({ label, hint, value, options, width = 'w-32', swatch, onChange, testid }: {
  label: string
  hint?: string
  value: string
  options: Array<{ value: string; label: string }>
  width?: string
  swatch?: string
  onChange: (v: string) => void
  testid?: string
}) {
  const known = !value || options.some((o) => o.value === value)
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest" title={hint}>{label}</label>
      <div className="flex items-center gap-1">
        {/* Rendered whenever the caller asked for a swatch at all, even with no colour to
            show — same reason as MiniNum's suffix: a chip that pops into existence when
            the value is set shoves every control after it sideways. */}
        {swatch !== undefined && (
          <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: swatch || 'transparent' }} />
        )}
        <select value={value} title={hint} data-testid={testid}
          onChange={(e) => onChange(e.target.value)}
          className={cn(width, 'bg-elevated border border-border rounded px-1.5 py-1 text-[10px] text-text-primary focus:outline-none focus:border-cyan/50')}>
          <option value="">— not declared —</option>
          {!known && <option value={value}>{value} — not recognised, ignored</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    </div>
  )
}

/** Compact one-line text — uncontrolled, commits on blur, same idiom as Field. */
function MiniTxt({ label, hint, value, placeholder, width = 'w-40', grow, onCommit, testid }: {
  label: string
  hint?: string
  value: string
  placeholder?: string
  width?: string
  grow?: boolean
  onCommit: (v: string) => void
  testid?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1', grow && 'flex-1 min-w-[10rem]')}>
      <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest truncate" title={hint}>{label}</label>
      <input
        defaultValue={value} placeholder={placeholder} spellCheck={false} title={hint}
        data-testid={testid}
        onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value) }}
        className={cn(grow ? 'w-full' : width, 'bg-elevated border border-border rounded px-1.5 py-1 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50')}
      />
    </div>
  )
}

/** Labelled, uncontrolled field — commits on blur, the same idiom the breakdown tables
 *  use. Uncontrolled so typing in one sequence never re-renders the other eleven. */
function Field({ label, value, onCommit, rows = 1, placeholder, testid }: {
  label: string
  value: string
  onCommit: (v: string) => void
  rows?: number
  placeholder?: string
  testid?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] font-semibold text-text-muted uppercase tracking-widest">{label}</label>
      <textarea
        defaultValue={value}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        data-testid={testid}
        onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value) }}
        className="w-full bg-elevated border border-border rounded px-2.5 py-1.5 text-[11px] text-text-primary placeholder:text-text-dim focus:outline-none focus:border-cyan/50 resize-y leading-relaxed"
      />
    </div>
  )
}
