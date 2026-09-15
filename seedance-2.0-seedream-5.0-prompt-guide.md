# BytePlus Prompt Guide — Seedream 5.0 (Image) & Seedance 2.0 (Video)

*A working reference for prompt engineering on BytePlus ModelArk. Grounded in the ModelArk model references; templates are illustrative applications of the documented formulas.*

---

## Part 1 — Seedream 5.0 (Image Generation)

### 1.1 The model

- **Dola Seedream 5.0 Lite** is the current flagship image model.
- Core strengths: reference consistency, complex spatial reasoning, professional stylistic transfer.
- Legacy endpoints still available: Seedream 4.5, 4.0, Seededit 3.0.

### 1.2 Prompt engineering rules

These two rules govern almost everything about prompt quality:

1. **Stay under 600 English words.** Beyond that, attention scatters — fine details get dropped in favor of the most heavily weighted elements. Long prompts *lose* control, they don't gain it.
2. **Use simple, direct language.** Concise, accurate prompts beat meandering, AI-generated descriptive paragraphs. Don't pad; say exactly what you want.

### 1.3 A reliable prompt structure

Seedream responds well to a front-loaded, layered description. A practical ordering:

```
[Subject + key attributes] → [Action / pose] → [Environment] →
[Lighting & color] → [Composition / framing] → [Style] → [Quality cues]
```

**Example (well under the word budget):**

> A weathered fisherman mending a net, seated on a stone harbor wall at dawn. Soft golden side-light, cool blue shadows. Tight three-quarter portrait framing, shallow depth of field. Photorealistic, fine skin and fabric texture, 4K.

### 1.4 Sizing — two mutually exclusive paradigms

You set output dimensions through `size`, and you pick **one** of these approaches:

| Paradigm | How it works | When to use |
|---|---|---|
| **Descriptive resolution** | Natural-language modifiers — `"2K"`, `"3K"`, `"4K"`. The model infers aspect ratio from the prompt's subject matter. | Fast, intent-driven generation where you trust the model to frame. |
| **Exact pixel-mapping** | Direct enforcement of aspect ratios, from ultra-wide **21:9** down to **1:1**. | Pipeline work needing deterministic, locked dimensions. |

### 1.5 Reference images & multi-image capabilities

Seedream 4.0–5.0 ingest up to **14 reference images** in a single inference pass. This is where the real power lives:

- **Subject replacement / spatial insertion** — segment a subject from Image A, map it into the environment of Image B with accurate contact shadows and matched depth-of-field.
- **Composite editing / attribute transfer** — e.g., a human model in one image + a garment in another → the garment drapes accurately over the model's proportions and pose.
- **Sequential character coherence** — feed multiple character reference sheets to generate new poses/scenarios while locking facial and anatomical identity.

**Prompting with references:** describe what each reference *contributes* and what the model should *do* with it, rather than re-describing the image. e.g. *"Place the subject from the first image into the kitchen from the second, matching the window light direction."*

### 1.6 Payload constraints (these shape how you prompt with assets)

| Limit | Value |
|---|---|
| Single reference image | ≤ **30 MB** |
| Total pixel count (width × height) | ≤ **36,000,000 pixels** |
| Total request body | ≤ **64 MB** |
| Reference formats | Public URLs **or** Base64 as `data:image/<format>;base64,<encoding>` |

> **Gotcha:** embedding several high-res Base64 images blows past the 64 MB body cap and triggers **HTTP 413 Payload Too Large**. Best practice — store assets in object storage (e.g. BytePlus TOS) and pass pre-signed URLs in the `image` array. Lower latency, no buffer overruns.

### 1.7 Streaming for responsive UIs

Seedream 5.0 Lite, 4.5, and 4.0 support **Server-Sent Events** via `stream: true`. The server pushes `image_generation.partial_succeeded` / `image_generation.partial_failed` events the moment each image finishes — each carrying an `image_index` plus the final `url` or `b64_json`. Use this to populate a grid progressively instead of blocking on the whole batch.

---

## Part 2 — Seedance 2.0 (Video Generation)

### 2.1 Models & specs

| Spec | Seedance 2.0 | Seedance 2.0 Fast |
|---|---|---|
| Model ID | `dreamina-seedance-2-0-260128` | `dreamina-seedance-2-0-fast-260128` |
| Resolutions | 480p, 720p, 1080p | 480p, 720p |
| Aspect ratios | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | same |
| Duration | 4–15 s | 4–15 s |

Fast trades 1080p for lower latency and compute cost. Frame count = **duration × 24 FPS**.

### 2.2 The Advanced Formula (the core of video prompting)

Seedance decouples a **spatial layer** (what's in frame) from a **temporal layer** (how it changes over time). A good prompt must address both. The full formula:

> **Precise Subject + Action Details + Scene/Environment + Lighting & Color Tone + Camera Movement + Visual Style + Image Quality + Constraints**

### 2.3 The four heuristics that make or break a generation

**1. Subject tagging — lock identity.**
Define each subject with stable static features, then reference it by tag for the rest of the prompt:

> `Define the woman wearing a red dress in <Image_1> as <Subject_1>`

Then use `<Subject_1>` rigorously thereafter. Skipping this causes **spontaneous subject mutation** mid-timeline.

**2. Quantify kinematics — kill abstract verbs.**
Abstract verbs hallucinate. Specify vector, speed, and inertia:

- ❌ "she raises her hand"
- ✅ "slowly raise a hand"
- ✅ "push hard off the ground"
- ✅ "use the inertia of turning around to naturally raise a hand"

Slow, coherent transitions suppress burst-dynamic failures — contortions, extra limbs, popping.

**3. Externalize emotion somatically — show, don't name.**
Don't write a feeling; write the body language that expresses it:

- ❌ "anger"
- ✅ "both fists clenched, jawline tense, chest heaving violently, eyes as sharp as knives"

**4. Functional typography — text that holds.**
The model renders accurate in-scene text (slogans on moving objects, synced subtitles, tracking speech bubbles) without warping or scrambling — provided you give it explicit text + positioning instructions.

### 2.4 A full prompt template

```
Subject:    <Subject_1> = [stable static description, mapped from <Image_1>]
Action:     [quantified motion — vector, speed, inertia]
Scene:      [environment, depth cues, background activity]
Lighting:   [key direction, color tone, mood]
Camera:     [movement: pan / tilt / zoom / orbit + speed]
Style:      [photoreal / 3D cartoon / film stock / etc.]
Quality:    [resolution intent, detail emphasis]
Constraints:[what must NOT happen — e.g. "no cuts", "keep face stable"]
```

**Worked example:**

> Define the man in the grey coat in `<Image_1>` as `<Subject_1>`. `<Subject_1>` walks slowly toward camera through falling snow, hands buried in pockets, shoulders hunched against the cold, breath visible. Quiet city street at night, shop windows glowing warm behind him. Cool blue ambient light, warm highlights from the windows. Camera slowly dollies back to match his pace. Cinematic, film-grain, photorealistic. Keep facial features stable throughout; no cuts.

### 2.5 Multimodal reference injection

A single payload can combine **text + images + video + audio**:

| Reference type | What it controls | Limit |
|---|---|---|
| **Image references** | Character identity, environment composition, rendering style (3D cartoon, photorealism…) | up to **9** |
| **Video reference** | Temporal dynamics — camera kinematics (pan, tilt, zoom, orbit), subject motion cadence, pacing | — |
| **Audio reference** (+ `generate_audio: true`) | Synthesized synchronized vocals, ambient SFX, score matched to the visuals | — |

> **Third-order example:** static product image + reference video of a camera orbit + voiceover track → a polished commercial where the product adopts the orbit motion and the visuals react to the audio.

### 2.6 Async lifecycle (how prompts actually get run)

Video generation is strictly asynchronous:

1. **Initiate** — `POST /contents/generations/tasks` → returns `task_id`, state `queued`.
2. **Poll** — `GET /contents/generations/tasks/{id}` — states: `queued → running → succeeded`/`failed`.
3. **Webhooks** — a `callback_url` parameter pushes an HTTP POST on state change (skip polling overhead).
4. **Abort** — `DELETE` on queued tasks frees compute when a user abandons a prompt.

### 2.7 Draft mode — iterate cheaply, then commit

Set `"draft": true` to skip the compute-intensive final denoising steps → a fast, low-fidelity wireframe video. Use it to validate **camera kinematics, subject placement, and pacing** at a fraction of the cost. Once approved, feed the `draft_task_id` back to execute the final high-res render (up to 1080p) on the validated wireframe.

> **Workflow implication:** prompt iteration belongs in draft mode. Only spend full-render compute on a prompt whose motion and blocking you've already confirmed.

### 2.8 Frame math & long-form extension

- Total frames = duration × **24 FPS**.
- `return_last_frame: true` → the final frame is returned as a distinct, **watermark-free PNG URL**.
- **Extension pattern:** feed Video A's `last_frame_url` into Video B's `first_frame` reference → daisy-chain past the 15-second cap into long-form narratives or seamless loops.

### 2.9 Biometric compliance — "Trusted Outputs" (read before prompting with faces)

Seedance 2.0 **categorically rejects** reference images/videos containing unverified real human faces. A face asset is accepted only if it originates from a trusted platform output generated **within the preceding 30 days, on the same account**:

- Face-containing videos generated by Seedance 2.0
- Last-frame images derived from Seedance 2.0 outputs
- Face-containing images from Dola Seedream 5.0 Lite

Trust is **nullified** by: altering file metadata, third-party compression, or cross-account asset transfer → the task fails immediately. (Real-person assets are possible via explicit enterprise contracts.)

> **Pipeline note:** this is why an image→video chain typically *starts* in Seedream 5.0 Lite — its face outputs are trust-valid inputs for Seedance 2.0 within the 30-day window.

---

## Part 3 — Chaining the two models

A common production pattern:

1. **Seedream 5.0 Lite** generates the character / keyframe / product still — exact pixel-mapped to the target aspect ratio (e.g. 16:9), faces kept trust-valid.
2. The still is passed as an **image reference** into **Seedance 2.0** (up to 9 references), with subject-tagging to lock identity.
3. **Draft mode** validates motion and camera; the approved draft is committed to a full 1080p render.
4. `return_last_frame` + the extension pattern stitches multiple clips past the 15-second cap.

**Division of labor when prompting the chain:** describe *appearance and composition* to Seedream; describe *motion, camera, and time* to Seedance. Don't re-litigate the look in the video prompt — reference it and tag it.

---

## Quick-reference cheat sheet

| | Seedream 5.0 Lite | Seedance 2.0 |
|---|---|---|
| Domain | Image | Video |
| Prompt cap | < 600 English words | (use the Advanced Formula) |
| Max references | 14 images | 9 images + video + audio |
| Sizing | Descriptive ("2K/3K/4K") **or** exact (21:9–1:1) | 480p/720p/1080p, 6 aspect ratios |
| Key prompt move | Concise layered description | Subject tagging + quantified kinematics |
| Cheap iteration | SSE streaming | `draft: true` |
| Faces | Trust-valid source for video | Trusted Outputs, 30-day window |
| Hard limits | 30 MB/img · 36 MP · 64 MB body | 4–15 s · 24 FPS |
