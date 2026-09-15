export type StageId = 1 | 2 | 3 | 4 | 5 | 6

export type StageStatus =
  | 'idle'
  | 'generating'
  | 'pending_review'
  | 'approved'
  | 'invalidated'

export interface QCCheck {
  label: string
  passed: boolean
  notes?: string
}

export interface QCResult {
  agentId: string
  checks: QCCheck[]
  summary: string
  completedAt: number
}

export interface StageVersion<TData = unknown> {
  id: string
  createdAt: number
  data: TData
  qcResult: QCResult | null
  approvalNotes: string
  /** Set true the moment this version is approved. Durable "was ever approved"
   *  signal that survives a later re-generate (which commits a fresh, unapproved
   *  version) — read at read-time so migrate() stays a no-op. Powers the stepper
   *  gate: a downstream stage stays reachable once its upstream was approved,
   *  even while the upstream is being re-worked. */
  approved?: boolean
}

export interface StageSlice<TData = unknown> {
  status: StageStatus
  activeVersionId: string | null
  versions: StageVersion<TData>[]
  isDirty: boolean
  /** Status before an upstream change invalidated this stage — restored when
   *  the user chooses "Keep current work". */
  prevStatus?: StageStatus
}

// ─── Project Style ───────────────────────────────────────────────────────────

export type StyleId = 'cinematic' | 'photoreal' | 'anime' | 'pixar3d' | 'cartoon2d' | 'comic' | 'custom'

export interface ProjectStyle {
  id: StyleId
  label: string
  promptSuffix: string
  negativePrompt: string
  anchorImageRefs: string[]
}

// ─── Stage-specific data shapes ─────────────────────────────────────────────

export interface ScriptData {
  concept: string
  content: string
  wordCount: number
  estimatedRuntime: number // minutes
  /** The runtime in SECONDS, from the backend's duration maths (POST /api/script/runtime).
   *  Whole minutes above cannot say a 40s short from a 90s one, and every value written
   *  before this field existed came from the words/130 page rule — roughly 2× the film. */
  estimatedRuntimeSecs?: number
  /** true when that backend call could not be made and the runtime above is the
   *  words/130 fallback. Shown as approximate; never presented as the real number. */
  runtimeApprox?: boolean
  /** true when the user hand-edited or loaded the script (vs pure generation) */
  edited?: boolean
  /** Item 1c: interactive "Develop idea" output, folded into the concept before the
   *  one-shot generate. Optional + read-time-defaulted → migrate() stays a no-op at
   *  persist version 5; plain strings so partialize's data-URI strip is unaffected. */
  expandedConcept?: string
  qa?: Array<{ question: string; options: string[]; answer: string }>
}

/** 'voice' = a speaker with no body on screen (phone voice, PA, narrator, a computer).
 *  It is cast, never drawn — see the breakdown's classification rule. */
export type AssetType = 'character' | 'voice' | 'prop' | 'wardrobe' | 'environment' | 'vfx' | 'fx'

export interface Asset {
  id: string
  name: string
  type: AssetType
  visualDescription: string
  sceneRefs: string[]
  // ── Phase 0 (additive, all optional — existing assets stay valid) ──
  /** Set on a VARIANT → the base character's asset id. Variants reuse identity. */
  parentCharacterId?: string | null
  /** Asset ids this one DEPICTS — a photo of them, a screen showing them, a portrait.
   *  Stage 3 holds this asset until all of them are approved, then renders it FROM
   *  their approved sheets, so the face inside the object is the film's, not invented. */
  dependsOn?: string[]
  /** Variants inherit the parent's set so identity is reused (only wardrobe/props re-render). */
  identityReferenceSetId?: string | null
  /** Costume description on a character — distinct from the standalone 'wardrobe' asset type. */
  wardrobe?: string | null
  /** Hair length, style and colour (may be read from a reference image). */
  hairstyle?: string | null
  /** Footwear description (may be read from a reference image). */
  shoes?: string | null
  /** Hats, canes, swords, garments, footwear… carried by this character. */
  props?: CharacterProp[]
  personality?: string | null
  backstory?: string | null
  /** The ACTING MASTER PROFILE — one 150-220 word paragraph of how this person moves,
   *  speaks, hides what they feel, and the exact trigger that cracks the mask. Written
   *  once by the stage-2 director pass and then RE-EXPRESSED per shot: it is what keeps a
   *  performance consistent across a whole film instead of re-derived per prompt. Kept
   *  separate from `personality` (which is temperament in prose, for a human reader) —
   *  this one is filmable direction and goes to the model. */
  acting?: string | null
  dialogueNotes?: string | null
  voiceProfile?: VoiceProfile | null
  /** Generation approval — mirrors the Stage-3 assetStates.status source of truth. */
  status?: 'draft' | 'approved'
  /** asset→shots dependency graph, for Phase-2 auto-propagation. */
  dependentShotIds?: string[]
}

export interface BreakdownData {
  /** Language the spoken dialogue is written in, declared once by the breakdown.
   *  Optional and read-time defaulted: films broken down before this existed have none
   *  and their prompts are unchanged. */
  dialogueLanguage?: string
  assets: Asset[]
  /** DERIVED projection of `segments`, one entry per SegmentShot. Kept because ~40 call
   *  sites read it; `segments` is the source of truth. Do not write to it directly —
   *  produce segments and let `flattenSegments` derive this. */
  shots: Shot[]
  scenes: Scene[]
  /** The unit of GENERATION. One segment = one Seedance call (≤15 s) that may contain
   *  several shots, which the model cuts internally.
   *
   *  Verified live 2026-07-31: a prompt declaring 3 shots of 2 s / 5 s / 3 s came back
   *  with real cuts at 2.04 s and 6.21 s, while the single-shot control had none. This
   *  is also how ByteDance's own Dramagic drives Seedance (5 shots, 2.5+3+3+2.5+1.5 s,
   *  in one generation). It is the ONLY way to get shots under 4 s: the API floor is
   *  4 s per call (server.py `max(4, min(15, …))`), so a 1.5 s insert cannot exist as
   *  its own render. */
  segments?: Segment[]
}

export interface Scene {
  id: string
  heading: string
  description: string
  /** Legacy name. With segments these hold SEGMENT ids — a segment inherits the id of
   *  the shot it was migrated from, so existing projects keep resolving unchanged. */
  shotIds: string[]
  segmentIds?: string[]
}

/** Camera vocabulary. Closed sets on purpose: prose cannot be checked, so 180°-axis
 *  breaks and "three identical sizes in a row" were never enforceable. These are the
 *  fields the coverage gates read. Values follow Dramagic's `size|move` tag. */
export const SHOT_SIZES = ['establishing', 'wide', 'full', 'medium', 'medium close-up',
  'close-up', 'extreme close-up', 'insert', 'pov', 'ots', 'two-shot'] as const
export type ShotSize = typeof SHOT_SIZES[number]

export const CAMERA_MOVES = ['locked', 'pan', 'tilt', 'dolly-in', 'dolly-out', 'push-in',
  'tracking', 'handheld', 'crane', 'whip-pan', 'zoom'] as const
export type CameraMove = typeof CAMERA_MOVES[number]

export interface Segment {
  id: string
  sceneId: string
  /** The story sequence this segment renders, when the project has a spine (see Shot). */
  sequenceId?: string
  order: number
  shots: SegmentShot[]
  /** Per-segment staging block — Dramagic's `Scene Settings` / `[Time]` / `[Light]`. */
  sceneSettings?: { time?: string; light?: string }
  /** Cause-and-effect bridge across the seam (ByteDance guide §2): the previous segment
   *  plants the signal, this one escalates it. Without it a cut reads as "the state
   *  suddenly changed" instead of "something is unfolding". */
  bridge?: { plantedInPrev?: string; escalatesHere?: string }
}

export interface SegmentShot {
  id: string
  /** Seconds. May be sub-4 (a 1.5 s insert, a 0.8 s reaction) — legal because the shot
   *  lives INSIDE a segment and never becomes its own API call. */
  durationSecs: number
  shotSize?: ShotSize
  cameraMove?: CameraMove
  /** Where everything IS — staging and screen geography. Separate from `action` because
   *  this is what makes the 180° axis checkable. */
  layout?: string
  /** What happens, first frame to last, plus the camera's move in prose. */
  action: string
  /** The legacy Shot's composition/staging prose, kept SEPARATE from `action` so the
   *  flat projection can restore the pair. Fusing the two lost the distinction
   *  irrecoverably and wrote the same string into both fields of every shot in every
   *  project that was opened. Absent on segments the backend authors. */
  visualDescription?: string
  assetsUsed: string[]
  /** Stays STRUCTURED. The `{…}` syntax Seedance reads is a prompt serialisation, not a
   *  storage format — characterId is what binds a line to its locked voice. */
  dialogue?: DialogueLine[]
  /** Scene-mode dialogue direction, written by Claude in the breakdown: the VOICES
   *  block plus numbered overlap instructions. Handed to Seed Audio as ONE scene call
   *  so characters can talk over each other; absent → the per-line concat of today. */
  dialogueScene?: string
  performance?: string | null
  /** Mirrors Shot.performanceSource — carried so the segment↔flat projection cannot
   *  launder a hand-written performance into an auto one on a disk round-trip. */
  performanceSource?: 'manual'
  /** Which side of the axis each character occupies, for the 180° check. */
  screenSide?: Record<string, 'L' | 'R'>
  orderIndex?: number
  isCustom?: boolean
  motionReferenceVideoId?: string | null
}

export interface Shot {
  id: string
  sceneId: string
  action: string
  visualDescription: string
  assetsUsed: string[]
  cameraAngle?: string
  /** One motivated lighting line from the breakdown — feeds the prompt's lighting slot. */
  lighting?: string
  estimatedDuration: number // seconds
  dialogue?: DialogueLine[]
  /** Scene-mode dialogue direction, written by Claude in the breakdown: the VOICES
   *  block plus numbered overlap instructions. Handed to Seed Audio as ONE scene call
   *  so characters can talk over each other; absent → the per-line concat of today. */
  dialogueScene?: string
  /** Acting intent / performance direction — HOW the character plays the beat
   *  (emotion, subtext, delivery). Shown on the storyboard (4.1) and fed into the
   *  Seedance shot prompt so the performance matches. */
  performance?: string | null
  /** WHO wrote `performance`. Absent = the director pass did (or it predates this
   *  field); 'manual' = a human typed it in the Shots table.
   *
   *  It exists because the merge has to tell a stale AUTO value from a hand-written one.
   *  The backend deliberately returns an empty performance for a shot with nobody in
   *  frame, but the old merge (`s.performance || merged.performance || s.performance`)
   *  could only add, never clear — measured on BLOOM, 6/6 character-less shots kept a
   *  camera note in the acting field. Clearing unconditionally would have destroyed
   *  manual edits instead, which is the requirement the OR-chain was protecting. This
   *  marker is what lets the clear be selective: auto values yield, manual ones never do. */
  performanceSource?: 'manual'
  // ── Phase 0 (additive, all optional — existing shots stay valid) ──
  /** Float index → insert custom shots between clips without renumbering (Phase 4).
   *  Unset = derive from array position lazily. */
  orderIndex?: number
  isCustom?: boolean
  /** External motion-reference video attached in the storyboard (Phase 3). */
  motionReferenceVideoId?: string | null
  /** Which SEQUENCE of the story spine this shot belongs to (SEQ_3). Written by the
   *  backend when the project has a spine, absent on every project that does not — it is
   *  what lets the breakdown QC ask whether the third act got the 22% of the runtime the
   *  approved spine promised it. Carried through untouched; the UI never edits it. */
  sequenceId?: string
}

export interface DialogueLine {
  characterId: string
  text: string
  emotion?: string
}

// ─── Stage 4: Storyboard (ONE BOARD PER SHOT) ────────────────────────────────

export interface StoryboardBeat {
  label: string          // SHOT_001 (single panel) or SHOT_001-A … -F (beats/CUTs)
  desc: string           // 2-4 sentences of body-part-level blocking
  /** Time range within the shot, e.g. "0-3s" — also the CUT boundary for Stage 5 */
  time?: string
  /** Production-template annotations (color-coded on the board) */
  name?: string          // quoted beat name, e.g. "Shield Impact"
  shot_type?: string     // shot-type opener, e.g. "Aggressive tight low-angle shot."
  /** Declared screen geometry, e.g. "Tomás:left, Nuria:right" — the 180°-axis
   *  declaration the storyboard QC's deterministic gate reads (it travels back to
   *  /api/storyboard/qc inside `panels`). Optional: boards written before it exists. */
  screen_side?: string
  /** The beat's DECLARED intent to swap sides IN FRAME: two figures who walk past each
   *  other DO exchange sides and that is the action, not a 180° break. It rides back to
   *  /api/storyboard/qc inside `panels` beside screen_side, and without it there the gate
   *  reads a correct in-frame pass as a continuity defect. Declared here because the
   *  board objects are passed through verbatim (`panels: b.panels`) — a field missing
   *  from this interface survives at runtime but is invisible to every future edit.
   *  Optional: boards written before 2026-08-05 have no such key. */
  crossing?: boolean
  /** What this beat LEAVES STANDING, e.g. "plate:on the wooden table, Nuria hair:tied bun"
   *  — where each prop is and how each character is dressed once the beat ends. It rides
   *  back to /api/storyboard/qc inside `panels`, where the deterministic
   *  check_object_continuity gate reads it; without it there the gate returns nothing and
   *  a plate set down in one beat can vanish in the next (BLOOM SHOT_055). Declared here
   *  for the same reason as `crossing`: the board objects are passed through verbatim
   *  (`panels: b.panels`), so a field missing from this interface survives at runtime but
   *  is invisible to every future edit. Optional: boards written before 2026-08-05. */
  leaves_behind?: string
  /** The beat's DECLARED intent to move a prop or change an outfit ON SCREEN: a hand sets
   *  the plate down, ties the hair back, pulls the coat off. A leaves_behind value that
   *  changes without it is reported as a continuity break; with it, the change IS the
   *  action. Optional: boards written before 2026-08-05 have no such key. */
  state_change?: boolean
  red?: string           // body/weapon movement paths
  blue?: string          // camera movement
  green?: string         // framing/composition note
  orange?: string        // lighting cue
  purple?: string        // audio/emotional beat emphasis
}

export interface ShotBoardState {
  status: 'idle' | 'pending' | 'approved'
  boardUrl: string       // CDN (24h) — display fallback only
  boardLocalPath: string // Shots/<SHOT_ID>/Storyboard/Versions/vNNN.png — the stable ref
  version: number
  rows: number
  cols: number
  panels: StoryboardBeat[]
  notes: string          // per-shot regenerate-with-notes
  // Item 0 (prompt transparency): what produced this board
  autoPrompt?: string
  sentPrompt?: string
  /** Dialogue audio (Seed Audio 1.0) generated + approved next to the board (3.2).
   *  Disk path. When approved, SG passes it to Seedance as the audio reference. */
  dialogueClipPath?: string
  dialogueApproved?: boolean
  /** 3.2b — the verdict on EACH speaking character's voice in that one clip, keyed by
   *  the character NAME. The name is the key because it is exactly the string the clip
   *  was rendered under: StoryboardView sends `assetMap[d.characterId].name` as
   *  `character`, and server._render_dialogue_clip looks that speaker's locked voice
   *  anchor up by the same string — so a Stage-2 id renumbering can never re-point one
   *  character's verdict onto another's voice.
   *
   *  There is deliberately NO per-speaker clip path beside it. A shot where two or three
   *  characters speak is ONE render on purpose — the only shape in which they can talk
   *  OVER each other — and server.py:4470-4474 states the result therefore cannot be
   *  split back out per speaker; /api/shot/dialogue-clip returns `{path, duration}` and
   *  nothing else (server.py:8119). The clip is shared; only the verdicts are per-voice.
   *
   *  `dialogueApproved` above stays the single flag Stage 5 gates on
   *  (FinalGenView.tsx:742) and is WRITTEN FROM this map (approved = every speaker
   *  ticked), never set beside it — otherwise "approved" could mean "one of the two
   *  voices is wrong".
   *
   *  Optional + read-time defaulted (`?? {}`) so `migrate()` stays a no-op — the v5 rule
   *  at pipeline.store.ts:628-631: "ALL new fields are optional → existing records stay
   *  valid untouched; defaults are applied at READ sites (`x ?? default`), so the
   *  migration is a no-op transform and just marks the schema version." A board written
   *  before 2026-08-09 has no key at all and reads as {}. */
  dialogueSpeakerApproved?: Record<string, boolean>
}

export interface SceneStoryboardState {
  status: 'idle' | 'generating' | 'pending' | 'approved'   // approved = every shot board approved
  shotBoards: Record<string, ShotBoardState>
  qcResult: unknown | null
  notes: string
}

export interface GeneratedAsset {
  assetId: string
  imageUrls: string[]
  selectedUrl: string | null
  loraRef?: string
}

/** A rung on the render cost ladder. A tier is a (model, resolution) pair resolved
 *  SERVER-SIDE (byteplus_generative.resolve_tier) — the frontend only names the rung.
 *
 *  preview 480p ($0.35/5s) — judge timing, blocking, does the beat read
 *  edit    720p ($0.76/5s) — judge the cut with the shots side by side
 *  master  project output size, 4k by default ($3.89/5s) — approved shots only
 *
 *  Over a ~540-shot episode that is ~$189 a preview pass against ~$2,100 a master
 *  pass, which is the entire reason the ladder exists.
 *
 *  Promotion is NOT an upscale. Seedance 2.0 has no seed, so re-rendering a shot at
 *  a higher tier produces a FRESH sample that can differ from the take approved
 *  below it; only the prompt and first frame carry over. Every promotion control
 *  has to say so — over-promising exactly this is what got the earlier draft→HD
 *  tier removed. */
export type RenderTier = 'preview' | 'edit' | 'master'

/** Low→high. Rank, never string inequality: comparing a shot's resolution against
 *  the project's output size (the old hdCandidates test) made LOWERING the output
 *  size offer to re-render every finished shot DOWNWARD. */
export const TIER_ORDER: readonly RenderTier[] = ['preview', 'edit', 'master']
export const tierRank = (t: RenderTier | undefined): number =>
  TIER_ORDER.indexOf(t ?? 'master')

/** The size preview/edit pin themselves to. The SERVER is authoritative
 *  (byteplus_generative.TIER_RESOLUTIONS decides what is actually submitted); this
 *  copy exists only so the UI can label a button and time a render honestly before
 *  the response comes back. 'master' is absent because it follows the project's
 *  own output size. Keep the two in sync — they are small and rarely change. */
export const TIER_FIXED_RESOLUTION: Partial<Record<RenderTier, string>> = {
  preview: '480p',
  edit: '720p',
}

/** Documented cost per 5-second 16:9 shot with no input video, per MODEL and
 *  resolution. Source: the live ModelArk pricing page (docs.byteplus.com/en/docs/
 *  ModelArk/1544106, read 2026-09-04): 2.5 = $0.514 / $1.156 / $2.843 at 480p / 720p /
 *  1080p (list price — 1080p carries a 28 % promotion until 2026-10-17 that is NOT
 *  baked in, so a forecast over-estimates rather than under-estimates); 2.0 base =
 *  $0.35 / $0.76 / $1.87 / $3.89; Fast $0.28 / $0.60; Mini $0.18 / $0.38.
 *
 *  The table used to be keyed by resolution alone with the 2.0 figures, which quoted a
 *  2.5 render at 720p 34 % under its real price and would have done the same at 1080p.
 *  A model/resolution pair the model cannot render is simply absent. The BILLED figure
 *  always comes from the returned completion_tokens, never from here. */
export const VIDEO_COST_PER_5S: Record<string, Record<string, number>> = {
  v25:  { '480p': 0.514, '720p': 1.156, '1080p': 2.843 },
  base: { '480p': 0.35, '720p': 0.76, '1080p': 1.87, '4k': 3.89 },
  fast: { '480p': 0.28, '720p': 0.60 },
  mini: { '480p': 0.18, '720p': 0.38 },
}
/** Per-5s price for (model, resolution). Unknown model → base 2.0, the rate the app
 *  quoted for everything before the table learned about models. */
export const videoCostPer5s = (model: string | undefined, resolution: string): number =>
  (VIDEO_COST_PER_5S[model ?? 'base'] ?? VIDEO_COST_PER_5S.base)[resolution]
  ?? VIDEO_COST_PER_5S.base[resolution] ?? 0
/** Base 2.0 column, kept for callers that have no model in scope. */
export const RESOLUTION_COST_PER_5S: Record<string, number> = VIDEO_COST_PER_5S.base

export interface GeneratedShot {
  shotId: string
  thumbnailUrl: string   // Seedream keyframe (0.5) — used as first_frame for Seedance
  videoUrl: string
  /** 720p H.264 preview proxy for 4k (10-bit HEVC) renders — plays in Chrome/Firefox
   *  where the raw 4k doesn't. Empty for non-4k. Prefer this in <video>; keep videoUrl
   *  (the 4k HEVC) as the download/export deliverable. */
  previewUrl?: string
  audioUrl?: string
  /** Seconds of footage in this take. UNSET means the length was never measured — a
   *  project reopened from disk whose take would not probe. It was required, so
   *  reconstruction filled the gap with a literal 5 and the phase-6 gate scored that
   *  five as if it had been measured. Optional so the gap can travel as a gap. */
  duration?: number
  seedanceTaskId?: string
  assembledPrompt?: string  // The formula prompt actually sent to Seedance (for verification)
  /** Absolute disk path of the saved keyframe — never expires; used as first_frame at animation time. */
  keyframeLocalPath?: string
  /** Absolute disk path of the saved render — never expires; used for QC and the editor. */
  videoLocalPath?: string
  /** How many approved-asset references the keyframe was generated with (consistency evidence). */
  keyframeRefCount?: number
  /** Seedance seed from the poll response — replaying it reproduces the take (draft→HD). */
  seed?: number
  /** Rendered resolution as reported by Seedance (480p / 720p / 1080p / 4k). */
  renderedResolution?: string
  /** Which rung of the cost ladder this take was rendered at (see RenderTier).
   *  UNSET means unknown — treated as 'master' everywhere tiers are ranked, so a
   *  shot of unknown provenance (e.g. a project reopened from disk) is never
   *  offered for promotion. Absent on every pre-ladder project by design. */
  tier?: RenderTier
  /** Last frame of the render (return_last_frame) — feeds scene-continuity chaining. */
  lastFrameUrl?: string
  /** Raw last-frame PNG persisted on disk (unaltered → keeps Seedance's trust watermark).
   *  The TRUSTED first_frame source for Extend, unlike an ffmpeg-extracted frame. */
  lastFrameLocalPath?: string
  /** When the current render started (ms epoch) — drives the visible elapsed timer. */
  renderStartedAt?: number
  /** Resolution of the render currently in flight (480p/720p/1080p). */
  renderingResolution?: string
  /** Generation mode. UNSET = default: 'storyboard' when the shot has a board
   *  (Seedance reference mode follows the beats), else 'keyframe'. Explicit
   *  'keyframe' is the cheap still-preview alternative. 'motion_ref' runs
   *  Seedance reference mode (no keyframe first-frame) so an attached reference
   *  video can drive the motion — i2v rejects mixing a first frame with any
   *  reference media, so this is the only mode where a motion video is honored. */
  /** ...and 'continuity' pins this shot's FIRST FRAME to the previous shot's last
   *  frame, for an exact match across the cut. It sends NO reference images:
   *  Seedance's modes are mutually exclusive — a first frame cannot be combined
   *  with reference_image — so this trades identity-by-references for raccord.
   *  Use it on continuous action across a cut; leave it off when the shot needs
   *  the character sheets to hold the face. */
  mode?: 'keyframe' | 'storyboard' | 'motion_ref' | 'continuity'
  /** Per-shot director notes — honored by keyframe AND animation prompts. */
  notes?: string
  status: 'queued' | 'generating' | 'keyframe_ready' | 'animating' | 'ready' | 'approved' | 'rejected'
  // ── Phase 0 (additive, all optional) ──
  /** Currently-shown take from the normalized FinalGenData.shotVersions stack (Phase 4). */
  selectedVersionId?: string
  isCustom?: boolean
  orderIndex?: number
  motionReferenceVideoId?: string | null
  /** assetId → asset version id used for the CURRENT take — flags a shot as stale
   *  when a dependency asset advances (Phase 2). */
  sourceAssetVersions?: Record<string, string>
  /** 3-bug1c: the storyboard board VERSION (ShotBoardState.version, monotonic vNNN)
   *  this clip was rendered from. When the shot's current board advances past it,
   *  FinalGenView flags the clip STALE ('board changed — regenerate this clip').
   *  Optional + read-time defaulted (undefined → never stale) so migrate() stays a no-op. */
  sourceBoardVersion?: number
}

export interface FinalGenData {
  shots: GeneratedShot[]
  // ── Phase 0 (additive, optional) — version stacks stored NORMALIZED (maps by id),
  // NEVER nested inside shots[] (deep-nested store arrays caused render loops before). ──
  /** shotId → all takes (the discarded ones stay here so the timeline stack can switch). */
  shotVersions?: Record<string, ShotVersion[]>
  /** shotId → the selected take's id. */
  shotSelectedVersion?: Record<string, string>
}

// ─── Phase 0: variants, versioning, custom shots, voice (ALL additive) ───────

/** A wearable/handheld a character carries: hat, cane, sword, jacket, boots… */
export interface CharacterProp {
  id: string
  type: string          // 'hat' | 'weapon' | 'garment' | 'footwear' | 'accessory' | free text
  description: string
}

/** Seed Audio audio_config — documented ranges (audio-generation.md §5). */
export interface VoiceAudioConfig {
  format?: string
  sample_rate?: number
  speech_rate?: number   // -50..100
  loudness_rate?: number // -50..100
  pitch_rate?: number    // -12..12
}

/** One re-generation of a voice, kept in history so a change can be reverted. */
export interface VoiceVersion {
  id: string
  createdAt: number
  notes?: string                 // the change request that produced this version
  designDescription?: string
  audioConfig?: VoiceAudioConfig
  previewLocalPath?: string      // persisted preview on disk (never the 2h Seed Audio URL)
}

/** A character's locked voice — design (synthesized from a description) or clone
 *  (from uploaded reference clips). Persisted per character; every line reuses it. */
export interface VoiceProfile {
  mode: 'design' | 'clone'
  designDescription?: string           // design mode
  referenceAudioPaths?: string[]       // clone mode — persisted disk paths (up to 3)
  audioConfig?: VoiceAudioConfig
  previewLocalPath?: string
  versions?: VoiceVersion[]            // history of re-generations with notes
  selectedVersionId?: string
}

/** One saved generation of an asset sheet. Stored NORMALIZED (Record<assetId,
 *  AssetVersion[]>) in Stage-3 data, never nested in Asset[]. Persisted to disk. */
export interface AssetVersion {
  id: string
  createdAt: number
  localPath?: string             // persisted image on disk (never the 24h CDN URL)
  url?: string                   // CDN url (best-effort; localPath is source of truth)
  sentPrompt?: string
  notes?: string                 // the regenerate-with-comments note that produced it
  status?: 'draft' | 'approved'
}

/** One saved render of a shot (a "take"). Stored NORMALIZED (FinalGenData.shotVersions).
 *  Discarded takes stay here for the timeline stack; each persisted to disk (survives 24h CDN). */
export interface ShotVersion {
  id: string
  createdAt: number
  videoLocalPath?: string        // persisted render on disk (never the 24h CDN URL)
  videoUrl?: string
  previewUrl?: string
  seedanceTaskId?: string
  resolution?: string
  /** Ladder rung this take was rendered at. Lets the Takes list show that a shot
   *  has, say, an approved 480p preview and a 4k master side by side. */
  tier?: RenderTier
  lastFrameUrl?: string
  assembledPrompt?: string
  notes?: string
  status?: 'draft' | 'approved'
  sourceAssetVersions?: Record<string, string>  // assetId → version id used (stale-check)
}

// ─── Studio gallery (P3) ─────────────────────────────────────────────────────
// One persisted record per Studio generation. URLs prefer the disk-served copy
// (never expires) over the 24h CDN link.
export interface GalleryItem {
  id: string
  mode: 'image' | 'video' | 'combined'
  prompt: string
  imageUrls: string[]
  videoUrl: string | null
  /** Disk path of the saved video, if persisted (served via /api/asset/serve). */
  videoLocalPath?: string
  seed?: number
  createdAt: number
}

// A reference picked (from the gallery or elsewhere) onto the shared tray, so it
// can be reused as a reference in any stage's ReferenceMediaPanel (P3b).
export interface TrayItem {
  id: string
  url: string
  kind: 'image' | 'video'
}

export interface DeliveryData {
  sequence: string[] // ordered shot IDs
  exportFormats: string[]
  exportUrl?: string
}
