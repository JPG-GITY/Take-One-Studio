---
name: cinematic-prompt-builder
description: Build professional, production-grade AI video generation prompts for any style — live-action cinematic, 3D animated feature, AAA game-engine cutscene, gameplay footage, FPV oner, product/commercial, creature VFX composite, kaiju, or anything else. Use this skill whenever the user wants to write, draft, structure, improve, or expand a video prompt; mentions shots, cuts, multishot, oner, packshot, HUD, speed-ramp, film burn, or references like image-handles or input-locked source-video tokens; asks for a "cinematic prompt" or "video prompt"; or hands over a rough scene idea to turn into a full prompt. Trigger even for partial requests like "make this into a proper prompt", "write me a 15s video prompt about X", or "fix the structure of this prompt". The output is always a single ready-to-paste prompt block, not a description of one.
---

# Cinematic Prompt Builder

This skill writes finished, copy-paste-ready prompts for AI video generation. The output is the prompt itself — a clean block the user pastes straight into a video model — never a meta-explanation of how a prompt could be written.

## What "good" means here

Every prompt this skill produces obeys five non-negotiable principles, regardless of style:

1. **Motion from frame one.** No static establishing holds. The camera and at least one element are already moving in the first second. Action happens immediately, not after a beat.
2. **Three-layer depth.** Foreground, midground, background are all populated. Human (or character) figures act as scale references against large subjects.
3. **Locked references.** When the user supplies a reference (`@image_1`, `<<<video_1>>>`, a Notion product link, a named character), the prompt states the reference matches 100%, names exactly what is preserved, and — for video composites — that nothing is re-graded, re-timed, or re-framed.
4. **Real physics and practical light.** Mass, gravity, inertia, contact shadows, surface tension, complex lighting that comes from sources in the scene. No floating props, no flat light.
5. **Content-policy-safe by construction.** Write the scene so it never needs to depict prohibited content. See `references/content-policy.md` — load it for any scene with conflict, creatures, crowds, destruction, weapons, or minors.

## Workflow

1. **Identify the style/format.** Match the request to one of the format templates below (or compose a new one). If genuinely ambiguous between two very different formats, ask once; otherwise infer and state the assumption in one line.
2. **Lock duration and structure.** Decide: single continuous **oner** (one unbroken take, no cuts) vs **multishot** (hard cuts at stated times). Default to whatever the user implied; most examples are 15s.
3. **Load the relevant reference file(s)** before writing:
   - `references/structure.md` — the full section vocabulary, ordering, and how to assemble a prompt. **Read this first, always.**
   - `references/styles.md` — per-style recipes (live-action, 3D animated, game cutscene + HUD, gameplay, FPV oner, product/commercial, VFX composite, kaiju/creature). Read the matching section.
   - `references/content-policy.md` — safe-construction rules and substitutions. Read whenever the scene has any risk surface.
4. **Write the prompt** following the chosen template. Obey the user's formatting standard (below).
5. **Deliver the prompt block directly** in chat as a clean fenced block, with a one-line note on any assumption made. Do not pad with commentary.

## Output formatting standard

These reflect the user's established working standard — follow them unless the user overrides:

- Lead with a **STYLE line / style prefix** (comma-separated descriptors or a `Style:` sentence), then the structured sections, then the shot-by-shot breakdown, then constraints/audio.
- Use the section vocabulary in `references/structure.md`. Not every prompt needs every section — include the ones the scene actually uses, in the canonical order.
- **Shot/section breakdowns** carry explicit timecodes (e.g. `Shot 2 (0:05–0:10)` or `[Section 3 — 4.0–6.5s]`) when the format is multishot. Oners use beat timestamps inside one continuous paragraph (e.g. `0:04–0:05 — the jolt`).
- Mark cuts explicitly: `HARD CUT —` between sections, or state `one take no cuts` for a oner.
- Put **AUDIO** near the end. Default to `NO MUSIC. SFX ONLY — diegetic sound throughout.` unless the user wants score.
- End multi-element prompts with a **CONSTRAINTS** and/or **POSITIVE LOCKS** block restating aspect ratio, reference fidelity, and the rules that must not break.
- State aspect ratio (default **16:9**) and total length.
- Keep prose dense and directive. No filler, no "the viewer feels", no marketing adjectives that don't change the render.

## Quick format selector

| User says… | Format | Key references |
|---|---|---|
| "cartoon", "animated", "Pixar", talking creatures | 3D animated feature, multishot, with dialogue | styles.md → Animated |
| "game", "HUD", "boss", "quest", third-person | Game-engine cutscene, multishot, persistent HUD | styles.md → Game cutscene |
| "racing game", "gameplay", "FPS gameplay" | Gameplay footage, locked rig, live HUD | styles.md → Gameplay |
| "oner", "one take", "FPV", "POV", "continuous" | Single continuous shot, beat timestamps | styles.md → FPV/Oner |
| "commercial", "product", "ad", "packshot" | Product spot, fast macro cuts, packshot resolve | styles.md → Product |
| "make the creature come out of", "add X to my clip" | VFX composite on a source video, input-locked | styles.md → VFX composite |
| "kaiju", "monster fight", "titan", "leviathan" | Creature/kaiju cinematic, original design | styles.md → Kaiju |
| "cinematic", "dragon", "rider", live-action epic | Live-action cinematic, oner or multishot | styles.md → Live-action |

When nothing fits cleanly, compose from `structure.md` directly — the section vocabulary is universal and supports any style.
