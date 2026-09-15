import { apiClient } from './client'
import type { BreakdownData, ProjectStyle } from '@/lib/types/pipeline.types'

export interface QCResponse {
  passed: boolean
  checks: Array<{ label: string; passed: boolean; notes: string; blocking?: boolean }>
  summary: string
  regen_prompt: string | null
  persona?: string                    // P6: which QC persona ran this gate
  drift_score?: number | null         // P4: 0.0 = on-style, 1.0 = off-style
  visual_observations?: {
    dominant_palette?: string
    lighting?: string
    render_style?: string
    observations?: string
    style_match_score?: number
  } | null
}

/** A character's locked voice. engine: "seed_tts" → preset voice (speaker + pitch/rate);
 *  "seed_audio" → Seed Audio 1.0 clone from ref_audio_path; "seed_audio_image" →
 *  design voice inferred from the character's portrait (image_ref_path). */
export interface VoiceConfig {
  speaker: string
  pitch_rate: number
  speech_rate: number
  loudness_rate?: number
  engine?: 'seed_tts' | 'seed_audio' | 'seed_audio_image'
  ref_audio_path?: string
  image_ref_path?: string
  versions?: Array<{ id: string; createdAt: number; notes?: string; engine?: string; speaker?: string; pitch_rate?: number; speech_rate?: number; loudness_rate?: number; ref_audio_path?: string; image_ref_path?: string }>
  selectedVersionId?: string
}

/** One gate from claude_agents.check_story_spine — Obstacle, Value change, Rhythm of
 *  reversals, Questions answered. Same shape as a QC check, on purpose: the breakdown
 *  QC already folds these in. `blocking` is absent on the checks that make the film
 *  weaker rather than illegible (Rhythm of reversals never sets it). */
export interface SpineCheck {
  label: string
  passed: boolean
  notes: string
  blocking?: boolean
}

/** One sequence of the STORY SPINE (claude_agents.generate_film_bible). Field names are
 *  the bible's on-disk shape, not a renaming — the gates read these exact keys, so a UI
 *  that edits the spine has to write them back verbatim. */
export interface BibleSequence {
  id: string
  /** The scene headings this sequence spans, comma separated. */
  covers?: string
  question_opened?: string
  /** Ids of the EARLIER sequences whose questions this one closes — a list, because a
   *  climax usually closes several at once. Bibles written before that can hold a bare
   *  string, which check_story_spine still accepts, so the UI must handle both. */
  answers?: string[] | string
  value_in?: string
  value_out?: string
  /** 'up' | 'down' move the protagonist's situation and are the only values the Value
   *  change gate counts; the model is told to leave it unchanged when nothing moves. */
  direction?: string
  /** What actively resists them, as something a camera can see. "NONE" (any casing) is
   *  what the Obstacle gate reads as nothing resisting. */
  obstacle?: string
  /** What this stretch is FOR — written by propose_spine, absent on derived bibles. */
  purpose?: string

  // ── The drama layer (claude_agents._check_drama_layer). EVERY field is optional and
  //    a bible that declares none of them scores exactly what it scores today: each of
  //    the eight new gates is guarded by "does any sequence declare the field I read".
  //    So the editor must be able to write a field AND to remove it again — an empty
  //    string here is not the same fact as an absent key, and normalise_sequence_drama
  //    drops anything it cannot read rather than keeping it.
  /** Dramatic intensity 1-10. 8+ is a PEAK, which the Irreversible peak gate then
   *  requires to cost something. Absent = this sequence declares no tension. */
  tension?: number
  /** One of claude_agents.SEQ_MODES. An unknown word reads as ABSENT in the gates. */
  mode?: string
  /** external_agent | environment | rule | self — WHO resists. 'self' is what produced
   *  FARO: 5 of 6 obstacles were the protagonist's own passivity. */
  obstacle_type?: string
  /** The named character/force resisting. The Recurring adversary gate counts repeats. */
  obstacle_owner?: string
  /** What this sequence COSTS. A bare string is legacy/model shorthand for `loses` and
   *  claude_agents._seq_event still accepts it, so the UI has to read both. */
  event?: { irreversible?: boolean; who?: string; loses?: string } | string
  /** 0-3, CUMULATIVE: how much the protagonist has given up by the END of this sequence. */
  cost_level?: number
  /** This sequence's fraction of the runtime. The shares sum to 1.0; the backend also
   *  reads a number > 1 as a percentage, which is why the editor writes fractions only. */
  seconds_share?: number
}

/** The film bible. Permissive on purpose — it is a loose dict on disk and carries fields
 *  nothing reads yet — EXCEPT the story spine, which a UI edits and the gates count. */
export interface FilmBible {
  logline?: string
  tone?: string
  characters?: Array<{ name: string; wants?: string; needs?: string; arc?: string }>
  sequences?: BibleSequence[]
  story_checks?: SpineCheck[]
  /** Approval lives INSIDE bible.json so it travels with the document it approves. */
  spine_approved?: boolean
  [key: string]: unknown
}

export interface BibleResponse {
  bible: FilmBible
  /** Recomputed by the backend over the bible it is returning — never the client's copy. */
  checks: SpineCheck[]
  approved: boolean
}

/** One queued render: the SAME wire body POST /api/video/create takes, already in
 *  snake_case, so the queue replays it unchanged instead of re-deriving the prompt. */
export type RenderQueueJob = Record<string, unknown> & { shot_id: string }

export type RenderQueueStatus = 'queued' | 'submitted' | 'done' | 'failed' | 'cancelled'

/** What the backend can honestly say about MONEY for one queued shot (render_queue.
 *  CHARGE_RISKS). The queue's claim window straddles the paid submit, so a stranded entry
 *  is NOT proof that nothing was billed — it used to be reported as if it were.
 *    'adopted'   an already-accepted task was found and reused; one charge, not two
 *    'unknown'   stranded, no evidence either way — the honest default
 *    'likely'    a submit went out and never got a verdict; a render may be billing
 *    'duplicate' PROVEN: a superseded claim filed its own task_id, so two paid renders
 *                exist for this shot */
export type RenderChargeRisk = '' | 'adopted' | 'unknown' | 'likely' | 'duplicate'

export interface RenderQueueState {
  queue_id: string
  running: boolean
  entries: Array<{
    shot_id: string; status: RenderQueueStatus; task_id?: string | null; error?: string | null
    charge_risk?: RenderChargeRisk
    /** What to check and where — written to be actionable, so show it verbatim. */
    charge_note?: string | null
    /** task_ids of renders that were submitted and billed but lost the entry to a
     *  competing claim. Naming them is the only way the operator can find the charge. */
    duplicate_task_ids?: string[]
  }>
  counts: { queued: number; submitted: number; done: number; failed: number }
  /** Shots with EVIDENCED risk ('likely' | 'duplicate'). Optional: an older backend
   *  simply doesn't send it and the panel shows no badge. */
  charges_at_risk?: number
}

/** Converts a ProjectStyle store object to the backend StyleConfig shape. */
function toStyleConfig(style: ProjectStyle) {
  return {
    label: style.id,
    prompt_suffix: style.promptSuffix,
    negative_prompt: style.negativePrompt,
    anchor_image_refs: style.anchorImageRefs ?? [],
  }
}

/** Everything a Seedance render needs, in the app's camelCase vocabulary. This used
 *  to be an inline annotation on createVideoTask; it is named now because the
 *  background render queue (C3) has to build the very same call without going
 *  through createVideoTask — a queued shot assembled from a second, drifting copy
 *  of this shape would render differently from the interactive one. */
export interface VideoCreateParams {
  shotId: string
  imageUrl: string
  prompt: string
  shotAction?: string
  shotScene?: string
  subjectHint?: string
  cameraAngle?: string
  envHint?: string
  lightingHint?: string
  // REQUIRED, and required at compile time rather than defaulted here. The backend makes
  // duration_secs mandatory on purpose — a guessed length is paid, mistimed footage — and
  // this mapper used to fill an absent one with 5, which turned that deliberate refusal
  // into a silently wrong render. Stage 5 always passes the measured value; the queue and
  // any new caller now have to as well, and tsc says so instead of Seedance.
  durationSecs: number         // SUM of the segment's shots; [4,15] enforced in backend (Seedance 2.0 §1)
  /** The shots INSIDE this call. One Seedance generation may hold several, which it
   *  cuts between itself — the only way a sub-4s beat can exist, since the API floor
   *  is 4s PER CALL. Absent/empty → classic one-shot-per-call assembly, unchanged. */
  segmentShots?: Array<{
    id: string; duration_sec: number; shot_size?: string; camera_move?: string
    layout?: string; action: string; assets_used?: string[]
    dialogue?: Array<{ character?: string; text?: string; emotion?: string }>
  }>
  sceneName?: string
  timeOfDay?: string
  /** What the previous segment ended on, restated as content — the model keeps no
   *  memory across calls, so this is what stops a cut from drifting elsewhere. */
  prevSegmentEnd?: string
  style: ProjectStyle
  referenceImages?: Array<{ url: string; role: string; weight?: number; path?: string; kind?: string }>
  referenceVideos?: string[]
  // Index-aligned with referenceVideos: 'body' | 'face' | '' for the undivided motion
  // role. Parallel to the urls, not folded into them, because the render queue replays
  // stored bodies verbatim and every one of those carries reference_videos as strings.
  referenceVideoKinds?: string[]
  /** Language the dialogue is WRITTEN in, declared by the breakdown. The 2.5 guide asks
   *  for it ahead of every spoken line because the model defaults to Chinese. */
  dialogueLanguage?: string
  audioUrl?: string
  generateAudio?: boolean      // false = retry path for Seedance audio content-filter false positives
  ratio?: string               // project aspect ratio
  resolution?: string          // 480p|720p|1080p|4k — the project's output size
  // Render tier: 'preview' (480p) and 'edit' (720p) pin their own size server-side
  // and ignore `resolution`; 'master' honours it. Omitted = legacy behaviour.
  tier?: 'preview' | 'edit' | 'master'
  /** Settings' "Video model" pick. Omitted = the previous behaviour exactly (base 2.0).
   *  A tier still wins: preview/edit/master pin their own model for cost reasons. */
  modelChoice?: 'v25' | 'base' | 'fast' | 'mini'
  /** True for "Match the previous cut": the first frame must stay byte-exact, so the
   *  backend must not reroute it through 2.5's (approximating) reference mode. */
  exactFirstFrame?: boolean
  seed?: number                // NO-OP on Seedance 2.0; kept for metadata only
  dialogue?: Array<{ character: string; text: string; emotion?: string }>
  /** Scene-mode dialogue direction from the breakdown; '' → per-line concat. */
  dialogueScene?: string
  /** ACTING MASTER PROFILES for this take's characters, `addr` = their 1-based
   *  reference-image index. Only 2.5 renders them (see assemble_subject_profiles). */
  subjects?: Array<{ name: string; acting: string; addr: number }>
  /** Names of assets approved in this SCENE that this take does not attach. */
  unusedAssets?: string[]
  // Production Video Direction template (Claude-assembled server-side)
  useDirection?: boolean
  directionMode?: 'storyboard' | 'keyframe'
  // The board's beats, forwarded VERBATIM and serialized as JSON — `unknown`, not
  // `string`, because a beat value is not always a string: `crossing` is a boolean.
  // The backend reads named fields only (desc/red/blue/green/orange/purple in
  // claude_agents' two beat_lines builders), so widening this changes no payload.
  beats?: Array<Record<string, unknown>>
  charName?: string
  charSignature?: string
  refAddressing?: string[]
  directorNotes?: string
  // Item 0/7c: dryRun assembles the direction prompt (incl. the Claude vision
  // step) WITHOUT creating a task; overrides are sent verbatim.
  dryRun?: boolean
  promptOverride?: string
  negativeOverride?: string
  // B2: lets the backend save this render autonomously if the tab closes
  projectName?: string
  projectPath?: string
}

/** camelCase params → the snake_case body POST /api/video/create takes. ONE mapping,
 *  shared by createVideoTask and by the render queue, whose jobs ARE these bodies
 *  replayed verbatim server-side (C3). Defaults live here so a queued job carries the
 *  same filled-in values an interactive submit would. */
export function toVideoCreateBody(params: VideoCreateParams): RenderQueueJob {
  return {
    shot_id: params.shotId,
    image_url: params.imageUrl,
    prompt: params.prompt,
    shot_action: params.shotAction ?? '',
    shot_scene: params.shotScene ?? '',
    subject_hint: params.subjectHint ?? '',
    camera_angle: params.cameraAngle ?? '',
    env_hint: params.envHint ?? '',
    lighting_hint: params.lightingHint ?? '',
    duration_secs: params.durationSecs,
    // Segment mode: the shots INSIDE this call. Empty → the server takes the
    // classic one-shot-per-call path, so nothing existing changes.
    segment_shots: params.segmentShots ?? [],
    scene_name: params.sceneName ?? '',
    time_of_day: params.timeOfDay ?? '',
    prev_segment_end: params.prevSegmentEnd ?? '',
    style: toStyleConfig(params.style),
    reference_images: params.referenceImages ?? [],
    reference_videos: params.referenceVideos ?? [],
    reference_video_kinds: params.referenceVideoKinds ?? [],
    dialogue_language: params.dialogueLanguage ?? '',
    audio_url: params.audioUrl ?? null,
    generate_audio: params.generateAudio ?? true,
    ratio: params.ratio ?? '16:9',
    resolution: params.resolution ?? '720p',
    tier: params.tier ?? '',
    model_choice: params.modelChoice ?? '',
    exact_first_frame: params.exactFirstFrame ?? false,
    seed: params.seed ?? null,
    dialogue: params.dialogue ?? [],
    dialogue_scene: params.dialogueScene ?? '',
    subjects: params.subjects ?? [],
    unused_assets: params.unusedAssets ?? [],
    use_direction: params.useDirection ?? false,
    direction_mode: params.directionMode ?? 'keyframe',
    beats: params.beats ?? [],
    char_name: params.charName ?? '',
    char_signature: params.charSignature ?? '',
    ref_addressing: params.refAddressing ?? [],
    director_notes: params.directorNotes ?? '',
    dry_run: params.dryRun ?? false,
    prompt_override: params.promptOverride ?? '',
    negative_override: params.negativeOverride ?? null,
    project_name: params.projectName ?? '',
    project_path: params.projectPath ?? '',
  }
}

export const pipelineApi = {
  // ── Project boot ─────────────────────────────────────────────────────────
  /** F2c: the project the BACKEND last saw being worked on. Both of the frontend's
   *  memories of the project root live in localStorage, so both die together with
   *  cleared site data / a fresh browser / incognito — this is the only thing left that
   *  knows a project exists. `project_path` is '' when there is none, or when the folder
   *  it named has since been deleted; never a 404. */
  getLastProject: () =>
    apiClient.get<{ project_path: string; project_name: string; savedAt: string }>('/api/project/last')
      .then((r) => r.data),

  /** Forget it — called on Reset, so a project the user just cleared cannot come back on
   *  the next boot through the fallback above. */
  forgetLastProject: () =>
    apiClient.delete<{ forgotten: boolean }>('/api/project/last').then((r) => r.data),

  // ── Stage 1 ──────────────────────────────────────────────────────────────
  generateScript: (concept: string, projectName?: string, projectPath?: string, targetDurationSecs?: number) =>
    apiClient.post<{ content: string; concept: string }>('/api/script/generate', {
      concept,
      project_name: projectName ?? '',
      project_path: projectPath ?? '',
      target_duration_secs: targetDurationSecs ?? 60,
    }, { timeout: 600_000 }).then((r) => r.data),   // long-form scripts exceed the 120s default

  // Item 1c — interactive "Develop idea": expand a concept + get selection questions.
  // Claude-routed (NOT seed); the one-shot Generate path above is unchanged.
  expandConcept: (concept: string, targetDurationSecs?: number) =>
    apiClient.post<{ expanded_concept: string; questions: Array<{ id: string; question: string; options: string[] }> }>(
      '/api/script/expand',
      { concept, target_duration_secs: targetDurationSecs ?? 60 },
      { timeout: 300_000 },
    ).then((r) => r.data),

  /** How long the script actually RUNS, from the pipeline's own duration maths
   *  (claude_agents.estimate_script_seconds) — dialogue at speaking rate, action at
   *  4.5 words/sec, the numbers phase 2 sizes its shots with. Pure arithmetic, no
   *  LLM, so the short timeout is the point: this is a label, and a label must not
   *  hold a generate or an autopilot run for two minutes when the backend is down. */
  scriptRuntime: (script: string) =>
    apiClient.post<{ seconds: number; dialogue_seconds: number; action_seconds: number; words: number }>(
      '/api/script/runtime', { script }, { timeout: 20_000 }).then((r) => r.data),

  qcScript: (script: string, concept?: string) =>
    apiClient.post<QCResponse>('/api/script/qc', { script, concept: concept ?? '' })
      .then((r) => r.data),

  // ── Stage 2 ──────────────────────────────────────────────────────────────
  // `concept` is the film's premise. The breakdown fans out into CONCURRENT batches
  // that each see only their own slice of the script, so without it five workers break
  // down the same film with no idea what it is about. The backend already accepted the
  // field; the client just never sent it.
  generateBreakdown: (script: string, projectName?: string, projectPath?: string,
                      targetDurationSecs?: number, concept?: string,
                      /** Settings' video model — the planner groups shots into segments THIS
                       *  model can render in one take (15s on 2.0, 30s on 2.5). */
                      modelChoice?: string) =>
    apiClient.post<BreakdownData>('/api/breakdown/generate', {
      script,
      concept: concept ?? '',
      project_name: projectName ?? '',
      project_path: projectPath ?? '',
      target_duration_secs: targetDurationSecs ?? 60,
      model_choice: modelChoice ?? '',
    }, { timeout: 900_000 }).then((r) => r.data),   // long-form: chunked into concurrent scene batches (150 min ≈ 30 batches)

  // targetDurationSecs lets the QC compare the breakdown's total runtime against what
  // was asked for. The UI has always shown that total; nothing ever checked it.
  // deterministicOnly skips the subjective LLM pass — autopilot uses it, since
  // everything that blocks an unattended run is arithmetic and the paid round-trip
  // cannot change the outcome.
  /** The project fields let the backend fold in the STORY gates (obstacle, value change,
   *  reversals, questions answered), which live in the bible. Omit them and the response
   *  is exactly what it was before. */
  /** `modelChoice` MUST be the same value generateBreakdown was given. The QC's duration
   *  ceilings are the chosen model's per-call limit (30s on 2.5, 15s on the 2.0 family),
   *  and the plan was written against exactly that number — sending nothing here is what
   *  made every 2.5 breakdown fail two blocking checks for takes the renderer accepts. */
  qcBreakdown: (breakdown: BreakdownData, script: string, targetDurationSecs?: number,
                deterministicOnly = false, project?: { name?: string; path?: string },
                modelChoice?: string) =>
    apiClient.post<QCResponse>('/api/breakdown/qc',
      { breakdown, script, target_duration_secs: targetDurationSecs ?? 0,
        deterministic_only: deterministicOnly,
        project_name: project?.name ?? '', project_path: project?.path ?? '',
        model_choice: modelChoice ?? '' },
      { timeout: 300_000 }).then((r) => r.data),

  // ── Film bible / story spine ──────────────────────────────────────────────
  /** Read the project's bible plus the STORY gates recomputed over it. The bible was
   *  written by phase 2 and read by nothing that could change it; this is the way in. */
  getBible: (params: { projectName?: string; projectPath?: string }) =>
    apiClient.get<BibleResponse>('/api/bible', {
      params: { project_name: params.projectName ?? '', project_path: params.projectPath ?? '' },
    }).then((r) => r.data),

  /** Have Take One Studio PROPOSE the spine from the script, before any breakdown exists.
   *
   *  The bible used to come into being only as a lazy side effect INSIDE
   *  /api/breakdown/generate: by the time the story tab could show a spine, the shot
   *  list had already been written from it, so approving it was approving something
   *  that had already been used. This is the same derivation, callable on its own.
   *
   *  Answers the SAME shape as GET /api/bible, so the panel can treat a derive exactly
   *  like a reload. Long timeout: it is a full Claude pass over the whole script, the
   *  same one the breakdown pays for today. */
  deriveBible: (params: { projectName?: string; projectPath?: string; script: string; targetDurationSecs?: number }) =>
    apiClient.post<BibleResponse>('/api/bible/derive', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
      script: params.script,
      target_duration_secs: params.targetDurationSecs ?? 60,
    }, { timeout: 600_000 }).then((r) => r.data),

  /** Have Take One Studio DESIGN the spine from the concept — before a word of script exists.
   *
   *  NO CALLER since 2026-08-12, deliberately. Designing from the concept means the model
   *  never sees the script, and on THE DIVORCE DRAMA QUEEN 2 it duly invented a cast:
   *  CLARA and DANIEL against a script about JOEL and MARA, 10/12 gates passing. The route
   *  is out of the UI; this client and the endpoint behind it are kept, unreachable, in
   *  case the idea comes back somewhere it can be checked (before "Develop idea", where
   *  the script would then be written to fit the spine rather than contradict it).
   *
   *  The inverse of deriveBible, and the whole point of it: a spine derived FROM a
   *  finished script is a post-mortem — it can report that nothing resisted the
   *  protagonist and it can never make something resist him. This one lands on disk
   *  first, with the drama layer (tension, mode, cost, share) the script is then
   *  written to fit.
   *
   *  Same response shape as GET /api/bible, so the panel treats it exactly like a
   *  reload. Same long timeout as the derivation — it is one full LLM pass. A 409 comes
   *  back when the stored spine is already APPROVED; the caller must not retry it, the
   *  user has to un-approve first. */
  proposeBible: (params: { projectName?: string; projectPath?: string; concept: string; targetDurationSecs?: number; toneHint?: string }) =>
    apiClient.post<BibleResponse>('/api/bible/propose', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
      concept: params.concept,
      target_duration_secs: params.targetDurationSecs ?? 60,
      tone_hint: params.toneHint ?? '',
    }, { timeout: 600_000 }).then((r) => r.data),

  /** Save an edited bible. The gates come back recomputed over what was STORED, so an
   *  edit that breaks the value chain shows up in the response rather than at render.
   *  Omit `approved` to leave the existing approval (bible.spine_approved) untouched. */
  saveBible: (params: { projectName?: string; projectPath?: string; bible: FilmBible; approved?: boolean }) =>
    apiClient.put<BibleResponse>('/api/bible', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
      bible: params.bible,
      ...(params.approved === undefined ? {} : { approved: params.approved }),
    }).then((r) => r.data),

  /** Director pass — fill a character's personality/backstory/wardrobe + the ACTING
   *  master profile (Seed 2.0 Pro). */
  enrichCharacter: (name: string, description?: string, context?: string) =>
    apiClient.post<{ personality?: string; backstory?: string; wardrobe?: string; acting?: string }>(
      '/api/character/enrich', { name, description: description ?? '', context: context ?? '' },
      { timeout: 120_000 }).then((r) => r.data),

  /** Vision read of character reference image(s) → structured fields (Seed 2.0 Pro). */
  describeCharacterRefs: (imageUrls: string[]) =>
    apiClient.post<{ appearance: string; hairstyle: string; wardrobe: string; shoes: string; props: string }>(
      '/api/character/describe-refs', { image_urls: imageUrls }, { timeout: 120_000 }).then((r) => r.data),

  /** Rewrite/enhance (or write, if empty) one field with the LLM (Seed 2.0 Pro). */
  enhanceText: (field: string, current?: string, context?: string) =>
    apiClient.post<{ text: string }>(
      '/api/text/enhance', { field, current: current ?? '', context: context ?? '' },
      { timeout: 120_000 }).then((r) => r.data.text),
  /** Same call, with the guide-check warnings. For `field: 'seedance_direction'` the server
   *  rewrites under the official Seedance guide of `context.model` and answers `text: ''`
   *  plus the failures when the result would break it — the caller keeps its text then. */
  enhanceTextChecked: (field: string, current?: string, context?: string) =>
    apiClient.post<{ text: string; warnings?: string[] }>(
      '/api/text/enhance', { field, current: current ?? '', context: context ?? '' },
      { timeout: 180_000 }).then((r) => ({ text: r.data.text ?? '', warnings: r.data.warnings ?? [] })),

  /** Batch-direct a group of shots in ONE call (Seed 2.0 Pro): action + visual +
   *  acting `performance`, grounded in the story (pass dialogue for the acting) and in
   *  the cast's acting master profiles, so the performance is a re-expression of who the
   *  character is instead of a fresh invention per batch.
   *  Per shot, `characters` = the names of the character assets IN that shot (resolve
   *  assetsUsed against the asset table — the backend only sees ids and cannot tell a
   *  character from a prop). An empty array means nobody is in frame and the shot comes
   *  back with performance '' — no acting direction for a shot with no actor. Omit the
   *  key entirely to keep the pre-existing behaviour (a performance for every shot).
   *  Per dialogue line, `character` = the SPEAKER'S NAME. The stored shape is
   *  {characterId:'ASSET_004'} and the backend holds no asset table, so the caller must
   *  resolve it — measured 2026-08-07, all 27 of BLOOM's dialogue lines were reaching the
   *  director with an empty speaker. `characterId` is still sent (the backend falls back
   *  to it when it holds a real name) but a bare asset id is never used as a speaker. */
  enhanceShots: (
    shots: Array<{ id: string; action?: string; visual_description?: string; dialogue?: Array<{ character?: string; characterId?: string; text?: string; emotion?: string }>; characters?: string[] }>,
    characters?: Array<{ name: string; acting?: string | null }>,
  ) =>
    apiClient.post<{ shots: Record<string, { action?: string; visual?: string; performance?: string }> }>(
      '/api/shots/enhance', { shots, characters: characters ?? [] }, { timeout: 180_000 }).then((r) => r.data.shots),

  // ── Stage 3 ──────────────────────────────────────────────────────────────
  /** `styleAnchorUrls` = the project's own style anchor images (store:
   *  style.anchorImageRefs). They are what makes the drift number mean anything: with
   *  them it is an image-to-image cosine, without them the backend falls back to a
   *  text-to-image cosine that its own docstring calls uncalibrated, and the gate then
   *  fails every asset ever generated. Optional — a project with no anchors simply gets
   *  the drift check judged from the vision observations instead of from the number. */
  qcAsset: (asset: object, image_url?: string, style_label?: string, style_suffix?: string,
            styleAnchorUrls?: string[]) =>
    apiClient.post<QCResponse>('/api/assets/qc', {
      asset, image_url,
      style_label: style_label ?? 'cinematic',
      style_suffix: style_suffix ?? '',
      style_anchor_urls: styleAnchorUrls ?? [],
      use_vision: true,
    }).then((r) => r.data),

  // ── Stage 4 ──────────────────────────────────────────────────────────────
  // ── Stage 3: Prompt doctor ────────────────────────────────────────────────
  doctorPrompt: (rawDescription: string, assetType: string, style: ProjectStyle) =>
    apiClient.post<{ doctored_prompt: string; raw: string; assembled_prompt?: string }>('/api/assets/doctor-prompt', {
      raw_description: rawDescription,
      asset_type: assetType,
      style_label: style.id,
      style_suffix: style.promptSuffix,
    }).then((r) => r.data),

  /** Seedream 5.0 Pro edit (reference-conditioned). `baseImage` is the subject
   *  being edited (Image 1); `referenceImages` are context (environment / wardrobe /
   *  other character), Image 2+. Non-destructive: with saveVersion+assetRelPath the
   *  result is written as a NEW asset version and localPath is returned. */
  editAsset: (params: {
    baseImage: string
    /** 'depicts' = render the OBJECT described, with the referenced people inside it
     *  (a photo, a screen, a portrait) — not a portrait of them. */
    tool?: 'place_in_env' | 'wardrobe' | 'edit_feature' | 'combine' | 'edit' | 'markup' | 'depicts'
    instruction?: string
    referenceImages?: string[]
    size?: string
    outputFormat?: string
    saveVersion?: boolean
    assetRelPath?: string
    projectName?: string
    projectPath?: string
    /** Locked project style — the edit renders in THIS style (legacy default: photoreal). */
    styleSuffix?: string
    /** The kind of sheet this edit produces. Set it whenever the RESULT is an asset
     *  sheet: the backend then applies the neutral-sheet treatment (flat studio light,
     *  mid-grey seamless background) instead of the project's locked cinematography,
     *  which is what every other sheet already gets. */
    assetType?: string
  }) =>
    apiClient.post<{ url: string; localPath: string; prompt: string; version?: number }>(
      '/api/assets/edit', {
        base_image: params.baseImage,
        tool: params.tool ?? 'edit',
        instruction: params.instruction ?? '',
        reference_images: params.referenceImages ?? [],
        size: params.size ?? '2K',
        output_format: params.outputFormat ?? 'png',
        save_version: params.saveVersion ?? false,
        asset_rel_path: params.assetRelPath ?? '',
        project_name: params.projectName ?? '',
        project_path: params.projectPath ?? '',
        style_suffix: params.styleSuffix ?? '',
        asset_type: params.assetType ?? '',
      }, { timeout: 300_000 }).then((r) => r.data),

  /** List Studio-generated images (disk paths) for the current project — Pro editor refs. */
  listStudioImages: (projectName?: string, projectPath?: string) =>
    apiClient.get<{ images: Array<{ path: string; filename: string }> }>('/api/studio/list', {
      params: { project_name: projectName ?? '', project_path: projectPath ?? '' },
    }).then((r) => r.data.images),

  /** Refine an edit instruction for the Pro editor (Seed 2.0 Pro, not Claude budget). */
  enhanceEditInstruction: (instruction: string, hasMarkup?: boolean, hasRefs?: boolean) =>
    apiClient.post<{ instruction: string }>('/api/assets/edit-enhance', {
      instruction, has_markup: hasMarkup ?? false, has_refs: hasRefs ?? false,
    }, { timeout: 120_000 }).then((r) => r.data.instruction),

  // ── Stage 5 ──────────────────────────────────────────────────────────────

  /** 0.5: Generate a Seedream keyframe for a shot BEFORE animating with Seedance.
   *  Item 0: dryRun returns the assembled prompt + planned refs without generating;
   *  promptOverride/negativeOverride are sent verbatim. */
  generateShotKeyframe: (params: {
    shotId: string
    shotDescription: string
    shotAction?: string
    subjectHint?: string
    envHint?: string
    lightingHint?: string
    approvedAssetUrls?: string[]
    refDescriptors?: string[]
    characters?: Array<{ name: string; description?: string; headshotUrl?: string }>
    style: ProjectStyle
    aspectRatio?: string
    projectName?: string
    projectPath?: string
    dryRun?: boolean
    promptOverride?: string
    negativeOverride?: string
    bestOf?: number            // generate N candidates, keep the most on-model
    referenceUrl?: string      // character reference the candidates are scored against
    // Photographic: backend vision-reads the board's first panel → composition rides
    // as TEXT (the board never rides as an image ref — trust chain).
    boardUrl?: string
    boardRows?: number
    boardCols?: number
  }) =>
    apiClient.post<{
      keyframe_url: string
      keyframe_local_path: string
      shot_id: string
      assembled_prompt: string
      sent_prompt?: string
      ref_count: number
      dry_run?: boolean
      negative_prompt?: string
      references?: Array<{ url: string; label: string }>
      candidates?: Array<{ index: number; url: string; consistency: number; differs?: string }>
      consistency?: number | null
    }>(
      '/api/video/keyframe',
      {
        shot_id: params.shotId,
        shot_description: params.shotDescription,
        shot_action: params.shotAction ?? '',
        subject_hint: params.subjectHint ?? '',
        env_hint: params.envHint ?? '',
        lighting_hint: params.lightingHint ?? '',
        approved_asset_urls: params.approvedAssetUrls ?? [],
        ref_descriptors: params.refDescriptors ?? [],
        characters: (params.characters ?? []).map((c) => ({
          name: c.name, description: c.description ?? '', headshot_url: c.headshotUrl ?? '',
        })),
        style: toStyleConfig(params.style),
        aspect_ratio: params.aspectRatio ?? '16:9',
        project_name: params.projectName ?? '',
        project_path: params.projectPath ?? '',
        dry_run: params.dryRun ?? false,
        prompt_override: params.promptOverride ?? '',
        negative_override: params.negativeOverride ?? null,
        best_of: params.bestOf ?? 1,
        reference_url: params.referenceUrl ?? '',
        board_url: params.boardUrl ?? '',
        board_rows: params.boardRows ?? 0,
        board_cols: params.boardCols ?? 0,
      },
      { timeout: 600_000 }
    ).then((r) => r.data),

  /** Measured length of a saved media file in seconds, or NULL when ffprobe cannot read
   *  one. The same probe the export trims and times subtitles with, so a length the
   *  browser could not decode is measured rather than invented. The null is the answer:
   *  callers must handle "unknown", never fall back to a constant (a made-up length is
   *  paid footage in Edit/Re-take and a bed that stops mid-film in the mix). */
  mediaDuration: (path: string) =>
    apiClient.get<{ duration: number | null }>('/api/asset/duration', {
      params: { path },
    }).then((r) => r.data.duration),

  /** Upload a music track to mix under the final render. dataB64 may be a data-URI. */
  uploadSoundtrack: (params: { projectName?: string; projectPath?: string; filename: string; dataB64: string }) =>
    apiClient.post<{ path: string; name: string }>('/api/edit/soundtrack', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
      filename: params.filename,
      data_b64: params.dataB64,
    }).then((r) => r.data),

  /** Render a shot's dialogue (locked voices, Seed Audio 1.0) into ONE clip for the
   *  storyboard generate/preview/approve step (3.2). `character` is the NAME.
   *
   *  The response really is just `{path, duration}` — server.py:8119. Two things it does
   *  NOT carry, both of which stage 4 has to get elsewhere, so nobody types them in here
   *  on the assumption that they arrive:
   *   - NO per-speaker clip paths. The multi-speaker render is ONE Seed Audio call so the
   *     voices can OVERLAP, and an overlap cannot be un-mixed (server.py:4470-4474). The
   *     per-speaker approval in StoryboardView therefore records a verdict per voice
   *     against this one shared clip, and auditions a single voice through
   *     `previewVoice` below (fresh render, touches no file on disk).
   *   - NO voice-substitution signal. `/api/shot/dialogue` and `/api/voice/preview` both
   *     report when Seed Audio rejected a reference and answered in a GENERIC voice
   *     (`voice_fallback_lines` / `voice_fallback`); this endpoint reports nothing, so a
   *     clip in a substitute voice is indistinguishable from a correct one here. That is
   *     the other reason the per-speaker audition goes through `previewVoice`: it is the
   *     only call in this flow that says which voice you actually heard. */
  renderDialogueClip: (params: { shotId: string; dialogue: Array<{ character: string; text: string; emotion?: string }>; projectName?: string; projectPath?: string; dialogueScene?: string }) =>
    apiClient.post<{ path: string; duration: number }>('/api/shot/dialogue-clip', {
      shot_id: params.shotId, dialogue: params.dialogue,
      // Scene-mode direction: with it the backend makes ONE overlapping take; without
      // it, the per-line concat. Empty on a breakdown written before scene mode.
      dialogue_scene: params.dialogueScene ?? '',
      project_name: params.projectName ?? '', project_path: params.projectPath ?? '',
    }, { timeout: 120_000 }).then((r) => r.data),

  /** Extend a rendered shot: animate a continuation from its last frame and concat it
   *  on, so the clip gets longer (Seedance i2v). Returns the new video path + duration. */
  extendShot: (params: { shotId: string; videoPath: string; extraSeconds: number; note?: string;
    projectName?: string; projectPath?: string; style: ProjectStyle; ratio?: string; resolution?: string;
    concat?: boolean; clipId?: string; referenceImages?: string[]; lastFrame?: string; lastFrameUrl?: string }) =>
    apiClient.post<{ video_path: string; duration: number; added_seconds: number; thumbnail_path: string; last_frame_url: string; last_frame_local_path: string }>(
      '/api/shot/extend', {
        shot_id: params.shotId, video_path: params.videoPath,
        extra_seconds: params.extraSeconds, note: params.note ?? '',
        project_name: params.projectName ?? '', project_path: params.projectPath ?? '',
        style: toStyleConfig(params.style),
        ratio: params.ratio ?? '16:9', resolution: params.resolution ?? '1080p',
        concat: params.concat ?? false, clip_id: params.clipId ?? '',
        reference_images: params.referenceImages ?? [],
        last_frame: params.lastFrame ?? '', last_frame_url: params.lastFrameUrl ?? '',
      }, { timeout: 600_000 }).then((r) => r.data),   // render (+ concat) — allow minutes

  /** Video-to-video VFX EDIT of a rendered shot (add ships, an explosion, relight…). The
   *  source clip is sent as a reference_video (look + motion), byte-identical so it keeps
   *  Seedance's Trusted-Output biometric pass; pass the fresh CDN videoUrl when available,
   *  else the backend re-hosts the local copy to R2. Returns a NEW take (non-destructive). */
  editShot: (params: { shotId: string; videoPath: string; videoUrl?: string; note: string;
    // NOT optional: the edit renders paid footage of this length. `duration?` with a
    // `?? 0` fallback here was what let a caller reach the backend with no length at all,
    // where it became 5s of Seedance. Measure the source clip, or don't call this.
    duration: number; projectName?: string; projectPath?: string; style: ProjectStyle;
    ratio?: string; resolution?: string; clipId?: string; referenceImages?: string[]; generateAudio?: boolean }) =>
    apiClient.post<{ video_path: string; duration: number; thumbnail_path: string; last_frame_url: string; last_frame_local_path: string }>(
      '/api/shot/edit', {
        shot_id: params.shotId, video_path: params.videoPath, video_url: params.videoUrl ?? '',
        note: params.note, duration: params.duration,
        project_name: params.projectName ?? '', project_path: params.projectPath ?? '',
        style: toStyleConfig(params.style),
        ratio: params.ratio ?? '16:9', resolution: params.resolution ?? '1080p',
        clip_id: params.clipId ?? '', reference_images: params.referenceImages ?? [],
        generate_audio: params.generateAudio ?? true,   // edits render SFX/ambient by default
      }, { timeout: 600_000 }).then((r) => r.data),   // v2v render — allow minutes

  /** Recover a COMPLETED take whose UI handler was orphaned — an Extend continuation or a
   *  v2v Edit, both of which save under Shots/<clipId>/. (tab reload /
   *  navigate mid-render). Read-only disk lookup of the latest video under the clip's
   *  folder — heals a stuck 'animating' placeholder WITHOUT paying for a re-render.
   *  Returns video_path:"" when nothing was saved (so the UI drops the dead placeholder). */
  recoverExtend: (params: { projectName?: string; projectPath?: string; clipId: string }) =>
    apiClient.post<{ video_path: string; duration: number; added_seconds: number; thumbnail_path: string; last_frame_local_path?: string }>(
      '/api/shot/extend-recover', {
        project_name: params.projectName ?? '', project_path: params.projectPath ?? '',
        clip_id: params.clipId,
      }).then((r) => r.data),

  /** Generate an INSTRUMENTAL MUSIC soundtrack with Seed Audio 1.0, sized to the film
   *  (targetSeconds): a short phrase looped + faded to the exact length. */
  generateSoundtrackMusic: (params: { projectName?: string; projectPath?: string; prompt: string; targetSeconds: number }) =>
    apiClient.post<{ path: string; name: string; duration: number; segments: number; target: number }>('/api/soundtrack/music', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
      prompt: params.prompt,
      target_seconds: params.targetSeconds,
    }, { timeout: 600_000 }).then((r) => r.data),   // sequential chunk gen — allow time

  /** Drop a character's cached fictional face block so the next keyframe re-rolls
   *  a fresh vision-grounded face (no manual file deletion). */
  resetCharacterIdentity: (params: { projectName?: string; projectPath?: string; characters?: string[] }) =>
    apiClient.post<{ cleared: string[] }>('/api/keyframe/reset-identity', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
      characters: params.characters ?? [],
    }).then((r) => r.data),

  /** Generate (and cache) a character's fictional-distinctive Face Anchor — a clean
   * t2i portrait that PASSES Seedance's real-person filter, so it can lock identity
   * as a reference across shots (unlike the realistic sheet). */
  faceAnchor: (params: {
    projectName?: string; projectPath?: string
    character: { name: string; description?: string; headshotUrl?: string }
    style: { label: string; promptSuffix: string; negativePrompt: string }
    force?: boolean
  }) =>
    apiClient.post<{ anchor_path: string; cached: boolean; url?: string }>('/api/character/face-anchor', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
      character: {
        name: params.character.name,
        description: params.character.description ?? '',
        headshot_url: params.character.headshotUrl ?? '',
      },
      style: {
        label: params.style.label,
        prompt_suffix: params.style.promptSuffix,
        negative_prompt: params.style.negativePrompt,
      },
      force: params.force ?? false,
    }).then((r) => r.data),

  /** Save a finished Seedance render to disk — local copy never 403s like signed CDN URLs. */
  saveShotVideo: (
    shotId: string, videoUrl: string, projectName?: string, projectPath?: string,
    meta?: {
      seed?: number; resolution?: string; prompt?: string
      // Item 0: provenance — auto prompt, override, negative, refs as attached
      autoPrompt?: string; promptOverride?: string; negativePrompt?: string
      references?: Array<{ url: string; label: string }>
      taskId?: string   // B2: mark this task done in the render registry (dedup vs reconciler)
      lastFrameUrl?: string   // persisted raw next to the video → trusted first_frame for Extend
      // What the shot was SUPPOSED to be, so the backend can measure what came back
      // against it: a degenerate file, a clip shorter than the beat, or dialogue that
      // would be cut off by -shortest. The dialogue goes over raw so the backend can
      // estimate its spoken length with the same function the breakdown sizes shots
      // with, rather than the client re-implementing that formula.
      durationSecs?: number
      dialogue?: Array<{ characterId?: string; text?: string; emotion?: string }>
    },
  ) =>
    apiClient.post<{ version: number; path: string; local_path: string; preview_path?: string; last_frame_local_path?: string; bytes?: number; gates?: Array<{ label: string; passed: boolean; notes: string }> }>(
      '/api/shot/save-video',
      {
        shot_id: shotId,
        video_url: videoUrl,
        project_name: projectName ?? '',
        project_path: projectPath ?? '',
        task_id: meta?.taskId ?? '',
        seed: meta?.seed ?? null,
        resolution: meta?.resolution ?? '',
        prompt: meta?.prompt ?? '',
        auto_prompt: meta?.autoPrompt ?? '',
        prompt_override: meta?.promptOverride ?? '',
        negative_prompt: meta?.negativePrompt ?? '',
        references: meta?.references ?? [],
        last_frame_url: meta?.lastFrameUrl ?? '',
        duration_secs: meta?.durationSecs ?? 0,
        dialogue: meta?.dialogue ?? [],
      }
    ).then((r) => r.data),

  /** 0.4: Create Seedance video task — backend builds formula-structured prompt. */
  createVideoTask: (params: VideoCreateParams) =>
    apiClient.post<{
      task_id?: string
      assembled_prompt?: string
      assembled_negative?: string
      dry_run?: boolean
      /** Non-null when the approved board does NOT describe the shots this card
       *  declares — a segment re-cut after it was boarded. The prompt was then
       *  assembled WITHOUT the board annotations for the shots the board no longer
       *  covers (byteplus_generative._merge_plan), which is a silent downgrade unless
       *  the operator is told. `summary` is the sentence to show. */
      board_mismatch?: {
        severity: 'warning' | 'info'
        shots: number; panels: number
        declared_sec: number; board_sec: number
        /** How many of `panels` carried a readable time range. 0 means the board could
         *  not be timed against the shots at all — a different fault from a board that
         *  times against 0s, and `summary` words it differently. */
        panels_timed?: number
        unboarded: string[]
        crowded: Array<{ shot: string; panels: number; kept: string; kept_coverage: number; dropped: number }>
        dropped_panels: number
        summary: string
      } | null
      // Echoed back from the actual submission — for a preview/edit tier this is
      // NOT what was requested, so the UI must record these rather than assume.
      tier?: string
      resolution?: string
      model?: string
    }>(
      '/api/video/create',
      toVideoCreateBody(params),
      // The vision step downloads + encodes refs and calls Claude — allow time
      { timeout: 600_000 }
    ).then((r) => r.data),

  pollVideoTask: (task_id: string) =>
    apiClient.get(`/api/video/poll/${task_id}`)
      .then((r) => r.data),

  /** P3.14: cancel a queued Seedance task (documented DELETE endpoint). */
  cancelVideoTask: (task_id: string) =>
    apiClient.delete(`/api/video/cancel/${task_id}`)
      .then((r) => r.data),

  /** B2: render tasks the backend recorded for this project — used to adopt a
   *  render the backend finished + saved while the tab was closed. */
  getRenderRegistry: (projectPath?: string, projectName?: string) =>
    apiClient.get<{ tasks: Array<{
      task_id: string; status: string; shot_id?: string
      video_local_path?: string; preview_local_path?: string; seed?: number; resolution?: string
    }> }>('/api/video/registry', { params: { project_path: projectPath ?? '', project_name: projectName ?? '' } })
      .then((r) => r.data),

  // ── Render queue (C3) ─────────────────────────────────────────────────────
  /** Hand a whole render pass to the backend: it submits the jobs itself, one at a
   *  time, so a closed tab no longer strands half a film. `jobs` are the SAME wire
   *  bodies POST /api/video/create takes — snake_case, replayed verbatim. */
  queueRender: (params: { projectName?: string; projectPath?: string; jobs: RenderQueueJob[] }) =>
    apiClient.post<{ queue_id: string; queued: number }>('/api/render/queue', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
      jobs: params.jobs,
    }).then((r) => r.data),

  /** Poll the queue: per-shot status (+ the task_id once submitted, so the UI can adopt
   *  a render the backend started) and the counts a progress bar needs. */
  getRenderQueue: (params: { projectName?: string; projectPath?: string }) =>
    apiClient.get<RenderQueueState>('/api/render/queue', {
      params: { project_name: params.projectName ?? '', project_path: params.projectPath ?? '' },
    }).then((r) => r.data),

  /** Stop the queue — entries not yet submitted become 'cancelled'. Tasks already sent
   *  to Seedance are a separate kill (cancelVideoTask), since they are already paid for.
   *  `at_risk` is the subset that was stranded mid-submit: those were handed to BytePlus
   *  with no verdict, so cancelling them is NOT a promise that they cost nothing. */
  cancelRenderQueue: (params: { projectName?: string; projectPath?: string }) =>
    apiClient.post<{ cancelled: number; at_risk?: number }>('/api/render/queue/cancel', {
      project_name: params.projectName ?? '',
      project_path: params.projectPath ?? '',
    }).then((r) => r.data),

  /** Consistency harness: rank candidate stills against a locked character reference
   *  (consistency/face/wardrobe 0-100 + a diagnosis). The objective evaluator for
   *  best-of-N and prompt-template A/B. */
  rankConsistency: (referenceUrl: string, candidates: Array<{ id: string; url: string }>) =>
    apiClient.post<{
      ranked: Array<{ id: string; url: string; consistency: number | null; face?: number; wardrobe?: number; differs?: string; notes?: string; error?: string }>
      best: { id: string; url: string; consistency: number | null } | null
    }>('/api/consistency/rank', { reference_url: referenceUrl, candidates }, { timeout: 120_000 }).then((r) => r.data),

  // ── Voice / dialogue ───────────────────────────────────────────────────────
  /** Voice preset catalog for the AG picker. */
  listVoices: () =>
    apiClient.get<{ presets: Array<{ id: string; label: string; speaker: string; pitch_rate: number; speech_rate: number }>; base_voice: string }>(
      '/api/voices').then((r) => r.data),

  /** Lock a character's voice (reused for every line they speak). engine "seed_audio"
   *  + a ref clip = cloned voice; "seed_tts" = preset voice. */
  assignVoice: (character: string, voice: VoiceConfig, projectName?: string, projectPath?: string) =>
    apiClient.post<{ character: string; voice: VoiceConfig }>(
      '/api/character/voice',
      { character, ...voice, project_name: projectName ?? '', project_path: projectPath ?? '' },
    ).then((r) => r.data),

  /** Upload an actor's reference clip → switches their anchor to Seed Audio 1.0 clone.
   *  audioB64 is a data URI / base64; ext ∈ wav|mp3|pcm|ogg (≤30 s, ≤10 MB). */
  uploadVoiceReference: (character: string, audioB64: string, ext: string, projectName?: string, projectPath?: string) =>
    apiClient.post<{ character: string; voice: VoiceConfig; ref_audio_path: string }>(
      '/api/character/voice/reference',
      { character, audio_b64: audioB64, ext, project_name: projectName ?? '', project_path: projectPath ?? '' },
      { timeout: 60_000 },
    ).then((r) => r.data),

  /** All character → locked-voice mappings for the project. */
  getCharacterVoices: (projectName?: string, projectPath?: string) =>
    apiClient.get<{ voices: Record<string, VoiceConfig> }>(
      '/api/character/voices', { params: { project_name: projectName ?? '', project_path: projectPath ?? '' } },
    ).then((r) => r.data),

  /** Audition a voice config — returns a data-URI mp3, through the same engine
   *  (Seed TTS 2.0 or Seed Audio 1.0 clone) render will use. */
  previewVoice: (voice: VoiceConfig, text?: string) =>
    apiClient.post<{
      audio_b64: string
      /** true when Seed Audio REJECTED the reference (voiceprint/content-sensitive) and
       *  spoke the audition in a GENERIC voice. The clip that just played is NOT the
       *  clone. The endpoint always sends this key; it used to be typed away here, so
       *  the picker locked substitute voices in silence. */
      voice_fallback: boolean
    }>('/api/voice/preview',
      { ...voice, ...(text ? { text } : {}) }, { timeout: 120_000 }).then((r) => r.data),

  /** Render each dialogue line with its character's locked voice + mix onto the shot
   *  video. Returns the dubbed clip (+ its 720p preview proxy). */
  generateShotDialogue: (params: {
    shotId: string; videoLocalPath: string
    lines: Array<{ character: string; text: string; emotion?: string }>
    projectName?: string; projectPath?: string; duck?: boolean
  }) =>
    apiClient.post<{
      shot_id: string; dub_path: string; preview_path: string; lines: number
      /** 0-based indexes of lines Seed Audio spoke in a GENERIC voice because it
       *  rejected the character's locked reference. Empty on a clean dub. The caller
       *  MUST surface it: otherwise a character silently changes voice mid-shot. */
      voice_fallback_lines?: number[]
    }>(
      '/api/shot/dialogue',
      {
        shot_id: params.shotId, video_local_path: params.videoLocalPath, lines: params.lines,
        project_name: params.projectName ?? '', project_path: params.projectPath ?? '', duck: params.duck ?? true,
      }, { timeout: 300_000 },
    ).then((r) => r.data),

  /** P5a Magic Box: interpret a natural-language shot instruction into a refined
   *  director note + the cheapest regen scope. */
  directShot: (params: {
    instruction: string
    action?: string; camera?: string; lighting?: string; notes?: string
    charName?: string; envHint?: string; styleLabel?: string
  }) =>
    apiClient.post<{ notes: string; scope: 'animate' | 'keyframe'; summary: string }>('/api/shot/direct', {
      instruction: params.instruction,
      action: params.action ?? '', camera: params.camera ?? '', lighting: params.lighting ?? '',
      notes: params.notes ?? '', char_name: params.charName ?? '', env_hint: params.envHint ?? '',
      style_label: params.styleLabel ?? 'cinematic',
    }).then((r) => r.data),

  qcFinalScene: (shot_id: string, video_url: string, shot_description: string, character_ref_url?: string) =>
    apiClient.post<QCResponse & { identity_drift?: number | null }>('/api/finalscene/qc', {
      shot_id, video_url, shot_description, character_ref_url: character_ref_url ?? '',
    }).then((r) => r.data),

  // ── Stage 6 ──────────────────────────────────────────────────────────────
  /** `render_path` is what turns this from a formality into a review: the backend samples
 *  frames across the rendered cut and the Final Director actually LOOKS. Without it the
 *  verdict is arithmetic plus a guess, and it says so in its own summary. */
  qcFinalCut: (sequence: string[], shot_data: object[], opts?: {
    render_path?: string; target_secs?: number
    // null where a level could not be measured at all (a silent programme reads -inf,
    // which is not a number JSON can carry).
    loudness?: { applied?: boolean; measured_lufs?: number | null; target_lufs?: number | null; reason?: string; silent?: boolean }
  }) =>
    apiClient.post<QCResponse>('/api/finalcut/qc', {
      sequence, shot_data,
      render_path: opts?.render_path ?? '',
      target_secs: opts?.target_secs ?? 0,
      loudness: opts?.loudness ?? null,
    }, { timeout: 300_000 })
      .then((r) => r.data),
}

