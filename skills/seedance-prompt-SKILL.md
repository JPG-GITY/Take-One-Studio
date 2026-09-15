---
name: takeone-seedance-prompt
description: >
  Seedance 2.0 prompt-writing system. Use whenever the user wants to write a Seedance prompt, build a cinematic shot or scene, turn an idea or script beat into a prompt, set up references/assets, or asks about Seedance prompting technique. Trigger on phrases like "prompt for Seedance", "write a Seedance prompt", "make a scene where...", "build a shot", "how to write a Seedance prompt". Output is a single standalone prompt. Always consult this skill before writing any Seedance prompt.
---

# Seedance 2.0 Prompt Writer

Turn scripts, scenes, and ideas into Seedance 2.0 prompts. Block, light, and pace each shot like a film.

**Output: always a single standalone prompt in a code block.**

---

## CORE PRINCIPLE: WRITE THE VISIBLE

The model reacts to what can be **seen and measured**, not to mood words.

Translate every abstraction into something observable.
- ❌ "tense scene" → ✅ "man freezes, slowly clenches his fist, light only from the side, half his face in shadow"
- ❌ "cool cinematic shot of a car, epic, fast" → ✅ "low tracking shot alongside the car as it powers through a wet curve, headlights glowing, spray off the tyres, hard buffeting camera shake"

Write in plain, clear, instruction-style language. Fewer precise words beat many vague ones.

Before generating, mentally "watch" the prompt as a viewer: is everything unambiguous, is the first frame non-empty, is it clear where the subject is and where it looks, where is the light coming from.

---

## WORKFLOW

1. **Read as a director.** Find the dramatic shape: where the scene turns, lands, breathes.
2. **Define continuity anchors.** Who is in frame, how they look, what they carry across cuts.
3. **Write the prompt** using the block structure below.
4. **Tag assets.** Tagging rules below.

If the idea is ambiguous, close the gaps in conversation first — blocking, angle, light, timing, character behavior, what is in the first frame, how it ends. The model fills any gap on its own, usually not the way intended.

---

## ASSET TAGGING

Reference image (`@tag`) sets **appearance and identity**. Text sets **what happens** and locks critical details. Both are required.

**Tag naming:**
- If the user specifies tags as `@tag_name`, use those.
- If no tags are specified, name them by load order of the supplied assets: `@image1 @image2 ...` for images, `@video1 @video2 ...` for videos, `@audio1 @audio2 ...` for audio.
- Otherwise follow the user's explicit instruction.

**Reference + text rule:** keep the character description minimal — long appearance text conflicts with the image and degrades it.

```
@TAG: age + role/build + current state + unique visible features + action-critical details + voice (only if it has a line). 100% matches the reference.
```

State critical details (small text, logos, color) in words even if they appear on the reference — the model can drop them.

Never place an `@tag` in a shot where that object is not present; the model will try to force it into frame.

---

## CONTEXT ISOLATION

Each generation is a blank slate — **no memory of previous shots.** A prompt is a sealed single-shot document.

Do not carry in: scene numbers, script headings, summaries of prior scenes, unused tags/characters, "as above / continues" phrasing, or people and props from a previous line that are not needed in this shot.

---

## STYLE — DISTRIBUTED, NOT A PREFIX

There is **no separate style-prefix block at the top of the prompt.** Style is not one thing in one place — it is a set of aspects, and each aspect lives in the block that already governs it, where it is most effective and unambiguous. State the target look, never what to avoid; adapt every line to this specific scene.

Cover these aspects, each in its home block:

| Aspect | Lives in | What to write |
|--------|----------|---------------|
| Lighting | **LIGHTING** | source, direction, exposure, key/fill, haze for THIS scene |
| Color / grade | **COLOR GRADE** (own block if grade is strong, e.g. teal-cyan desaturated) or folded into **LOCATION** + **LIGHTING** for a naturalistic look | palette as material + light beam + role, never a flat list |
| Lens / optical character | **OPTICS** | FOV°, rectilinear/anamorphic, prime-lens character, motion-blur |
| Camera body / tonal character | **CAMERA** | tonal latitude, highlight roll-off, color science — as a look, not a model name |
| Skin / micro-realism | **PERFORMANCE** (or inside **ACTION**) | pore-level realism, capillary flush, living eyes, catch-lights, visible breath |
| Acting | **PERFORMANCE** (or inside **ACTION**) | micro-pauses, precise eye-line, restraint, muscle-level emotion |
| Physics realism | **PHYSICS** | gravity, inertia, mass, contact shadows, fluids, particles |
| Composition / blocking | **FIRST FRAME / BLOCKING** | framing rule for THIS scene; everyone moving from frame one |
| Continuity | **POSITIVE LOCKS** | characters, props, environment identical across cuts |
| Wardrobe | **WARDROBE** (own block when costume matters) | material + condition, scene-logical |
| Format / resolution / grain / fps / bitrate | **STYLE** + **OUTPUT SETTINGS** at the **end**, just before LOCKS | 8K, photoreal, anamorphic, fine grain, real-time vs slow-mo per segment |

**Placement principle:** descriptive style (light, color, optics, physics, acting) sits *inside the content block it describes*, in the body of the prompt. Technical/format style (resolution, grain, fps, bitrate, overall look reference) sits as a **suffix stack at the end** (`STYLE`, `OUTPUT SETTINGS`), right before `POSITIVE LOCKS`. Nothing style-related goes at the very top — the prompt still opens on `SCENE CONTEXT` and `ACTIVE REFERENCES`.

Use only the aspects the shot needs. A naturalistic single take may have no `COLOR GRADE`, `WARDROBE`, or `OUTPUT SETTINGS` block at all and fold those notes into LIGHTING and POSITIVE LOCKS. A graded, multi-segment piece earns the full suffix stack.

If the user supplies their own prefix or block text, use it verbatim.

---

## PROMPT STRUCTURE

Write blocks in this order. Logic: context and references first, then space and timing, then action and physics, then the descriptive-style blocks in their home positions, and a technical-style suffix at the end. Use only the blocks the shot needs; drop the rest.

```
SCENE CONTEXT
[1–2 sentences: what happens, where, when. Geo-positions of characters.]

ACTIVE REFERENCES
[@tag + minimal anchor of critical details + "100% matches the reference"]

LOCATION MAP
[Foreground / midground / background, where the camera is, where light comes from, movement paths. Naturalistic color can live here.]

FIRST FRAME / BLOCKING
[Who is where in the first frame: positions, orientation, gaze. Composition rule for this scene.]

FORMAT MODE
[Choose the level of control the shot needs:
 - Single continuous shot — "one continuous shot, the camera does not cut on its own."
 - Sequence of cuts, no timecodes — "CUT 1 … CUT 2 … CUT 3", described in order.
 - Timed multishot — explicit HARD CUTs at stated seconds.]

OPTICS
[Shot size + FOV per segment + lens/optical character. For multishot add "no drift mid-segment".]

CAMERA
[Operator behavior: height, distance, movement, focus. Camera-body tonal character as a look.]

ACTION
[Events at the precision the shot needs. Camera motion and subject motion stated separately.]

PERFORMANCE        (when acting matters)
[Acting + skin/micro-realism: muscle-level emotion, eye-line, catch-lights, breath, pore-level detail.]

PHYSICS
[Mass, inertia, contact, fluids, particles.]

LIGHTING
[Source, direction, exposure — priority block.]

COLOR GRADE        (when the grade is strong / stylized)
[Palette as material + light + role; grade character. Omit for naturalistic looks — fold color into LOCATION/LIGHTING.]

WARDROBE           (when costume matters)
[Material + condition, scene-logical.]

AUDIO
[Only the needed sound / line.]

STYLE              (technical-style suffix)
[Overall look in words, photoreal, format, grain — no director or equipment names.]

OUTPUT SETTINGS    (when format must be pinned)
[Resolution, anamorphic, real-time vs slow-mo per segment.]

POSITIVE LOCKS
[Short fixers against likely failures, in positive form, restating critical info once. Continuity lives here.]
```

The descriptive-style blocks (PERFORMANCE, PHYSICS, LIGHTING, COLOR GRADE, WARDROBE) sit in the body next to what they govern. The technical-style blocks (STYLE, OUTPUT SETTINGS) form a short suffix stack just before POSITIVE LOCKS. Nothing style-related opens the prompt.

A **lock** is a short hard fixer placed next to what it protects, e.g. `"headlights stay glowing in every shot"`. Write densely where control matters, sparsely where it does not. Say each important thing once, clearly.

---

## CUTS AND TIMING

Pick the precision the shot actually needs — these are points on a scale, not a binary:

- **Single shot (oner)** → "one continuous shot, the camera does not cut on its own."
- **Sequential cuts, no timecodes** → describe shots in order as `CUT 1 … CUT 2 … CUT 3`. Use when you want specific cuts but exact timing does not matter.
- **Timed multishot** → explicit HARD CUTs at stated seconds. Use when beats must land on a clock.
- **Freestyle b-roll** → do not lock cuts; let the model find angles.

When you specify cuts (timed or not), lock that the camera does not add its own: *"cuts only at the specified points, the camera does not cut on its own."*

**Timecode format** (only when timing matters):
```
0.0s to 1.0s — [description]
1.0s HARD CUT
1.0s to 3.0s — [description]
```

**Sequential format** (cuts without timecodes):
```
CUT 1 — [description]
CUT 2 — [description]
```

**Cut types:** `HARD CUT`, `SMASH CUT`, `MATCH CUT`, `INSERT CUT`, `REVERSE CUT`, `WHIP CUT`. Fades / crossfades only if explicitly requested.

Across internal cuts hold: same character set, same geometry, screen direction, gaze, light, wardrobe, prop state.

---

## DIRECTING

**Blocking.** State where each character stands, sits, moves; what their hands do; what sits between them. "She sits across from him at the diner booth, knees touching under the table" beats "they sit and talk."

**Pace.** Read the dramatic structure. Confession scene → air, held shots, beats of silence. Action → compression, short cuts. A reveal lands on one held close-up.

**Acting.** Translate emotion into concrete on-shot direction:
- ❌ "she looks sad" → ✅ "her eyes drop to the table, jaw tightens, she swallows once before answering"
- ❌ "he is angry" → ✅ "knuckles whiten on the glass, breath shortens, eyes never leave hers"

Restraint by default — a whisper out-acts a shout most of the time.

**Continuity** (hold in mind, do not write as a block): state carried forward (wet/dry/bloodied), appearance not drifting, emotional carry from the previous scene, one time-of-day and weather unless the location changes.

**Camera language.** Be concrete: FOV°, height, movement, motivation. Motivate every camera move.
- "Low-angle 18° dolly-in, slow push from waist to chest as she realizes."
- "Static 47° two-shot, eye-level, locked off — lets the silence sit."
- "Handheld 63°, follow from behind — camera lags half a beat."

---

## PROMPTING RULES

- **Positive only.** Describe what should happen, not what to avoid. ❌ "does not fall backward" → ✅ "stays upright, feet planted."
- **Speeds in km/h.** ❌ "fast/slow" → ✅ "moves at 40 km/h", "camera pans at 5 km/h."
- **Atmosphere in percent / meters.** ❌ "light fog" → ✅ "fog density 40%", "haze visible at 15 meters depth."
- **Atmosphere builds in steps across shots.** Shot 1: fog 20% → Shot 2: 40% → Shot 3: 60%.
- **Giant scale via human-height comparison.** ❌ "huge", "three meters tall" → ✅ "stands as tall as four humans stacked head to toe."
- **Left/right is from the camera.** "Subject moves left" = left from the camera's view.
- **Environment interaction stated physically.** Snow melts on skin, rain runs down hair, wind moves fabric.
- **Emotion through muscle movement, not labels.**

---

## OPTICS — SHOT SIZE, LENS, FOV

Two levers define "how it is shot": **shot size** and **focal length**.

### Shot sizes
| Abbr | Meaning | In frame |
|------|---------|----------|
| ECU | Extreme Close-Up | a detail: eyes, button, headlight, hand |
| CU | Close-Up | full face / one element large |
| MCU | Medium Close-Up | head and shoulders |
| MS | Medium Shot | roughly to the waist |
| WS | Wide Shot | full figure + surroundings |
| EWS | Extreme Wide | scale, location |

### Focal length (mm — for describing size while writing, not for the prompt text)
| Lens | Effect | Use for |
|------|--------|---------|
| 24–35mm wide | space, slight perspective distortion | action, immersion, wides |
| 50mm normal | natural perspective, "as the eye sees" | realism, neutral shots |
| 85mm portrait | soft bokeh, subject separated from background | portrait, emotion |
| 135mm+ tele | strong compression, "watching from afar" | observation, distance, sport |

In the prompt text use **FOV in degrees** from the table below, not millimeters.

### FOV anchor table (degrees for the prompt)
| FOV | mm equiv | Purpose | When |
|-----|----------|---------|------|
| 180° | Fisheye | spherical distortion | POV, dream-state |
| 107° | 14–16mm | architectural ultra-wide | huge interiors, epic establish |
| 84° | 20–24mm | wide | establish, group blocking |
| 63° | 28–35mm | observational | wide observation, reportage |
| 47° | 40–50mm | neutral human perspective | universal establish, medium |
| 29° | 75–85mm | portrait compression | medium-isolate, dialogue bust |
| 18° | 100–135mm | natural portrait | close-portrait, identity-preserving |
| 12° | 180–200mm | tele-detail | hands, objects, detail-on-wide |
| 8° | 300–400mm | extreme compression | observation, broadcast |

Use only the discrete steps from the table. Not "23°" — use 18° or 29°. In a multishot, set FOV per segment and add `"no drift mid-segment"`.

### Camera placement in the prompt
Place the CAMERA block in the **3rd position** of the prompt's core layers (subject → action → camera → style → constraints). Moved to the end, FOV gets ignored; moved to the front, it conflicts with identity.

---

## OPTICAL TECHNIQUES

**Observation pattern (hidden-camera effect)** — all three ingredients at once:
1. Foreground occlusion — out-of-focus obstruction over 20–30% of frame (wall, pillar, branch, arch).
2. Atmospheric haze — fog/dust/shimmer between camera and subject.
3. Distance vantage — super-tele 8°–12°, operator anchored far away.
Change the occlusion type between beats; keep the vantage single.

**Sports broadcast:** `8° super-tele + handheld 1–2cm tremor + "anchored at distance, finding the action"`.

**Detail-on-wide (snake cam):** `84° wide FOV + low-angle right up against a small object` — foreground object exaggerated, background recedes into depth.

**Intimate wide:** `63–84° wide FOV on a close face` — face centered, surroundings readable without blur.

**Tele compressed air column** at 8°–12°: `"dust suspended in the long compressed air column between camera and subject"`, `"heat shimmer compressed into a wall of haze in front of the figure"`.

---

## SPECIAL PROTOCOLS

**4-mechanism multishot consistency stack (extreme FOV: 8°, 107°):**
1. Sequence-wide identity lock — single location reference across all beats.
2. LENS LOCK opener — explicit FOV phrase at the start of each beat.
3. LENS CHECK closer — confirm FOV at the end of the beat.
4. Color via material + light, not as a list.
All four are required, or extreme-FOV multishots break down after 2–3 beats.

**Whip-pan timing:**
```
0.3s — Subject A settled
0.8s — WHIP motion-blur transition
1.4s — Subject B settled
```
A whip under 0.8s renders as a hard cut without blur.

**Mixed time-speed (real-time + slow-mo):** hard cuts only between speed modes. Each shot is one speed start to finish.

**Cracks/breaks without impact (anti-impact lock):**
- "crowd PRESSES, not strikes"
- "fracture originates from edge stress, not center impact"
- "no impact point — pressure-based crack"
- sequential timing edge-to-center, not radial from a point.

---

## CAMERA / LIGHT / COLOR

**White balance** in Kelvin, set to the scene mood, fixed within a scene (3200K / 4000K / 5600K / 8500K).

**Equipment:** describe the look, not gear. No camera/film/lens model names — they get ignored or break complex moves.

**Color rule:** tie color to **material + light beam + compositional role**, never a flat list.
- ❌ "the woman wears red, the man wears blue"
- ✅ "crimson silk scarf catching the cold tungsten spill from the corridor"

**Background in layers:** state foreground / midground / background separately.

**Camera on the shadow side**, with a stated operator axis.

---

## CHECKLIST (before each prompt)

- All blocks in order: context and references first, then space/timing, then action/physics, then style in its home blocks, technical-style suffix last?
- Tags named per the tagging rule (`@tag_name`, or load-order `@image1`/`@video1`/`@audio1`, or user instruction)?
- `@tag` only in shots where the object is present?
- No style-prefix block at the top — prompt opens on SCENE CONTEXT / ACTIVE REFERENCES?
- Each style aspect placed in its home block (light→LIGHTING, color→COLOR GRADE or LOCATION, acting/skin→PERFORMANCE, format/grain→STYLE+OUTPUT SETTINGS suffix)?
- Style adapted to this scene (not generic)?
- Everything positive (no "does not X")?
- Speeds in km/h, atmosphere in %/meters, giants vs human height?
- Emotion through muscle movement, not labels?
- Left/right from the camera?
- FOV in degrees from the anchor table (not mm, not arbitrary)?
- CAMERA block in 3rd position?
- WB in Kelvin for the scene mood?
- Color via material + light + role, not a list?
- Camera on the shadow side, operator axis stated?
- Background in foreground/midground/background layers?
- Multishot: FOV per segment + "no drift mid-segment"; extreme FOV → all 4 consistency mechanisms?

---

## FINAL RULES

- **English prompts only.**
- **Positive phrasing only** — state the target, never the prohibition.
- **No director names, no signature-work references, no equipment names.**
