/** Shots → segments, without losing a project.
 *
 *  A segment is one Seedance call (≤15 s) containing one or more shots that the model
 *  cuts internally. Verified live 2026-07-31: a prompt declaring 3 shots of 2/5/3 s came
 *  back with cuts at 2.04 s and 6.21 s; the single-shot control had none. It is also the
 *  only way to get a shot under 4 s, since the API floor is 4 s PER CALL.
 *
 *  THE MIGRATION RULE THAT MAKES THIS SAFE — a migrated segment INHERITS THE SHOT'S ID.
 *  `SHOT_001` becomes a segment `SHOT_001` holding one sub-shot `SHOT_001_S1`. Six maps
 *  in a live project are keyed by shot id — stage-4 `shotBoards`, stage-5 `shots[].shotId`,
 *  `approvedShotIds`, `shotVersions`, `shotSelectedVersion` and `finalCutEdit.order/clips`
 *  — plus the `Shots/<id>/` folders on disk and the render registry. Minting fresh ids
 *  would orphan all of them; ROBOTECH alone would lose 44 approvals, 44 boards and its cut.
 *  So the id is the anchor and nothing is rekeyed.
 *
 *  Everything here is PURE and IDEMPOTENT: a breakdown that already has segments comes
 *  back untouched. That matters because this runs from three entry points that can all
 *  fire on the same state (zustand `migrate`, `loadProjectState`, `normalizeBreakdown`).
 */
import type { BreakdownData, Segment, SegmentShot, Shot } from './types/pipeline.types'

/** Seedance's ceiling PER CALL, and therefore per segment. The backend refuses a longer
 *  request with a 422 instead of clamping it (server.py `_create_video_impl`), because a
 *  clamp drops the segment's LAST SHOTS and nothing downstream can tell the clip is short
 *  of its own EDL entry. Mirrored here so stage 5 can refuse BEFORE it sends and name the
 *  shot, rather than surfacing a raw backend error mid-batch. Same name and value as
 *  `claude_agents.SEGMENT_MAX_SECS`, which caps only segments the planner GENERATED — a
 *  legacy or hand-edited shot never went through it. */
export const SEGMENT_MAX_SECS = 15

/** Per-model ceiling, mirroring `byteplus_generative._MODEL_CAPS`. 2.5 renders up to
 *  30 s in ONE take, which is the whole reason to choose it: a long take has no cuts
 *  to drift across. Anything unrecognised falls back to the 2.0 value — the safe
 *  direction, since refusing early beats a 422 mid-batch. */
export const segmentMaxSecsFor = (model?: string): number =>
  model === 'v25' ? 30 : SEGMENT_MAX_SECS

/** Per-model IMAGE-reference ceiling, mirroring `byteplus_generative._MODEL_CAPS["images"]`.
 *  2.0 accepts 9, 2.5 accepts 30. Hardcoding 9 truncated a 2.5 render's references to a
 *  third of what it may carry — and a dropped reference is precisely the failure this
 *  pipeline is fighting, since the prompt still NAMES the subject the model was not shown.
 *  This is the HARD limit; the sd25-pe contract's "prefer 1-8 subjects" is a stability
 *  recommendation, and the caller's priority order (characters → environment → board →
 *  props) decides what goes first if a scene ever reaches it. */
export const maxImageRefsFor = (model?: string): number => model === 'v25' ? 30 : 9

/** Per-model AUDIO-reference ceiling (`_MODEL_CAPS["audios"]`). 2.5 takes 10 clips, which is
 *  what makes one clip PER SPEAKER possible instead of a single mixed track — the case that
 *  matters once more than three characters talk in one take. */
export const maxAudioRefsFor = (model?: string): number => model === 'v25' ? 10 : 3

/** Per-model VIDEO-reference ceiling (`_MODEL_CAPS["videos"]`). 3 on the 2.0 family, 10 on
 *  2.5. It sat only in Studio's own tier table, so the two could drift; this is the sibling
 *  the image and audio helpers were always missing. */
export const maxVideoRefsFor = (model?: string): number => model === 'v25' ? 10 : 3

/** COMBINED run time allowed across reference clips of one media type — a limit the count
 *  ceilings above say nothing about. 2.0 takes 3 videos *totalling ≤15 s* and 3 audios on the
 *  same budget; 2.5 takes 10 of each totalling ≤30 s. Three 10-second clips is a legal COUNT
 *  on 2.0 and double its legal DURATION, so anything that checks only `length` lets a 400
 *  through. Numerically equal to the clip-length ceiling today, and kept separate because it
 *  is a different limit that could stop being equal. */
export const refSecsFor = (model?: string): number => model === 'v25' ? 30 : 15

/** How a reference is ADDRESSED in the prompt, per model.
 *
 *  2.0 documents `<Image_N>`; 2.5 reassigns `<>` to sound effects (alongside `{}` dialogue,
 *  `()` music, `【】` subtitles) and states plainly that subject names must not also live in
 *  angle brackets "so one symbol does not perform two roles" — so 2.5 addresses `@Image N`.
 *  Getting this wrong is not cosmetic: on 2.5 an `<Image_1>` reads as a sound-effect tag.
 *  Lifted out of FinalGenView (where it was `refAddr`) so Studio cannot grow a second,
 *  divergent copy. */
export const refToken = (model: string | undefined, n: number,
                         kind: 'Image' | 'Video' | 'Audio' = 'Image'): string =>
  model === 'v25' ? `@${kind} ${n}` : `<${kind}_${n}>`

/** Total run time of a segment — the sum of its shots, which is what Seedance is asked
 *  for and what the EDL lays down. Never read a segment's duration any other way. */
export function segmentDurationSecs(seg: Segment): number {
  return (seg.shots ?? []).reduce((n, s) => n + (Number(s.durationSecs) || 0), 0)
}

/** The composition prose, under either spelling the pipeline uses. */
const vd = (s: Shot & { visual_description?: string }): string =>
  s.visualDescription || s.visual_description || ''

/** One legacy Shot → one single-shot Segment. Lossless: every field lands somewhere. */
function shotToSegment(shot: Shot, order: number): Segment {
  const sub: SegmentShot = {
    id: `${shot.id}_S1`,
    // Verbatim, even over SEGMENT_MAX_SECS. A legacy shot's length is a FACT about the
    // project; clamping it here would hide the overrun rather than fix it, and would put
    // a duration in the EDL that the shot list disagrees with. Stage 5 refuses to render
    // an over-length segment and names it instead (FinalGenView).
    durationSecs: Number(shot.estimatedDuration) || 5,
    // `cameraAngle` was free prose ("extreme wide, static"), so it cannot be trusted to
    // fill the closed `cameraMove` vocabulary. It is preserved verbatim inside `action`
    // rather than guessed at — a wrong tag would make the coverage gates lie.
    // NEVER fuse these. They are different things — `action` is what moves, and
    // `visualDescription` is the composition — and the video prompt sends them to
    // different slots. Concatenating them wrote one string into both fields of every
    // shot of every project that was opened, and the pair cannot be recovered from the
    // result. Verified damage before the fix: ROBOTECH had action===visualDescription
    // in 44/44 shots where its pre-migration breakdown.json has 0/44.
    // Both spellings: the camelCase form is what the store holds, but breakdown.json on
    // disk is snake_case and reaches here through project reconstruction. Reading only
    // one spelling made the other fuse by a different route — the same data loss.
    action: shot.action || vd(shot) || '',
    visualDescription: vd(shot) || undefined,
    layout: shot.cameraAngle || undefined,
    assetsUsed: shot.assetsUsed ?? [],
    dialogue: shot.dialogue,
    performance: shot.performance,
    // Provenance travels WITH the value. Drop it here and a hand-written performance
    // comes back from a round-trip looking auto-generated — i.e. clobberable.
    performanceSource: shot.performanceSource,
    orderIndex: shot.orderIndex,
    isCustom: shot.isCustom,
    motionReferenceVideoId: shot.motionReferenceVideoId,
  }
  return {
    id: shot.id,                    // ← the anchor. See the header.
    sceneId: shot.sceneId,
    // "Lossless: every field lands somewhere" — including the story sequence. Undefined
    // on every project with no spine, which is every project generated before one.
    sequenceId: shot.sequenceId,
    order,
    shots: [sub],
    sceneSettings: shot.lighting ? { light: shot.lighting } : undefined,
  }
}

/** Segments → the flat `Shot[]` projection that ~40 existing call sites still read.
 *  A single-shot segment round-trips to something equivalent to the original shot; a
 *  multi-shot segment projects one Shot per sub-shot, so legacy readers see every beat
 *  rather than silently losing the ones inside a segment. */
export function flattenSegments(segments: Segment[]): Shot[] {
  const out: Shot[] = []
  for (const seg of segments) {
    const solo = (seg.shots ?? []).length === 1
    for (const sh of seg.shots ?? []) {
      out.push({
        // A one-shot segment projects back under the SEGMENT's id, so ROBOTECH's boards,
        // approvals and cut keep matching. Only a genuinely split segment exposes the
        // sub-shot id, and that shot never existed in the old maps anyway.
        id: solo ? seg.id : sh.id,
        sceneId: seg.sceneId,
        sequenceId: seg.sequenceId,
        action: sh.action,
        // `?? sh.action` keeps the backend-authored path byte-identical — those
        // SegmentShots carry no visualDescription and never did.
        visualDescription: sh.visualDescription ?? sh.action,
        assetsUsed: sh.assetsUsed ?? [],
        cameraAngle: [sh.shotSize, sh.cameraMove].filter(Boolean).join(', ') || sh.layout,
        lighting: seg.sceneSettings?.light,
        estimatedDuration: Number(sh.durationSecs) || 0,
        dialogue: sh.dialogue,
        performance: sh.performance,
        performanceSource: sh.performanceSource,   // see toSegment — provenance travels with the value
        orderIndex: sh.orderIndex,
        isCustom: sh.isCustom,
        motionReferenceVideoId: sh.motionReferenceVideoId,
      })
    }
  }
  return out
}

/** THE normaliser. Idempotent; safe to call on anything shaped like a breakdown.
 *
 *  Returns a breakdown that carries BOTH representations: `segments` (source of truth)
 *  and `shots` (derived projection). Callers that already read `shots` keep working
 *  untouched, which is what lets the migration land without one 40-file commit. */
/** The ids a scene is BOARDED and RENDERED by — i.e. its units of generation.
 *
 *  A scene carries two lists and they are not interchangeable. `shotIds` is every shot
 *  the breakdown wrote; `segmentIds` is the subset that survives shotsToSegments()'s
 *  projection, one per Seedance call. The absorbed shots are not missing work — they are
 *  the PANELS inside another segment's board, and no button can ever reach them.
 *
 *  Reading `shotIds` in a boarding or approval check therefore counts work that cannot
 *  exist: DryRUN reported "38 shots left" for 19 boards that were all already made, and
 *  Stage 5's gate refused to open for four scenes whose every board was approved. This is
 *  the ONE definition both stages use so the two can never drift apart again.
 *
 *  Falls back to `shotIds` for projects planned before segments existed, where a segment
 *  inherits its shot's id and the two lists are identical.
 */
export const boardIds = (
  sc?: { shotIds?: string[]; segmentIds?: string[] } | null,
): string[] => (sc?.segmentIds?.length ? sc.segmentIds : sc?.shotIds) ?? []

/** The three fields a segment must carry for its WHOLE run, not just its first beat.
 *
 *  `assetsUsed` decides what gets attached, `dialogue` decides whether a voice track is
 *  built at all, and `performance` is the acting the model is asked to play — and all three
 *  are per-beat in the breakdown. Anything that reads them off the representative shot is
 *  reading beat 1 and calling it the segment.
 *
 *  Order matters and is preserved: `<Image_N>`/`@Image N` addresses attachments by index, so
 *  first-appearance order is the stable one, and dialogue is concatenated in beat order
 *  because that is the order it is spoken in.
 *
 *  `performance` is JOINED rather than replaced: ACTING SKILL §8.5 wants one flowing
 *  paragraph, and §8.1 ("no character in frame → no paragraph") is why empties are dropped
 *  instead of preserved as blanks. Identical paragraphs across beats — what the director
 *  pass writes for a character who holds the same state — collapse to one.
 */
function mergedBeatFields(seg: Segment, rep: Shot): Partial<Shot> {
  const beats = seg.shots ?? []
  if (beats.length < 2) return {}          // identity on a one-shot segment; keep rep as-is

  const assetsUsed: string[] = []
  const dialogue: NonNullable<Shot['dialogue']> = []
  const acting: string[] = []
  const scene: string[] = []
  for (const b of beats) {
    for (const id of b.assetsUsed ?? []) if (!assetsUsed.includes(id)) assetsUsed.push(id)
    for (const d of b.dialogue ?? []) dialogue.push(d)
    const p = (b.performance ?? '').trim()
    if (p && !acting.includes(p)) acting.push(p)
    // The scene-mode dialogue direction. A segment is ONE Seed Audio call, so its beats'
    // directions become consecutive blocks of one performance rather than separate takes.
    // Usually only one beat carries dialogue and this is a straight passthrough.
    const sc = (b.dialogueScene ?? '').trim()
    if (sc && !scene.includes(sc)) scene.push(sc)
  }
  return {
    assetsUsed: assetsUsed.length ? assetsUsed : rep.assetsUsed,
    dialogue: dialogue.length ? dialogue : rep.dialogue,
    performance: acting.length ? acting.join(' ') : rep.performance,
    dialogueScene: scene.length ? scene.join('\n\n') : rep.dialogueScene,
  }
}

export function shotsToSegments<T extends Partial<BreakdownData>>(bd: T): T
export function shotsToSegments<T extends Partial<BreakdownData>>(bd: T | null | undefined): T | null | undefined
export function shotsToSegments<T extends Partial<BreakdownData>>(bd: T | null | undefined): T | null | undefined {
  if (!bd || typeof bd !== 'object') return bd

  const existing = Array.isArray(bd.segments) && bd.segments.length ? bd.segments : null
  const shots = Array.isArray(bd.shots) ? bd.shots : []
  if (!existing && !shots.length) return bd            // nothing to do; not a breakdown

  const segments: Segment[] = existing ?? shots.map(shotToSegment)

  // The flat projection carries ONE ENTRY PER SEGMENT, because `shots` is what drives
  // the stage-5 strip, the stage-4 boards and the EDL — and every one of those is a unit
  // of RENDERING, not of intent. Leaving one entry per sub-shot put a card on the strip
  // for each beat and rendered each one as its own call: a 3-beat segment became three
  // 4s renders instead of one 9.5s take, which is both triple the cost and the loss of
  // the internal cut the grouping exists to create.
  //
  // The representative is the segment's FIRST shot as the caller normalised it, so the
  // fields a SegmentShot has no room for (visualDescription, the camera prose) survive;
  // only the duration is replaced, by the segment's total.
  //
  // …but the three fields that decide what gets ATTACHED to the render must be the
  // segment's UNION, not the first beat's. The representative pattern silently scoped them
  // to beat 1 while the prompt TEXT is written from every beat, so the model was told about
  // people it was never shown. Measured on DryRUN (19 segments, 2026-08-09):
  //   · 32 asset references lost across 13 of 19 segments — SHOT_050 attached 1 of 5, and
  //     Moe, the protagonist, was missing from 16 segments whose action text names him;
  //   · 6 of 10 dialogue lines lost, which also starves `_has_dialogue` server-side and so
  //     silently disables the whole Seedance audio path (server.py, ref_first_frame);
  //   · the per-beat `performance` (ACTING SKILL §8 scene adaptation) lost with them.
  // Grouping shots into longer takes — the reason 2.5's 30 s ceiling exists — made the loss
  // grow with every beat absorbed, so the long-take feature is what exposed this.
  // The official sd25-pe contract requires the opposite: an "omission audit" in which
  // "every required entity must have exactly one explicit role in the Prompt".
  //
  // A one-shot segment is unaffected: every merge below is the identity on a single beat.
  let flat: Shot[]
  if (existing && shots.length) {
    const byId = new Map(shots.map((s) => [s.id, s]))
    flat = segments.map((seg) => {
      const first = seg.shots?.[0]
      const rep = (first && byId.get(first.id)) || byId.get(seg.id)
      const total = segmentDurationSecs(seg)
      return rep
        ? { ...rep, id: seg.id, sceneId: seg.sceneId, estimatedDuration: total,
            ...mergedBeatFields(seg, rep) }
        : flattenSegments([seg])[0]
    }).filter(Boolean)
  } else {
    flat = flattenSegments(segments)
  }

  // Scenes point at units of GENERATION. With inherited ids these are the same strings
  // they always were, so the copy is free — but making it explicit means the stage-4/5
  // grouping can move to `segmentIds` without another migration.
  const bySeg = new Set(segments.map((s) => s.id))
  const scenes = (bd.scenes ?? []).map((sc) => ({
    ...sc,
    segmentIds: sc.segmentIds ?? (sc.shotIds ?? []).filter((id) => bySeg.has(id)),
  }))

  return { ...bd, segments, shots: flat, scenes } as T
}

/** Push an edit made on the flat `shots` list down into the segment that renders it.
 *
 *  `segments` is what stage 5 builds the prompt from, so a stage-2 edit that only wrote
 *  `shots` was invisible to the render: the director changed the action, the dialogue or
 *  the lighting, the UI showed the change, and Seedance received the text from before it.
 *  Lighting was the worst of them — `lightingHint` prefers the segment with `??`, so the
 *  edit was dropped on EVERY route, not just the segment one.
 *
 *  Matching is by id, which the inheritance rule makes reliable: a one-shot segment and
 *  its shot share the id, and a grouped segment's sub-shots keep their own.
 */
export function syncSegmentsFromShots<T extends Partial<BreakdownData>>(bd: T): T {
  if (!bd || !Array.isArray(bd.segments) || !Array.isArray(bd.shots)) return bd
  const byId = new Map(bd.shots.map((s) => [s.id, s]))
  const segments = bd.segments.map((seg) => {
    const shots = (seg.shots ?? []).map((sub) => {
      // A one-shot segment's sub-shot may be keyed under the SEGMENT's id (that is how
      // the projection presents it), so fall back to it before giving up.
      const s = byId.get(sub.id) ?? ((seg.shots ?? []).length === 1 ? byId.get(seg.id) : undefined)
      if (!s) return sub
      return {
        ...sub,
        action: s.action ?? sub.action,
        visualDescription: s.visualDescription ?? sub.visualDescription,
        assetsUsed: s.assetsUsed ?? sub.assetsUsed,
        dialogue: s.dialogue ?? sub.dialogue,
        dialogueScene: s.dialogueScene ?? sub.dialogueScene,
        // `??` and not `||`: the flat side is authoritative, and after the director pass
        // clears a character-less shot its performance is '' — a real value that must
        // reach the segment, not be read as "absent" and replaced by the stale one.
        performance: s.performance ?? sub.performance,
        performanceSource: s.performanceSource ?? sub.performanceSource,
        // Only a single-shot segment can take its duration from the flat entry — for a
        // grouped one that number is the segment TOTAL, and writing it into each sub-shot
        // would multiply the segment's length by its shot count.
        durationSecs: (seg.shots ?? []).length === 1
          ? (Number(s.estimatedDuration) || sub.durationSecs)
          : sub.durationSecs,
      }
    })
    const rep = byId.get(seg.id) ?? byId.get(seg.shots?.[0]?.id ?? '')
    return {
      ...seg,
      shots,
      sceneSettings: rep?.lighting ? { ...seg.sceneSettings, light: rep.lighting }
                                   : seg.sceneSettings,
    }
  })
  return { ...bd, segments } as T
}

/** Apply the normaliser to a whole persisted snapshot's stage 2, wherever it came from
 *  (localStorage via `migrate`, or `pipeline_state.json`, which carries NO version field
 *  at all — verified on ROBOTECH: its top-level keys are just `savedAt` and `state`).
 *  Mutates in place and returns the same object, matching the existing `migrate` style. */
export function migrateStagesToSegments(stages: unknown): unknown {
  const st = stages as Record<string, { versions?: Array<{ data?: unknown }> }> | null
  if (!st || typeof st !== 'object') return stages
  const stage2 = st['2']
  if (!stage2 || !Array.isArray(stage2.versions)) return stages
  for (const v of stage2.versions) {
    if (v && typeof v === 'object' && v.data && typeof v.data === 'object') {
      v.data = shotsToSegments(v.data as Partial<BreakdownData>)
    }
  }
  return stages
}
