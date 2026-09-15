# Seedance 2.5 — Multimodal Video Generation (R2V)

> **Source:** BytePlus/Volcano "Seedance 2.5 Multimodal Generated Video User Guide",
> captured 2026-08-04. Companion to `video-seedance.md` (which covers 2.0 / Fast / Mini and is
> still the authority for everything Take One Studio ships today).
>
> **Pricing (§9)** points to the public ModelArk pricing page.

## Contents
1. What 2.5 changes
2. Capability map (R2V task types)
3. Locked vs unlocked tasks
4. Input creative limits & recommendations
5. Prompt writing — basic
6. Prompt writing — advanced
7. New capabilities in detail
8. Differences from 2.0 (the four that matter)
9. Pricing
10. Implications for Take One Studio

---

## 1. What 2.5 changes

**Model ID:** `dreamina-seedance-2-5-260628` — display name **Dreamina-Seedance-2.5**,
version **260628**. **Verified 2026-08-04 against the live `GET /api/v3/models` catalog on this
account**, alongside `dreamina-seedance-2-0-260128`, `-fast-260128` and `-mini-260615`. As with 2.0, the
console and Elements/Digital-Character URLs may use the un-prefixed form `seedance-2-5-260628`;
billing and resource-pack docs use the `dreamina-` form, and Volcano Engine pricing names it
`doubao-seedance-2.5` (the Volcano Engine / China-side name). All refer to the same model.
Endpoint is the same AP-Southeast task API as 2.0 — video is **not** available in `eu-west-1`.

- **Single 30-second output** from one call (2.0 caps at 15 s).
- **Up to 50 reference creatives** in one input — images, audio and video mixed.
- **Professional editing and extension** are first-class task types, not workarounds.
- **10+ languages natively generated** (vs 2.0's English + JA/ID/ES/PT prompt support).
- Photorealism, lighting/shadow behaviour, performance understanding and camera movement all
  moved closer to real photography.

The source is explicit that 2.5 is **not** the generational jump 2.0 was over 1.5. It is a
production-hardening release: longer takes, richer references, stabler edit/extend, freer aspect
ratio, better A/V alignment. The framing is "from a stunning creative model to end-to-end
industrialised video production".

## 2. Capability map (R2V task types)

| Family | Task | Detail |
|---|---|---|
| **Reference** | Entity reference | Appearance ID / voice of people, objects, scenes, virtual characters. Entity image, entity A/V, or image + voice-audio combined |
| | Motion reference | Actions, expressions, camera movement, effects — from an image or video; combinable with entity reference |
| | **Base-mesh reference / rendering** *(new)* | Feed a coarse- or fine-grained white-model (blockmesh) video; the model references its motion and renders on top. Stackable with entity + scene reference |
| | Style reference | Style of a reference image/video; combinable with entity reference |
| | Audio reference | Music, melody, dialogue, timbre; combinable with entity reference |
| | **Multi-panel storyboard** | One image holding several storyboard panels — provides plot reference, *not* frame-exact alignment |
| | **Keyframe reference** *(new)* | Multiple independent images passed in order as keyframes; output aligns to them relatively strictly |
| **First/last frame** | First frame, or first + last frame | This is the old I2V. **As of 2.5 it is folded into R2V at the inference level** |
| **Edit** | Video instruction editing | Add / modify / delete on the video's frames via text, with optional timestamps scoping when the edit applies |
| | Video reference-image editing | Same, but guided by additional reference images |
| | Video + audio editing | Add / edit / remove vocals, music, sound effects |
| **Extend** | Video extension | Extend forward or backward, optionally seamless in both picture and audio; combinable with entity reference |
| **Other** | AutoCut | Many images/videos in → one short video out, with text, stickers, transitions |
| | Seamless transition | Two clips in; the model generates the connecting content |
| | Combination | Any of the above composed freely |

## 3. Locked vs unlocked tasks

2.5 introduces a distinction 2.0 does **not** have: whether the input creatives lock the output
video's attributes.

- **Locked** — the creative is placed as a fixed segment on the output timeline; the model adapts
  to it, so aspect ratio (and sometimes duration) are dictated by the input and **cannot be set
  by the user**.
- **Unlocked** — the creative is only a semantic reference; width, height and duration stay
  user-controlled.

### Locked tasks

| Task | What gets locked | Trigger phrasing |
|---|---|---|
| **Video editing** | Aspect ratio strictly matches the input video. Duration *basically* aligns with the input — up to ~0.3 s drift because of input-frame processing, but only transition frames are compressed; content stays complete. **Use `output_format: mov`** | "edit / add / delete / modify / replace…" e.g. *"add some small animals to @video1"*, *"replace the characters in @video1 with those in @image1"*, *"delete the background music of @video1"* |
| **First / first+last frame** | Aspect ratio strictly matches the **first** frame. If the last frame's ratio differs it will be **stretched** — pass both at the same ratio. Duration stays user-settable | Prefer the **parameter** `role: first_frame` / `role: last_frame` over prose. Prose fallback: *"@image1 is the first frame…"*, *"with @image1 as the first frame, seamlessly transition to last frame @image2"* |
| **Video extension** | Aspect ratio strictly matches the input video. Duration stays user-settable. **Use `output_format: mov`** | "extend forward/backward, continue, pick up the story…" e.g. *"extend @video1 backward, with the character in @image1 descending from the sky"* |

### Unlocked tasks — two that need care

- **Multi-panel storyboard** — generated frames are **not** strictly aligned to the panels. The
  storyboard supplies a general plot reference only. Use simple line-art panels and supply what
  the panels don't carry (action, camera movement, style) via the prompt.
- **Keyframe reference** — multiple *independent* storyboard images do align relatively strictly.
  Duration stays user-settable. This is the route when the output must follow the boards exactly.

## 4. Input creative limits & recommendations

| Question | Answer |
|---|---|
| Hard input ceiling | **≤ 30 images** at ≤ 4K each · **≤ 10 video clips**, ≤ 30 s total · **≤ 10 audio clips**, ≤ 30 s total (50 creatives overall) |
| Entities via **A/V** reference | 1–5 works well; 6–10 possible but stability drops (expect re-rolls) |
| Entity A/V reference **duration** | 5–10 s is the sweet spot; longer reduces stability |
| Entities via **image** reference | 1–8 works well; 9–12 possible with reduced stability |
| Multi-view entity images | 1–5 entities: single- or multi-view both fine. **> 5 entities: single view is more stable** — split multi-view into separate images rather than one composite |
| Storyboard panels in a grid | **< 15 panels**. Prefer stick-figure / line art; don't overload panels with text |
| Base-mesh granularity | **Coarse (simple geometric shapes) references best.** Assemble characters/objects/animals from simple solids |
| Video to be **edited** | **≤ 20 s** for good results; longer is less stable |
| Reference images for an edit | 1–5 good; 6–8 possible with reduced stability |
| Extension format | **MOV in and MOV out** for the best A/V sync |

## 5. Prompt writing — basic

Treat 2.5 as a *visual content producer*; write a **structured prompt with a director's mindset**.

| Block | What goes in it |
|---|---|
| **(R2V) creative mapping** | State the **number (in upload order)** and **role** of every image/video/audio — which is the look, which is the voice, which is the motion, which is the scene |
| **One-line summary** | Entity + location + event + theme/style + notable camera move |
| **Specific plot** | Storyboard *or* timeline (either works). Split by timestamp or "Shot N" and describe content, camera movement, action, dialogue, sound per segment. Prefer **positive** descriptions |
| **Negative control** | Supported for subtitles and audio — *"no subtitles"*, *"no BGM"* |
| **Closing** | Details that hold across the whole piece: camera position/movement, environment, sound, atmosphere |

### Reference-class prompts (multi-creative mapping)

As the number of creatives grows, mapping becomes the single most important thing.

- Number creatives by upload order (`Image 1` / `Video 1` / `Audio 1`) and **bind text to each
  one**. Do **not** rely on labels drawn inside the image — writing "Zhang San" on a picture and
  then saying "Zhang San is at school" reliably causes character confusion or duplication.
- Map every entity one by one; with many people, use a checklist.
  *"img1-2 = Character 1, uses Audio 1; img3-4 = Character 2, uses Audio 2"*
- Be specific about **what** to reference, and about **which part** if partial.
  *"Refer to the casting action in Video 1, and the orbiting camera movement in Video 2"*
  *"Refer to the lighting, shadow and filter settings in Reference Image 1"*
- When the reference is already accurate, **reference it and stop** — don't re-narrate it.
  *"Strictly refer to the movements and camera work in Video 1, keep the sequence consistent"*
  beats spelling out "raise your hand first, then turn around, camera slowly orbits…".

### Editing prompts

Define the scope and the content precisely; use timestamps for partial edits; describe the change
as **A → B**.

- *"Only edit the man's lines in Video 1, change them to '…', give him a Northeast Chinese accent"*
- *"Change the man's coffee-drinking action from 4 s to 6 s in Video 1 to mopping the floor; keep everything else unchanged"*
- *"Replace the Asian girl on the right in Video 1 with the Black girl in Image 1"*

### Timestamps

**Unit is 1 integer second.** 2.5 responds to timestamps; 2.0 does not (it only responds to shot
numbers).

- Too little plot in a window → the model improvises. Too much → it over-trims or drops beats.
  Budget the time realistically.
- **Do not** use timestamps for frequency control ("shake your head 3× per second").
- Keep the timeline **continuous** — `0-3s … 3-7s … 7-15s`, never `0-3s … 5-6s`.
- Point-in-time control works: *"fast leftward pan transition at the 5th second"*.
- Relative time works: *"after 3 seconds, the people around him shake their heads"*,
  *"after the shutter fires, the frame freezes for 1 second"*.

### Negative control

- Subtitles — *"no subtitles"*, *"no additional dialogue subtitles"*.
- Audio, at per-channel granularity — SFX, BGM and dialogue separately.
  *"No BGM, only ambient and action sounds"* · *"No sound at all"*.

## 6. Prompt writing — advanced

**Cinematographic language.** Write common terms plainly — shot size (extreme long → extreme
close-up), camera movement (push/pull/pan/track/follow/orbit/dive/tilt/handheld), angle (low,
high, POV). Named techniques work directly: long take, Hitchcock zoom, aerial, FPV, bullet time,
handheld, ramp. **Niche terms need `[term + description]`**, e.g. *"focus shift: the foreground
tree goes soft while the background figure resolves"*. For transitions, state **both** the trigger
point and the method — *"fast left pan transition at 5 s (left wipe + natural dissolve)"*.

**Action & emotion.** Prefer general action descriptions ("performed several high knees and
somersaults", "the two engaged in close-quarters combat"); add specifics only for a few memorable
beats, and don't repeat the same action. For expressions use descriptive sentences over idioms —
"eating heartily with a contented smile" beats "eating with gusto".

**Base-mesh reference / rendering.**
1. Name **which** elements of the mesh video you are referencing. No lighting change in the mesh →
   *"refer to the camera movement and action of [Video 1]"*. Lighting change you want kept →
   say so explicitly.
2. If reference images are also passed, state the correspondence:
   *"map the man in grey in [Image 1] to the red mesh in [Video 1]; replace green mesh 2 with the
   red-haired girl in [Video 2]"*.
3. Still describe the wanted content in detail, and make sure the text matches the mesh. For a
   mesh entity with no image/video overlay, a detailed appearance description improves the result.

**Base-mesh gotchas.**
- Don't build fine articulation (limbs, wings) into the mesh entity — torso only. Extra elements
  undermine vividness and produce stiff limbs.
- If the mesh *does* have limbs/wings, supplement the prompt with the corresponding action
  description to avoid the stiffness.
- Fine-grained meshes must be **clean**: no trajectory lines, coordinate lines or camera cones —
  they leak into the output and add nothing.

**Multi-panel storyboards.**
- Keep it under ~15 panels; an 18-panel grid tends to produce static frames and sequence disorder.
- Avoid dirty / over-sharpened AI-generated boards, and avoid heavy text on panels.
- Watch for internal contradictions and physically unreasonable camera/motion design.
- The grid will **not** align strictly. If strict alignment is required, use **keyframe reference**
  instead.
- Line-art workflow: (1) declare the reference mapping, (2) write the story outline, (3) describe
  the plot panel by panel, supplying at minimum what the panels don't show — scene, materials,
  camera movement, action, style — and use timestamps to fix the logic.
- Concept boards / keyframe designs accept a shorthand prompt:
  *"Follow the sequence of the storyboard to construct a complete storyline with reasonable and
  coherent camera movements."*

**Keyframe reference.** Pass the boards as independent references **in order**, and make the
**first sentence** of the prompt say so: *"Take Image 1 to Image 7 in sequence as keyframes: …"*.

## 7. New capabilities in detail

**Base-mesh (white-model) reference / rendering.** Coarse-grained meshes carry motion, camera
movement, blocking and lighting timing; you can overlay subject/scene/prop reference images to
control the render. Fine-grained meshes target full re-rendering — "colouring the white model" —
and are the route for high-difficulty previs, including frame-by-frame structural alignment of
complex 3D wireframes at finished-film visual quality.

**Video instruction editing.** Rewrites frame content while holding composition, camera position,
lighting and performance rhythm. The source's example ages a woman from twenty-something to sixty
across one continuous take with no cuts, no flicker and no feature drift.

**Video reference-image editing.** Same, guided by images — e.g. replacing both fighters' costumes
from two reference images and the location from a third, while keeping the choreography and its
original rhythm untouched.

**Video + audio editing.** Add, edit or remove vocals, music and SFX; the example switches all
English speech, narration and title subtitles to French/Japanese with everything else held.

**Video extension.** Output volume may shift slightly against the input; the shift is **smaller
when extending a clip 2.5 generated itself**, and the seam is better. **Select MOV as the output
format.**

**AutoCut.** Many stills → one edited short with its own audio/BGM, optionally holding the
originals nearly untouched ("live photo" motion only).

**Seamless transition.** Two clips in; the model invents the connecting move — the example flies
to the top, reverses, dives vertically, and morphs mahjong tiles into skyscrapers across the cut,
without altering either uploaded clip.

## 8. Differences from 2.0 (the four that matter)

| # | 2.0 | 2.5 |
|---|---|---|
| 1 | Ignores timestamps; responds to shot numbers only | **Responds to timestamps** in integer seconds |
| 2 | Multi-view entity reference **not recommended** | Multi-view **supported** |
| 3 | **6 fixed** output aspect ratios | **Any ratio in [0.4, 2.5]**, driven by the input creatives |
| 4 | — | **MOV output**, which holds colour/luminance consistency and A/V sync far better on extend/edit tasks |

Plus: 15 s → **30 s** single output; ≤ 50 reference creatives; first/last-frame folded into R2V.

## 9. Pricing

Seedance 2.5 is billed per output token. Current prices are on the public ModelArk pricing page:
https://docs.byteplus.com/en/docs/ModelArk/1544106

Last checked 2026-09-04: 480p and 720p cost $10.70 per million tokens with no input video and
$6.40 with input video; 1080p costs $11.70 and $7.00. Always check the page before quoting a price.

## 10. Implications for Take One Studio

Not implemented. Read these as design notes for whoever picks this up — **verify each against the
live API before writing code.**

- **4K is the blocker.** Take One Studio's Final Cut exports 4K 10-bit HEVC (Seedance 2.0 native), and 2.5
  **does not support 4K** (it does render 1080p, 10-bit, since at least 2026-09-02 — see §9).
  2.5 cannot replace `SEEDANCE_MODEL` wholesale for a 4K deliverable — it is a second,
  env-selectable tier alongside 2.0.
- **30 s clips vs 4–15 s.** Stage 5 currently renders one shot per clip inside Seedance 2.0's
  4–15 s window. A 30 s ceiling would let a whole scene render as one take — but the storyboard,
  shot list, per-shot approval and the `MAX_VERSIONS` ring buffer are all keyed to *shot*
  granularity, so this is a pipeline-shape change, not a parameter change.
- **50 reference creatives** vs 2.0's 9 images / 3 videos / 3 audio. The trusted asset library
  could pass far more of a scene's approved sheets in one call — but the entity-count guidance
  (1–8 image entities, 1–5 A/V entities) is the real ceiling, not the 50.
- **Timestamps become real.** `assemble_video_prompt()` currently writes prose; 2.5 responds to
  integer-second timestamps, which maps almost directly onto the Stage-4 board panel timings
  (`0-1.2s`, `1.2-2.5s`, …) we already generate. Note 2.5 wants **integer** seconds and a
  **continuous** timeline, and our panels are fractional.
- **Native editing/extension.** Stage 6's Extend clip / Edit clip and Studio's Extend/Edit are
  hand-built around i2v-from-last-frame. 2.5 has both as native task types with proper aspect and
  duration locking — likely simpler and higher fidelity, at the cost of a second code path.
- **MOV.** Our chain is MP4 end to end. 2.5's extend/edit quality guidance is explicitly
  MOV-in/MOV-out; adopting it touches `storage.save_shot_video`, the timeline player and export.
- **Locked-parameter semantics are new.** Today the UI always lets the user pick resolution and
  duration. Under 2.5 the edit/extend/first-frame paths would have to **disable** those controls
  and derive them from the input — surfacing that, rather than silently ignoring a user's pick.
- **Voice.** 2.5 generates 10+ languages natively and can reference an entity's timbre from audio.
  That overlaps with the Seed Audio 1.0 Voice Lock; worth measuring before duplicating.
- **Trust / biometric compliance: identical to 2.0.** The source guide never mentions it, but the
  user confirmed 2026-08-04 that **Seedance 2.5 behaves exactly like Seedance 2.0** here, so
  `video-seedance.md` §7 and `trusted-asset-library.md` remain the authority and carry over
  unchanged. In short: Seedream 5.0 **Pro and Lite are both exemption-eligible**; the
  t2i → image → i2v chain on the **same account** is fully exempt; **i2i is auto-exempt** under
  KYC HIGH; virtual humans only — real faces stay prohibited; and **re-encoding nullifies trust**,
  so a trusted frame must ride **byte-exact** (this is why Studio passes the original
  `return_last_frame` URL verbatim while it lives, and the RAW saved copy after). Take One Studio's
  existing guards — `resolve_reference_strict()`, the RAW last-frame save, the
  `privacyinformation|inputimagesensitive` retry that regenerates a distinctive fictional face —
  transfer to 2.5 as-is.
