"""
Claude QC Agent module — wraps the Anthropic SDK for all 6 pipeline stages.
Each stage gate uses a named persona system prompt (P6).
Uses prompt caching on the shared base prompt to reduce latency & cost.
"""

import os
import json
import logging
import re          # nivel de módulo: _ACCENT_NAMED se compila al importar
from pathlib import Path
from typing import Any
import anthropic
import httpx
from openai import OpenAI
import usage

logger = logging.getLogger(__name__)

# Env-overridable so a model upgrade is a one-line .env change (no code edit).
MODEL = os.getenv("CLAUDE_AGENT_MODEL", "claude-sonnet-4-6")

# ── QC gate backend ───────────────────────────────────────────────────────────
# QC verdicts (all stage gates) run on Seed 2.0 Pro (BytePlus/ARK) by default so
# they DON'T spend Anthropic credits — Claude stays reserved for the "brain"
# (breakdown, prompts, face blocks). Vision is already BytePlus, so QC becomes
# 100% BytePlus. Claude is an automatic fallback if seed is missing/errors.
# Flip QC_BACKEND=claude in .env to revert with zero code changes.
QC_MODEL = os.getenv("QC_MODEL", "seed-2-0-pro-260328")
QC_BACKEND = os.getenv("QC_BACKEND", "seed").strip().lower()

# ── Breakdown backend (1a, 2026-07-15) ────────────────────────────────────────
# The production BREAKDOWN is a "brain" writing task, so it runs on CLAUDE by
# default — the script never left Claude; only the breakdown had drifted to Seed.
# Seed 2.0 stays reserved for QC VERDICTS (QC_BACKEND above). These are TWO
# INDEPENDENT flags on purpose: QC=Seed while breakdown=Claude is the intended
# split (do NOT overload QC_BACKEND). Flip BREAKDOWN_BACKEND=seed to route the
# breakdown to Seed 2.0 Pro (BytePlus billing) with the same automatic Claude
# fallback. (enhance_shots routes through the same path → also Claude by default,
# intended: it's a writing/assist task, not a QC verdict.)
BREAKDOWN_BACKEND = os.getenv("BREAKDOWN_BACKEND", "claude").strip().lower()

# ── Render-queue claim window: explicit bounds for the two submit-path calls ──
# vision_video_prompt() and video_direction() are the only two Claude calls that run
# INSIDE render_queue.py's claim window (server.py _create_video_impl, reached from
# _queue_submit_one) — the second one runs as well whenever the first throws. Until
# 2026-08-01 they inherited the SDK's own defaults, which on anthropic 0.107.1 measure
# Timeout(connect=5, read=600, write=600, pool=600) and max_retries=2: 3 x 600 = 1800 s
# of legal, still-alive work for ONE call, 3600 s for both — four times the 900 s grace
# render_queue.STALE_CLAIM_SECS allows before it declares the claimer dead and re-queues
# the shot. A re-queued LIVE claim is submitted a second time and BytePlus bills the
# render twice, so that arithmetic was not cosmetic.
#
# Worst case now: (1 + SUBMIT_PATH_MAX_RETRIES) x SUBMIT_PATH_TIMEOUT_SECS per call
#                 = 2 x 90 s = 180 s, x2 calls = 360 s, well under STALE_CLAIM_SECS.
# These are applied PER REQUEST (self.client.with_options, the same idiom
# byteplus_generative.py uses) and never on the shared client: the long-form script and
# breakdown calls stream for many minutes on purpose and must keep the 600 s read.
SUBMIT_PATH_TIMEOUT_SECS = float(os.getenv("TAKEONE_SUBMIT_LLM_TIMEOUT", "90"))
SUBMIT_PATH_MAX_RETRIES = int(os.getenv("TAKEONE_SUBMIT_LLM_RETRIES", "1"))
# …and since 2026-08-07 both of those calls are TWO-PROVIDER (Seed 2.0 Pro first, Claude
# only as the fallback — see _text_llm), so the retry budget above is SPENT ON THE OTHER
# PROVIDER instead of on a second attempt at the same one:
#
#   one leg = 1 Seed attempt x 90 s + 1 Claude attempt x 90 s = 180 s
#           = (1 + SUBMIT_PATH_MAX_RETRIES) x SUBMIT_PATH_TIMEOUT_SECS, the IDENTICAL
#             per-leg worst case render_queue.py's 900 s bounded arithmetic already
#             counts. Two legs (vision, then the text template) = 360 s, unchanged.
#
# Re-asking a provider that just failed is worth less than asking the one that did not:
# measured 2026-08-07, the out-of-credit Anthropic leg returns its 400 in well under a
# second and the SDK's own retry bought exactly one more 400. A Seed timeout, meanwhile,
# now falls THROUGH to Claude rather than re-queuing on the same socket — and the two
# stage-5 legs give the pipeline two independent Seed attempts anyway (vision, then the
# text template), which is the retry that actually recovers a transient blip.
SUBMIT_PATH_PROVIDER_RETRIES = int(os.getenv("TAKEONE_SUBMIT_LLM_PROVIDER_RETRIES", "0"))
# Same window, same reason: _image_block() fetches every reference image serially before
# the vision call, and VideoTaskRequest accepts up to 9 refs. At the old 60 s that term
# alone was 540 s; 20 s is still generous for a <3 MB JPEG and caps it at 180 s.
SUBMIT_PATH_IMAGE_FETCH_SECS = int(os.getenv("TAKEONE_SUBMIT_IMAGE_TIMEOUT", "20"))

# ── Load skill files (0.3) ────────────────────────────────────────────────────
# Skills live under skills/qc/ relative to this file.
# If a skill file exists it REPLACES the inline persona prompt for that gate.

_SKILLS_DIR = Path(__file__).parent / "skills" / "qc"

def _load_skill(filename: str) -> str | None:
    """Load a QC skill file. Returns None if not found."""
    path = _SKILLS_DIR / filename
    try:
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return None


def _load_skill_section(filename: str, heading: str) -> str | None:
    """Load ONE `## ` section (heading through the next `## `) of a skill file that lives
    in skills/, one level above the QC personas.

    Loading a whole craft skill wholesale is what makes them unusable here, which is why
    they have sat on disk unread. skills/Director_ShotList.md is 415 lines and most of it
    is addressed to a chat assistant that delivers an HTML file to a human: an output
    template, a revision protocol, a worked example. Worse, its "The Style Prefix" section
    declares that a full style block opens every prompt, and the newer
    skills/seedance-prompt-SKILL.md says the exact opposite ("nothing style-related opens
    the prompt", camera in 3rd position) — which is what this codebase's own prompt
    assembler already does, correctly. Pasting the whole file in would hand the writer two
    contradictory laws and let the older one win by being longer.

    So: one section, by name. The file stays the single source of truth — edit the .md and
    the prompt changes — without importing the parts that do not apply.
    """
    # skills/ first, then the repository root. `ACTING SKILL.md` lives at the root — 444
    # lines of craft that no code had ever opened, because this loader only looked one
    # level up from the QC personas. Two directories instead of one is what connects it,
    # and moving the file would be a worse fix: it is referenced by name in comments all
    # over this codebase.
    # Una ruta CON separadores se resuelve desde la raíz del repo: el contrato de
    # Seedance 2.5 vive en `.agents/skills/sd25-pe/SKILL.md`, fuera de skills/, y su
    # nombre de fichero ("SKILL.md") es demasiado genérico para buscarlo por directorios.
    for path in (_SKILLS_DIR.parent / filename,
                 Path(__file__).parent / filename):
        try:
            text = path.read_text(encoding="utf-8")
            break
        except Exception:
            continue
    else:
        return None
    lines = text.splitlines()
    want = heading.strip().lower()
    start = next((i for i, ln in enumerate(lines)
                  if ln.startswith("## ") and ln[3:].strip().lower().startswith(want)), None)
    if start is None:
        return None
    end = next((j for j in range(start + 1, len(lines)) if lines[j].startswith("## ")), len(lines))
    body = "\n".join(lines[start:end]).strip().rstrip("-").strip()
    return body or None

# A SHOOTING SCRIPT NUMBERS ITS SCENES, AND EVERY DETERMINISTIC READER MISSED IT.
#
# Four regexes recognise a scene heading — the cue reader, the cast reader, the scene
# splitter and the location list — and all four were anchored on INT/EXT at the START of
# the line. A production draft does not put it there: it puts the scene number first, and
# again in the right margin ("A1  EXT. SMALL HOLDING - NUMIDIA - DAWN  A1"). The heading
# then fails the heading test, falls through to the character-cue test — all caps, opens
# with a letter, under 40 characters — and is read as a PERSON.
#
# Measured on the GLADIATOR II shooting script (2026-08-14): `script_speaking_cast`
# returned "A1  EXT. SMALL HOLDING - NUMIDIA - DAWN" as a member of the cast, the derived
# bible gave it a character entry, and it was on its way to a face sheet and a paid render.
# That script numbers A1, 11A, 17A, 23/23A, 47A-G, 110A/B, 122A/B … roughly thirty of
# them. A plain `1  EXT.` survived only because the cue test requires a leading letter —
# the numbering style, not the format, decided whether the film had phantom characters.
#
# The prefix is optional and matches nothing in a script that has no numbers, which is
# what every project on this machine looks like: cast and locations come back byte-identical
# for all 15 of them.
_SCENE_NUM = r'(?:[A-Z]{0,2}\d{1,3}[A-Z]?(?:\s*/\s*[A-Z]{0,2}\d{1,3}[A-Z]?)?[.\s]\s*)?'

# ── Persona system prompts (P6) ───────────────────────────────────────────────

_BASE_SCHEMA = """\
ALWAYS respond with valid JSON only — no prose, no markdown fences.

Schema:
{
  "passed": true | false,
  "checks": [
    { "label": "string", "passed": true | false, "notes": "string" }
  ],
  "summary": "One sentence narrative for the director.",
  "regen_prompt": "If failed, a concise improved prompt for regeneration. Otherwise null.",
  "persona": "string"
}

CALIBRATION (read carefully): You are an ADVISORY gate, not a gatekeeper. Mark a
check "passed": false ONLY for a genuine, blocking defect that would visibly harm
the film. Minor, subjective or nice-to-have polish is NOT a failure — put it in
that check's "notes" WITH "passed": true. Do not manufacture problems, and never
fail a check for information you were not given. The top-level "passed" is false
ONLY if at least one check has a real blocking defect; otherwise it is true. Good,
usable work should PASS with constructive notes.

Be concise, precise, and director-focused. Use professional film production terminology."""

_PERSONAS: dict[str, str] = {
    "film_director": f"""\
You are the FILM DIRECTOR QC gate for Take One Studio.
Your voice is that of a seasoned auteur director (think Fincher, Spielberg, or Villeneuve).
You review scripts and final cuts for story arc, pacing, visual potential, emotional impact,
and cinematic language. You push for work that is bold, clear, and moving.
{_BASE_SCHEMA}
Set "persona" to "Film Director".""",

    "producer": f"""\
You are the LINE PRODUCER QC gate for Take One Studio.
Your voice is that of a hard-nosed production executive: practical, budget-aware, continuity-obsessed.
You review breakdowns for scope, feasibility, shot count rationality, asset completeness, and
element continuity across scenes. You flag anything that will blow the schedule or break continuity.
{_BASE_SCHEMA}
Set "persona" to "Producer".""",

    "art_director": f"""\
You are the ART DIRECTOR QC gate for Take One Studio.
Your voice is that of a senior visual development artist who has trained at ILM and Disney.
You judge assets on palette discipline, silhouette readability, design uniqueness, style consistency,
and adherence to the declared project style. You flag muddy palettes, generic designs, and style drift.
{_BASE_SCHEMA}
Set "persona" to "Art Director".""",

    "layout_director": f"""\
You are the LAYOUT DIRECTOR QC gate for Take One Studio.
You review environment designs for spatial coherence across multiple camera angles, believable
depth and scale, consistent geography, and workable camera blocking.
You flag impossible geography, inconsistent lighting axes, and environments that won't cut together.
{_BASE_SCHEMA}
Set "persona" to "Layout Director".""",

    "camera_director": f"""\
You are the CAMERA DIRECTOR & ANIMATION DIRECTOR joint QC gate for Take One Studio.
You review shot descriptions and storyboards for cinematographic language, motivated camera movement,
frame composition, asset placement physics, and animation performance notes.
You judge whether shots will edit together and serve the story.
{_BASE_SCHEMA}
Set "persona" to "Camera Director".""",

    "animation_director": f"""\
You are the ANIMATION DIRECTOR QC gate for Take One Studio.
You review rendered video shots for motion quality, temporal consistency, character performance,
visual fidelity against approved reference assets, and physics plausibility.
You flag frozen motion, identity drift, lighting mismatches, and unnatural movement arcs.
{_BASE_SCHEMA}
Set "persona" to "Animation Director".""",
}


# ── Photographic-style enforcement (Bug 3) ────────────────────────────────────
# Photoreal projects were rendering as illustrated "identity boards" because the
# template's photographic-medium rule was inconsistently followed by the model.
# We detect a photographic style and (a) inject a hard directive into the prompt
# builder's system text and (b) post-process the returned prompt to GUARANTEE a
# dominant real-photo framing (early tokens weigh heaviest in Seedream).

_PHOTO_MARKERS = ("photo", "photograph", "photoreal", "realistic", "dslr", "live action", "live-action")


def _is_photographic(style_label: str = "", style_suffix: str = "") -> bool:
    s = f"{style_label} {style_suffix}".lower()
    return any(m in s for m in _PHOTO_MARKERS)


# ── HELL GRIND · the film's LOOK does not live in the reference sheet ─────────
#
# Quoted from the production brief: "Keep the sheet boring on purpose. Neutral grey
# background. Flat light. Real skin with visible pores, no retouch. The cinema look does
# not live in the character sheet — it lives in the locations and in the video prompts.
# Bake film grain and cinematic lenses into the sheet, and the character will carry that
# look into every scene and stop reacting to new light."
#
# Take One Studio's photographic mandate below did EXACTLY what the brief warns against: the
# [CAMERA] block ordered "natural film grain" and a lens with character, and the ANTI-CGI
# paragraph ordered "real photographic depth of field (slightly soft background), genuine
# film grain". MEASURED on Tomás Arroyo (BLOOM), 4/4 styled sheets: the writer emitted
# "[CAMERA] Arri Alexa 35, 85mm prime, soft diffused key with subtle rim light, ISO 320,
# fine natural 35mm film grain" — grain, lens and a directional key baked into the very
# document every later shot takes the face from.
#
# `neutral=True` swaps ONLY the two lines that carry look (camera + anti-CGI) for their
# flat-light equivalents. The skin/surface line is untouched: "real skin with visible
# pores, no retouch" is what the brief ASKS for, and it is already what that line says.
# Default False → every existing caller gets byte-identical text.
def _photo_directive(subject: str, neutral: bool = False) -> str:
    """Append the Seedream-5 [CAMERA] + [SKIN]/[SURFACE] mandate for photographic
    styles. Positive framing (the guide warns negatives can reinforce what they
    negate); these two blocks are the #1 lever that separates a real photograph
    from a clean 3D/CGI render.

    neutral=True → the NEUTRAL REFERENCE SHEET variant (HELL GRIND rule above): still a
    real photograph, but shot flat on a copy stand — no grain, no lens character, no
    shaped light. Used for character / prop / wardrobe sheets only.
    """
    is_person = "person" in subject or "actor" in subject
    surface = (
        "[SKIN] real skin behaviour — visible pores and fine texture, subsurface light, a "
        "semi-matte finish with natural sheen only where lit; never smooth, waxy or plastic.\n"
        if is_person else
        "[SURFACE] real material behaviour — true texture (grain, weave, brushed/worn metal, "
        "scuffed edges), accurate reflectance and contact shadows; never a clean CGI surface.\n"
    )
    camera = (
        "[CAMERA] a real camera body + a normal prime lens, stopped down so the WHOLE subject "
        "is evenly sharp, lit by one large soft source with equally soft fill from the opposite "
        "side (e.g. 'Sony A7R V, 85mm prime, large softbox key with matching soft fill, ISO 100, "
        "even exposure') — flat, even, colour-neutral documentation light. NO film grain, NO "
        "anamorphic or wide-angle lens character, NO lens flare, NO vignette, NO bokeh, NO rim "
        "or coloured light, NO colour grade.\n"
        if neutral else
        "[CAMERA] a real camera body + prime lens + studio lighting + ISO + natural film grain "
        "(e.g. 'Arri Alexa 35, 85mm prime, soft diffused key with gentle rim light, ISO 320, fine "
        "film grain'); pick a body/lens that suits the look.\n"
    )
    anti_cgi = (
        "ANTI-CGI (critical — output was reading like a MetaHuman): this is a set of REAL STUDIO "
        "PHOTOGRAPHS of the same real person — each pose/view is its OWN separate photograph (an "
        "actor lookbook / wardrobe test), NOT a single 3D character turnaround. It must NOT look "
        "like a CGI character, a MetaHuman, a Unreal-Engine/video-game model or a 3D render: keep "
        "asymmetric human imperfection and real un-retouched skin — pores, fine lines, stray "
        "hairs, uneven tone — not the poreless symmetry of a render. End with the anchors: 'real "
        "photograph, photographic, not CGI, not a game render'.\n"
        if neutral else
        "ANTI-CGI (critical — output was reading like a MetaHuman): this is a set of REAL STUDIO "
        "PHOTOGRAPHS of the same real person — each pose/view is its OWN separate photograph (an "
        "actor lookbook / wardrobe test), NOT a single 3D character turnaround. It must NOT look "
        "like a CGI character, a MetaHuman, a Unreal-Engine/video-game model or a 3D render: keep "
        "real photographic depth of field (slightly soft background), genuine film grain, "
        "asymmetric human imperfection, and softly imperfect studio light — not the flat even clean "
        "shading of a render. End with the anchors: 'real photograph, photographic, candid, not "
        "CGI, not a game render'.\n"
    )
    return (
        f"\n\nPHOTOGRAPHIC STYLE — it must read as a REAL PHOTOGRAPH of {subject}, captured on a "
        "camera, not a render. Two blocks are MANDATORY and specific:\n"
        + camera
        + surface
        + anti_cgi +
        "Throughout, use 'photograph / photographed / shot on'; do NOT use the words render, "
        "rendered, rendering, CGI, illustration, concept art, or design sheet."
    )


def _enforce_photographic(prompt: str, subject: str = "a real person",
                          neutral: bool = False) -> str:
    """Deterministic safety net for photographic styles. Positive-first: ensure a
    real-camera framing dominates. (We no longer blind-replace render/CGI words —
    the prompt now uses 'not CGI / not a game render' as deliberate anti-MetaHuman
    anchors, and a blind swap turned 'not CGI' into the contradictory 'not
    photographic'.)

    neutral=True → the tail that was APPENDING film grain to every sheet ("Captured with
    fine natural film grain…") is replaced by the flat-studio tail. This net fires on the
    LAST sentence, which the model weights heavily: leaving it in place would have put the
    grain back into the neutral sheets by hand, after the writer had been told to drop it.
    """
    p = prompt.strip()
    for bad in ("character identity board", "identity board", "object design sheet",
                "character art-book", "art-book", "design sheet", "character sheet"):
        repl = "studio photography contact sheet"
        p = p.replace(bad, repl).replace(bad.title(), repl)
    if not any(m in p[:120].lower() for m in ("photo", "photograph", "dslr", "shot on", "camera")):
        p = f"Studio photograph of {subject}, shot on a professional cinema camera. " + p
    if neutral:
        # "skin with visible pores" is the brief's own wording and belongs on a PERSON.
        # Measured on a live prop sheet: an unconditional skin tail put "real un-retouched
        # skin texture with visible pores" on a soldered steel tin. Same [SKIN]/[SURFACE]
        # split _photo_directive already makes, for the same reason.
        is_person = "person" in subject or "actor" in subject
        texture = ("real un-retouched skin texture with visible pores" if is_person
                   else "real un-retouched material texture")
        return p.rstrip(".") + (f". Flat even studio light on a neutral grey seamless "
                                f"background, {texture}, no film grain, no colour grade.")
    if "grain" not in p.lower():
        p = p.rstrip(".") + ". Captured with fine natural film grain and real skin texture."
    return p


#: The one paragraph that turns any of the three reference sheets into a look-free
#: technical document. Appended LAST-but-one in the system prompt (the writer LLM weights
#: the end hardest — the same reason the headless restatement sits where it does).
#: HELL GRIND, quoted: "Keep the sheet boring on purpose. Neutral grey background. Flat
#: light. […] Bake film grain and cinematic lenses into the sheet, and the character will
#: […] stop reacting to new light."
#: Written positive-first (the Seedream guide warns a negative can reinforce what it
#: negates), with the ban list second — the same shape as the existing [FORBIDDEN] block.
_NEUTRAL_SHEET_BLOCK = (
    "\n\nNEUTRAL REFERENCE SHEET — this overrides ANY look wording above. This image is a "
    "technical reference document for the production department, NOT a frame of the film: "
    "flat, even, colour-neutral light from a large soft source with equally soft fill; a "
    "clean NEUTRAL MID-GREY seamless background and nothing else in frame; correct white "
    "balance; the whole subject evenly sharp; real un-retouched surface texture. It must "
    "carry NO film grain, NO lens character (no anamorphic, no wide-angle distortion, no "
    "flare, no vignette, no bokeh), NO colour grade or colour cast of any kind (no teal, no "
    "orange, no golden hour, no coloured practicals or glow), and NO weather, water, haze, "
    "smoke, dust or atmosphere. The film's look is applied later, in the locations and in "
    "the shot prompts; this sheet stays neutral so the subject RE-LIGHTS correctly under "
    "whatever light a scene puts it in."
)


# The panel spec of each sheet layout, in ONE place. The [COMPOSITION] block, the
# IDENTITY LOCK line and the closing SHEET SPEC restatement all read from here: they
# are three separate statements of the same fact inside one system prompt, and when
# they disagreed the writer LLM followed whichever it liked and reverted to the
# canonical four-pose turnaround it knows (that is what the two comments below record).
# "faces" is the number of faces the finished sheet shows — the number HELL GRIND's
# rule 1 is about.
#
# "crop" is where the BIG face sits, as (left, top, right, bottom) fractions of the
# sheet — server._derive_headshot cuts exactly that box to make Headshot/headshot.png,
# the face reference every board gets. It lives HERE, next to the sentence that tells
# Seedream where to put the panel, because the two are the same fact: change the layout
# and a crop that stayed behind stops being a face (the top-left quadrant of a headless
# sheet is a forehead). Both boxes MEASURED over 4 renders each at 2144x2144, 2026-08-06.
_SHEET_LAYOUTS: dict[str, dict[str, Any]] = {
    # HELL GRIND, quoted: "A character sheet is three images: a close-up of the face, a
    # full body from the front, and a full body from the back. And the front full-body
    # figure HAS NO HEAD. […] On wide shots the model kept taking the face from the small
    # full-body figure on the sheet — where the face is tiny and blurry. Remove that head,
    # and the model has only one place to take the face from: the close-up." Plus: "the
    # sheets the model understands best have a large portrait in 3/4 view".
    # Take One Studio's own A/B had tried to fix the same drift by ADDING the cropped headshot as a
    # second board reference and measured ZERO difference over 8 trials; this is the
    # opposite move — REMOVE the competing faces instead of adding another.
    # crop = the LEFT HALF, down to 66%: the portrait fills the left column top-to-bottom,
    # so the old top-left-quadrant box would have returned a forehead. 4/4 renders put the
    # whole head + shoulders inside this box and nothing else — the only other thing the
    # box can touch is the headless figure's suit, which carries no face by construction.
    "headless": {"labels": "FRONT / BACK", "faces": 1, "crop": (0.02, 0.02, 0.49, 0.66),
                 "lock": "the headless front figure, the back figure and the 3/4 portrait",
                 "spec": "TWO (2) full-body figures — a HEADLESS front view and a back view — "
                         "plus ONE (1) large 3/4 face portrait"},
    # crop = the top-left close-up of the two-close-up top row. Unchanged: sheets already
    # on disk were cut with exactly this box.
    "2+2":      {"labels": "FRONT / BACK", "faces": 3, "crop": (0.02, 0.02, 0.49, 0.39),
                 "lock": "both poses",
                 "spec": "TWO (2) full-body poses (FRONT, BACK) plus TWO (2) face close-ups"},
    "4+2":      {"labels": "FRONT / 3/4 / SIDE / BACK", "faces": 6, "crop": (0.02, 0.02, 0.49, 0.39),
                 "lock": "all four poses",
                 "spec": "FOUR (4) full-body poses (FRONT, 3/4, SIDE, BACK) plus TWO (2) face close-ups"},
}
# The sheet the pipeline builds when nobody asks for anything else. One name for it, so
# identity_board_prompt's default and _derive_headshot's default crop cannot drift apart.
SHEET_LAYOUT_DEFAULT = "headless"


def _composition_block(layout: str = SHEET_LAYOUT_DEFAULT, grey_bg: bool = True,
                       pose_labels: bool = True) -> str:
    """The [COMPOSITION] line of a character reference sheet. Split out so the Studio's
    Character Creator can offer sheet variants without forking the prompt.

    layout "headless" → the HELL GRIND sheet and the DEFAULT since 2026-08-06: ONE large
        3/4 face portrait + a HEADLESS front full-body + a back full-body. Exactly ONE
        face on the sheet, so a wide shot has only one place to take it from.
    layout "4+2" → 4 full-body poses (FRONT/3-4/SIDE/BACK) + 2 face close-ups (the sheet
        the pipeline produced before that date; SIX faces, four of them tiny)
    layout "2+2" → 2 full-body poses (FRONT/BACK) + 2 face close-ups (a 4-panel sheet)
    """
    backdrop = "on a clean neutral grey seamless studio backdrop" if grey_bg else \
               "on a plain uncluttered backdrop that keeps the figure fully readable"
    if layout == "headless":
        # Labels here name TWO panels, not four — and the portrait is deliberately left
        # unlabeled: it is the only face, nothing distinguishes it from anything else.
        labelled_ = (' each labeled with its pose name ("FRONT", "BACK")' if pose_labels else
                     ' with NO text, captions or labels of any kind rendered anywhere in the image')
        return (
            "[COMPOSITION] a CHARACTER REFERENCE SHEET laid out as TWO COLUMNS, "
            f"{backdrop}. LEFT COLUMN — exactly the LEFT HALF of the frame, top edge to "
            "bottom edge: ONE single LARGE head-and-shoulders portrait of the {subject} in "
            "THREE-QUARTER view, the head turned slightly away from camera (NEVER straight-on, "
            "NEVER a profile), filling that half of the image. RIGHT COLUMN — the right half: "
            "EXACTLY TWO (2) — no more, no fewer — separate full-body figures of the SAME "
            "{subject} standing side by side, head-to-toe,"
            f"{labelled_}. The LEFT of those two is the FRONT view and it is HEADLESS: the "
            "figure ends cleanly at the base of the neck, exactly like a tailor's dress form "
            "or a wardrobe mannequin torso — NO head, NO face, NO hair, NO neck stump detail "
            "above the shoulder line. This is a clean tailoring crop, NOT an injury: no blood, "
            "no wound, no gore, nothing severed. The RIGHT of those two is the BACK view, seen "
            "from directly behind, showing the back of the head only. "
            "THE SHEET CONTAINS EXACTLY ONE FACE — the large 3/4 portrait. There is NO face on "
            "the front figure (it has no head) and NO face on the back figure (it faces away), "
            "and there is NO second close-up, NO extra pose, NO inset. If the character wears a "
            "helmet/mask/hood, the portrait shows the head BARE so the real face reads clearly. "
            "Identical wardrobe, build and props on both figures.\n"
        )
    two = layout == "2+2"
    # EMPHATIC counts: with a plain "TWO separate figures" the writer LLM kept reverting to
    # the canonical four-pose turnaround it knows (verified against the live endpoint), so
    # the panel count is stated as a hard, numeric, do-not-deviate requirement.
    poses = ('EXACTLY TWO (2) — no more, no fewer — separate full-body figures standing side '
             'by side in one frame, in exactly these two poses: FRONT and BACK (do NOT add a '
             '3/4 or SIDE pose)') if two else (
             'EXACTLY FOUR (4) separate full-body figures standing side by side in one frame, '
             'each a distinct pose, FRONT, THREE-QUARTER, SIDE and BACK')
    count = "BOTH full-body figures" if two else "ALL FOUR figures"
    # Labels are what make the panels readable as a turnaround; without them the sheet must
    # carry NO rendered text at all (a half-labeled sheet is the worst of both).
    labelled = (' each labeled with its pose name ("FRONT", "3/4", "SIDE", "BACK")'
                if pose_labels else
                ' with NO text, captions or labels of any kind rendered anywhere in the image')
    return (
        "[COMPOSITION] a MULTI-POSE MODEL SHEET — NOT a single portrait. The SAME {subject} "
        f"appears as {poses}, full body head-to-toe,{labelled}, {backdrop}; PLUS two FACE "
        f"close-up portraits (front + 3/4) along the top row. {count} AND BOTH close-ups must "
        "be present and visible. If the character wears a helmet/mask/hood, the close-ups show "
        "the head BARE so the real face reads clearly. Identical face, wardrobe and props in "
        "every pose.\n"
    )


def _looks_non_human(description: str) -> bool:
    """Best-effort: does this CHARACTER description describe a NON-HUMAN creature
    (beast, alien, spirit, anthropomorphic animal, luminous being) rather than a
    person? Keeps the photographic directive from forcing 'a real person' onto a
    creature — which flattened Loom's 'heron-like being with hands instead of wings'
    into a humanoid actor (observed 2026-07-17). Conservative: fires only on clear
    non-human signals, so real people (even fantastical ones) stay 'a real person'."""
    d = f" {(description or '').lower()} "
    strong = ("creature", "beast", "monster", "alien", "dragon", "demon", "wraith",
              "elemental", "non-human", "nonhuman", "anthropomorphic", "heron-like",
              "bird-like", "reptilian", "insectoid", "tentacl", "winged being",
              "hands instead of wings", "feather-form", "translucent blue",
              "quadruped", "six-legged", "luminous spirit")
    if any(s in d for s in strong):
        return True
    # 'being'/'entity'/'spirit' are non-human ONLY paired with a supporting cue
    # (and never for the phrase "human being").
    if "human being" not in d and any(f" {w}" in d for w in ("being", "entity", "spirit")):
        cues = ("translucent", "glowing", "luminous", "feather", "wings", "tail",
                "no pupils", "golden eyes", "amber eyes", "eight-foot", "eight feet",
                "otherworldly", "ethereal", "ancient")
        return any(c in d for c in cues)
    return False


def estimate_dialogue_seconds(dialogue: list[dict] | None) -> float:
    """Rough spoken duration of a shot's dialogue, used to size the clip so the
    audio isn't cut off. Cinematic delivery ≈ 2 words/sec, plus a short beat per
    line and a lead-in/tail hold. Deliberately a little generous (cut-off is worse
    than a slightly long clip).

    This is the pipeline's ONE piece of duration maths and every other estimate in
    this file is built on it (estimate_script_seconds, estimate_shots_seconds, the
    breakdown's shot sizing, the server's "Dialogue fits" gate on a landed clip). It
    was private to phase 2 for no reason other than where it was first needed — a
    number the whole pipeline reconciles against cannot live behind an underscore in
    the middle of the breakdown.

    `dialogue` is the breakdown's shape — [{"text": "...", "characterId": ...}] —
    and anything without text is ignored, so an empty list scores 0.0: no speech, no
    lead-in, no tail. Behaviour is UNCHANGED from the private version; only the name
    is new."""
    total = 0.0
    lines = 0
    for d in dialogue or []:
        text = (d.get("text") or "").strip()
        if not text:
            continue
        words = len(text.split())
        total += words * 0.5 + 0.6      # ~2 words/sec + a beat per line
        lines += 1
    return total + (0.8 if lines else 0.0)   # lead-in + tail hold


#: The private spelling this maths was born with. Kept as an ALIAS (the same object,
#: not a wrapper) because it is imported by name in server.py's shot-video QC gate and
#: called three times in the breakdown below — renaming those buys nothing and a stale
#: import would be a silent 500 on a path that only runs after a paid render.
_estimate_dialogue_seconds = estimate_dialogue_seconds


# ── Runtime maths shared by every phase ───────────────────────────────────────
# Speech runs at ~2 words/sec (above). ACTION does not: an action line is not
# performed word by word, it is a description of something the camera watches
# happen — "He turns it over." is four words and about two seconds of screen.
#
# 4.5 words/sec is a FIT, not a convention. Measured over the 15 projects on this
# machine that have both a script and a breakdown, scoring
# (dialogue seconds + action_words / rate) against the breakdown's own
# Σ duration_sec — the shot lengths the film is actually rendered at:
#     3.0 w/s → median |err| 51%   4.0 → 24%   5.0 → 17%
#     3.5 w/s → median |err| 35%   4.5 → 14%   5.5 → 23%
# ROBOTECH's script lands at 267s against 294s of real shots; the words/130 rule
# this replaced says 569s for the same 1233 words, i.e. nearly double the film.
ACTION_WORDS_PER_SEC = 4.5


def split_script_speech(script: str) -> tuple[list[dict], int]:
    """Split a screenplay into its SPOKEN lines and its remaining ACTION word count.

    Returns ([{"text": "the spoken line"}, ...], action_words) — the dialogue list is
    already in the shape estimate_dialogue_seconds eats, so the two compose.

    The format is the one generate_script asks for and every real project on disk
    uses: an ALL-CAPS character cue on its own line (optionally "(V.O.)"/"(CONT'D)"),
    then the speech until a blank line, with parentheticals on their own lines. Scene
    headings and transitions are structure, not screen time, and count as neither.
    Markdown decoration is stripped first because half the scripts on disk are written
    with **bold** cues and *italic* action.

    Validated against the breakdowns the LLM extracted from those same scripts: the
    dialogue word count matches EXACTLY on ROBOTECH (71), a test project (62), FAIL 5 (17),
    FAIL 8 (32) and Fail 6 (37)."""
    import re   # module-local, as everywhere else in this file

    # A cue is short by nature. The length bound is what keeps an all-caps ACTION or
    # title line from swallowing the paragraph under it as "dialogue"; the character
    # class still deliberately excludes the em dash, which is how every slug line and
    # title card in these scripts is punctuated (`\w` does not match it).
    #
    # `\w` and `[^\W\d_]` rather than `A-Z`, because the ASCII class made any character
    # whose name carries an accent INVISIBLE: measured 2026-08-12 on THE DIVORCE DRAMA
    # QUEEN, `TOMÁS` failed to match and all eight of his lines were counted as ACTION
    # words instead of speech, while `TOMAS` (same script, tilde removed) parsed both
    # speakers. Every JOSÉ, ANDRÉ, MÜLLER, NIÑA and O'BRIEN-with-an-accent had the same
    # hole. The docstring's five validation projects all use ASCII names, which is why
    # it never surfaced. The all-caps discrimination this class used to double as is
    # already done by the `ln.upper() == ln` test at the call site, so widening the
    # class costs nothing: a lowercase "Tomás" still cannot open a cue.
    cue = re.compile(r"^([^\W\d_][\w .'\-/]{1,38})(\([^)]*\))?:?$", re.UNICODE)
    heading = re.compile(
        r'^' + _SCENE_NUM +
        r'(INT\.|EXT\.|INT/EXT|EXT/INT|I/E\b|INT\b|EXT\b|FADE |CUT TO|SMASH CUT'
        r'|MATCH CUT|DISSOLVE|TITLE CARD|THE END|END OF)', re.I)

    def clean(ln: str) -> str:
        # Strip markdown emphasis, then whitespace.
        return ln.strip().strip("*_").strip()

    spoken: list[dict] = []
    action_words = 0
    lines = script.split("\n")
    i = 0
    while i < len(lines):
        raw = lines[i]
        ln = clean(raw)
        i += 1
        if not ln or set(ln) <= set("-—_=~"):     # blank or a rule/separator
            continue
        # A markdown title or act marker ("# FOUNDATION", "## ACT ONE") is structure,
        # not screen time. It has to be recognised BEFORE the cue test: an all-caps
        # title is shaped exactly like a character name, and Alastor 2's "# FOUNDATION"
        # was charging its two title lines below as spoken dialogue.
        if raw.lstrip().startswith("#") or heading.match(ln):
            continue
        if ln.upper() == ln and cue.match(ln) and any(c.isalpha() for c in ln):
            # A cue owns everything up to the next blank line.
            while i < len(lines):
                s = clean(lines[i])
                i += 1
                if not s:
                    break
                if s.startswith("(") and s.endswith(")"):
                    continue                       # parenthetical: a direction, not speech
                spoken.append({"text": s})
            continue
        action_words += len(ln.split())
    return spoken, action_words


def _speech_key(text: str) -> str:
    """A spoken line reduced to what makes it the SAME line. Punctuation and case are
    exactly what a rewriting model changes while keeping the line, so comparing raw text
    would report drift that nobody lost."""
    import re
    return re.sub(r"[^\w\s]", "", str(text or "")).lower().split().__str__()


def script_speaking_cast(script: str) -> list[str]:
    """The characters who SPEAK, read straight off the screenplay's cues, in order of
    first line. Deterministic — the same cue grammar split_script_speech uses, so a name
    it cannot see here is a name that costs speech time there too.

    Exists because asking the model nicely did not work: after `derive_film_bible` was
    told in as many words that "EVERY character who SPEAKS needs an entry", DRAMA QUEEN 2
    still came back with one character out of two, and invented both their names. A list
    of names is not a request the model can compress."""
    import re
    cue = re.compile(r"^([^\W\d_][\w .'\-/]{1,38})(\([^)]*\))?:?$", re.UNICODE)
    heading = re.compile(
        r'^' + _SCENE_NUM +
        r'(INT\.|EXT\.|INT/EXT|EXT/INT|I/E\b|INT\b|EXT\b|FADE |CUT TO|SMASH CUT'
        r'|MATCH CUT|DISSOLVE|TITLE CARD|THE END|END OF)', re.I)
    out: list[str] = []
    for raw in (script or "").split("\n"):
        ln = raw.strip().strip("*_").strip()
        if not ln or raw.lstrip().startswith("#") or heading.match(ln):
            continue
        if ln.upper() == ln and cue.match(ln) and any(c.isalpha() for c in ln):
            # "(CONT'D)" / "(V.O.)" are the same person speaking again.
            name = re.sub(r"\(.*\)", "", ln).strip().rstrip(":").strip()
            if name and name not in out:
                out.append(name)
    return out


def dialogue_coverage(script: str, shots: list[dict] | None) -> dict:
    """How much of the SCRIPT's dialogue actually reached the breakdown.

    Returns {script_lines, breakdown_lines, missing: [text, …], covered: bool}.

    WHY THIS EXISTS. The breakdown writer summarises. Measured on THE DIVORCE DRAMA QUEEN
    (2026-08-12): an 18-line script came back as 8 lines, losing five of each character's
    — and the loss is not random, it is the middle of every exchange, which is where an
    argument escalates. Two successive passes over the same script dropped DIFFERENT
    lines, which is the signature of a model compressing rather than extracting.

    Nothing checked. The breakdown looked complete because it WAS complete in shape:
    every shot had a `dialogue` list, and no one had counted them against the source. This
    is the same rule the rest of this codebase already follows for render slots — surface
    the per-item outcome, never present a partial set as complete.

    `split_script_speech` is the ground truth and it is deterministic, so this costs no
    tokens and cannot itself hallucinate. It is only trustworthy for character names it
    can SEE, which is why the cue class had to stop being ASCII-only first — before that
    fix this function would have reported ten of Tomás's lines as missing from a breakdown
    that had three of them.
    """
    spoken, _ = split_script_speech(script or "")
    want = [str(s.get("text") or "").strip() for s in spoken if str(s.get("text") or "").strip()]
    have: list[str] = []
    for sh in (shots or []):
        for line in (sh.get("dialogue") or []):
            t = str((line or {}).get("text") or "").strip()
            if t:
                have.append(t)
    # Multiset, not set: "I know." is said by both characters in the DRAMA QUEEN script,
    # and a set would call one of them covered by the other.
    pool: dict = {}
    for t in have:
        pool[_speech_key(t)] = pool.get(_speech_key(t), 0) + 1
    missing = []
    for t in want:
        k = _speech_key(t)
        if pool.get(k, 0) > 0:
            pool[k] -= 1
        else:
            missing.append(t)
    return {"script_lines": len(want), "breakdown_lines": len(have),
            "missing": missing, "covered": not missing}


def dialogue_invention(script: str, shots: list[dict] | None) -> dict:
    """Words the film would SPEAK that the screenplay never wrote.

    Returns {added: [word, …], dialogue_words, script_words}. `added` empty means every
    word of every spoken line is traceable to the script, in order.

    THE OTHER HALF OF dialogue_coverage, and the half that was missing. That function
    drains a pool of script lines and reports what it could not find — so a breakdown that
    DOUBLES the dialogue returns `covered: True`. Measured on DRAMA QUEEN 2: a stored
    version carries 170 spoken words against a script of 81, missing:[] — the film would
    say twice what was written, and every check called it complete. The user's rule is the
    right one: "si en el guion hay 20 líneas de diálogo, en el breakdown debería haber 20;
    nada puede ser inventado, para eso es el QC."

    WHY WORDS, AND WHY ALIGNED. Counting lines cannot express that rule without firing on
    correct work, and both failure modes are real and on disk:
      · a SPLIT — `_split_dialogue_for_duration` breaks a speech too long for one Seedance
        take across two shots, by design. Line-counting reads that as 1 lost + 2 added.
      · a MERGE — the writer joins two adjacent speeches into one line. BLOOM's SHOT_027
        and Alastor 2's SHOT_109 do exactly this: 28/28 and 27/27 of their words are the
        script's, but neither line appears in it verbatim.
    A monotonic word alignment (difflib) is immune to both: the words are the same words,
    in the same order, so nothing aligns as inserted.

    WHY IT DOES NOT USE split_script_speech. The cue reader is line-based and has measured
    holes — a lowercase parenthetical (`MOE (whispering)`) fails its all-caps test, a
    hard-wrapped screenplay yields one "line" per physical line, and a markdown treatment
    (FOUNDATION) has no cues it can see at all. Any check built on it inherits those, and a
    gate that fires on correct work teaches people to bypass gates. Aligning against the
    WHOLE script text needs no cue detection, so it works on every format in the tree. The
    cost is that it is conservative — a fabricated line assembled out of ACTION words could
    align — and conservative is the right direction for something that blocks.

    Duplication falls out for free: the alignment is monotonic, so a line repeated in the
    breakdown finds no second copy in the script and its words count as added. That is the
    honest reading — the film would say it twice.

    Measured across all 15 projects on this machine: 13 report zero. One test project reports
    `différent` (the script says "different"), FAIL 7 reports `die` (SHOT_007 carries
    "DIE!" twice). Both are real.
    """
    import difflib
    import re as _re_di

    def _words(t: str) -> list[str]:
        return _re_di.sub(r"[^\w\s]", " ", (t or "").lower()).split()

    have: list[str] = []
    for sh in (shots or []):
        for line in (sh.get("dialogue") or []):
            have.extend(_words(str((line or {}).get("text") or "")))
    src = _words(script or "")
    if not have or not src:
        # No dialogue, or no script to compare against: nothing to claim either way. An
        # empty verdict is not a passing one — the caller decides what to do with it.
        return {"added": [], "dialogue_words": len(have), "script_words": len(src)}
    sm = difflib.SequenceMatcher(None, src, have, autojunk=False)
    added: list[str] = []
    for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
        if tag in ("insert", "replace"):
            added.extend(have[j1:j2])
    return {"added": added, "dialogue_words": len(have), "script_words": len(src)}


def estimate_script_seconds(script: str) -> float:
    """How long a SCRIPT will run, in seconds — phase 1's answer to "is this the
    length I asked for?", built on the same maths phase 2 sizes its shots with.

    Replaces `len(words) / 130`, the standard page-rate rule, which assumes a
    Courier-formatted page whose action is spread over sparse lines. These scripts
    are dense prose paragraphs: measured against the breakdowns of every real project
    on disk it overstated the film by roughly a factor of two (ROBOTECH: 569s claimed,
    294s of shots).

    Dialogue is charged at speaking rate (it is performed), action at ACTION_WORDS_PER_SEC
    (it is watched). Returns 0.0 for an empty script."""
    spoken, action_words = split_script_speech(script or "")
    return estimate_dialogue_seconds(spoken) + action_words / ACTION_WORDS_PER_SEC


def clip_seconds(item: dict | None) -> float | None:
    """One shot's / segment's / timeline clip's runtime in seconds, or None when that is
    genuinely UNKNOWN.

    Reads every spelling the field has in this codebase: the generator writes
    duration_sec, the frontend normalises it to estimatedDuration, a SEGMENT's sub-shot
    carries durationSecs, and the finished cut describes a clip with a bare duration. A
    helper that knew only one of them would quietly return 0 for half the callers here.

    `durationSecs` was the missing one, and it was the spelling of the unit the UI posts
    most: a normalised segment has no duration of its own, so the sum falls through to its
    sub-shots, and every one of those reads durationSecs (lib/segments.ts SegmentShot).
    The "Footage share" gate therefore measured 0s of footage against every planned
    sequence and reported -100% across the board on a breakdown holding 86s — visible on
    DRAMA QUEEN 2, 2026-08-13. The QC's own "Segment length" check reads both spellings
    two hundred lines away, which is how the two disagreed about the same segments.

    Returns None — never a number — when no spelling is present or none of them parses.
    "No recorded duration" and "zero seconds long" are different facts, and every place
    that could not tell them apart ended up inventing 5.0 and feeding it to a gate."""
    if not isinstance(item, dict):
        return None
    for key in ("duration_sec", "estimatedDuration", "durationSecs", "duration"):
        raw = item.get(key)
        if raw in (None, ""):
            continue
        try:
            return float(raw)
        except (TypeError, ValueError):
            continue
    return None


def estimate_shots_seconds(items: list[dict] | None) -> float:
    """Σ runtime of a list of SHOTS or of SEGMENTS, so any phase can reconcile what it
    holds against the target without re-deriving the sum in place (it is currently
    written out by hand in the QC, in the segment grouper and in the server).

    Accepts either unit because a segment IS a shot list with its own agreed length:
    a segment's own duration_sec wins when present (it is the padded, post-grouping
    number that gets sent to the API), and only when it has none do we fall back to
    summing its shots — otherwise a segment list would be counted twice.

    Built on clip_seconds, which is the same rule per item; an item whose length is
    unknown contributes 0 here, so this sum is a LOWER BOUND on a list with gaps. A
    caller that has to tell "unknown" from "zero" — the final-cut gate does — must use
    clip_seconds itself rather than the sum."""
    total = 0.0
    for it in items or []:
        if not isinstance(it, dict):
            continue
        secs = clip_seconds(it) or 0.0
        if secs <= 0 and isinstance(it.get("shots"), list):
            secs = estimate_shots_seconds(it["shots"])     # a segment with no own length
        total += secs
    return total


# Seedance 2.0's documented clip range (video-seedance §1). This is the ONE place
# the ceiling is defined for breakdown-time decisions; the server clamps again at
# submit as a backstop. The breakdown used to aim for 4-12 while everything
# downstream allowed 4-15, so a 13-15s beat could never be proposed at all.
SHOT_MIN_SECS = 4
SHOT_MAX_SECS = 15

# The [4,15] range above is the range of a CALL, and a call is now a SEGMENT — one
# Seedance generation holding several shots that the model cuts internally (verified
# 2026-07-31: a prompt declaring 2s/5s/3s came back with cuts at 2.04s and 6.21s).
#
# So a shot INSIDE a segment is not bound by the 4s floor. That floor is exactly what
# made a rhythm impossible: the guide's own table wants 0.5-2s for a reaction, an eye
# flick, an insert, and every one of those was unreachable when a shot had to be its own
# render. ROBOTECH's histogram is the symptom — 5s×12, 6s×11, everything bunched in one
# gear. A shot that ends up ALONE in its segment still has to satisfy the 4s call floor.
SHOT_MIN_IN_SEGMENT = 0.5
SEGMENT_MIN_SECS = 4
SEGMENT_MAX_SECS = 15

# Duration by dramatic FUNCTION, from the ByteDance guide §5. Used to sanity-check what
# the model proposes: the point is not that a given shot is wrong, it is that a film
# whose shots all fall in one band has one gear.
DURATION_BANDS = (
    (0.5, 2.0, "reaction / eye movement / insert / prop hit"),
    (3.0, 5.0, "a normal action, start to finish"),
    (5.0, 8.0, "interaction, light dialogue, spatial relationships"),
    (8.0, 12.0, "a complete action, an explanation, an emotional beat that lingers"),
    (12.0, 15.0, "dialogue-driven scene or complex blocking"),
)


# Shot sizes, widest to tightest. Classified from the breakdown's free-text camera
# field — there is no structured shotSize yet, and the vocabulary the LLM actually
# uses is narrow enough to read reliably. Order matters: `_shot_size` returns the
# FIRST match, so the more specific phrases have to come before the looser ones
# ("extreme close" before "close", "medium close" before "medium").
_SHOT_SIZES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("XCU", ("extreme close", "ecu", "macro", "insert", "detail")),
    ("MCU", ("medium close", "mcu", "bust")),
    ("MLS", ("medium long", "cowboy", "three-quarter", "mls")),
    ("CU",  ("close-up", "close up", "closeup", "cu ", "head shot", "headshot")),
    ("XLS", ("extreme wide", "extreme long", "establishing", "aerial", "vista", "xls", "ews")),
    ("MS",  ("medium", "mid shot", "waist", "two-shot", "two shot", "ms ")),
    ("LS",  ("long shot", "full shot", "full body", "wide", "ws ", "ls ")),
)


def _shot_size(camera: str) -> str:
    """Bucket a free-text camera note into a shot size, or '?' when it says nothing."""
    c = f" {(camera or '').lower().strip()} "
    for size, needles in _SHOT_SIZES:
        if any(n in c for n in needles):
            return size
    return "?"


def analyze_coverage(shots: list[dict], max_run: int = 3) -> list[dict]:
    """Deterministic coverage findings over a scene's shot list.

    Two things a viewer reads as "made by a machine" long before they can say why,
    and both are arithmetic rather than opinion — so they belong in code, not in an
    LLM verdict that is advisory by design:

      1. SIZE MONOTONY. Cutting between shots of the same size reads as coverage that
         was never planned. Three in a row is the point where it stops looking like a
         choice. (A run of identical sizes is also exactly what a flat shot list
         produces when nothing decided the coverage.)
      2. RHYTHM. If every shot in a scene is the same length, the cut has no pulse.
         That is the signature of deriving duration from target/shot_count instead of
         from the drama, which is how this pipeline used to size every shot.

    Returns [] when the shots are fine, so an empty list means "nothing to say".
    """
    findings: list[dict] = []
    if len(shots) < 3:
        return findings                      # too short for either claim to mean anything

    sizes = [(s.get("id") or "?", _shot_size(s.get("camera") or s.get("cameraAngle") or "")) for s in shots]
    known = [(sid, sz) for sid, sz in sizes if sz != "?"]

    # 1. Runs of the same size.
    run_start, run_size, run = 0, None, 0
    for i, (sid, sz) in enumerate(known + [("", None)]):
        if sz == run_size:
            run += 1
            continue
        if run_size is not None and run >= max_run:
            ids = [x[0] for x in known[run_start:run_start + run]]
            findings.append({
                "kind": "size_monotony", "size": run_size, "shots": ids,
                "detail": f"{run} consecutive {run_size} shots ({', '.join(ids[:5])}) — "
                          "vary the size or the cut reads as unplanned coverage.",
            })
        run_start, run_size, run = i, sz, 1

    # 2. No rhythm: every duration effectively identical.
    durs = [float(s.get("duration_sec") or 0) for s in shots]
    durs = [d for d in durs if d > 0]
    if len(durs) >= 3 and max(durs) - min(durs) < 1.0:
        findings.append({
            "kind": "flat_rhythm", "shots": [s.get("id") for s in shots],
            "detail": f"every shot is {durs[0]:.0f}s — the cut has no pulse; "
                      "let tension set the length (dialogue 6-12s, action 3-5s).",
        })

    # 3. Nothing said about framing at all.
    if len(known) < len(sizes) / 2:
        findings.append({
            "kind": "unspecified_framing",
            "shots": [sid for sid, sz in sizes if sz == "?"][:8],
            "detail": f"{len(sizes) - len(known)} of {len(sizes)} shots name no shot size — "
                      "framing is being left to the render to invent.",
        })
    return findings


def _scene_target(target_secs: int, shot_estimate: int) -> tuple[int, int]:
    """How many SCENES a cut of this length should have.

    Scene count was derived from shot count (shots/4 to shots/2), which is fine for a
    90-second short and absurd for an episode: 45 minutes came out as 150-300 "scenes"
    for ~600 shots. A real 45-minute TV episode has roughly 30-45 — a scene is a unit
    of dramatic action, not a bucket of shots, and asking for 200 of them produced a
    script of disconnected fragments with no room for any of them to develop.

    Above short-film length the count therefore comes from RUNTIME: a scene runs about
    a minute and a half on average. Below it, the old shot-derived range is kept so
    existing short projects generate exactly as they did before.
    """
    if target_secs <= 180:                     # shorts: unchanged behaviour
        lo = max(2, round(shot_estimate / 4))
        return lo, max(lo + 1, round(shot_estimate / 2))
    mins = target_secs / 60.0
    lo = max(3, round(mins / 1.5))             # ~90s per scene at the slow end
    hi = max(lo + 2, round(mins / 1.0))        # ~60s per scene at the brisk end
    return lo, hi                              # 45 min → 30-45, matching TV drama


def _split_dialogue_for_duration(dialogue: list[dict], max_secs: int = SHOT_MAX_SECS) -> list[list[dict]]:
    """Group a shot's dialogue into chunks that can each be SPOKEN in max_secs.

    Returns one list per resulting shot, in order. A single chunk comes back when
    the dialogue already fits — the overwhelmingly common case, so nothing changes
    for ordinary shots.

    A line too long to fit on its own is split on sentence boundaries, and only if
    a single sentence still doesn't fit is it broken on word count. Splitting mid
    sentence is a last resort because it puts a cut in the middle of a clause.
    """
    import re   # module-local, as everywhere else in this file

    def dur(lines: list[dict]) -> float:
        return _estimate_dialogue_seconds(lines)

    # Break one over-long line into speakable pieces, keeping speaker attribution.
    def explode(line: dict) -> list[dict]:
        text = (line.get("text") or "").strip()
        if not text or dur([line]) <= max_secs:
            return [line]
        parts, buf = [], []
        for sentence in re.split(r"(?<=[.!?…])\s+", text):
            if not sentence:
                continue
            trial = " ".join(buf + [sentence])
            if buf and dur([{**line, "text": trial}]) > max_secs:
                parts.append({**line, "text": " ".join(buf)})
                buf = [sentence]
            else:
                buf.append(sentence)
        if buf:
            parts.append({**line, "text": " ".join(buf)})
        # A single sentence longer than the ceiling — break on words rather than
        # let it be silently clipped at render time.
        out: list[dict] = []
        for p in parts:
            if dur([p]) <= max_secs:
                out.append(p)
                continue
            words = (p.get("text") or "").split()
            # 2 words/sec with the per-line beat already counted in the estimate.
            per = max(1, int((max_secs - 1.4) * 2))
            for i in range(0, len(words), per):
                out.append({**p, "text": " ".join(words[i:i + per])})
        return out or [line]

    flat: list[dict] = []
    for line in dialogue or []:
        if (line.get("text") or "").strip():
            flat.extend(explode(line))

    chunks: list[list[dict]] = []
    cur: list[dict] = []
    for line in flat:
        if cur and dur(cur + [line]) > max_secs:
            chunks.append(cur)
            cur = [line]
        else:
            cur.append(line)
    if cur:
        chunks.append(cur)
    return chunks or [[]]


def _size_and_split_shots(shots: list[dict]) -> tuple[list[dict], int]:
    """Give every shot a duration its dialogue can actually be spoken in, splitting
    shots whose dialogue exceeds the ceiling. Returns (shots, split_count).

    This replaces a clamp that silently LOST dialogue: a 40-word speech estimates at
    ~21s, was clamped to 15s, and the tail simply never made it into the take — the
    line was cut off mid-sentence in the finished episode with nothing reporting it.
    Splitting is also the better coverage: an unbroken 21-second take of one person
    talking is a shot a director would have cut anyway.

    Split parts keep the original id with a _2, _3 suffix. Base ids are SHOT_%03d
    with no suffix, so these cannot collide with a generated id.
    """
    import math as _math   # module-local, as everywhere else in this file

    # How many shots share each segment label. A shot that is ALONE in its segment is
    # its own Seedance call and still has to clear the 4s API floor; one that shares a
    # segment does not, and that is the whole point — it is where a 1.5s insert lives.
    grouped: dict[str, int] = {}
    for s in shots:
        key = str(s.get("segment") or "")
        if key:
            grouped[key] = grouped.get(key, 0) + 1

    def _floor(shot: dict) -> float:
        key = str(shot.get("segment") or "")
        return SHOT_MIN_IN_SEGMENT if grouped.get(key, 0) > 1 else float(SHOT_MIN_SECS)

    out: list[dict] = []
    splits = 0
    for shot in shots:
        lo = _floor(shot)
        spoken = _estimate_dialogue_seconds(shot.get("dialogue"))
        if spoken <= 0:
            # No dialogue — keep whatever the director asked for, inside the range.
            # Rounded to 0.5s rather than up to a whole second: a beat asked for as 1.5s
            # must not silently become 2s, because those halves are the rhythm.
            cur = float(shot.get("duration_sec") or 5)
            shot["duration_sec"] = max(lo, min(SHOT_MAX_SECS, round(cur * 2) / 2))
            out.append(shot)
            continue
        if spoken <= SHOT_MAX_SECS:
            cur = float(shot.get("duration_sec") or 5)
            shot["duration_sec"] = max(lo, min(SHOT_MAX_SECS,
                                              round(max(cur, spoken) * 2) / 2))
            out.append(shot)
            continue

        chunks = _split_dialogue_for_duration(shot.get("dialogue") or [])
        splits += len(chunks) - 1
        base_id = shot.get("id") or "SHOT"
        for i, chunk in enumerate(chunks):
            part = {**shot, "dialogue": chunk}
            # The scene prompt was written for the WHOLE shot's dialogue, so an inherited
            # copy would make this part speak the lines that just moved to another part —
            # and the numbered beats would out-run the lines that are left. Dropping it
            # puts every part back on the per-line path, which is exactly what a shot
            # without a scene prompt has always done.
            part.pop("dialogue_scene", None)
            if i:
                part["id"] = f"{base_id}_{i + 1}"
                # A split part is a NEW shot. Leaving it on the parent's segment label
                # would push that segment past 15s, and the split exists precisely
                # because the speech did not fit in one take.
                part["segment"] = f"{shot.get('segment') or base_id}_{i + 1}"
            secs = _estimate_dialogue_seconds(chunk)
            part["duration_sec"] = max(float(SHOT_MIN_SECS),
                                       min(SHOT_MAX_SECS, round(secs * 2) / 2 or float(SHOT_MIN_SECS)))
            out.append(part)
    return out, splits


#: Estados que el ambiente RESUELVE, y lo que los resuelve. Un plano interior con fuego
#: no puede tener a nadie con hielo en el pelo — el usuario lo vio en FARO antes que
#: ninguna comprobación, porque no había ninguna.
_TRANSITORIOS = ("frozen", "ice in", "icy", "frost", "frosted", "soaked", "drenched",
                 "dripping wet", "sopping", "blue lips", "shivering", "snow on",
                 "snow-covered", "teeth chattering")
_CALOR = ("fire", "stove", "hearth", "fireplace", "flame", "brazier", "furnace",
          "radiator", "heater", "burning", "embers")


#: Lo que convierte una mención en una NEGACIÓN. Sin esto, "no longer shivering" y
#: "shivering stopped" —que es exactamente lo que se le pidió al modelo escribir— se leen
#: como el defecto que buscan. Disparó en 26 de 40 planos correctos.
_NIEGA_ANTES = ("no longer", "not ", "never ", "stopped", "once ", "previously ",
                "已", "已经")
_NIEGA_DESPUES = ("stopped", "gone", "dried", "over", "no more", "subsided", "eased")


def _delta_de_estado(desc: str) -> str:
    """Solo lo que este estado AÑADE.

    La descripción de un estado arrastra delante la del personaje base, y esa base puede
    decir "shipwreck soaked clothing" para siempre: al mirarla entera, hasta el estado
    "Dawn after the storm — hair fully dry" contenía la palabra "soaked" y fallaba.
    """
    d = (desc or "").lower()
    for marca in ("wardrobe for this variant:", "state for this variant:", "; wardrobe:"):
        if marca in d:
            return d.split(marca, 1)[1]
    return d


def _transitorio_vivo(desc: str) -> str:
    """El primer estado transitorio que NO está negado, o cadena vacía."""
    d = _delta_de_estado(desc)
    for w in _TRANSITORIOS:
        i = 0
        while (i := d.find(w, i)) != -1:
            antes = d[max(0, i - 26):i]
            despues = d[i + len(w):i + len(w) + 26]
            negado = (any(n in antes for n in _NIEGA_ANTES)
                      or any(n in despues for n in _NIEGA_DESPUES))
            if not negado:
                return w
            i += len(w)
    return ""


def check_state_physics(shots: list[dict], assets: list[dict]) -> list[dict]:
    """¿Alguien sigue congelado junto a una estufa encendida?

    Comprobación determinista de la única regla de continuidad física que se puede leer
    del texto: un estado TRANSITORIO (empapado, hielo, labios azules) no sobrevive a un
    interior con fuente de calor. Es el error que el usuario encontró mirando FARO —
    Mara con escarcha en el pelo, dentro del faro, a treinta centímetros de la estufa.

    Devuelve una lista de checks; vacía si no hay personajes con estado.
    """
    estados = {a.get("id"): (a.get("name", ""), (a.get("visual_description") or "").lower())
               for a in (assets or []) if a.get("parentCharacterId")}
    if not estados:
        return []
    malos: list[str] = []
    for sh in (shots or []):
        escena = f"{sh.get('scene','')} {sh.get('action','')} {sh.get('visual_description','')} {sh.get('lighting','')}".lower()
        interior = escena.strip().startswith("int.") or " int. " in escena
        calor = any(w in escena for w in _CALOR)
        if not (interior and calor):
            continue
        for aid in (sh.get("assets_used") or []):
            if aid not in estados:
                continue
            nombre, desc = estados[aid]
            hit = _transitorio_vivo(desc)
            if hit:
                malos.append(f"{sh.get('id')}: {nombre} sigue '{hit}' junto al fuego")
    return [{
        "label": "State physics", "passed": not malos, "blocking": False,
        "notes": ("no transient state survives a heated interior."
                  if not malos else
                  f"{len(malos)} shot(s) keep a transient state indoors by a heat source — "
                  f"ice does not survive a lit stove: {'; '.join(malos[:4])}"),
    }]


#: LEGACY-ONLY prose heuristic for "the beat SHOWS the move". Kept so a board written
#: before `crossing` existed is judged exactly as it was judged before, and for NO other
#: reason: it reads scenery as choreography. Measured over 90 beats of BLOOM SC-002+SC-011
#: (2026-08-05), 15 beats were forgiven by it and 8 of those 15 matched on the word "exit"
#: used as a NOUN — "faint gym exit lights glow 18m deep in background", "distant gym exit
#: doors glow warm behind him". A figure who teleports across frame in a beat that happens
#: to mention an exit sign is waved through. That is why the intent is now DECLARED by the
#: beat writer (`crossing`) instead of inferred from its prose.
_CRUCE_VISIBLE = r"\b(cross\w*|exit\w*|leav\w*|enter\w*|swap\w*|switch\w*|pass\w*|past)\b"


def panel_fov(beat: dict) -> str:
    """The FOV degrees a board panel committed to ("Neutral medium shot, 47° FOV." → "47°"),
    or "" when the panel names none.

    Only the NUMBER is lifted: the size words in the same field restate what the shot
    already declares. Measured on BLOOM's 148 panels, 132 of the 163 degree-values a board
    carries live in `shot_type` — and until 2026-08-07 neither of the two direction writers
    below put that field in front of the model. Measured at the request boundary on the 17
    BLOOM cards that take the direction template: 0 of 82 panel FOV values reached either
    writer's user message (Kelvin did, 27/27, because it rides in `orange`). The whole
    point of _SEEDANCE_UNITS is the degrees, and the degrees were the part being dropped.
    """
    import re   # module-local, as everywhere else in this file
    m = re.search(r"(\d{1,3}(?:\.\d+)?)\s*°", str(beat.get("shot_type") or ""))
    return f"{m.group(1)}°" if m else ""


def _parse_screen_side(raw: Any) -> dict[str, tuple[str, str]]:
    """'Tomás:left, Nuria:right' → {'tomas': ('left', 'Tomás'), 'nuria': ('right', 'Nuria')}.

    Key for comparing, name for the note the director reads. Tolerant on purpose: the
    separator may be , ; or |, the side may be written 'left' / 'screen-left' /
    'frame left' / 'L', and the accent on Tomás is folded into the KEY so 'Tomás' in beat
    A and 'Tomas' in beat B are the SAME person (they are, and a gate that misses that
    reports nothing). Anything unreadable ('offscreen', 'back to camera', empty) is
    dropped as NOT DECLARED — never as a violation.
    """
    import re
    import unicodedata
    out: dict[str, tuple[str, str]] = {}
    for item in re.split(r"[,;|\n]", str(raw or "")):
        if ":" not in item:
            continue
        name, _, side = item.rpartition(":")
        key = _norm_name(name)
        key = "".join(c for c in unicodedata.normalize("NFKD", key)
                      if not unicodedata.combining(c)).strip()
        if not key:
            continue
        s = side.strip().lower()
        izq, der = "left" in s, "right" in s
        if izq and not der:
            out[key] = ("left", name.strip())
        elif der and not izq:
            out[key] = ("right", name.strip())
        elif "cent" in s or "middle" in s:
            out[key] = ("centre", name.strip())
        elif s in ("l",):
            out[key] = ("left", name.strip())
        elif s in ("r",):
            out[key] = ("right", name.strip())
    return out


def _split_sides(raw: str) -> list[str]:
    """Trocea "A:left of frame, on the window side of the bed; B:right of frame, door side"
    sin partir por la coma que separa el lado del CUADRO del lado del MUEBLE."""
    import re
    return [x for x in re.split(r"[;,](?=[^|]*(?::|$))", str(raw or "")) if x.strip()]


def carry_anchored(prev: str, beats: list[dict]) -> str:
    """Where each person stands IN THE ROOM, for the next board of the same scene.

    Sibling of carry_screen_side and deliberately NOT the same thing: that one records the
    side of the FRAME and normalises whatever it is given down to left/right/centre, so an
    anchor written as "left of the bed" reaches the next board as "left" and the bed is
    gone. This one is prose and is merged verbatim, because the bed is the whole point.

    Same merge semantics as its sibling: a person who sits out a shot keeps their anchor,
    and a shot that declares nothing leaves the carry untouched — "" in and no declarations
    out means the next prompt is byte-identical to what it was before this existed.
    """
    merged: dict[str, str] = {}
    for item in str(prev or "").split(";"):
        if ":" in item:
            k, _, v = item.partition(":")
            if k.strip():
                merged[_norm_name(k)] = f"{k.strip()}:{v.strip()}"
    for b in (beats or []):
        if not isinstance(b, dict):
            continue
        # `anchored` es el campo dedicado; `screen_side` es el que el escritor SÍ rellena
        # siempre, y desde ahora lleva el mueble después de la coma. Se lee el primero que
        # traiga algo: medido en BLACKMIRROR 4, 0 de 15 viñetas devolvieron `anchored` y
        # 15 de 15 devolvieron `screen_side`.
        raw = str(b.get("anchored") or "").strip() or str(b.get("screen_side") or "")
        for item in raw.replace(",", ";").split(";") if b.get("anchored") else _split_sides(raw):
            if ":" in item:
                k, _, v = item.partition(":")
                if k.strip() and v.strip():
                    merged[_norm_name(k)] = f"{k.strip()}:{v.strip()}"
    return "; ".join(merged.values())


def anchor_conflicts(prev: str, beats: list[dict]) -> list[str]:
    """Who changed which side of the furniture between one board and the next.

    check_screen_direction reads the panels INSIDE one board, which is why a scene could
    mirror wholesale at a board boundary and both boards pass: BLACKMIRROR 4 drew Michael
    on the right of the bed in SHOT_004 and on the left in SHOT_008, and each page was
    internally consistent. This reads the carried blocking against what the new board
    declares, per person.

    Deliberately crude and one-directional: it only fires on a left/right or near/far
    REVERSAL of the same person, which is the failure that shows on screen. Anything it
    cannot read is not a violation — a gate that guesses is a gate nobody trusts.
    """
    def _sides(txt: str) -> set[str]:
        # SÓLO LA MITAD DEL MUEBLE. `screen_side` viaja ahora como "left of frame, on the
        # window side of the bed": la primera mitad es el CUADRO y puede reflejarse en un
        # contraplano legítimamente, así que compararla da falsos positivos — se vio como
        # "was left, right and this board puts them left, right", que no informa de nada.
        # Lo que no puede cambiar es lo que va después de la primera coma.
        t = str(txt or "").lower()
        # La coma separa ENTRADAS, no mitades — el escritor la usa así y por eso la
        # primera versión de esto comparaba la entrada de un personaje con la del
        # siguiente y devolvía "was left, right and this board puts them left, right".
        # La barra separa el cuadro del mueble, y sólo el mueble se compara.
        if "|" not in t:
            return set()          # sin ancla de mueble no hay nada que comparar
        return {w for w in ("left", "right", "near", "far") if w in t.split("|", 1)[1]}

    before: dict[str, tuple[str, set[str]]] = {}
    for item in _split_sides(prev):
        if ":" in item:
            k, _, v = item.partition(":")
            if k.strip():
                before[_norm_name(k)] = (k.strip(), _sides(v))
    out: list[str] = []
    for b in (beats or []):
        if not isinstance(b, dict):
            continue
        # Mismo respaldo que carry_anchored: el escritor rellena `screen_side` siempre y
        # `anchored` casi nunca, y desde ahora el mueble va dentro del primero.
        raw = str(b.get("anchored") or "").strip() or str(b.get("screen_side") or "")
        for item in _split_sides(raw):
            if ":" not in item:
                continue
            k, _, v = item.partition(":")
            key = _norm_name(k)
            if key not in before:
                continue
            name, old = before[key]
            new = _sides(v)
            # Un giro es "left" que pasa a "right" (o near/far), no la simple ausencia:
            # un plano puede no mencionar el lado y eso no es una violación.
            for pair in (("left", "right"), ("near", "far")):
                if pair[0] in old and pair[1] in new or pair[1] in old and pair[0] in new:
                    msg = (f"{name} was {', '.join(sorted(old))} and this board puts them "
                           f"{', '.join(sorted(new))}")
                    if msg not in out:
                        out.append(msg)
    return out


def carry_screen_side(prev: str, beats: list[dict]) -> str:
    """The axis a shot LEAVES BEHIND, for the next shot of the same scene to inherit.

    `prev` (the axis coming in) updated by every side the beats of this shot declare, in
    order — a MERGE, not a replacement, because a character can sit out a shot and still
    be on their side when the scene cuts back to them. BLOOM SC-011 is the case: the board
    holding SHOT_028 also holds SHOT_029, a Tomás-only insert, so its LAST beats can name
    Tomás and not Beni. Replacing the carry with the last beat's declaration would drop
    Beni entirely and the next board would again be written blind — which is exactly the
    flip this is here to stop (Beni left → right in 4 of 5 baseline runs, 2026-08-05).

    Returns the same "Name:side, Name:side" spelling the beat writer emits, so it goes
    straight back into the next shot's prompt. "" in, no beats declaring → "" out, and the
    next prompt is byte-identical to what it was before this existed.
    """
    merged: dict[str, tuple[str, str]] = dict(_parse_screen_side(prev))
    for b in (beats or []):
        if not isinstance(b, dict):
            continue
        merged.update(_parse_screen_side(b.get("screen_side")))
    return ", ".join(f"{nombre}:{lado}" for lado, nombre in
                     ((v[0], v[1]) for v in merged.values()))


def _beat_crossing(b: dict) -> bool:
    """Did THIS beat DECLARE that the figures exchange sides in frame?

    The beat writer fills `crossing` (a boolean field of the skeleton, so it is present on
    every beat it writes). A beat that has no such key predates the field — a board saved
    to disk before 2026-08-05, replayed through QC — and only THOSE fall back to the prose
    regex, so their verdict is exactly the verdict they got before. New boards are judged
    on what they declared, never on whether the word "exit" appears in the scenery.
    """
    if "crossing" in b:
        return _as_bool(b.get("crossing"))
    import re
    return bool(re.search(_CRUCE_VISIBLE, f"{b.get('desc', '')} {b.get('red', '')}", re.I))


def _beat_declares_crossing(b: dict) -> bool:
    """Did this beat EXPLICITLY set `crossing`: true — as opposed to merely reading like a
    crossing to the legacy prose regex?

    Two different questions, and they license two different things. `_beat_crossing(b)`
    answers "may a side flip land ON this beat"; this one answers "may a side flip land on
    the beat AFTER this one", because a pass that happens DURING beat A is only visible as
    swapped sides in beat B.

    Only the explicit key counts here, and that is deliberate: a pre-2026-08-05 board has
    no `crossing` key on any beat, so this is False everywhere on it and its verdict stays
    exactly the verdict it got before the forward licence existed. The prose regex is not
    trustworthy enough to hand a licence to a beat it was never asked about — it already
    forgives "gym exit lights" 8 times in 90 BLOOM beats when asked about the beat itself.
    """
    return "crossing" in b and _as_bool(b.get("crossing"))


def check_screen_direction(panels: list[dict]) -> list[dict]:
    """¿Cada personaje sigue en su lado del eje dentro del MISMO plano? (regla de 180°)

    The beats of one shot are ONE continuous action drawn as N panels, so the geometry
    the first beat establishes is the geometry every later beat has to keep. Nothing
    enforced that: the beat prompt asked for a DIRECTION per beat and the beats were
    written independently, so BLOOM's SHOT_004 ("Tomás walks across the lot, Nuria passes
    him") put Tomás screen-left in beat A and screen-right in beat B — two incompatible
    geometries of one continuous walk — and SHOT_055 moved Clara to the far side of the
    table between beat B and beat C with nothing on screen to show the move.

    Deterministic, because it reads what each beat DECLARES (`screen_side`, written by
    the beat writer) instead of asking an LLM to eyeball prose. Measured on the boards on
    disk (2026-08-04): 488 beats across 165 board versions, 0 of them declaring a side —
    nothing was checkable, which is exactly why nothing was ever caught.

    A CROSSING IS NOT AN AXIS BREAK. Two people who walk past each other in a locked-off
    frame DO exchange sides, and that is the action, not a defect — BLOOM SHOT_004 ("Tomás
    walks slowly across the lot… Nuria passes him without slowing") swaps them on purpose.
    Which of the two happened is not recoverable from prose, so the beat writer DECLARES it
    (`crossing`) and this reads the declaration: sides flip + crossing declared = the
    action; sides flip + crossing NOT declared = the figure teleported between two panels
    of one continuous shot. Beats with no `crossing` key at all are pre-2026-08-05 boards
    and keep the old prose heuristic (see _beat_crossing).

    THE DECLARATION SITS ON THE BEAT WHERE THE PASS HAPPENS, AND THE FLIP APPEARS ON THE
    NEXT ONE. That is not a subtlety, it is what the writer actually does: measured on
    BLOOM SHOT_004 ("Tomás walks slowly across the lot… Nuria passes him without slowing"),
    6 runs of 2026-08-05, ALL 6 put `crossing: true` on beat A — the beat during which they
    pass — and beat A still shows them on their ORIGINAL sides, because that is where the
    beat starts. The swap is first visible in beat B, which correctly declares no crossing
    of its own. Reading the licence off beat B alone failed 4 of those 6 correct boards
    ("Nuria was right in SHOT_004-A, now left"), and the other 2 passed by accident (one
    wrote an unparseable "right→left", one simply did not move her). So a flip between two
    beats is licensed by a crossing declared on EITHER end of that gap. The licence is
    consumed by the very next beat that declares a side — beat A's crossing explains B, and
    nothing further.

    Returns [] when NO beat declares a side, so a board written before `screen_side`
    existed produces byte-identical QC output to today. Compares each character against
    the previous beat of the SAME shot that declared them; 'centre' is on the axis, not a
    side, so it neither breaks nor re-establishes anything.
    """
    import re
    by_shot: dict[str, list[dict]] = {}
    for p in (panels or []):
        if not isinstance(p, dict):
            continue
        label = str(p.get("label") or "")
        # SHOT_004-A … -H → SHOT_004, the same beat-letter strip server._panel_shot_id does.
        by_shot.setdefault(re.sub(r"-[A-Z]$", "", label), []).append(p)

    declarados = 0
    saltos: list[str] = []
    for _sid, beats in by_shot.items():
        # personaje → (lado, beat que lo fijó, ¿ese beat declaró el cruce?). El tercer
        # campo es la LICENCIA HACIA ADELANTE: el paso ocurre DURANTE el beat que lo
        # declara y sólo se ve como lados intercambiados en el siguiente.
        lado: dict[str, tuple[str, str, bool]] = {}
        for b in beats:
            sides = _parse_screen_side(b.get("screen_side"))
            if not sides:
                continue
            declarados += 1
            visible = _beat_crossing(b)                  # licencia sobre ESTE beat
            declara = _beat_declares_crossing(b)         # licencia sobre el SIGUIENTE
            for quien, (s, nombre) in sides.items():
                if s == "centre":
                    continue
                previo = lado.get(quien)
                # `previo[2]` es False en todo board anterior a `crossing` (la clave no
                # existe), así que su veredicto es idéntico al de antes de esta línea.
                if previo and previo[0] != s and not visible and not previo[2]:
                    saltos.append(f"{b.get('label')}: {nombre} was {previo[0]} in "
                                  f"{previo[1]}, now {s}")
                lado[quien] = (s, b.get("label"), declara)  # siempre, para no repetir el salto
    if not declarados:
        return []
    return [{
        "label": "Screen direction", "passed": not saltos, "blocking": False,
        "notes": (f"{declarados} beat(s) declare a screen side; nobody crosses the axis "
                  f"inside a shot."
                  if not saltos else
                  f"{len(saltos)} axis break(s) — a character changes side between beats of "
                  f"the SAME shot without that beat declaring crossing=true (an in-frame "
                  f"pass is allowed; a silent swap is not): "
                  + "; ".join(saltos[:4])),
    }]


# ── El estado que un beat DEJA ATRÁS: objetos y vestuario ────────────────────
#
# Mismo defecto que el eje de pantalla, distinto eje: un beat se escribe CIEGO a lo que
# el anterior dejó puesto. Medido en el QC de storyboard de BLOOM (24 escenas,
# 2026-08-05): de 6 fallos, 5 son esto —
#   · SHOT_055 "Clara sets a ceramic plate down gently on the wooden table": beat A lo
#     lleva, beat B lo apoya, beat C la mesa está VACÍA.
#   · SC-015 "Nuria has loose untied hair in SHOT_040-A but a tied bun in all subsequent
#     panels with no on-screen transition shown."
#   · SC-021 "Old Agronomist work overalls disappear across all SHOT_062_2 panels, then
#     reappear unannounced in SHOT_063."
#   · SC-012 "lantern positions, left wall window, stair block sides and sample case
#     submersion level all changed across panels with no on-screen action justification."
# Los cuatro son el mismo hecho: nada transporta "qué hay dónde" ni "cómo va vestido
# quién" de un beat al siguiente, ni dentro de un board ni entre boards de una escena.

#: El objeto DEJÓ DE EXISTIR en la escena. Separado de "no entra en este encuadre"
#: a propósito: un corte que excluye un plato NO es un fallo de continuidad; un plato
#: que se evapora sí. Confundirlos convierte cada plano corto en una falsa alarma.
_ESTADO_IDO = (r"\b(gone|removed|taken away|taken|cleared|emptied|discarded|absent|"
               r"none|nothing|nowhere|no longer)\b")
#: "No cabe en este encuadre" — un hecho de framing, nunca una infracción. El hueco entre
#: "out of" y "frame" admite adjetivos porque el escritor los mete: 1 de 5 escenas SC-021
#: correctas (2026-08-05) se suspendía sólo por escribir "out of close frame" en vez de
#: "out of frame", que es la MISMA afirmación sobre el encuadre.
_ESTADO_FUERA = (r"(out of (\w+ ){0,2}(frame|shot|view)|off ?-? ?screen|offscreen|"
                 r"not visible|behind camera|obscured|hidden)")
#: Lo lleva una persona: si el personaje sale del plano, el objeto sale con él, así que
#: omitirlo después no es que se haya evaporado.
_ESTADO_LLEVADO = (r"\b(hands?|held|holding|carr\w+|arms?|grip\w*|pocket|lap|clutch\w*|"
                   r"cradl\w*|fingers?)\b")
#: Está PUESTO en el decorado. Éste es el único estado del que "no lo menciono" equivale
#: a "desapareció": el atrezzo no se va andando solo.
_ESTADO_PUESTO = (r"\b(on|onto|atop|against|beside|under|underneath|over|next to|by|"
                  r"leaning|resting|propped|table|floor|ground|counter|shelf|wall|rail|"
                  r"bank|surface|bed|step|sill|ledge|rack|hook)\b")

#: ANATOMÍA — un trozo de una figura, nunca una prenda. Sale de lo que el escritor
#: realmente escribió en las 10 escenas de SC-021 medidas el 2026-08-05 ("Tomás Arroyo
#: both hands:...", "tomas torso:...", "tomás both feet:..."): describe una POSTURA, y una
#: postura cambia en cada beat porque eso es la acción. Las prendas de verdad (overalls,
#: boots, hair, coat, hat, gloves, apron) NO están aquí y se siguen vigilando.
_ANATOMIA = {"hand", "hands", "foot", "feet", "arm", "arms", "leg", "legs", "head",
             "torso", "chest", "back", "shoulder", "shoulders", "knee", "knees",
             "elbow", "elbows", "finger", "fingers", "fist", "fists", "chin", "jaw",
             "face", "eyes", "gaze", "hip", "hips", "wrist", "wrists", "weight",
             "stance", "posture", "pose", "body", "grip", "palm", "palms"}

#: Palabras que no distinguen dos estados: "on the wooden table" y "on wooden table" son
#: el mismo sitio. Se quitan ANTES de comparar para que una reescritura inocente no se
#: reporte como un movimiento.
_ESTADO_VACIAS = {"the", "a", "an", "of", "its", "his", "her", "their", "is", "are",
                  "and", "to", "at", "in", "on", "still", "now"}


def _norm_estado(v: str) -> frozenset[str]:
    """El valor de un estado como conjunto de palabras significativas, para comparar.

    Comparar cadenas crudas convierte "on the wooden table" → "on wooden table" en un
    movimiento del plato, que no lo es. Comparar conjuntos con tolerancia de subconjunto
    (ver _mismo_estado) perdona el adjetivo que sobra o falta y NO perdona
    "left wall bracket" → "right wall bracket", que es exactamente el fallo de SC-012.
    """
    import re
    import unicodedata
    t = unicodedata.normalize("NFKD", str(v or "").lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return frozenset(w for w in re.split(r"[^a-z0-9]+", t) if w and w not in _ESTADO_VACIAS)


def _mismo_estado(a: str, b: str) -> bool:
    """¿Describen a y b el MISMO estado? Igualdad de palabras significativas, o que uno
    sea subconjunto del otro ("on the table" ⊆ "on the wooden table": la mesa no se ha
    movido, sólo se ha descrito con más detalle). Dos conjuntos que se cruzan a medias
    ("left wall" vs "right wall") NO son el mismo estado."""
    x, y = _norm_estado(a), _norm_estado(b)
    if not x or not y:
        return x == y
    return x == y or x <= y or y <= x


def _estado_tipo(v: str) -> str:
    """ido / fuera / llevado / puesto / otro. El orden importa: 'resting in her hands'
    es LLEVADO aunque contenga 'resting', y 'gone from the table' es IDO aunque contenga
    'table'."""
    import re
    s = str(v or "").strip().lower()
    if not s:
        return "otro"
    if re.search(_ESTADO_FUERA, s):
        return "fuera"
    if re.search(_ESTADO_IDO, s):
        return "ido"
    if re.search(_ESTADO_LLEVADO, s):
        return "llevado"
    if re.search(_ESTADO_PUESTO, s):
        return "puesto"
    return "otro"


def _parse_leaves_behind(raw: Any) -> dict[str, tuple[str, str]]:
    """'plate:on the wooden table, Nuria hair:tied bun' →
    {'plate': ('on the wooden table', 'plate'), 'nuria hair': ('tied bun', 'Nuria hair')}.

    Clave normalizada para comparar, clave original para la nota que lee el director.
    Misma tolerancia que _parse_screen_side y por la misma razón: el separador puede ser
    , ; | o salto de línea, y el acento se pliega en la CLAVE para que "Tomás jacket" y
    "Tomas jacket" sean la misma prenda. Una entrada sin ':' o sin valor se descarta como
    NO DECLARADA — nunca como infracción.
    """
    import re
    import unicodedata
    out: dict[str, tuple[str, str]] = {}
    for item in re.split(r"[,;|\n]", str(raw or "")):
        if ":" not in item:
            continue
        name, _, val = item.partition(":")   # partition, no rpartition: el VALOR puede
        # llevar ':' ("plate:on the table: centre"), la clave no.
        key = re.sub(r"\s+", " ", name.strip().lower())
        key = "".join(c for c in unicodedata.normalize("NFKD", key)
                      if not unicodedata.combining(c)).strip()
        val = val.strip()
        if not key or not val:
            continue
        out[key] = (val, name.strip())
    return out


def carry_leaves_behind(prev: str, beats: list[dict]) -> str:
    """El estado que un BOARD deja atrás, para que el siguiente board de la misma escena
    lo herede.

    `prev` (lo que venía puesto) actualizado por cada entrada que declaren los beats de
    este board, en orden — un MERGE, no un reemplazo, exactamente por la razón por la que
    carry_screen_side también fusiona: un objeto puede no salir en el último beat de un
    board (un inserto cerrado sobre una cara) y seguir estando en la mesa cuando la escena
    vuelve al plano general. Reemplazar por lo último declarado borraría la mesa entera.

    Devuelve la misma ortografía "Clave:valor, Clave:valor" que escribe el beat writer,
    para que entre tal cual en el prompt del board siguiente. "" de entrada y ningún beat
    declarando → "" de salida, y el prompt siguiente es idéntico byte a byte al de antes
    de que esto existiera.
    """
    merged: dict[str, tuple[str, str]] = dict(_parse_leaves_behind(prev))
    for b in (beats or []):
        if not isinstance(b, dict):
            continue
        merged.update(_parse_leaves_behind(b.get("leaves_behind")))
    return ", ".join(f"{nombre}:{valor}" for valor, nombre in
                     ((v[0], v[1]) for v in merged.values()))


def _beat_declares_state_change(b: dict) -> bool:
    """¿Este beat declaró EXPLÍCITAMENTE que el cambio de estado OCURRE EN PANTALLA aquí?

    Sólo cuenta la clave explícita, igual que _beat_declares_crossing y por el mismo
    motivo: un board anterior a 2026-08-05 no tiene la clave en ningún beat, así que esto
    es False en todo él y su veredicto queda idéntico al de antes. No hay heurística de
    prosa de reserva — inferir "la cogió" de un desc es exactamente lo que hacía el regex
    de `crossing` cuando perdonaba 8 saltos de 90 beats por la palabra "exit".
    """
    return "state_change" in b and _as_bool(b.get("state_change"))


def _clave_natural(label: str) -> tuple:
    """SHOT_062-A → ('shot_', 62, '-a'): ordena SHOT_9 antes que SHOT_10 y SHOT_062 antes
    que SHOT_062_2. El orden IMPORTA aquí y no importaba en check_screen_direction: aquel
    agrupa por plano y compara dentro del grupo, éste sigue un objeto a través de toda la
    escena, y los paneles llegan del front como Object.values(boards).flatMap(...) — orden
    de inserción del store, no orden de escena. Ordenar aquí hace el gate determinista sea
    cual sea el orden en que el caller los meta."""
    import re
    return tuple(int(t) if t.isdigit() else t
                 for t in re.split(r"(\d+)", str(label or "").lower()))


def check_object_continuity(panels: list[dict]) -> list[dict]:
    """¿Lo que un beat deja puesto sigue puesto en el siguiente? (atrezzo y vestuario)

    Hermano de check_screen_direction: misma forma, otro eje. Aquél lee `screen_side` y
    pregunta "¿sigue cada personaje en su lado?"; éste lee `leaves_behind` y pregunta
    "¿sigue el plato en la mesa y las mismas ropas puestas?". Determinista porque lee lo
    que el beat DECLARA, no lo que su prosa insinúa.

    ÁMBITO: la ESCENA entera, no el plano. Los tres defectos medidos que no son SHOT_055
    cruzan el corte — la coleta de Nuria cambia entre SHOT_040-A y los paneles siguientes,
    el mono del agronomista desaparece en SHOT_062_2 y reaparece en SHOT_063 — y un gate
    que sólo mirara dentro de un board no vería ninguno de los tres.

    QUÉ ES INFRACCIÓN:
      · el valor de una clave CAMBIA entre dos beats y ningún beat de ese hueco declara
        `state_change` (el plato pasa de la mesa a las manos sin que nadie lo coja);
      · una clave que estaba PUESTA en el decorado deja de declararse (el plato se
        evapora de la mesa). Sólo para lo PUESTO: lo que lleva un personaje se va con él.
        Cuenta también el beat que no declara NADA, siempre que otro beat de su mismo
        plano sí declare: ahí el campo existía y el vacío es un olvido — y es literalmente
        SHOT_055-C, el fallo que se vio a ojo (ver "QUÉ BOARDS HABLAN" en el cuerpo).
      · una prenda deja de declararse en un beat en el que su dueño SÍ está en cuadro
        (el mono del agronomista). La presencia se lee de `screen_side`, que ya nombra a
        todo personaje del beat; sin ella no se aplica esta regla.

    QUÉ NO ES INFRACCIÓN: nada que sea una FIGURA. Una persona (o su mano, o su peso) se
    mueve sola: dónde está lo declara `screen_side` y lo juzga check_screen_direction, y
    cambiar de postura entre dos beats es la acción. Ver _es_figura y sus números — sin
    ese filtro este gate suspendía las 10 escenas medidas por 86 cambios de postura y
    cero objetos. Tampoco lo es un valor "out of frame"/"offscreen" (un encuadre cerrado no es
    un fallo de continuidad), y cualquier cambio que un beat de cualquiera de los dos
    extremos del hueco declare con `state_change: true`. La licencia se lee de LOS DOS
    extremos por lo mismo que la de `crossing`: el movimiento ocurre DURANTE el beat que
    lo declara, y el escritor puede describir en `leaves_behind` el estado con el que ese
    beat empieza o con el que acaba. Aceptar sólo un extremo suspendía 4 de 6 boards
    correctos cuando se midió con `crossing` (2026-08-05).

    UNA DECLARACIÓN, UN CAMBIO. La licencia hacia adelante se GASTA si el beat que la
    declara ya cambia el valor él mismo: si el beat B dice "state_change" y su
    `leaves_behind` ya pasa el plato de las manos a la mesa, el movimiento está contado y
    B no explica además que el beat C lo haga desaparecer. Sin esta contabilidad el propio
    caso que motivó el gate — plato apoyado en B, ausente en C — pasaba el examen (medido
    con la primera versión de esta función: 1 de 5 casos de fallo se colaba). Sólo cuando
    el beat que declara NO cambia su propio valor (escribió el estado de partida) queda la
    licencia viva para el beat siguiente, que es la convención que `crossing` documenta.

    Devuelve [] cuando ningún beat declara nada VIGILABLE — ni un board escrito antes de
    que el campo existiera, ni uno cuya ficha sólo tiene figuras: en los dos casos no hay
    nada que este gate pueda afirmar, y la salida de QC es exactamente la de hoy.
    """
    ordenados = sorted([p for p in (panels or []) if isinstance(p, dict)],
                       key=lambda p: _clave_natural(p.get("label")))

    # Quién sale en cada beat, según lo que YA declara screen_side. Se reutiliza en vez de
    # inventar un campo nuevo: el prompt ya obliga a nombrar ahí a todo personaje del desc.
    presentes: list[set[str]] = [set(_parse_screen_side(p.get("screen_side")))
                                 for p in ordenados]
    personajes: set[str] = set().union(*presentes) if presentes else set()

    def _dueno(clave: str) -> str:
        """'nuria hair' → 'nuria' cuando Nuria es un personaje de esta escena. El vestuario
        se declara "<Personaje> <prenda>", así que el dueño es el nombre más largo que
        encaje con el principio de la clave (más largo: 'old agronomist' antes que 'old')."""
        toks = clave.split()
        mejor = ""
        for p in personajes:
            pt = p.split()
            if toks[:len(pt)] == pt and len(p) > len(mejor):
                mejor = p
        return mejor

    def _es_figura(clave: str) -> bool:
        """¿La clave es una FIGURA (o un trozo de una), en vez de algo que deja atrás?

        LA FRONTERA ENTRE LOS DOS GATES: `screen_side` dice DÓNDE ESTÁN LAS FIGURAS y
        check_screen_direction la juzga; `leaves_behind` dice QUÉ DEJAN PUESTO. Una
        persona se mueve sola — cambiar de postura entre dos beats es la ACCIÓN, no un
        fallo de continuidad — y el atrezzo no.

        MEDIDO en BLOOM SC-021 (4 boards, 19 beats, 10 escenas completas generadas
        2026-08-05, 5 con carry y 5 sin): el escritor rellenaba la ficha con posturas
        ("Beni:leaning out cab window", "Tomás:hand at jaw", "Old Agronomist:seated on
        rail") y este gate reportaba CADA cambio de postura. 86 infracciones en 10
        escenas, 86 de 86 sobre figuras: cero sobre un objeto o una prenda. Un gate que
        suspende las 10 escenas por la única cosa que NO le toca vigilar no se lee, y no
        leerlo es cómo se pierde el plato de la mesa. Se filtran aquí, y el prompt ya no
        pide figuras (ver "leaves_behind" en storyboard_panels), así que la ficha vuelve
        a ser lo que dice ser: atrezzo y vestuario.
        """
        if clave in personajes:
            return True
        # "<Personaje> <parte del cuerpo>" — anatomía, no vestuario: la mano de Tomás no
        # es una prenda que se pueda perder. Las prendas ("overalls", "boots", "hair")
        # NO están en la lista y se siguen vigilando.
        toks = clave.split()
        return len(toks) > 1 and toks[-1] in _ANATOMIA and bool(_dueno(clave))

    def _fichas(p: dict) -> dict[str, tuple[str, str]]:
        """Lo que el beat declara, sin las figuras."""
        return {k: v for k, v in _parse_leaves_behind(p.get("leaves_behind")).items()
                if not _es_figura(k)}

    # QUÉ BOARDS HABLAN. Un beat que no declara nada es ambiguo: o es un board viejo (no
    # existía el campo) o es el escritor que se dejó el campo vacío en ESE beat. Los dos
    # merecen trato opuesto y el board entero los separa: si algún beat de ESE plano
    # declara algo, el campo existía y un beat vacío del mismo plano es un olvido, no un
    # board legacy. MEDIDO (harness t_gate.py, 2026-08-05): sin esta distinción el caso
    # que motiva todo el gate — SHOT_055, plato en la mano en A, apoyado en B, beat C sin
    # declaración ninguna — PASABA el examen, porque el `continue` de abajo saltaba
    # justamente el beat en el que el plato desaparece. 1 de 5 casos de fallo se colaba, y
    # era el que el usuario vio a ojo. Un board donde NADIE declara (recuperado de disco,
    # anterior a 2026-08-05) sigue saltándose entero, así que una escena que mezcla un
    # board viejo con uno nuevo no inventa infracciones sobre el viejo.
    #
    # Se mide sobre el campo EN CRUDO, no sobre `_fichas`: un board que sólo declaró
    # figuras («Beni:leaning out cab window») ya demuestra que el campo existía cuando se
    # escribió, así que un beat suyo sin nada que vigilar es un olvido y no un board
    # legacy. Filtrar antes de esta cuenta dejaba mudos precisamente los boards de SC-021,
    # donde el escritor llenaba la ficha de posturas — y con ellos, sin vigilancia, el
    # mono del agronomista.
    import re as _re
    def _plano(p: dict) -> str:
        return _re.sub(r"-[A-Z]$", "", str(p.get("label") or ""))
    declarantes = {_plano(p) for p in ordenados
                   if _parse_leaves_behind(p.get("leaves_behind"))}

    declarados = 0
    fallos: list[str] = []
    # clave → (valor, tipo, cómo lo escribió el autor, beat que lo fijó, ¿queda licencia?)
    # El nombre tal cual lo escribió el autor viaja con el estado para que las dos notas
    # (cambio y desaparición) nombren la prenda igual: sin él la desaparición reportaba la
    # clave normalizada ("old agronomist overalls") y el cambio la original.
    estado: dict[str, tuple[str, str, str, str, bool]] = {}
    for p, quienes in zip(ordenados, presentes):
        entradas = _fichas(p)
        if not entradas and _plano(p) not in declarantes:
            continue                      # board que no declara nada: no afirma, no infringe
        if entradas:
            declarados += 1               # el contador cuenta DECLARACIONES, no beats vistos
        declara = _beat_declares_state_change(p)
        etiqueta = p.get("label")

        for clave, (valor, nombre) in entradas.items():
            previo = estado.get(clave)
            cambia_aqui = bool(previo) and not _mismo_estado(previo[0], valor)
            if cambia_aqui:
                tipo_nuevo = _estado_tipo(valor)
                # Salir de cuadro no es desaparecer: un plano más cerrado deja fuera media
                # cocina y eso es encuadre, no continuidad. Volver a entrar tampoco.
                licencia = declara or previo[4] or tipo_nuevo == "fuera" or previo[1] == "fuera"
                if not licencia:
                    fallos.append(f'{etiqueta}: {nombre} was "{previo[0]}" in {previo[3]}, '
                                  f'now "{valor}"')
            # La licencia sobrevive a este beat sólo si NO la ha gastado ya en su propio
            # valor (ver "UNA DECLARACIÓN, UN CAMBIO" arriba).
            estado[clave] = (valor, _estado_tipo(valor), nombre, etiqueta,
                             declara and not cambia_aqui)

        # Lo que este beat DEJÓ DE NOMBRAR. Sólo se persigue lo que no puede irse solo:
        # atrezzo PUESTO en el decorado, y ropa cuyo dueño sigue en cuadro.
        for clave, (valor, tipo, nombre, donde, pendiente) in list(estado.items()):
            if clave in entradas:
                continue
            dueno = _dueno(clave)
            vigilada = tipo == "puesto" or bool(dueno and dueno in quienes)
            if not vigilada:
                continue
            if declara or pendiente:
                # `declara`: este beat dice que AQUÍ se mueven cosas, y no se le exige
                # además enumerar lo que se llevó. `pendiente`: el beat anterior declaró un
                # movimiento cuyo resultado aún no había escrito (se la llevó en la mano).
                # En los dos casos el hueco está explicado y la clave deja de seguirse.
                #
                # Lo que NO vale aquí es una licencia YA GASTADA: si el beat anterior apoyó
                # el plato en la mesa y lo escribió, no explica además que la mesa esté
                # vacía en éste — y eso es literalmente SHOT_055.
                estado.pop(clave, None)
                continue
            fallos.append(f'{etiqueta}: {nombre} was "{valor}" in {donde} and is gone here — '
                          f'no beat declares it moved or taken')
            # Se marca como ido para no repetir el mismo fallo en cada beat posterior
            # (mismo motivo por el que check_screen_direction reasigna `lado` siempre).
            estado[clave] = ("gone", "ido", nombre, etiqueta, False)

    if not declarados:
        return []
    return [{
        "label": "Object & wardrobe continuity", "passed": not fallos, "blocking": False,
        "notes": (f"{declarados} beat(s) declare what they leave behind; every prop stays "
                  f"put and every wardrobe item persists."
                  if not fallos else
                  f"{len(fallos)} continuity break(s) — something placed or worn changes or "
                  f"vanishes between beats without a beat declaring state_change=true (an "
                  f"on-screen move is allowed; a silent one is not): "
                  + "; ".join(fallos[:4])),
    }]


def _has_obstacle(seq: dict) -> bool:
    """Does something actually resist here? Exact equality against "NONE" let 'None.',
    'N/A' and 'nothing resists her' all count as a real obstacle — and the same string
    then went into every batch prompt as `resisted by: None.`"""
    v = str(seq.get("obstacle") or "").strip().strip(".").lower()
    return bool(v) and v not in ("none", "n/a", "na", "nothing", "no obstacle", "-")


#: The DRAMA LAYER of a sequence. Every field below is OPTIONAL: a bible written before
#: they existed declares none of them, every gate that reads them is skipped, and
#: check_story_spine returns exactly the four checks it always returned (proven against
#: FARO's and ROBOTECH's bible.json on disk — identical output, byte for byte).
#:
#: The vocabulary is not invented. It is the annotation set used to score 13 produced
#: sci-fi screenplays (Andor 2x09, Wakanda Forever, Cowboy Bebop 1x08, Dune, Frankenstein,
#: Free Guy, Prey, Project Hail Mary, Severance pilot, Stranger Things 4x07, The Man Who
#: Fell to Earth 1x01, The Tomorrow War, The Wild Robot). Those 13 use 8 of these 9 modes
#: each; what this app produced used one — FARO's 1229 words contain no laugh, smile or
#: joke anywhere.
SEQ_MODES = ("action", "dread", "horror", "comedy", "quiet", "wonder", "grief",
             "reveal", "procedural")
#: The three modes that work as a RELIEF VALVE. In the 13, a peak is followed within two
#: sequences by one of these on average 11 times per script; The Tomorrow War's two
#: tension-10 sequences drop immediately to 7 and 4, and the sequence before the finale is
#: comedy. A curve that only climbs reads as noise, not as pressure.
SEQ_RELIEF_MODES = ("comedy", "quiet", "wonder")
#: WHO resists. 'self' is the one that produced FARO: 5 of its 6 obstacles are the
#: protagonist's own passivity ("Elias holds the door bolt unmoving"), which is why the
#: film has no antagonist and nothing ever costs him anything.
SEQ_OBSTACLE_TYPES = ("external_agent", "environment", "rule", "self")


def _as_bounded_int(v: Any, lo: int, hi: int) -> int | None:
    """v as an int inside [lo, hi], or None when it is absent or unreadable.

    None, not a default: "this spine does not declare a tension" and "this sequence is a
    1" are different facts, and every gate below branches on the difference. Inventing a
    default here is the `or 5.0` mistake that silently disarmed three other gates in this
    codebase."""
    if v is None or v == "":
        return None
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return None
    return max(lo, min(hi, n))


def _as_bool(v: Any) -> bool:
    """JSON true/false, but also the STRINGS a text model writes when it forgets it is
    emitting JSON — "false"/"no"/"0" must not read as True just because they are
    non-empty strings."""
    if isinstance(v, str):
        return v.strip().lower() not in ("", "false", "no", "0", "none", "n/a")
    return bool(v)


def _seq_tension(seq: dict) -> int | None:
    """Dramatic intensity 1-10, or None when this sequence does not declare one."""
    return _as_bounded_int(seq.get("tension"), 1, 10)


def _seq_cost(seq: dict) -> int | None:
    """How much the protagonist has given up by the END of this sequence, 0-3."""
    return _as_bounded_int(seq.get("cost_level"), 0, 3)


def _seq_mode(seq: dict) -> str:
    """The sequence's tonal mode, lowercased, or "" when absent or outside the
    vocabulary. An unknown word is treated as ABSENT rather than as a tenth mode — it
    must not inflate the tonal-range count."""
    m = str(seq.get("mode") or "").strip().lower()
    return m if m in SEQ_MODES else ""


def _seq_obstacle_type(seq: dict) -> str:
    """external_agent|environment|rule|self, or "" when absent/unknown."""
    t = str(seq.get("obstacle_type") or "").strip().lower()
    return t if t in SEQ_OBSTACLE_TYPES else ""


def _seq_share(seq: dict) -> float | None:
    """This sequence's share of the runtime as a fraction, or None.

    Accepts a percentage too (12 means 12%, not 12x the film): a model asked for "a
    fraction that sums to 1.0" writes percentages often enough that reading 12 as 12.0
    would blow every share gate and the per-sequence word budget with it."""
    raw = seq.get("seconds_share")
    if raw is None or raw == "":
        return None
    try:
        f = float(raw)
    except (TypeError, ValueError):
        return None
    if f > 1.0:
        f = f / 100.0
    return f if f > 0 else None


def _seq_event(seq: dict) -> dict:
    """The sequence's COST, as {irreversible, who, loses} — always a dict, possibly empty.

    A string is accepted and read as the thing lost: half the time a model answers
    "event": "she burns the transmitter" instead of the object, and throwing that away
    would fail the peak gate on a spine that did state its cost."""
    ev = seq.get("event")
    if isinstance(ev, dict):
        return ev
    if isinstance(ev, str) and ev.strip():
        return {"irreversible": True, "loses": ev.strip()}
    return {}


def normalise_sequence_drama(seq: dict) -> dict:
    """Coerce the drama fields of ONE sequence in place, touching only what is there.

    A legacy sequence — no tension, no mode, no event — comes back untouched, which is
    the whole contract: shape_film_bible runs this over every sequence it stores, so it
    runs over every re-save of every existing project's bible, and a normaliser that
    wrote defaults would rewrite FARO's spine the first time someone edited a comma.

    One rule for all six fields: what is STORED is always readable. A value that is
    present but unreadable ("tension": "high", "mode": "melancholy", a share of 0) is
    dropped rather than kept, because every gate below already reads it as absent — and a
    field the gates ignore while the editor still displays it is the worst of both."""
    for key, coerce in (("tension", _seq_tension), ("cost_level", _seq_cost),
                        ("mode", _seq_mode), ("obstacle_type", _seq_obstacle_type),
                        ("seconds_share", _seq_share)):
        if key not in seq:
            continue
        val = coerce(seq)
        if val in (None, ""):
            seq.pop(key)
        else:
            seq[key] = round(val, 4) if key == "seconds_share" else val
    if "obstacle_owner" in seq:
        owner = str(seq.get("obstacle_owner") or "").strip()
        # NOT split here. A list of owners can only be told from a name that contains a
        # separator by asking the CAST, and this function deliberately sees one sequence
        # and nothing else — see resolve_obstacle_owner, which shape_film_bible runs
        # afterwards with `characters` in hand.
        if owner:
            seq["obstacle_owner"] = owner
        else:
            seq.pop("obstacle_owner")
    ev = _seq_event(seq)
    if ev:
        seq["event"] = {"irreversible": _as_bool(ev.get("irreversible")),
                        "who": str(ev.get("who") or "").strip(),
                        "loses": str(ev.get("loses") or "").strip()}
    elif "event" in seq:
        seq.pop("event")
    return seq


def resolve_obstacle_owner(owner: str, cast: list[str]) -> str:
    """One declared character out of whatever the model wrote in `obstacle_owner`.

    The field is a KEY into `characters`, not prose: "Cast declared" tests the whole
    string for membership in the cast and "Recurring adversary" tallies it verbatim. Asked
    to read a two-hander correctly, the model answered "JOEL, MARA" for the sequence where
    the two of them block each other (2026-08-12) — honest about the scene, unusable as
    data: the gate reported that a character called "JOEL, MARA" has no dossier while both
    of them had one, and the pair counted as a third, single-appearance adversary.

    Splitting on the separator ALONE is worse than the disease. `script_speaking_cast`
    returns a unison cue as ONE name, so "MR. AND MRS. VANCE" is a legitimate declared
    character, and a blind split stores "MR." — a name that is in no cast, reaches disk,
    the editor and every batch prompt, and fails the very gate the split was meant to fix.
    "JOEL AND MARA'S LANDLORD" would credit the protagonist as the antagonist.

    So the cast decides, and only the cast:
      · the whole string names someone declared  -> keep it, separators and all;
      · it splits into fragments and EVERY fragment names someone declared -> it is a
        list, and the first one wins;
      · anything else -> return it UNCHANGED. "JOEL AND MARA'S LANDLORD" splits into a
        declared JOEL and an undeclared "MARA'S LANDLORD", so it is a name, not a list —
        taking the first match there would credit the protagonist as the antagonist.
        Never invent, never truncate to a non-name, never drop it: an owner the cast does
        not know is a real finding, and "Cast declared" is the gate that reports it.
    """
    owner = (owner or "").strip()
    if not owner:
        return ""
    known = {c.strip().lower(): c.strip() for c in cast if c and c.strip()}
    if owner.lower() in known:
        return owner
    import re   # module-local, as everywhere else in this file
    parts = [p.strip(" \t'\"") for p in re.split(r",|\band\b|&|/", owner, flags=re.IGNORECASE)]
    parts = [p for p in parts if p]
    # `parts` may hold ONE name — ", JOEL" is a declared character with a stray separator,
    # and dropping the separator is a cleanup, not a choice between two people. The rule is
    # the same either way: every fragment must be someone the cast knows.
    if parts and all(p.lower() in known for p in parts):
        return parts[0]
    return owner


def spine_shares(seqs: list[dict]) -> list[float]:
    """Each sequence's share of the runtime, normalised to sum to 1.0.

    Declared shares are used as given (renormalised, so a spine that sums to 0.98 is not
    judged as if the film stopped early); sequences that declare none take the mean of
    those that do; a spine with no shares at all falls back to equal stretches, because
    a spine without shares still has an ORDER and order is enough to say "this peak is
    in the first half".

    NOTE the deliberate split of duties: this normalises for POSITION and for the word
    budget, and the SHARE gate below reads the RAW numbers. If the gate read these it
    could never fail, which is how a check becomes decoration."""
    n = len(seqs)
    if not n:
        return []
    declared = [_seq_share(s) for s in seqs]
    known = [d for d in declared if d is not None]
    fill = (sum(known) / len(known)) if known else (1.0 / n)
    vals = [d if d is not None else fill for d in declared]
    total = sum(vals)
    if total <= 0:
        return [1.0 / n] * n
    return [v / total for v in vals]


def spine_positions(seqs: list[dict]) -> list[float]:
    """Where each sequence FALLS in the finished film, 0.0-1.0, at the MIDPOINT of its
    stretch of runtime — the number the peak-placement and escalation gates measure
    against. Midpoint, not end: a 20-minute finale "is at" the middle of its own stretch,
    and judging it by its last frame would pass any spine whose peak is simply last."""
    acc = 0.0
    out: list[float] = []
    for w in spine_shares(seqs):
        out.append(acc + w / 2)
        acc += w
    return out


def _check_drama_layer(seqs: list[dict]) -> list[dict]:
    """The eight gates that read the drama layer. Returns [] for a spine that declares
    none of it.

    Each block is guarded by "does ANY sequence declare the field this gate reads". That
    is what makes the whole layer additive: the gates cannot fail a bible for lacking
    fields that did not exist when it was written, and a project that never touches the
    new UI keeps exactly the verdict it has today.

    The measurements these thresholds come from are on 13 produced sci-fi screenplays;
    the specific numbers are cited at each gate.
    """
    out: list[dict] = []
    n = len(seqs)
    tensions = [_seq_tension(s) for s in seqs]
    modes = [_seq_mode(s) for s in seqs]
    otypes = [_seq_obstacle_type(s) for s in seqs]
    owners = [str(s.get("obstacle_owner") or "").strip() for s in seqs]
    costs = [_seq_cost(s) for s in seqs]
    raw_shares = [_seq_share(s) for s in seqs]
    pos = spine_positions(seqs)

    # ── 1. IRREVERSIBLE PEAK. The headline finding: the 13 write CONSEQUENCES, this app
    # wrote STATES. A sequence at tension 8+ that costs the protagonist nothing they can
    # never get back is a loud scene, not a turn — and a film built out of those is the
    # "sequence of events" verdict this whole check family exists for. BLOCKING.
    if any(t is not None for t in tensions):
        peaks = [i for i, t in enumerate(tensions) if (t or 0) >= 8]
        paid = [i for i in peaks
                if _as_bool(_seq_event(seqs[i]).get("irreversible"))]
        if not peaks:
            notes = (f"no sequence reaches tension 8 — the highest is "
                     f"{max((t for t in tensions if t is not None), default=0)}. A film "
                     "with no peak has nothing to cost the protagonist.")
        elif paid:
            losses = [str(_seq_event(seqs[i]).get('loses') or '').strip() or "(unnamed)"
                      for i in paid]
            notes = (f"{len(paid)}/{len(peaks)} peak(s) cost something irreversible: "
                     f"{'; '.join(losses[:3])}.")
        else:
            notes = (f"{len(peaks)} sequence(s) reach tension 8+ "
                     f"({', '.join(str(seqs[i].get('id', '?')) for i in peaks[:5])}) and NOT ONE "
                     "takes something the protagonist can never get back. Loud, not costly.")
        # ADVISORY since 2026-08-12, and the demotion is not a softening — it is the
        # difference between "this film is weaker" and "this breakdown cannot be built".
        # While only propose_spine wrote a tension, this gate never ran on a derived bible
        # and blocking cost nothing. Now derive_film_bible writes one, and the flag reaches
        # an unattended run through a path none of it is visible from: generate_breakdown
        # derives and SAVES the bible (server.py), shape_film_bible stamps story_checks
        # into it, /api/breakdown/qc prefers that stored copy and folds it into the QC
        # verdict, and AutopilotController throws on ANY failing blocking check.
        # Reproduced on a calm 60-second short with tensions 3/6/7 — a reading this
        # module's own prompt calls legitimate: "no sequence reaches tension 8" halted the
        # run before a single asset was generated, and the only exit was to hand-edit the
        # number upwards. The autopilot's stop condition is documented as checks that make
        # the breakdown UNBUILDABLE, and the sibling footage check was made non-blocking
        # for this exact reason ("a blocking verdict on it would stop every unattended
        # autopilot run at stage 2"). A flat story is buildable; it is just flat, and the
        # gate still says so in red on the spine editor.
        #
        # "Cast matches the script" stays BLOCKING on purpose: that one is not a judgement
        # about the film, it is two documents disagreeing about who is in it.
        out.append({"label": "Irreversible peak", "passed": bool(paid),
                    "blocking": False, "notes": notes})

    # ── 2. PEAK PLACEMENT. Measured across the 9 scored scripts: the LAST sequence at
    # tension >= 9 sits at 0.88 of the runtime on average, median 0.93. A film that
    # spends its highest card early and then keeps going has no third act.
    #
    # "The peak" is the LAST sequence in the top band, not the single global maximum, and
    # that is what the measurement actually says. The Tomorrow War has two 10s: the second
    # sits at 0.72 and the film's real climax is the 9 that ends it, at 0.93. Judging the
    # global max would fail a curve every one of the 13 would recognise as correct. The
    # band is the maximum, or 9 when the film reaches 9 — whichever is lower.
    if any(t is not None for t in tensions):
        top = max((t for t in tensions if t is not None), default=0)
        band = min(top, 9)
        idx = max(i for i, t in enumerate(tensions) if (t or 0) >= band)
        at = pos[idx]
        out.append({
            "label": "Peak placement", "passed": at >= 0.75,
            "notes": (f"the last sequence in the top band (tension {tensions[idx]} ≥ {band}, "
                      f"{seqs[idx].get('id', '?')}) falls at {at:.2f} of the runtime."
                      + ("" if at >= 0.75 else
                         " The 13 produced scripts put their last 9+ peak at 0.88 on "
                         "average (median 0.93); this one peaks and then keeps going."))})

    # ── 3. RELIEF. The valve. In the 13 a peak is followed within two sequences by
    # comedy, quiet or wonder ~11 times per script. Sequences at the very end are exempt:
    # a peak with nothing after it is an ENDING, not a missing valve — the same exemption
    # the "Questions answered" gate gives the last sequence's open question.
    if any(t is not None for t in tensions) and any(modes):
        unrelieved: list[str] = []
        for i, t in enumerate(tensions):
            if (t or 0) < 8:
                continue
            window = modes[i + 1:i + 3]
            if not window:
                continue                      # the film ends here
            if not any(m in SEQ_RELIEF_MODES for m in window):
                unrelieved.append(str(seqs[i].get("id", "?")))
        out.append({
            "label": "Relief", "passed": not unrelieved,
            "notes": (f"{len(unrelieved)} peak(s) are never let go of "
                      f"({', '.join(unrelieved[:5])}) — nothing in the two sequences after "
                      "them is comedy, quiet or wonder."
                      if unrelieved else
                      "every peak is followed within two sequences by comedy, quiet or wonder.")})

    # ── 4. TONAL RANGE. The 13 use 8 of the 9 modes each. One register for a whole film
    # is the flatness a viewer reports as "it all felt the same"; the 40% ceiling is what
    # separates "a dread film with jokes in it" from "83 minutes of dread".
    #
    # BOTH thresholds SCALE with the spine, because as absolutes they were unreachable on
    # a short one and a gate that cannot pass is not a measurement. The arithmetic: 4
    # distinct modes needs 4 sequences to put them in; and "no mode above 40%" allows a
    # mode at most 0.4n times, which is 1 for every n below 5 — i.e. on a 3- or 4-sequence
    # spine it demands that EVERY sequence be a different register. DRAMA QUEEN 2 (three
    # sequences, two people in a kitchen) failed this gate on arithmetic, not on tone.
    # From 8 sequences up — the length the 13 were measured at — `need` is 4 and the
    # ceiling applies, so a feature-length spine scores exactly what it scored before.
    if any(modes):
        declared = [m for m in modes if m]
        distinct = sorted(set(declared))
        counts = {m: declared.count(m) for m in distinct}
        worst, worst_n = max(counts.items(), key=lambda kv: kv[1])
        frac = worst_n / len(declared)
        need = min(4, max(2, len(declared) // 2))
        capped = len(declared) >= 5
        ok = len(distinct) >= need and (frac <= 0.40 or not capped)
        out.append({
            "label": "Tonal range", "passed": ok,
            "notes": (f"{len(distinct)} mode(s) across {len(declared)} sequence(s) "
                      f"({', '.join(distinct)}); '{worst}' is {frac:.0%} of them."
                      + ("" if ok else
                         f" A spine this length needs at least {need} distinct mode(s)"
                         + (" and none above 40%" if capped else "")
                         + ". The 13 produced scripts use 8 of the 9 modes each."))})

    # ── 5. AGENCY. FARO is the case: 5 of 6 obstacles ARE the protagonist's own
    # passivity, so nothing in the film has an agenda of its own and no one can lose to
    # anything. Denominator is EVERY sequence — a sequence that declares no obstacle_type
    # is not evidence of an antagonist.
    if any(otypes) or any(owners):
        external = [i for i, t in enumerate(otypes) if t and t != "self"]
        selfish = [str(seqs[i].get("id", "?")) for i, t in enumerate(otypes) if t == "self"]
        out.append({
            "label": "Agency", "passed": len(external) * 2 >= n,
            "notes": (f"{len(external)}/{n} sequence(s) are resisted by something other than "
                      f"the protagonist themself."
                      + (f" Self-resisted: {', '.join(selfish[:5])}." if selfish else "")
                      + ("" if len(external) * 2 >= n else
                         " A protagonist who is only ever stopped by their own hesitation "
                         "cannot be beaten, so nothing they do costs anything."))})

    # ── 6. RECURRING ADVERSARY — a WARNING, not a failure. A named force that comes back
    # is what lets an audience feel a threat build; but a legitimate film can be resisted
    # by a different thing every time (the environment, a rule), so this is advice.
    #
    # The "3 sequences" is SCALED for the same reason Tonal range is: on a 3-sequence
    # spine it asks for an adversary in every single one, and a sequence whose obstacle is
    # NONE makes that impossible — the gate then reports a missing antagonist that no
    # rewrite could supply. Two appearances is the least that can be called recurring, so
    # short spines are held to that; from 4 sequences up the bar is the measured 3.
    if any(otypes) or any(owners):
        named = [o for o in owners if o]
        counts = {}
        for o in named:
            counts[o.lower()] = counts.get(o.lower(), 0) + 1
        best, best_n = (max(counts.items(), key=lambda kv: kv[1]) if counts else ("", 0))
        need = min(3, max(2, n - 1))
        out.append({
            "label": "Recurring adversary", "passed": best_n >= need, "blocking": False,
            "notes": (f"'{best}' resists in {best_n} sequence(s)." if best_n >= need else
                      (f"no single adversary appears in {need}+ sequences (best: '{best}' × {best_n})."
                       if named else
                       "no sequence names WHO is resisting — obstacle_owner is empty "
                       "everywhere, so no threat can build across the film."))})

    # ── 7. ESCALATION. cost_level is cumulative: by the final third the protagonist must
    # have given something up. A 0 there says the last act found them exactly as whole as
    # the first — which is the shape of ROBOTECH, 16 scenes in which nothing is spent.
    if any(c is not None for c in costs):
        late = [i for i in range(n) if pos[i] > 2 / 3]
        free = [str(seqs[i].get("id", "?")) for i in late if costs[i] == 0]
        out.append({
            "label": "Escalation", "passed": not free,
            "notes": (f"{len(free)} sequence(s) in the final third still cost the "
                      f"protagonist nothing ({', '.join(free[:5])})."
                      if free else
                      f"every sequence in the final third ({len(late)} of {n}) has a cost.")})

    # ── 8. SHARE. Two failures in one gate because they are the same question: does this
    # document describe a real runtime? Shares that do not sum to 1 mean the plan does not
    # add up to the film; shares that are all the same mean a film with no act structure —
    # the third act is not the same size as the first in any of the 13. Reads the RAW
    # declared numbers, never spine_shares(), which normalises them.
    if any(s is not None for s in raw_shares):
        known = [s for s in raw_shares if s is not None]
        total = sum(known)
        missing = n - len(known)
        mean = total / len(known)
        spread = [abs(s - mean) / mean for s in known] if mean > 0 else [0.0]
        flat = max(spread) <= 0.20
        sums = abs(total - 1.0) <= 0.02 and not missing
        out.append({
            "label": "Runtime share", "passed": sums and not flat,
            "notes": (f"shares sum to {total:.3f}"
                      + (f" ({missing} sequence(s) declare none)" if missing else "")
                      + (f"; widest deviation from the mean is {max(spread):.0%}."
                         if mean > 0 else ".")
                      + ("" if sums else " They must sum to 1.00 ±0.02 — this plan does not "
                                         "add up to the film that was asked for.")
                      + ("" if not flat else " Every sequence is within 20% of the mean "
                                             "length: that is a flat film, not three acts."))})
    return out


def check_story_spine(bible: dict, script: str = "") -> list[dict]:
    """Is this a story, or a sequence of events? Four checks, all arithmetic — plus the
    eight drama gates of _check_drama_layer for a spine that declares the drama layer.

    ROBOTECH is the case these exist for. It had continuity, coverage and a runtime
    inside target, and the verdict from the only person who watched it was "the story
    does not exist". Nothing in the pipeline disagreed, because nothing was looking:
    every story judgement was a label an LLM wrote about itself. These are countable.

    `blocking` marks the ones that make a film illegible rather than merely weaker.
    """
    seqs = [s for s in (bible.get("sequences") or []) if isinstance(s, dict)]
    out: list[dict] = []
    if not seqs:
        return [{"label": "Story spine", "passed": False, "blocking": True,
                 "notes": "No sequences — nothing describes what the film is about, so "
                          "none of the story checks can run."}]

    # 1. Something has to RESIST. A protagonist who never fails has no story: UNIT-7
    #    walked for 44 shots and was stopped by nothing, which is why 3 minutes read as
    #    a reel. This is the single most predictive check of the four.
    no_obstacle = [str(s.get("id", "?")) for s in seqs if not _has_obstacle(s)]
    out.append({
        "label": "Obstacle", "passed": len(no_obstacle) <= len(seqs) // 3,
        "blocking": len(no_obstacle) == len(seqs),
        "notes": (f"{len(no_obstacle)}/{len(seqs)} sequence(s) have nothing resisting the "
                  f"protagonist ({', '.join(no_obstacle[:5])})."
                  if no_obstacle else f"all {len(seqs)} sequences have an obstacle.")})

    # 2. The value has to MOVE, and not always the same way. A film that only descends
    #    is as monotonous as one that only climbs; the alternation is the pulse.
    dirs = [str(s.get("direction") or "").strip().lower() for s in seqs]
    moved = [d for d in dirs if d in ("up", "down")]
    flips = sum(1 for a, b in zip(moved, moved[1:]) if a != b)
    out.append({
        "label": "Value change", "passed": len(moved) >= min(len(seqs), max(2, len(seqs) - 1)),
        "blocking": len(moved) < len(seqs) // 2,
        "notes": (f"{len(moved)}/{len(seqs)} sequences change the protagonist's situation."
                  + ("" if len(moved) >= len(seqs) - 1
                     else " The rest leave them exactly where they were."))})
    out.append({
        "label": "Rhythm of reversals", "passed": len(moved) < 3 or flips >= 1,
        "notes": (f"{flips} reversal(s) across {len(moved)} sequences."
                  + ("" if flips or len(moved) < 3
                     else " Every sequence moves the same direction — the film has one gear."))})

    # 3. Questions have to close. An opened question that is never answered is the exact
    #    shape of "I did not understand it": the audience is still holding it at the end.
    pos = {str(s.get("id")): i for i, s in enumerate(seqs)}
    opened = {str(s.get("id")) for s in seqs if str(s.get("question_opened") or "").strip()}
    # Only a LATER sequence can answer an earlier one. Without the ordering check a set
    # of self-referencing sequences passed with nothing closed at all.
    answered: set = set()
    for i, s in enumerate(seqs):
        raw = s.get("answers")
        # A sequence can close SEVERAL earlier questions at once — a climax usually does.
        # Accepting only one string made a legible film look full of dangling threads.
        ids = raw if isinstance(raw, list) else ([raw] if raw else [])
        for a in ids:
            a = str(a or "").strip()
            if a and pos.get(a, 10**6) < i:
                answered.add(a)
    # The LAST sequence is allowed to leave its question open — that is an ending, not a
    # hole, and on a series episode it is the hook.
    dangling = sorted(q for q in opened - answered if q and q != str(seqs[-1].get("id")))
    out.append({
        "label": "Questions answered", "passed": not dangling,
        "blocking": len(dangling) > len(seqs) // 2,
        "notes": (f"{len(dangling)} question(s) opened and never answered "
                  f"({', '.join(str(d) for d in dangling[:5])})."
                  if dangling else f"every question opened is answered later.")})

    # 4. The drama layer — tension, mode, cost, share. Appended, never merged into the
    #    four above, and EMPTY for any bible that does not declare those fields, so the
    #    verdict on every project that exists today is unchanged (verified against
    #    FARO's and ROBOTECH's bible.json: identical lists).
    out.extend(_check_drama_layer(seqs))

    # 5. REFERENTIAL INTEGRITY. The four checks above measure whether the STRUCTURE is a
    #    story; these measure whether it is a story about THIS film. Both failures below
    #    were live on DRAMA QUEEN 2 (2026-08-12) and every gate still read 10/12 PASSING:
    #
    #      * `characters` listed CLARA and nobody else, while `obstacle_owner` named
    #        DANIEL in four sequences — an antagonist who owns 4/9 obstacles and has no
    #        wants, needs or arc for a performance to be built from. "Recurring adversary"
    #        happily reported "'daniel' resists in 4 sequence(s)" without noticing he was
    #        never declared.
    #      * The script's cast is JOEL and MARA. Neither name appears anywhere in the
    #        spine. The breakdown reuses a bible that HAS characters and sequences without
    #        re-deriving it, so those two would have been broken down against a stranger's
    #        spine.
    #
    #    Arithmetic, like the rest: a set difference, no tokens, nothing to hallucinate.
    declared = {str(c.get("name") or "").strip().lower()
                for c in (bible.get("characters") or []) if isinstance(c, dict)}
    declared.discard("")
    owners = {str(s.get("obstacle_owner") or "").strip(): None for s in seqs}
    undeclared = sorted({o for o in owners if o and o.strip().lower() not in declared})
    out.append({
        "label": "Cast declared", "passed": not undeclared, "blocking": False,
        "notes": (f"{', '.join(undeclared)} own(s) an obstacle but has no entry under "
                  f"characters — nothing grounds their performance."
                  if undeclared else
                  "every character who owns an obstacle is declared."),
        "hint": ("Add an entry with wants/needs/arc for each, or hand the obstacle to a "
                 "character who has one." if undeclared else "")})

    # Only when the script is available: a caller that cannot see it reports nothing
    # rather than guessing, the same rule the other gates follow.
    if script.strip():
        spoken = {n.lower() for n in script_speaking_cast(script)}
        if spoken:
            missing = sorted(n for n in spoken if n not in declared)
            out.append({
                "label": "Cast matches the script", "passed": not missing, "blocking": True,
                "notes": (f"{len(missing)} character(s) speak in the script and are absent "
                          f"from the spine: {', '.join(m.upper() for m in missing)}. "
                          f"The spine declares {', '.join(sorted(d.upper() for d in declared)) or 'nobody'}."
                          if missing else
                          f"all {len(spoken)} speaking character(s) are in the spine."),
                "hint": ("This spine is not about this script. Re-derive it from the "
                         "script before the shot list is written from it."
                         if missing else "")})
    return out


def shape_film_bible(data: dict, max_sequences: int = 12) -> dict:
    """Normalise a raw derived bible into the shape the rest of the app stores, reads
    and edits — and score its spine only when it HAS one.

    Split out of ClaudeQCAgents.derive_film_bible so the shaping is exercisable and
    reusable without an LLM call: it is pure, does no I/O, and is where the two things
    that used to poison a bible on the way to disk are handled.

    Returns {logline, tone, characters, sequences} plus story_checks IFF there are
    sequences to check.

    `max_sequences` defaults to the 12 this has always truncated at — derive_film_bible
    asks for 3-8, so the cap has never bitten there. propose_spine raises it, because it
    asks for 8-15 and a spine silently cut to 12 would lose the ending AND leave
    seconds_share summing to less than 1, failing a gate for a reason the user cannot see.
    """
    chars = [c for c in (data.get("characters") or []) if isinstance(c, dict) and c.get("name")]
    seqs = [s for s in (data.get("sequences") or [])
            if isinstance(s, dict) and (s.get("value_in") or s.get("question_opened"))]
    seen_ids: set = set()
    for i, s in enumerate(seqs, start=1):
        # str() and uniqueness, both load-bearing: a numeric id raised TypeError in
        # the gates' join() and the caller's broad except then discarded the WHOLE
        # bible — logline, characters and spine — from every batch prompt. And a
        # duplicate id collapses in the set arithmetic below, so "Questions answered"
        # could pass with nothing actually answered.
        sid = str(s.get("id") or "").strip() or f"SEQ_{i}"
        while sid in seen_ids:
            sid = f"{sid}_{i}"
        seen_ids.add(sid)
        s["id"] = sid
        # Coerce the drama fields — and ONLY the ones this sequence actually declares.
        # A legacy sequence comes out of here untouched (see normalise_sequence_drama).
        normalise_sequence_drama(s)
        # THEN resolve the owner against the cast, which is only visible from here. Runs
        # after the coercion so it reads the stripped value, and only when there IS a cast
        # to check against — with none declared there is nothing to resolve to and the
        # string stays exactly as written.
        if s.get("obstacle_owner") and chars:
            s["obstacle_owner"] = resolve_obstacle_owner(
                s["obstacle_owner"], [str(c.get("name") or "") for c in chars])
    bible = {
        "logline": str(data.get("logline") or "").strip(),
        "tone": str(data.get("tone") or "").strip(),
        "characters": chars[:24],
        "sequences": seqs[:max_sequences],
    }
    # ONLY score a bible that HAS a spine — the same guard PUT/GET /api/bible already
    # apply. Scoring unconditionally was the second way the blocking "Story spine — no
    # sequences" verdict reached disk: a derivation that returns characters but zero
    # sequences (a short script, a model that answered half the schema) is saved by
    # generate_breakdown on `characters OR sequences`, and /api/breakdown/qc PREFERS
    # the stored story_checks over recomputing — so that one failure then forced
    # passed=False on every later QC run for the project. An ABSENT spine is not a
    # FAILED spine; the honest verdict for it is "nothing to score", i.e. no checks.
    checks = check_story_spine(bible) if bible["sequences"] else []
    if checks:
        bible["story_checks"] = checks
    return bible


def shape_proposed_spine(raw: str | dict) -> dict:
    """Turn what propose_spine's model answered into a stored bible, or {}.

    Split out of the method for the same reason shape_film_bible was: it is the whole
    behaviour worth testing and it must be exercisable WITHOUT paying for a generation.
    Pure, no I/O, no client.

    Accepts the raw text (fenced or not) or an already-parsed dict. Returns the
    shape_film_bible shape so a proposed spine and a derived one are interchangeable to
    every consumer — _bible_as_context, the story gates, the spine editor, PUT /api/bible.

    Deliberately does NOT repair seconds_share. Renormalising here would make the
    "Runtime share" gate unfailable, and a gate that cannot fail is decoration; the
    numbers the model chose are the numbers the user is shown.
    """
    import json as _json
    if isinstance(raw, dict):
        data = raw
    else:
        txt = (raw or "").strip()
        if txt.startswith("```"):
            txt = txt.split("```")[1].lstrip("json").strip()
        try:
            data = _json.loads(txt)
        except Exception as e:  # noqa: BLE001
            logger.warning("[Spine] unparseable proposal — no spine: %s", e)
            return {}
    if not isinstance(data, dict):
        return {}
    # 15, not the derive path's 12 — this asks for 8-15 (see shape_film_bible).
    return shape_film_bible(data, max_sequences=15)


#: Words per second of FINISHED FILM, for turning a sequence's runtime share into a word
#: budget — the inverse of estimate_script_seconds, which cannot be inverted exactly
#: because it charges speech and action at different rates (2 w/s vs ACTION_WORDS_PER_SEC).
#:
#: 3.3 is the MEDIAN of the 16 scripts on this machine, scored with the same maths:
#:   Foundation 4.50 · Fail_EP4 4.21 · ROBOTECH 4.08 · FARO 3.14 · Alastor 2 2.49 ·
#:   UNTITLED 1.85 — i.e. an all-action script lands near 4.5 and an all-dialogue one
#: near 2.0, and the median script is 39% dialogue by runtime.
#: Used ONLY to brief the model on length; the truth is still measured after the fact
#: with estimate_script_seconds, never assumed.
SCRIPT_WORDS_PER_SEC = 3.3


#: What a sequence has to carry before it is worth writing FROM. A dict with an id and
#: nothing else describes no stretch of film, and treating it as a spine would replace the
#: one-call script with N calls that each know less than the single call did.
_SPINE_USABLE_KEYS = ("question_opened", "value_in", "value_out", "purpose", "obstacle",
                      "covers")


def _spine_sequences(spine: list[dict] | dict | None) -> list[dict]:
    """The usable sequence list out of whatever the caller had at hand — a whole bible, a
    bare list of sequences, or None. Returns [] when there is nothing to write from, which
    is the signal every caller uses to keep the single-call behaviour."""
    if isinstance(spine, dict):
        spine = spine.get("sequences")
    if not isinstance(spine, list):
        return []
    return [s for s in spine
            if isinstance(s, dict) and any(str(s.get(k) or "").strip()
                                           for k in _SPINE_USABLE_KEYS)]


def _sequence_word_budget(secs: float) -> tuple[int, int]:
    """(target words, hard ceiling) for a stretch of screenplay meant to run `secs`.

    The ceiling is the all-action rate: more words than that cannot possibly cut to this
    length, whatever the mix. The target is the measured median blend."""
    target = max(40, round(secs * SCRIPT_WORDS_PER_SEC))
    ceiling = max(60, round(secs * ACTION_WORDS_PER_SEC))
    return target, ceiling


#: What each mode has to FEEL like on the page. Named per sequence in the per-sequence
#: prompt, because the one-call script had a single line of structural instruction
#: ("setup -> single complication -> resolution") and every stretch of every film it
#: wrote came out in the same register.
_MODE_TEXTURE = {
    "action": ("Short declarative sentences, one action per line, hard verbs. Geography "
               "must stay legible: who is where, moving which way. No introspection."),
    "dread": ("Withhold. Describe what is ALMOST visible and what the character does not "
              "look at. Long paragraph, then one short line. Nothing jumps out."),
    "horror": ("The body reacts before the mind does. Name the sound before the source. "
               "Let one sentence be too long and the next be three words."),
    "comedy": ("Rhythm is the joke: setup line, beat, turn. Characters are competent and "
               "still lose. Never write that something is funny."),
    "quiet": ("Two people and an object. Silence is written as behaviour — what hands do "
              "while a line goes unanswered. This is where the audience catches up."),
    "wonder": ("The camera stops. Scale first, then the human looking at it. Sensory, "
               "specific, unhurried; no one explains what they are seeing."),
    "grief": ("Practical actions performed badly. The loss is never named by the person "
              "carrying it; it shows in what they keep doing anyway."),
    "reveal": ("Order is everything: the audience must get the fact one beat before the "
               "character reacts to it. Rewrite nothing that came before — recontextualise it."),
    "procedural": ("Competence under pressure. Real steps in real order, jargon that means "
                   "something, and one step that does not work."),
}


def _tension_texture(t: int) -> str:
    """The rhythm a given intensity is written in. A 9 and a 3 must not read the same —
    which is exactly what a single script call produced (52% of ROBOTECH's shots came out
    5-6 seconds long, the flat middle of the range)."""
    if t >= 9:
        return ("Maximum pressure. Sentences under ten words. No adverbs. The scene ends "
                "on the worst outcome, not on a recovery.")
    if t >= 7:
        return ("High pressure. Cut in late, leave early, deny the characters time to "
                "explain themselves.")
    if t >= 4:
        return "Working pressure. Scenes may breathe, but every one has a want in it."
    return ("Low pressure on purpose. Let a moment last longer than it needs to; this is "
            "the floor the peaks are measured from.")


def _group_into_segments(shots: list[dict],
                         max_secs: float = SEGMENT_MAX_SECS) -> list[dict]:
    """Build the SEGMENT list — the units Seedance is actually called with — from the
    flat shot list the model returns.

    Deterministic on purpose. The model proposes the grouping (a `segment` label per
    shot); this decides what is legal. A segment must:
      * hold consecutive shots of ONE scene — a cut across a location is a new call;
      * sum to at most 15s, the API ceiling per call;
      * sum to at least 4s, the API floor — so a lone short shot is padded, never sent
        under-length to be silently stretched by the server.

    Shots the model did not label fall back to one-shot segments, which is exactly the
    old behaviour: a project that ignores the grouping still renders, it just has no
    internal rhythm.
    """
    segments: list[dict] = []
    cur: dict | None = None

    def close(seg: dict | None) -> None:
        if not seg or not seg["shots"]:
            return
        total = sum(float(s.get("duration_sec") or 0) for s in seg["shots"])
        # Under the call floor: give the slack to the LAST shot (the one that plays out),
        # so the extra time reads as a hold rather than a stretched action.
        if total < SEGMENT_MIN_SECS and seg["shots"]:
            # A 1.5s insert stranded alone gets inflated to 4s and stops being an insert.
            # Greedy first-fit can strand one when the ceiling evicts it, so say so —
            # silently stretching a beat is the failure this whole change exists to end.
            if len(seg["shots"]) == 1 and total < SHOT_MIN_SECS:
                logger.warning("[Segments] %s: a %.1fs shot ended up alone and was padded "
                               "to the %ds call floor — its rhythm is lost",
                               seg.get("id"), total, SEGMENT_MIN_SECS)
            seg["shots"][-1]["duration_sec"] = round(
                (float(seg["shots"][-1].get("duration_sec") or 0)
                 + (SEGMENT_MIN_SECS - total)) * 2) / 2
        seg["duration_sec"] = sum(float(s.get("duration_sec") or 0) for s in seg["shots"])
        segments.append(seg)

    for sh in shots:
        label = str(sh.get("segment") or "") or f"__solo__{sh.get('id')}"
        scene = sh.get("scene_id") or sh.get("scene") or ""
        dur = float(sh.get("duration_sec") or 0)
        cur_total = (sum(float(s.get("duration_sec") or 0) for s in cur["shots"])
                     if cur is not None else 0.0)
        fits = (cur is not None
                and cur["label"] == label
                and cur["scene_id"] == scene
                and cur_total + dur <= max_secs)
        # A shot too short to stand alone must never OPEN a segment: greedy first-fit
        # would leave it stranded and padded to 4s. Keep it with the run it belongs to
        # whenever the same scene still has room, even across a label change.
        if (not fits and cur is not None and dur < SHOT_MIN_SECS
                and cur["scene_id"] == scene and cur_total + dur <= max_secs):
            fits = True
        # Still no room and the shot is too short to stand alone: rather than strand it,
        # carry the PREVIOUS shot over with it. [7, 7, 1.5] has a legal cut at [7] + [7, 1.5];
        # greedy first-fit could only see [7, 7] + [1.5-padded-to-4], which destroys the
        # insert. Only when the donor segment survives the loss.
        carried: dict | None = None
        if (not fits and cur is not None and dur < SHOT_MIN_SECS
                and cur["scene_id"] == scene and len(cur["shots"]) >= 2):
            donor = cur["shots"][-1]
            donor_d = float(donor.get("duration_sec") or 0)
            if (cur_total - donor_d >= SEGMENT_MIN_SECS
                    and donor_d + dur >= SEGMENT_MIN_SECS
                    and donor_d + dur <= max_secs):
                carried = cur["shots"].pop()

        if not fits:
            close(cur)
            # The segment takes the id of its FIRST shot, not a fresh SEG_NNN. Minting a
            # new namespace left every consumer keyed by shot id unable to find its
            # segment: `segmentOf(shot.shotId)` returned undefined for all of them, so
            # segment mode never fired, `scene.segmentIds` came out empty, and each beat
            # was billed as its own 4s call — the sub-4s shot the whole change exists for
            # could not survive. The same rule already makes the MIGRATION lossless.
            first_id = str((carried or sh).get("id") or f"SEG_{len(segments) + 1:03d}")
            cur = {"id": first_id, "label": label, "scene_id": scene, "shots": []}
            if carried is not None:
                cur["shots"].append(carried)
        cur["shots"].append(sh)
    close(cur)

    for seg in segments:
        seg.pop("label", None)
    return segments


# ── Long-form breakdown chunking ──────────────────────────────────────────────
# A 150-min feature is ~1800 shots ≈ 470k tokens of JSON — far beyond any single
# LLM call's 64k output cap. The script is split into scenes, scenes are grouped
# into runtime-bounded BATCHES, each batch is generated in one call, then merged.

def _split_script_scenes(script: str) -> list[str]:
    """Split a screenplay into scenes at slug lines (INT./EXT.). Falls back to the
    whole script as one chunk when there are no headings."""
    import re
    heading = re.compile(r'^\s*' + _SCENE_NUM + r'(INT\.|EXT\.|INT/EXT|EXT/INT|I/E\b|INT\b|EXT\b)', re.I)
    scenes: list[str] = []
    cur: list[str] = []
    for ln in script.split("\n"):
        if heading.match(ln) and cur:
            scenes.append("\n".join(cur)); cur = [ln]
        else:
            cur.append(ln)
    if cur:
        scenes.append("\n".join(cur))
    scenes = [s.strip() for s in scenes if s.strip()]
    return scenes if len(scenes) > 1 else [script.strip()]


# ── Location STATE, out of the slug line ────────────────────────────────────────────
#
# HELL GRIND, quoted: "Every state of a character is a separate asset. Wet, wounded,
# changed clothes — that is @roco, @roco_wet, @roco_blood, each with its own description.
# Mix the states in one text, and the model starts mixing them between shots. LOCATIONS
# WORK THE SAME WAY: day, night and rain are three different assets."
#
# Take One Studio already splits CHARACTER states (_apply_wardrobe_variants). A location was ONE
# asset whatever the hour, and the signal to split it was already in the script and being
# thrown away: _script_locations stripped the trailing time-of-day off every slug line, so
# "EXT. ARROYO FARM - DAY" and "EXT. ARROYO FARM - NIGHT" folded to the same canonical
# name and therefore to one environment sheet. MEASURED on BLOOM's stored breakdown
# (2026-08-06): ASSET_025 "ARROYO FARM" covers SC-008 (DAY) and SC-022 (NIGHT), and
# ASSET_032 "Field Lab" covers SC-014 (DAY), SC-017 (NIGHT) and SC-018 — one daylight
# sheet standing in for a night scene three times over.
#
# The fold is deliberate and narrow. A script that writes MORNING once and DAY twice must
# not get two sheets of the same light, and PRE-DAWN is DAWN. Four buckets only, because
# each extra bucket is an extra image to generate and approve.
#
# The qualified spellings ("LATE AFTERNOON", "BEFORE DAWN") are here because ROBOTECH's
# script writes six of its sixteen slugs that way and NEITHER the old tail regex nor a
# bare-token list recognised them: the hour stayed glued to the location, so "RESEARCH
# OUTPOST — LATE AFTERNOON" and "RESEARCH OUTPOST — DUSK" were two unrelated places
# instead of two states of one.
_TOD_FOLD = {
    "day": "DAY", "morning": "DAY", "afternoon": "DAY", "midday": "DAY", "noon": "DAY",
    "early morning": "DAY", "late morning": "DAY",
    "early afternoon": "DAY", "late afternoon": "DAY",
    "night": "NIGHT", "evening": "NIGHT", "midnight": "NIGHT", "late night": "NIGHT",
    "dawn": "DAWN", "predawn": "DAWN", "pre dawn": "DAWN", "before dawn": "DAWN",
    "sunrise": "DAWN", "first light": "DAWN",
    "dusk": "DUSK", "sunset": "DUSK", "twilight": "DUSK", "early evening": "DUSK",
    "magic hour": "DUSK", "golden hour": "DUSK",
}
# Relative tails carry no light of their own — "CONTINUOUS" after a NIGHT slug is night.
# Treated as INHERIT, not as a state, which is why BLOOM's "INT. FIELD LAB - LATER"
# lands on NIGHT (its previous scene) instead of minting a third Field Lab.
_TOD_RELATIVE = {"continuous", "later", "moments later", "same", "same time",
                 "same day", "same night", "cont d", "contd", "continued"}
# The other half of the quoted rule ("day, night and RAIN"). Slug lines carry weather far
# less often than time, but when they do it changes the plate more than the hour does.
_WEATHER_FOLD = {
    "rain": "RAIN", "raining": "RAIN", "rainy": "RAIN", "in the rain": "RAIN",
    "storm": "STORM", "stormy": "STORM", "thunderstorm": "STORM",
    "snow": "SNOW", "snowing": "SNOW", "snowy": "SNOW",
    "fog": "FOG", "foggy": "FOG", "mist": "FOG", "misty": "FOG",
}


_SLUG_TAIL_RE = None          # built on first use by _slug_tail_re()


def _slug_tail_re():
    """The trailing-state regex, built ONCE from the three vocabularies above.

    Deliberately an explicit alternation of KNOWN tokens rather than a generic
    "last dash-delimited word", which is how the pre-state version of this code worked
    and why it was safe: a generic tail eats "ARROYO FARM - FIELD" down to "ARROYO FARM"
    and loses a real location. Inner spaces match hyphens too, so "PRE-DAWN", "PRE DAWN"
    and "PREDAWN" are one token — the first spelling is the one BLOOM actually uses, and
    a naive tail regex silently turns it into the location "SEAWALL - PRE" (caught here
    2026-08-06 before it shipped)."""
    import re
    global _SLUG_TAIL_RE
    if _SLUG_TAIL_RE is None:
        toks = sorted(set(_TOD_FOLD) | set(_WEATHER_FOLD) | _TOD_RELATIVE,
                      key=len, reverse=True)
        alt = "|".join(re.escape(t).replace(r"\ ", r"[-–—\s]*") for t in toks)
        _SLUG_TAIL_RE = re.compile(r'\s*[-–—]{1,2}\s*(' + alt + r')\s*$', re.I)
    return _SLUG_TAIL_RE


def _split_slug_state(name: str) -> tuple[str, str, str]:
    """Split one slug line's body into (location, time-of-day, weather).

    `name` is the heading with the INT./EXT. prefix already removed. Peels RECOGNISED
    trailing segments only — "FARM - FIELD - NIGHT" loses NIGHT and keeps "FARM - FIELD",
    exactly as the old tail loop did — and returns what it peeled instead of discarding
    it. Time-of-day is "" when the tail was relative (CONTINUOUS/LATER) or absent, which
    the caller resolves by inheriting the previous scene's state.
    """
    import re
    tail = _slug_tail_re()
    tod = wx = ""
    while True:
        m = tail.search(name)
        if not m:
            break
        tok = re.sub(r"\s+", " ", re.sub(r"[^a-z]+", " ", m.group(1).lower())).strip()
        if tok in _TOD_FOLD:
            tod = tod or _TOD_FOLD[tok]
        elif tok in _WEATHER_FOLD:
            wx = wx or _WEATHER_FOLD[tok]
        # else: a relative tail — inherit, see _TOD_RELATIVE
        name = name[:m.start()].strip()
    return name.strip(" -–—."), tod, wx


def _state_suffix(tod: str, wx: str) -> str:
    """The canonical state label appended to a location name. ONE spelling, here, so the
    canonical list, the batch prompt and _ensure_scene_environments cannot disagree."""
    return " ".join(p for p in (tod, wx) if p)


def _script_locations(script: str) -> list[str]:
    """The film's CANONICAL location list, taken from the scene headings.

    Batches run concurrently and blind, so each one invents its own name for a place
    another batch has already named. _norm_name folds case and separators, which is why
    "School - Hallway" ≡ "School Hallway" — but it cannot save "School gym parking lot"
    from "School Gymnasium - Parking Lot", or "Tomás Kitchen" from "Tomás's House -
    Kitchen". All three pairs came out of one BLOOM breakdown (2026-08-03) as SIX
    environment assets with six separately-generated images, so the kitchen the script
    deliberately returns to in its last act was a different room than the one it left.

    Making the matcher fuzzier is the wrong fix: "Arroyo Farm Field" is a subset of
    "Arroyo Farm" and merging those two loses a real location. A screenplay already
    carries the canonical list — that is what slug lines ARE — so the batches are given
    it and told to use those exact names instead of each inventing one.

    STATES (HELL GRIND rule 2 — see _TOD_FOLD): a location the film visits under more
    than one light comes back as one entry PER state, named "<LOCATION> - <STATE>". A
    location with a single state keeps its bare name, so the 25→20 dedup this list was
    built for does not regress and only the genuinely two-state places grow. MEASURED
    over every script on this machine (17 of them, 2026-08-06; an earlier note here said
    15 and missed FARO): 14 lists byte-identical, and three change —
      • BLOOM     20 → 22: ARROYO FARM and FIELD LAB, the two places it visits by day
                  and by night.
      • FARO       5 →  7: LIGHTHOUSE — ROCKY SHORE and — GROUND FLOOR, each NIGHT and
                  DAWN. The GROUND FLOOR pair is the interesting one: its night visits
                  are all written "— MOMENTS LATER"/"— LATER", so the split exists only
                  because a relative tail INHERITS (see _TOD_RELATIVE).
      • ROBOTECH  16 → 16, seven entries respelled: five lose an hour that used to stay
                  glued to the location ("EASTERN HIGHWAY — MIDDAY"), and RESEARCH
                  OUTPOST splits DAY/DUSK. Its slugs write "— MIDDAY", "— LATE
                  AFTERNOON" and "— BEFORE DAWN", none of which the old vocabulary knew.

    Returns headings stripped of the INT./EXT. prefix, de-duplicated by _norm_name (per
    state), in first-appearance order.
    """
    import re
    heading = re.compile(r'^\s*' + _SCENE_NUM + r'(?:INT\.?/EXT\.?|EXT\.?/INT\.?|I/E|INT\.?|EXT\.?)\s+(.*)$', re.I)
    # Pass 1: every slug in order, with its state resolved. Relative and missing tails
    # inherit the PREVIOUS slug's state (screenplay convention), so a script that never
    # writes a time of day gives every location one state and splits nothing.
    seq: list[tuple[str, str, str]] = []          # (name, norm key, state label)
    states: dict[str, list[str]] = {}             # key → distinct states, in order
    prev_state = ""
    for ln in script.split("\n"):
        m = heading.match(ln)
        if not m:
            continue
        name, tod, wx = _split_slug_state(m.group(1).strip())
        if not name:
            continue
        state = _state_suffix(tod, wx) or prev_state
        prev_state = state
        key = _norm_name(name)
        if not key:
            continue
        seq.append((name, key, state))
        if state and state not in states.setdefault(key, []):
            states[key].append(state)
    # Pass 2: qualify ONLY the locations that genuinely appear in more than one state.
    out: list[str] = []
    seen: set[str] = set()
    for name, key, state in seq:
        multi = len(states.get(key, [])) > 1
        label = f"{name} - {state}" if (multi and state) else name
        k = _norm_name(label)
        if k and k not in seen:
            seen.add(k); out.append(label)
    return out


def _location_state_index(script: str) -> dict[str, dict[str, str]]:
    """{norm(location): {STATE: the exact canonical name}} for the same slug walk
    _script_locations does. Feeds _canonical_env_name.

    Exists because "tell the writer to use the exact string" is not a guarantee, and the
    state suffix made that gap expensive. MEASURED across 4 live BLOOM breakdowns
    (2026-08-06): shown a list where two entries end in "- DAY"/"- NIGHT", the writer
    generalises and appends its scene heading's hour to OTHER entries too — and it does
    not do so consistently between concurrent batches. Run 4 came back with
    "TOMÁS'S HOUSE - KITCHEN - DAY" from one batch and "TOMÁS'S HOUSE - KITCHEN" from the
    other: 23 environments for 20 places, i.e. exactly the duplicate this canonical list
    was built to kill (25→20, 2026-08-03), re-created by the fix for rule 2. Runs 1-3 were
    clean, which is the point — a prompt instruction that holds 3 times out of 4 is not a
    contract, so the fold below is code."""
    seq_states: dict[str, dict[str, str]] = {}
    for label in _script_locations(script):
        loc, tod, wx = _split_slug_state(label)
        seq_states.setdefault(_norm_name(loc), {})[_state_suffix(tod, wx)] = label
    return seq_states


def _canonical_env_name(name: str, index: dict[str, dict[str, str]]) -> str:
    """Fold an LLM-written environment name onto the canonical entry it means.

    - the place is in the script and the state matches → the canonical spelling, verbatim
    - the place has ONE state in the whole film → the hour is noise the writer added, drop
      it ("TOMÁS'S HOUSE - KITCHEN - DAY" → "TOMÁS'S HOUSE - KITCHEN")
    - the place has SEVERAL states and this name names none of them → left alone: guessing
      which light was meant would silently point a night scene at a daylight sheet, and a
      visible extra asset is the better failure
    - the place is not in the script at all (an interior the slug lines never name) → left
      alone, exactly as before this function existed
    """
    loc, tod, wx = _split_slug_state(name)
    entry = index.get(_norm_name(loc))
    if not entry:
        return name
    state = _state_suffix(tod, wx)
    if state in entry:
        return entry[state]
    if len(entry) == 1:
        return next(iter(entry.values()))
    return name


def _batch_scenes(scenes: list[str], target_secs: int, batch_secs: int = 300) -> list[tuple[str, int]]:
    """Group consecutive scenes into batches, each ~batch_secs of runtime, so one
    LLM call per batch stays within the output-token budget. Returns [(text, secs)]."""
    total = sum(len(s) for s in scenes) or 1
    sec_of = [max(4, round(target_secs * len(s) / total)) for s in scenes]
    batches: list[tuple[str, int]] = []
    buf: list[str] = []
    buf_secs = 0
    for s, sec in zip(scenes, sec_of):
        if buf and buf_secs + sec > batch_secs:
            batches.append(("\n\n".join(buf), buf_secs)); buf, buf_secs = [], 0
        buf.append(s); buf_secs += sec
    if buf:
        batches.append(("\n\n".join(buf), buf_secs))
    return batches or [(scenes[0] if scenes else "", target_secs)]


# Shared Seedance-grammar guidance injected into the shot-direction templates (takeone-seedance-prompt
# skill). Seedance obeys MEASURABLE specs, not mood words — the single biggest quality lever. Kept
# terse so it doesn't crowd out the per-shot content in the (bounded) prompt.
_SEEDANCE_UNITS = (
    "QUANTIFY every spec (Seedance obeys numbers, not mood words): camera FOV in DEGREES from this "
    "table — POV/dream 180°, epic ultra-wide 107°, establishing wide 84°, observational 63°, "
    "neutral/medium 47°, dialogue/portrait 29°, close-portrait 18°, tele-detail 12° (pick the "
    "nearest step, never an arbitrary angle); speed in km/h; white balance in Kelvin (≈3200K warm / "
    "5600K neutral / 8500K cool); atmosphere as % haze or depth in meters; giant scale as "
    "human-height multiples ('as tall as four people'). Left/right is from the CAMERA. Block "
    "geo-spatially — where each figure stands relative to the space and to each other, real distances."
)


#: THE ACTING MASTER PROFILE (ACTING SKILL §6-§7, on disk at the repo root and — like every
#: other skill in this project — never loaded by anything). One profile per recurring
#: character, written ONCE at breakdown time and then re-expressed per scene (§8), which is
#: what holds a performance consistent across 41 shots instead of re-inventing a temperament
#: per prompt. The four rules the skill calls non-negotiable are spelled out because they are
#: the ones a generic "describe the character's acting" instruction reliably drops:
#:   · every tic carries its TRIGGER — "cracks his knuckles" is decoration, "cracks his
#:     knuckles during small talk to fake confidence" is dramaturgy;
#:   · the gait is NAMED, then unpacked into biomechanics;
#:   · at least one "However, when X" clause — the mask and the exact crack. The skill calls
#:     this "the difference between a puppet and a person";
#:   · eye life, which it calls the number-one tell of AI acting.
#: No wardrobe and no camera/colour in here on purpose: the profile has to survive a costume
#: change and a relight, and wardrobe already has its own field on the same object. The
#: original one-clause ban ("NO wardrobe") leaked anyway — measured on BLOOM's 10 characters,
#: 1 profile keyed a body marker to the costume ("too-short suit sleeves" on Tomás Arroyo),
#: which dies the moment the costume does; hence the explicit noun list and the "describe the
#: shoulder, not the jacket" line. Someone ELSE's garment as a mask-break trigger is the skill
#: working (Nuria softens for a stranger wearing her father's work boots) and is carved out.
# Cómo se reconoce que el perfil YA nombra un acento. Se acepta la palabra suelta y las
# formas que un director escribe sin usarla ("Received Pronunciation", "clipped vowels"),
# porque exigir el sustantivo obligaría a reescribir perfiles correctos.
_ACCENT_NAMED = re.compile(
    r"\baccent(?:ed|s)?\b|received pronunciation|\bRP\b|\bbrogue\b|\bdrawl\b|\bvowels\b|\blilt\b",
    re.I)

_ACTING_PROFILE_FIELD = (
    '"acting":"the ACTING MASTER PROFILE — ONE flowing paragraph of 150-220 words, present '
    "tense, every inner state carried by an OBSERVABLE body marker (never 'he is nervous' — "
    "the trembling lip, the heavy swallow, the long inhale). Cover, in this order: physique "
    "and posture as a document of their biography; the psychological engine in one clause; "
    # El ACENTO, por su nombre. El campo ya lo pedía y el escritor lo omitía: medido en
    # BLACKMIRROR 4, 6 de 7 perfiles no lo mencionaban, y Seed Audio cae entonces en
    # General American — en una serie ambientada en Downing Street, y distinto de un plano
    # a otro porque cada síntesis elige por su cuenta. El único personaje que sí lo
    # declaraba ("flat midlands accent") es el único que sonó británico.
    "vocal profile — pitch, THE ACCENT BY NAME (a real one: 'Received Pronunciation', "
    "'Glaswegian', 'Boston Irish'…; when the script names no region say 'neutral' outright, "
    "but NEVER leave the accent unstated), pace, and how the voice breaks under pressure; "
    "signature "
    "and stress tics EACH WITH ITS TRIGGER; what they do to hide what they feel; eye life "
    "(gaze targeting, blink rate and how both shift with the beat); a NAMED walking style in "
    "quotes, then unpacked into weight, step and what the torso does. It MUST contain at "
    "least one clause of the form 'However, when <trigger>, <how posture, gait and face "
    'change>\' — the mask and the exact condition that cracks it. Optionally one softening '
    "target: the single person or thing the face genuinely softens for. THE PROFILE MUST "
    "SURVIVE A COSTUME CHANGE: say nothing about what THIS character wears — no garment, "
    "fabric, fit, cut, sleeve, collar, footwear or accessory of theirs, and no body marker "
    "that depends on one; the same object already carries a 'wardrobe' field and that is "
    "where the costume lives. Describe the shoulder, not the jacket on it. A garment worn by "
    "SOMEONE ELSE stays legal when it is the trigger of a clause (a stranger in her father's "
    "work boots is a trigger, not a costume). NO camera, NO lighting, NO colour either — "
    'those live elsewhere in the prompt."'
)

#: The two acting rules that are about HOW to phrase a beat rather than who the character is,
#: so they belong to the shot pass and not to the profile above.
#: 1. STATES, NOT TRANSITIONS (ACTING SKILL §10) — the skill's own example: "reaches into the
#:    bag, pulls out, winds up" collapses; "mid-throw, arm extended" lands. Take One Studio's beats are
#:    written as processes today, which is exactly the failing form.
#: 2. RESTRAINT (Director_ShotList, "a whispered line beats a shouted one 90% of the time").
#:    Independently corroborated: two separate viewers of Higgsfield's Hell Grind complained
#:    the cast shouts constantly.
_ACTING_BEAT_RULES = (
    "ACTING CRAFT — two rules, both measured:\n"
    "- STATES, NOT TRANSITIONS. Video models fail transitions and nail states. Write the "
    "character ALREADY IN the state — 'mid-throw, arm extended', 'already halfway across the "
    "room', 'jaw already set' — never the process of getting there ('reaches in, pulls out, "
    "winds up'). Chain states beat by beat instead of narrating a continuous process.\n"
    "- RESTRAINT BY DEFAULT. Big emotion only when the moment has earned it; a whispered line "
    "out-acts a shouted one most of the time. Play the suppression, not the outburst.\n"
    "- EYES LEAD THE THOUGHT: the gaze reaches the target a touch before the head turns, and "
    "the thought is readable in the eyes before the words come."
)

#: POSITIVE-ONLY PHRASING (takeone-seedance-prompt skill, "Prompting rules"). Measured on BLOOM's
#: 40 boards: 95 of 148 panels contain a negative clause, 146 occurrences, and the top offenders
#: are all the same shape — "Locked static, no camera motion" ×5, "No movement, held static
#: pose" ×3. The skill's warning is that a negation reinforces what it negates, so "no camera
#: motion" is a worse way to ask for a locked-off frame than "camera locked off, framing held".
#:
#: WHAT THIS RULE IS WORTH, MEASURED (2026-08-07, independent 3-arm experiment, N=6 per arm,
#: BLOOM's 41 shots through /api/shots/enhance, scored on the 35 PEOPLED shots):
#:   OLD     no _POSITIVE_ONLY, no _ACTING_BEAT_RULES, no cast profiles → 28.2 shots-with-
#:           negation, 40.0 negative fragments
#:   NEW     current code, cast profiles passed                        → 23.3 / 32.5, p=0.0011
#:   CONTROL current code (both rule blocks IN) but cast=[]            → 27.2 / 37.2,
#:           vs OLD p=0.15 — INSIDE VARIANCE
#: CONTROL−OLD isolates these two rule blocks: 1.0 shots, not established. NEW−CONTROL is the
#: CAST PROFILES: 3.9 shots. So ~79% of the win this wording is casually credited with is
#: actually `characters` being passed at all. Do not re-derive this, and do not credit the
#: prompt for the cast's work. KEPT anyway, and the reason is the numbers, not sentiment:
#: CONTROL−OLD points the right way, the block is ~150 tokens of a system prompt that is
#: prompt-cached across a film's batches, and deleting it on p=0.15 would be making a
#: behaviour change out of an unestablished result — the exact error this note exists to stop.
#: Settling it needs a much larger N, not another 6-run pass.
_POSITIVE_ONLY = (
    "POSITIVE PHRASING ONLY. State what IS there and what DOES happen, never what is absent "
    "or forbidden — a negation tends to reinforce the thing it negates. Write 'camera locked "
    "off, framing held' rather than 'no camera motion'; 'she holds the pose, weight settled' "
    "rather than 'no movement'; 'the frame stays on him' rather than 'nothing else enters'.\n"
    # SUPPRESSION is the case the rule above does not cover on its own, and acting direction
    # is made of it. First pass over BLOOM's 41 shots WITH the rule above and without this
    # paragraph: 35 negative fragments survived and almost all were withheld reactions —
    # "he does not lift his head", "he does not blink", "his stride does not waver". The
    # note is RIGHT (restraint is the direction) and the phrasing is wrong: naming the blink
    # is how you get a blink. The fix is not to drop the beat but to write its positive face.
    "This binds hardest to WITHHELD reactions, which is most of acting direction: a "
    "suppressed movement is written as the held state, not as the movement denied. 'His head "
    "stays down, eyes on his hands' rather than 'he does not lift his head'; 'lids stay "
    "open, gaze steady' rather than 'he does not blink'; 'the stride holds its length' "
    "rather than 'his stride does not waver'; 'the breath stays shallow and even' rather "
    "than 'his breath does not change'. Same beat, stated as what the body IS doing."
)


class ShotPayloadError(ValueError):
    """A shot in an /api/shots/enhance batch is the wrong SHAPE. The caller's mistake,
    so it answers 422 — not 502, which says the LLM upstream broke."""


def _validate_shot_payload(shots: list[dict]) -> None:
    """Refuse a malformed shot batch LOUDLY, before enhance_shots does any work.

    `shots` is `list[dict]` in the request model ON PURPOSE — the shot payload is
    pass-through and must not be schema-pinned — so pydantic checks that each entry is a
    dict and nothing more. Everything inside it was therefore unchecked, and four shapes
    were measured (2026-08-07, through the real endpoint, 3/3 identical runs) doing real
    damage while reporting 200 OK:

      · characters: "Beni"       → the old `isinstance(v, (str, bytes))` guard in
        _shot_cast returned None, i.e. "the caller said nothing", so the ENTIRE
        character-less gate switched itself off. A caller that sends a bare name instead
        of a list silently gets pre-gate behaviour and is never told. (SHOT_101: acting
        direction written, gate never consulted.)
      · characters: {}           → fell straight through that guard, iterated to [], and
        [] is the ASSERTION "nobody is in this frame" — so a malformed value DELETED the
        acting direction. (SHOT_102: performance came back "".) Same for ["", " "] and
        [None]: non-empty lists that filter down to nothing.
      · characters: {"Beni": 1}  → iterated the dict KEYS and built the cast ["Beni"] out
        of a dict lookup. Proved by contrast: {"":1} cleared the performance (SHOT_104)
        while {"Beni":""} did not (SHOT_105) — the key decides, the value is ignored.
      · dialogue: "a string"     → _dlg iterated the string character by character and the
        endpoint answered 502 {"detail":"Shot enhance failed: 'str' object has no
        attribute 'get'"} — an internal traceback fragment as the API's answer to a bad
        body. Worse in a batch: one malformed shot took 14 good ones down with it
        (measured, SHOT_201 got nothing because SHOT_202 was malformed).

    WHY 422 AND NOT A LOG-AND-CARRY-ON. There is no safe default to carry on WITH. The
    three real shapes mean three different things — absent = "no opinion", [] = "nobody
    in frame, delete the direction", [names] = "these people" — and a malformed value
    gives no basis to pick one; guessing is exactly what produced the two failures above.
    A 4xx also lands where a human can see it: autoEnhanceShots counts the failed batch
    and runDirectorPass turns it into the sticky "Director pass INCOMPLETE" toast, which
    quotes `detail` verbatim (client.ts passes a string detail straight into Error).
    422 specifically, because FastAPI already answers 422 for the same class of mistake
    when pydantic CAN see it (a non-dict shot entry) — the code should not depend on
    which layer happened to catch the wrong type. A logger.warning goes out too, so the
    rejection is findable in the server log by an operator who missed the toast.

    NULL is the one shape that is NOT an error: `characters: null` / `dialogue: null` is
    the wire form of "no value", indistinguishable in intent from omitting the key, and
    that is how it already behaved.

    UNCHANGED, by construction: key absent, a list of names, and an empty list. Verified
    byte-identical to the pre-fix responses over the full shape matrix."""
    RULE = {"characters": "'characters' must be a list of names — an empty list means nobody "
                          "is in frame; omit the key to say nothing about the cast",
            "dialogue": "'dialogue' must be a list of line objects"}

    def reject(sid: str, key: str, why: str) -> None:
        msg = f"shot {sid}: '{key}' {why}. {RULE[key]}."
        logger.warning("[EnhanceShots] REJECTED batch of %d — %s", len(shots), msg)
        raise ShotPayloadError(msg)

    def first_bad(seq: list, ok: type) -> tuple:
        """The first entry that is not `ok`, as a 1-tuple, or () — NOT `None` as the
        sentinel. `None` is itself one of the values being screened for: the first cut of
        this validator used `next(..., None)` and `characters: [null]` therefore passed
        the type check and died on `.strip()` further down, turning the very silent-502
        this function exists to remove back on. Caught by the shape matrix (M8/N7)."""
        for x in seq:
            if not isinstance(x, ok):
                return (x,)
        return ()

    for s in shots:
        sid = str(s.get("id"))
        v = s.get("characters")
        if v is not None:
            if not isinstance(v, list):
                reject(sid, "characters", f"is a {type(v).__name__}, not a list")
            bad = first_bad(v, str)
            if bad:
                reject(sid, "characters", f"contains a {type(bad[0]).__name__}, not a name")
            # A NON-EMPTY list that filters down to nothing is not the "nobody in frame"
            # assertion — it is an unusable value that used to produce the same deletion.
            if v and not any(x.strip() for x in v):
                reject(sid, "characters", "is a non-empty list with no usable name in it")
        d = s.get("dialogue")
        if d is not None:
            if not isinstance(d, list):
                reject(sid, "dialogue", f"is a {type(d).__name__}, not a list")
            bad = first_bad(d, dict)
            if bad:
                reject(sid, "dialogue", f"contains a {type(bad[0]).__name__}, not a line object")


def _directing_craft() -> str:
    """The directing half of skills/Director_ShotList.md, prefixed with what it does NOT
    govern here. Empty string when the file is missing or DIRECTING_CRAFT=0.

    Two of its rules are overridden on purpose, and saying so inside the prompt is the
    point — an instruction the model has to reconcile silently is how contradictory craft
    guidance degrades output instead of improving it:

      · Lens in millimetres ("Low-angle 35mm dolly-in"). This project's shot list bans mm
        and f-stops on the `camera` field, and quantifies with FOV in degrees instead
        (_SEEDANCE_UNITS), which is what the generation model actually reads. Measured:
        18/32 beats carried a table FOV with that block, 0/32 without.
      · The HTML deliverable, the revision protocol and the style-prefix law from the
        sections around it — not loaded at all, see _load_skill_section.

    Env-gated and defaulted ON, unlike SCENE_GEO_LAYOUT: this is prose about how to think
    about a scene, not a structural block that can invent geography.
    """
    if os.getenv("DIRECTING_CRAFT", "1") != "1":
        return ""
    body = _load_skill_section("Director_ShotList.md", "How to direct")
    if not body:
        return ""
    return (
        "\n\nDIRECTING CRAFT — read this as the standard for the fields below. Two "
        "adjustments for THIS shot list: express camera as size + move + motivation in "
        "prose (this pipeline quantifies optics later, in degrees of FOV, so no lens "
        "millimetres or f-stops here), and keep continuity where it says to keep it — in "
        "your head, surfacing as concrete language inside the fields, never as a block of "
        "its own.\n\n" + body + "\n"
    )


#: THE DIALOGUE SCENE PROMPT — the audio half of a shot, written here because nothing
#: downstream can write it.
#:
#: Until this field existed, a shot's dialogue was rendered ONE CALL PER LINE and the
#: clips were concatenated with 0.35 s of silence between them (server._concat_audio_
#: files), so no character could ever interrupt another: every argument in every film
#: came out as two people politely taking turns. Seed Audio renders a whole scene in ONE
#: call — overlaps and all — when it is given one identity clip per speaker (@Audio1..
#: @AudioN, audio-generation.md §4) and a prompt that DIRECTS the overlap. The clips the
#: backend can make by itself; the direction it cannot, because writing it needs the
#: lines, their emotions and each speaker's ACTING MASTER PROFILE at the same time, and
#: this is the only pass that holds all three. A mechanical template would produce a
#: mechanical performance, which is the thing being fixed.
#:
#: The shape below is the user's own, validated live on 2026-08-09: a one-line take/
#: acoustics header, a VOICES block, "PERFORM EXACTLY THIS", numbered beats where the
#: interruption is named as an instruction ("the instant X lands the word 'that', Y cuts
#: straight in ON TOP of him"), and a held room tone to close. Their reference runs ~700
#: characters, hence the 900 ceiling: the API's own cap is 2048 (§4, §9) and the render
#: is skipped above it, and every character here is also breakdown output tokens the
#: batch budget (ideal_shots * 260 + 4000) did not previously have to carry.
#:
#: OPTIONAL, and omitted for most shots on purpose — one speaker cannot overlap anybody,
#: and Seed Audio takes at most 3 audio references. A breakdown that never writes it
#: behaves exactly as breakdowns did before it existed.
_DIALOGUE_SCENE_FIELD = (
    '"dialogue_scene":"OPTIONAL — include ONLY when TWO OR THREE different characters '
    "speak in THIS shot; omit the key entirely otherwise (one voice cannot overlap "
    "itself, and the audio model accepts at most three voices). ONE Seed Audio scene "
    "prompt, plain text with newlines, that makes those characters speak OVER each "
    "other, built from this shot's dialogue lines, their emotions and each speaker's "
    "ACTING MASTER PROFILE. Exactly four parts, in this order: (1) ONE opening line — "
    "how many people, that it is a single continuous take, where it happens and how the "
    "space sounds, and that there is no music and no sound effects; (2) a line reading "
    "VOICES, then ONE line per speaker in the order they FIRST speak in this shot, "
    "formed as 'NAME (@Audio1) — ' followed by that character's vocal profile (sex, age "
    "band, accent, pitch and texture, pace) and their emotional state in this shot. "
    "Number the @Audio tags 1, 2, 3 strictly in first-speaking order and NEVER reorder "
    "them — the tag is positional and mis-numbering hands a line to the wrong voice. Use "
    "the character's NAME, never their asset id; (3) the line 'PERFORM EXACTLY THIS. The "
    "voices must overlap.'; (4) numbered beats, one per line, covering every line of "
    "dialogue in order — each names who speaks, HOW they speak it, and then the line "
    "itself in double quotes, VERBATIM and identical to its dialogue[].text. At least "
    "one beat MUST direct an explicit interruption, naming the word the interrupter cuts "
    "in on and telling them not to wait for the other to finish, and the interrupted "
    "character MUST be told to keep pushing through underneath rather than stop and "
    "restart. Close with a final numbered beat holding a stated number of seconds of "
    "room tone. Write the DIRECTIONS in English; the quoted lines stay in the script's "
    "original language. Invent NO line that is not in this shot's dialogue. At most 900 "
    'characters in total."'
)


def _breakdown_system_prompt(target_secs: int, max_shots: int, ideal_shots: int, per_shot: int,
                             segment_max_secs: float = SEGMENT_MAX_SECS) -> str:
    """The production-coordinator breakdown schema + rules, scoped to ONE batch of
    scenes (part of a longer film). Same contract as the single-call version."""
    return (
        "You are a VFX/animation production coordinator.\n"
        "You are given ONE segment (a few consecutive scenes) of a longer film. Break down "
        "ONLY this segment. Output a JSON object (no markdown fences) with:\n"
        '{"assets":[{"id":"ASSET_001","name":"...","type":"character|voice|prop|environment|fx",'
        '"visual_description":"concise, max 60 words","depends_on":[]}],'
        '"shots":[{"id":"SHOT_001","segment":"SEG_A","scene":"...","action":"...",'
        '"layout":"where everything IS in frame","visual_description":"max 60 words",'
        '"assets_used":["ASSET_001"],"shot_size":"medium","camera_move":"dolly-in",'
        '"camera":"...","lighting":"...","duration_sec":4,'
        '"dialogue":[{"characterId":"ASSET_001","text":"the spoken line, verbatim","emotion":"defiant"}],'
        + _DIALOGUE_SCENE_FIELD + "}]}\n"
        "IDs are LOCAL to this segment (ASSET_001…, SHOT_001…); they are renumbered globally "
        "on merge. Use a character's real NAME consistently so the same person merges across "
        "segments.\n"
        "LANGUAGE: write ALL fields in ENGLISH (action, visual_description, camera, "
        "lighting, names) regardless of the script's language — generation models "
        "adhere best to English. EXCEPTION: dialogue[].text stays VERBATIM in the "
        "script's original language (it is the spoken line; never translate it) — and so "
        "do the quoted lines inside dialogue_scene, for the same reason; its DIRECTIONS "
        "stay English.\n"
        "Asset classification rules (apply strictly):\n"
        "- ANY humanoid figure is type \"character\" — alive, dead, robot, android, "
        "hologram, mannequin, or background extra. Humanoids need identity-consistent "
        "treatment (character sheet + face reference) across shots, even corpses.\n"
        "- \"prop\" = inanimate objects. \"environment\" = places. \"fx\" = visual "
        "effects (glows, particles, energy, weather).\n"
        # A VOICE IS NOT A FACE — the exception the humanoid rule above needs. An entity
        # that SPEAKS but has no body on screen is real to the film (it holds dialogue,
        # it needs casting) and unreal to the camera. Typed "character" it gets a sheet:
        # BLACK MIRROR, 2026-08-15 — the writer created "Electronic Kidnapper Voice" as a
        # character, its own visual_description saying "no visual form", and attached it
        # to SHOT_021/023/025 alongside the hostage. A character asset there means a face
        # rendered, paid for, and sent to the board as a person standing in the room.
        # "voice" keeps the dialogue routing (it is a speaker like any other) and drops
        # the picture: stage 3 casts it a voice, and no image reference is ever built
        # from it, so it cannot appear in a frame it has no business being in.
        "- An entity that SPEAKS but is NEVER SEEN is type \"voice\", not \"character\": "
        "a phone voice, a distorted kidnapper on a speaker, a PA announcement, a radio "
        "operator, an off-screen narrator, a computer. It gets a VOICE, never a picture. "
        "Give it an empty visual_description — there is nothing to draw. If the speaker "
        "IS seen at any point in this script, it is a \"character\" instead.\n"
        # A SOUND IS NOT AN ASSET. Every asset is rendered as an IMAGE and paid for, so an
        # audio cue costs a picture of a noise — and the model has to invent what a noise
        # looks like. GLADIATOR II, 2026-08-14: the writer created an "fx" asset called
        # "Warning Bell Tone", described as "deep resonant repeating bell clang, distant
        # echo", and Seedream returned an East Asian temple bell in a pagoda over a river
        # valley, with sound-wave spirals drawn in the air — in a Roman-Numidian siege. It
        # was generated, approved, and became attachable as a visual reference for the
        # scene. The bell that RINGS is a sound; the bell that HANGS is a prop.
        "- A SOUND IS NEVER AN ASSET. Bells, horns, drums, alarms, screams, ambience and "
        "music are audio, and every asset is rendered as a picture — never create an "
        "asset for a noise. If the object making the sound is SEEN, create it as the "
        "\"prop\" it is (\"Bronze warning bell\"), described as the object, not the sound.\n"
        # AN ASSET THAT DEPICTS A PERSON IS NOT AN INDEPENDENT ASSET. Every asset is
        # rendered alone, from its own description, so a prop that CONTAINS someone gets
        # a stranger's face: DRAMA QUEEN 3 has a prop "2011 Polaroid photo — faded
        # coffee-ringed polaroid, young Joel and Mara grinning", generated with zero
        # character references, so the couple in the photograph on the protagonists'
        # fridge are two people the film has never met. BLACK MIRROR, 2026-08-15: the
        # same shape again, and this time invisible to a name scan — "Conference Plasma
        # Screen, showing hostage video feed" never writes "Susannah", yet the woman on
        # that screen must be her. Only the writer, who has the scene, can see it; so it
        # is declared here, and stage 3 then holds the asset until what it depicts is
        # approved and renders it FROM those approved sheets.
        "- depends_on: if an asset DEPICTS another asset — a photograph of someone, a "
        "screen or monitor showing them, a portrait, a statue, a wanted poster, a mirror, "
        "a news feed — list the ids of everyone/everything depicted in it. Write the "
        "description as the OBJECT (\"framed photograph on the desk\"), never as the "
        "person, and let depends_on carry who is in it. An asset that depicts nobody "
        "leaves depends_on empty. Never point an asset at itself.\n"
        # A PROP SHEET IS A REFERENCE, NOT A PHOTOGRAPH OF A SCENE. Every prop and fx
        # asset is composited into shots later, so any room baked into its sheet travels
        # with it into every shot that uses it. Measured on BLACK MIRROR, 2026-08-15: the
        # briefing-room screen came back mounted on a ROUGH NATURAL STONE WALL, in a film
        # whose two locations are an oak-panelled briefing room and a bedroom — the
        # description said "wall mounted", nobody said which wall, and the model invented
        # one. The fix is not to attach the room; it is to stop describing one.
        "- A \"prop\" or \"fx\" visual_description describes the OBJECT ALONE — its form, "
        "material, colour, condition, scale. Never write the room, furniture, floor, wall "
        "or view around it, and never say where in a scene it sits; that belongs to the "
        "shot, not to the asset. \"Corded grey desk phone, coiled cable, worn keypad\" — "
        "not \"desk phone on the nightstand beside the bed\".\n"
        "- Create ONE \"environment\" asset for EVERY distinct scene location (each "
        "INT./EXT. heading) — a scene whose location has no environment asset is an "
        "incomplete breakdown.\n"
        # HELL GRIND rule 2, quoted: "LOCATIONS WORK THE SAME WAY: day, night and rain
        # are three different assets." One sheet cannot serve both: MEASURED on BLOOM,
        # a single "ARROYO FARM" asset covered a day scene and a night scene, and a
        # single "Field Lab" covered day, night and later.
        "- A location the film visits under DIFFERENT LIGHT is a DIFFERENT environment "
        "asset — day, night, dawn, dusk, rain are separate assets, named "
        "\"<LOCATION> - DAY\" / \"<LOCATION> - NIGHT\". Never describe two lighting states "
        "in one environment's visual_description; the render mixes them between shots.\n"
        "Rules:\n"
        f"- TARGET RUNTIME for THIS segment: {target_secs} seconds.\n"
        f"- Maximum shots: {max_shots}. Aim for around {ideal_shots} shots.\n"
        # Duration comes from the BEAT, not from a default. Asking for "per_shot ±2s"
        # produced scenes where every shot was the same length, which is a cut with no
        # pulse — the single clearest sign nothing decided the pacing.
        # SEGMENTS. This is the change that makes a rhythm possible at all: one render
        # call is a SEGMENT of up to 15s that may contain SEVERAL shots, and the model
        # cuts between them itself. A shot inside a segment is free of the 4s floor —
        # which is why a 1s reaction or a 1.5s insert can finally exist.
        '- "segment" REQUIRED: consecutive shots that belong to ONE continuous piece of '
        "action share the same segment label (SEG_A, SEG_B…). A segment is rendered as "
        f"ONE take, so its shots MUST be the same location and MUST sum to at most "
        f"{segment_max_secs:g}s. Start a new segment on a change of location, a time jump, "
        "or when the sum would exceed the ceiling.\n"
        "- GROUP shots into segments of 2-4 wherever the action is continuous. A segment "
        "of one shot is correct only for a true standalone beat.\n"
        # El espectador NO perdona la elipsis física. En FARO el desglose escribió "la
        # encuentra en las rocas" y luego "ella está dentro": nunca se la ve levantar,
        # cruzar la puerta ni dejarla en el suelo, y el resultado se lee como un error de
        # continuidad constante. Una elipsis de TIEMPO se acepta; una de CUERPO no.
        "- COVER THE TRANSITIONS. When a character changes posture or place between one "
        "beat and the next — lying to standing, outside to inside, carried to set down, "
        "seated to at the window — you MUST write the shot that shows the change "
        "happening. Never jump from one body position to another. A cut from someone on "
        "the floor to the same person standing, with nothing in between, reads as a "
        "mistake, not as an ellipsis. Time may be skipped; a body moving may not.\n"
        f"- duration_sec comes from what the beat NEEDS, not from a default. Use the "
        f"function of the shot: 0.5-2s for a reaction, an eye movement, an insert or a "
        f"prop hit; 3-5s for a normal action start to finish; 5-8s for interaction or "
        f"light dialogue; 8-12s for a complete action or an emotional beat that lingers; "
        f"12-15s for a dialogue-driven scene. Fractional values like 1.5 or 2.5 are "
        f"allowed and wanted. Within one scene the lengths MUST vary — a film whose "
        f"shots all sit in one band has one gear. Around {per_shot}s is the average to "
        f"land near, never the value to repeat.\n"
        f"- A shot ALONE in its segment must still be {SHOT_MIN_SECS}-{SHOT_MAX_SECS}s "
        f"(it becomes its own render). Shots SHARING a segment may be as short as "
        f"{SHOT_MIN_IN_SEGMENT}s.\n"
        f"- The sum of all duration_sec MUST NOT exceed {target_secs + 5}.\n"
        # The old rule asked for a MOVE and a pacing word, never a SIZE — so most shots
        # named none and the render invented the framing. Coverage is the size pattern
        # across a scene; without it every shot lands on the same medium.
        # Closed vocabularies, not prose. Free text cannot be checked, which is why the
        # 180-degree axis and "three identical sizes in a row" were never enforceable.
        '- "shot_size" REQUIRED, exactly one of: establishing, wide, full, medium, '
        'medium close-up, close-up, extreme close-up, insert, pov, ots, two-shot.\n'
        '- "camera_move" REQUIRED, exactly one of: locked, pan, tilt, dolly-in, '
        'dolly-out, push-in, tracking, handheld, crane, whip-pan, zoom.\n'
        '- "camera" REQUIRED: the same two in prose, plus pacing. No lens mm / f-stops.\n'
        # Layout is the scene's GEOGRAPHY — who stands where, what leads the eye. Kept
        # apart from action because that separation is what makes screen direction and
        # the 180-degree axis checkable rather than a matter of opinion.
        '- "layout" REQUIRED: where everything IS at the start of the shot — subject '
        "position in frame, what is foreground/background, which side of frame each "
        "person occupies. Describe the arrangement, not the movement.\n"
        "- COVERAGE: vary the size across a scene — NEVER three consecutive shots of the "
        "same size. Cover a conversation the way it would be shot: a wider shot to place "
        "the people in the room, singles on each speaker, a closer size on the beat that "
        "turns, an insert on what matters. The size should change because the drama "
        "changed, not on a rota.\n"
        '- "lighting" REQUIRED: ONE motivated lighting line — direction + temperature + quality.\n'
        '- "action" REQUIRED: ONE continuous movement, present tense, specific to body parts '
        "with quantified degree; prefer slow, gentle, continuous motion; emotion as visible "
        "physical detail, never abstract words.\n"
        '- "dialogue" REQUIRED on every shot (use [] when no one speaks): extract the EXACT '
        "spoken lines belonging to that shot, verbatim; characterId = the speaking character's "
        "asset id; do NOT invent lines.\n"
        # MEASURED, and why this is no longer one sentence: an 18-line script came back as
        # 8 lines on THE DIVORCE DRAMA QUEEN (2026-08-12), and two successive passes over
        # the same script dropped DIFFERENT lines — a model compressing, not extracting.
        # What it kept was the first line of each exchange; what it dropped was the middle,
        # which in an argument IS the escalation. Repeating "verbatim" was not enough: the
        # writer has to be told that dropping is a DEFECT rather than editing, and that the
        # overflow goes in another shot instead of on the floor.
        "- EVERY spoken line in the script must appear in EXACTLY ONE shot. This is a "
        "TRANSCRIPTION, not a summary. Short interjections and one-word replies carry the "
        "escalation of an argument and are the first thing a summary throws away. Do not "
        "merge two lines into one, do not skip a reply because it is short, and do not drop "
        "a line because the shot already has dialogue - give it another shot instead. A "
        "script line that appears in no shot is a DEFECT, and it is counted after you "
        "answer.\n"
        # The 60-word ceiling on the next line is why this bullet exists at all: a scene
        # prompt is 100-150 words by construction (a VOICES block plus a beat per line),
        # so without the carve-out the model has two contradictory instructions and
        # resolves them by amputating the direction that makes the voices overlap.
        '- "dialogue_scene" OPTIONAL — write it ONLY for a shot where two or three '
        "different characters speak, exactly as the field describes above, and omit the "
        "key entirely everywhere else. It is what lets them interrupt each other; a shot "
        "without it is spoken one line at a time. It is the ONE field exempt from the "
        "60-word ceiling below (its own limit is 900 characters).\n"
        "- One shot per major camera setup. Keep ALL string values under 60 words.\n"
        # The craft goes BEFORE the closing JSON instruction so the last thing the model
        # reads is still the output contract — the same placement reason _NEUTRAL_SHEET_BLOCK
        # documents for sitting last-but-one.
        + _directing_craft() +
        "Return ONLY valid, complete JSON — do not truncate."
    )


def _norm_name(s: str) -> str:
    """Canonical dedup key for asset / location names: lowercased, separators
    (- – — /) folded to spaces, whitespace squeezed. WITHOUT the separator fold,
    "School - Hallway" (from a scene heading INT. SCHOOL - HALLWAY - DAY) and
    "School Hallway" (from the LLM asset list) hash to DIFFERENT keys, so the
    breakdown merge AND _ensure_scene_environments both miss the match and a
    DUPLICATE environment gets created + referenced together in the same shots
    (observed 2026-07-17: ASSET_019/031 + ASSET_020/032 school-env dup pairs)."""
    import re
    return re.sub(r"\s+", " ", re.sub(r"[-–—/]", " ", (s or "").lower())).strip()


def _ensure_scene_environments(assets: list, shots: list) -> int:
    """Every scene location MUST have an ENVIRONMENT asset. The generator regularly
    lists scenes (Observatory Exterior, Upper Atmosphere…) without creating one,
    which fails Producer-QC "Completeness" on EVERY regen (observed: 4 identical
    fails in a row — the LLM repeats the same gap). Deterministic code-side
    guarantee instead of LLM roulette: synthesize a minimal environment asset per
    uncovered location (description grounded in that scene's first shot visual so
    nothing is invented) and link it to the scene's shots. Returns #added.

    STATE-AWARE since 2026-08-06 (HELL GRIND rule 2 — "LOCATIONS WORK THE SAME WAY: day,
    night and rain are three different assets"). The backstop has to split the same way
    the canonical list does, or a location the writer covered at DAY only would count the
    NIGHT scene as covered and the night sheet would never exist. Only locations the film
    visits under MORE THAN ONE light are qualified; everything else keeps the exact key it
    had before, which is why this pass still adds 0 assets to BLOOM's stored breakdown."""
    import re

    def _loc_state(s: str) -> tuple[str, str]:
        """(location, canonical state) for a scene heading OR an environment asset name.
        Replaces the old inline _clean: same prefix strip and whitespace squeeze, but the
        time-of-day is RETURNED instead of thrown away (and PRE-DAWN no longer leaves the
        location named "SEAWALL - PRE", which the old `[-–—]\\s*(…DAWN)\\b.*$` did)."""
        s = re.sub(r"^(INT|EXT|I/E|EST)[./\s]*", "", (s or "").strip(), flags=re.I)
        loc, tod, wx = _split_slug_state(re.sub(r"\s+", " ", s))
        return loc.strip(" -–—."), _state_suffix(tod, wx)

    # Fold separators too (see _norm_name) so "school - hallway" ≡ "school hallway"
    # and a scene-heading location matches an already-listed environment.
    _norm = _norm_name

    def _idnum(aid) -> int:
        m = re.search(r"(\d+)$", str(aid or ""))
        return int(m.group(1)) if m else 0

    seq = max([_idnum(a.get("id")) for a in assets] or [0])
    by_scene: dict = {}
    for sh in shots:
        by_scene.setdefault(str(sh.get("scene") or ""), []).append(sh)

    # Which locations appear under more than one light. Walked in SHOT order (= scene
    # order), because a heading with no time of day — BLOOM's "INT. FIELD LAB", which the
    # writer emitted for the script's "INT. FIELD LAB - LATER" — inherits the previous
    # scene's state exactly as _script_locations does it.
    states: dict[str, list[str]] = {}
    scene_state: dict[str, str] = {}
    prev_state = ""
    for loc in by_scene:
        cleaned, st = _loc_state(loc)
        st = st or prev_state
        prev_state = st
        scene_state[loc] = st
        n = _norm(cleaned)
        if n and st and st not in states.setdefault(n, []):
            states[n].append(st)

    def _key(location: str, state: str) -> str:
        """The coverage key: the location, plus its state ONLY where the film uses more
        than one. A single-state location therefore hashes to the same string it always
        did — the 20-environment BLOOM baseline is untouched."""
        n = _norm(location)
        return f"{n} {state.lower()}" if (state and len(states.get(n, [])) > 1) else n

    env_norms = []
    # …and WHICH asset each key belongs to. The list above answered "is this scene
    # covered"; the id is what the second pass needs to link a covered scene's shots.
    env_ids: dict[str, str] = {}
    for a in assets:
        if str(a.get("type") or "").lower() != "environment":
            continue
        aloc, ast = _loc_state(a.get("name") or "")
        _k = _key(aloc, ast)
        env_norms.append(_k)
        if _k and _k not in env_ids and a.get("id"):
            env_ids[_k] = str(a["id"])

    added = 0
    for loc, scene_shots in by_scene.items():
        cleaned, _st = _loc_state(loc)
        state = scene_state.get(loc, "")
        n = _key(cleaned, state)
        # Skip empty and generic scene-code fallbacks (SC_01 from the merge default) —
        # a code is not a filmable location to synthesize an environment for.
        if not n or re.fullmatch(r"sc[-_ ]?\d+", n):
            continue
        # covered when an environment name and the location contain one another
        # ("Deep Space Starfield" covers scene "Deep Space", and vice versa)
        if any(en and (en in n or n in en) for en in env_norms):
            continue
        seq += 1
        aid = f"ASSET_{seq:03d}"
        name = cleaned.title() if (cleaned.isupper() or cleaned.islower()) else cleaned
        # A synthesized asset for a two-state location must SAY which state it is, or the
        # sheet it produces is a coin flip between the two lights (rule 2).
        if state and len(states.get(_norm(cleaned), [])) > 1:
            name = f"{name} - {state}"
        first_visual = next((str(s.get("visual_description") or "").strip()
                             for s in scene_shots if s.get("visual_description")), "")
        desc = (f"The {name} location. {first_visual}".strip())[:400] \
            or f"The {name} location as described in the script."
        assets.append({"id": aid, "name": name, "type": "environment",
                       "visual_description": desc})
        env_norms.append(n)
        env_ids[n] = aid
        for sh in scene_shots:
            used = sh.setdefault("assets_used", [])
            if aid not in used:
                used.append(aid)
        added += 1

    # ── SECOND PASS: a covered scene's shots must reference the room they happen in ──
    #
    # The loop above links a synthesized environment to every shot of its scene, and did
    # nothing at all when the writer had ALREADY created the asset — the scene counted as
    # covered and the per-shot link was never checked. So a shot could sit in a scene whose
    # room exists and not name it, which nothing downstream could tell from a shot that
    # genuinely has no location.
    #
    # It cost a visibly different room. DRAMA QUEEN 3, 2026-08-14: SHOT_001, SHOT_007 and
    # SHOT_011 carried ASSET_003 "KITCHEN — 2:19 AM"; SHOT_003 carried Joel and Mara only.
    # The storyboard endpoint reserves its two environment slots from the SHOT's own asset
    # list (server.py, `env_a`), so SHOT_003's board went out with 4 identity references
    # and NO room — no angle sheet, no base plate — and Seedream drew a different kitchen,
    # in a different light, for one board of a four-board scene.
    #
    # This is not invention: the scene is one place and the breakdown already said which.
    # It is the same link the pass above has always made, applied to the case it skipped.
    linked = 0
    for loc, scene_shots in by_scene.items():
        cleaned, _st2 = _loc_state(loc)
        n = _key(cleaned, scene_state.get(loc, ""))
        if not n or re.fullmatch(r"sc[-_ ]?\d+", n):
            continue
        # Same containment rule the coverage test uses, so a scene is linked to exactly
        # the asset that made it count as covered.
        aid = env_ids.get(n) or next((i for k, i in env_ids.items()
                                      if k and (k in n or n in k)), "")
        if not aid:
            continue
        for sh in scene_shots:
            used = sh.setdefault("assets_used", [])
            if aid not in used:
                used.append(aid)
                linked += 1
    if linked:
        logger.info("[Breakdown] linked %d shot(s) to the environment of the scene they "
                    "happen in — without it their boards are drawn with no room reference",
                    linked)
    return added


# Words that make an asset a CONTAINER for someone else's likeness. The backstop below
# only fires inside one of these: without the scoping, "MICHAEL'S OFFICE" would declare a
# dependency on Michael, and an office does not depict its owner — it belongs to him.
_DEPICTION_WORDS = (
    "photo", "photograph", "polaroid", "snapshot", "picture", "portrait", "headshot",
    "mugshot", "poster", "painting", "sketch", "drawing", "statue", "bust", "sculpture",
    "screen", "monitor", "display", "television", "tv", "projection", "hologram",
    "mirror", "footage", "feed", "video", "broadcast", "newspaper", "magazine", "billboard",
)


#: Los principios del contrato sd25-pe que gobiernan el PROMPT que se envía, no la
#: conducta de un agente conversacional. El propio repo aprendió con Director_ShotList
#: que pegar un fichero entero dirigido a otro actor le da al escritor dos leyes
#: contradictorias y gana la más larga: el 2 ("reorganiza SIEMPRE con la plantilla"), el
#: 4, el 5 ("pregunta lo menos posible") y el 9 ("devuelve una sola versión") hablan de
#: cómo se comporta el agente, y aquí no hay agente que pregunte ni versiones que elegir.
#: Estos siete describen el artefacto y son los que este pipeline incumplía.
_SD25_PRINCIPLES = (1, 3, 6, 7, 8, 10, 11)


def sd25_contract() -> str:
    """Los principios innegociables aplicables, leídos del contrato vendorizado.

    941 líneas en `.agents/skills/sd25-pe/SKILL.md`, citadas en comentarios por todo el
    código y abiertas por ninguno hasta hoy. "" si el fichero no está — un despliegue sin
    el skill emite exactamente el prompt que emitía antes.
    """
    import re
    sec = _load_skill_section(".agents/skills/sd25-pe/SKILL.md", "Non-Negotiable Principles")
    if not sec:
        return ""
    keep = []
    for m in re.finditer(r'^(\d+)\.\s+(.+?)(?=\n\d+\.\s|\Z)', sec, re.M | re.S):
        if int(m.group(1)) in _SD25_PRINCIPLES:
            keep.append("- " + " ".join(m.group(2).split()))
    if not keep:
        return ""
    return ("THE SEEDANCE 2.5 CONTRACT — these are the platform's own non-negotiable "
            "rules for the prompt you are writing. Obey them over any habit:\n"
            + "\n".join(keep) + "\n")


def _ambiguous_nouns(shots: list[dict]) -> list[tuple[str, list[str]]]:
    """Sustantivos que nombran a MÁS DE UN asset aprobado de este board.

    "phone" con `Blackberry Mobile Phone` y `Corded Bedside Desk Phone` en la misma
    escena no identifica nada, y el resultado se ve en pantalla: BLACK MIRROR V3, suena
    el fijo y el personaje levanta el móvil. Se compara el sustantivo FINAL de cada
    nombre, que es el que la prosa usa a secas, y se descartan los pares donde un nombre
    contiene al otro — "Michael Callow" y "Michael Callow · In crisis briefing" son la
    misma persona con otra ropa, no dos cosas que confundir.
    """
    seen: dict[str, list[str]] = {}
    for sh in (shots or []):
        for a in (sh.get("assets") or []):
            n = str(a.get("name") or "").strip()
            if not n:
                continue
            head = n.lower().split(" · ")[0].split()[-1]
            if len(head) < 4:
                continue
            if n not in seen.setdefault(head, []):
                seen[head].append(n)
    out = []
    for head, names in seen.items():
        distinct = [n for n in names
                    if not any(m is not n and (m.lower() in n.lower() or n.lower() in m.lower())
                               for m in names)]
        if len(distinct) > 1:
            out.append((head, sorted(distinct)))
    return sorted(out)


def _link_depicted_assets(assets: list) -> int:
    """Normalise `depends_on` and fill in what a name scan can prove.

    An asset that DEPICTS a character is not independent: rendered from its own
    description alone, the face inside it is a stranger's. The writer declares these
    (breakdown rule `depends_on`) because most are invisible to text matching — BLACK
    MIRROR's "Conference Plasma Screen, showing hostage video feed" never writes
    "Susannah". This function is the other half: it throws away ids that do not exist
    or point at the asset itself, and ADDS the ones a depiction container names outright
    — DRAMA QUEEN 3's "2011 Polaroid photo — young Joel and Mara grinning", which shipped
    with no references and put two strangers on the protagonists' fridge.

    Returns the number of dependency links added by the scan (normalisation is silent).
    """
    import re   # module-local, as everywhere else in this file
    by_id = {str(a.get("id")): a for a in (assets or []) if a.get("id")}
    # Only base characters can be depicted — a wardrobe variant is the same person, and
    # pointing at one would make the dependent asset wait on an outfit rather than a face.
    cast = [a for a in (assets or [])
            if str(a.get("type") or "").lower() == "character" and not a.get("parentCharacterId")]
    # A first name is only usable when it is unique in the cast; "Michael Callow" and
    # "Michael Reyes" in one film make "Michael" ambiguous, and a wrong face is worse
    # than none. Full names are always usable.
    firsts: dict[str, list] = {}
    for c in cast:
        parts = str(c.get("name") or "").split()
        if parts:
            firsts.setdefault(parts[0].lower(), []).append(c)

    added = 0
    for a in (assets or []):
        aid = str(a.get("id") or "")
        raw = a.get("depends_on") or a.get("dependsOn") or []
        if not isinstance(raw, list):
            raw = []
        deps: list[str] = []
        for d in raw:
            d = str(d or "").strip()
            if d and d != aid and d in by_id and d not in deps:
                deps.append(d)

        atype = str(a.get("type") or "").lower()
        if atype not in {"character", "voice", "environment"}:
            hay = f"{a.get('name') or ''} {a.get('visual_description') or ''}".lower()
            if any(re.search(r'\b' + w + r'\b', hay) for w in _DEPICTION_WORDS):
                for c in cast:
                    cid = str(c.get("id"))
                    if cid in deps or cid == aid:
                        continue
                    name = str(c.get("name") or "").strip()
                    if not name:
                        continue
                    first = name.split()[0]
                    # A POSSESSIVE IS OWNERSHIP, NOT A LIKENESS — the same distinction the
                    # scoping above makes, one level down. Probe, 2026-08-15: "Michael's
                    # phone — dark smartphone, screen off" matched on `screen` + `Michael`
                    # and would have sent Michael's face as the reference for rendering a
                    # switched-off handset. His phone is his; it does not show him.
                    poss = r"(?![’']s)"
                    hit = re.search(r'\b' + re.escape(name) + r'\b' + poss, hay, re.I) or (
                        len(first) >= 3 and len(firsts.get(first.lower(), [])) == 1
                        and re.search(r'\b' + re.escape(first) + r'\b' + poss, hay, re.I))
                    if hit:
                        deps.append(cid)
                        added += 1

        a["depends_on"] = deps

    if added:
        logger.info("[Breakdown] linked %d depicted identity/identities the writer left "
                    "implicit — those assets now render FROM the approved sheets", added)
    return added


def _apply_wardrobe_variants(assets: list, shots: list, plan: dict) -> int:
    """Phase-2 wardrobe VARIANTS. Given a per-character outfit plan
    {char_name: [{"label","wardrobe","scenes":[scene headings]}]}, append a variant
    CHARACTER asset for each outfit AFTER the first (parentCharacterId → base id,
    wardrobe, name 'Base · label') and REWRITE each shot's assets_used to the variant
    whose scenes match that shot. The base character keeps the FIRST outfit; the shot
    rewrite is what makes the frontend derive each variant's sceneRefs AND makes
    Stage-5 reference the right outfit per scene — no separate scene map needed.
    Additive + defensive: a malformed entry is skipped, the base flow is untouched,
    and a variant with no matching shot is never created. Returns #variants added."""
    import re
    if not plan:
        return 0

    def _idnum(aid) -> int:
        m = re.search(r"(\d+)$", str(aid or ""))
        return int(m.group(1)) if m else 0
    seq = max([_idnum(a.get("id")) for a in assets] or [0])

    base_by_name = {
        _norm_name(a.get("name") or ""): a
        for a in assets
        if str(a.get("type") or "").lower() == "character" and not a.get("parentCharacterId")
    }
    shots_by_scene: dict = {}
    for sh in shots:
        shots_by_scene.setdefault(_norm_name(sh.get("scene") or ""), []).append(sh)

    def _matching_shots(scene_headings: list) -> list:
        wanted = [_norm_name(s) for s in (scene_headings or []) if s]
        out: list = []
        for skey, shs in shots_by_scene.items():
            if skey and any(w and (w in skey or skey in w) for w in wanted):
                out.extend(shs)
        return out

    added = 0
    for cname, outfits in (plan or {}).items():
        if not isinstance(outfits, list) or len(outfits) < 2:
            continue                                   # single/no outfit → nothing to vary
        base = base_by_name.get(_norm_name(str(cname)))
        if not base:
            continue
        base_id = base["id"]
        first = outfits[0] if isinstance(outfits[0], dict) else {}
        if first.get("wardrobe"):
            base["wardrobe"] = str(first["wardrobe"]).strip()   # default look on the base
        for outfit in outfits[1:]:
            if not isinstance(outfit, dict) or not str(outfit.get("wardrobe") or "").strip():
                continue
            targets = _matching_shots(outfit.get("scenes") or [])
            if not targets:
                continue                               # no shot → don't create an orphan
            label = str(outfit.get("label") or "alt look").strip()
            wardrobe = str(outfit["wardrobe"]).strip()
            seq += 1
            vid = f"ASSET_{seq:03d}"
            assets.append({
                "id": vid,
                "name": f"{base.get('name', 'Character')} · {label}",
                "type": "character",
                "parentCharacterId": base_id,
                "wardrobe": wardrobe,
                "visual_description": (
                    f"{base.get('visual_description') or base.get('name', '')}. "
                    f"Same person and face as {base.get('name', 'the character')}; "
                    f"wardrobe for this variant: {wardrobe}"
                ).strip(),
            })
            added += 1
            for sh in targets:                         # point matching shots at the variant
                used = sh.get("assets_used") or []
                sh["assets_used"] = [vid if x == base_id else x for x in used]
    return added


def _parse_breakdown_json(raw: str) -> dict:
    """Strip fences and decode the first JSON object. Raises on truncated/invalid JSON."""
    import json as _json
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
    if raw.endswith("```"):
        raw = raw.rsplit("```", 1)[0]
    return _json.JSONDecoder().raw_decode(raw.strip())[0]


# sd25-pe principle 7: "Do not write aspect ratio, total duration, resolution, frame rate,
# or the audio toggle into the Prompt." The storyboard's panel notes carry them anyway —
# measured on El Viaje SHOT_008, the board's framing note read "9:16 aspect, holds full
# threshold" and went into the direction verbatim, where check_prompt_guides flagged it.
_GEN_PARAMS = re.compile(
    r"(?:\bframing:\s*)?\b\d{1,2}:\d{1,2}\s*aspect(?:\s*ratio)?\b,?\s*"
    r"|\b(?:16:9|9:16|4:3|1:1|21:9)\b,?\s*"
    r"|\b\d{3,4}p\b,?\s*|\b4k\b,?\s*|\b\d+\s*fps\b,?\s*",
    re.IGNORECASE,
)


def _strip_generation_params(text: str) -> str:
    """A board note without its generation parameters (principle 7); '' stays ''."""
    if not text:
        return text
    out = _GEN_PARAMS.sub("", str(text))
    return re.sub(r"\s{2,}", " ", out).strip(" ,;")


_BLOCK_LABEL = re.compile(r"^\[[^\]]+\]$")


def _block_span(text: str, block: str) -> tuple[int, int] | None:
    """(start, end) line indexes of one `[Block]`: its label line through the line before
    the next `[Label]`. The assembled prompt separates blocks by LABEL, not by blank line —
    a blank-line rule swallowed 49 lines as "the roles" on the first live run."""
    lines = (text or "").splitlines()
    try:
        i = next(k for k, ln in enumerate(lines) if ln.strip() == block)
    except StopIteration:
        return None
    j = i + 1
    while j < len(lines) and not _BLOCK_LABEL.match(lines[j].strip()):
        j += 1
    return i, j


def _block_lines(text: str, block: str) -> list[str]:
    """The lines of one `[Block]` of a prompt, label excluded, stripped, blanks dropped."""
    span = _block_span(text, block)
    if not span:
        return []
    lines = (text or "").splitlines()
    return [ln.strip() for ln in lines[span[0] + 1:span[1]] if ln.strip()]


def _splice_block(text: str, block: str, original: str) -> str:
    """Put the ORIGINAL `[Block]` back into a rewritten prompt, replacing whatever the
    model wrote there. The references are attached by the application, so their block is
    not the model's to edit — asking it to copy 7 lines verbatim is what failed live, and
    a rule enforced by construction does not depend on the model reading it."""
    o = _block_span(original, block)
    if not o:
        return text
    olines = original.splitlines()[o[0]:o[1]]
    lines = text.splitlines()
    t = _block_span(text, block)
    if t:
        return "\n".join(lines[:t[0]] + olines + lines[t[1]:])
    # The model dropped the block: it goes back where the contract puts it — right after
    # [Generation Goal], or at the top when even that is missing.
    g = _block_span(text, "[Generation Goal]")
    at = g[1] if g else 0
    return "\n".join(lines[:at] + olines + lines[at:])


_GUIDES_DIR = Path(__file__).parent / "byteplus-genius" / "references"
_GUIDE_25 = _GUIDES_DIR / "seedance-2.5-prompt-optimizer-SKILL.md"
_GUIDE_20 = _GUIDES_DIR / "video-seedance-2.0-prompt-guide.md"


def _md_section(text: str, heading: str) -> str:
    """One markdown section: the heading line through the line before the next heading of
    the same or a higher level. '' when the heading is not there."""
    lines = text.splitlines()
    try:
        i = next(k for k, ln in enumerate(lines) if ln.strip() == heading)
    except StopIteration:
        return ""
    level = len(heading) - len(heading.lstrip("#"))
    out = [lines[i]]
    for ln in lines[i + 1:]:
        if ln.startswith("#") and (len(ln) - len(ln.lstrip("#"))) <= level:
            break
        out.append(ln)
    return "\n".join(out).strip()


def _star_section(text: str, start: str, stop: str) -> str:
    """The 2.0 guide has no markdown headings — its section titles are `*`-prefixed lines.
    Slice from the line containing `start` to the line before the one containing `stop`."""
    lines = text.splitlines()
    try:
        i = next(k for k, ln in enumerate(lines) if start in ln)
    except StopIteration:
        return ""
    out: list[str] = []
    for ln in lines[i:]:
        if ln is not lines[i] and stop in ln:
            break
        out.append(ln.lstrip("*").strip())
    return "\n".join(out).strip()


def _seedance_guide_text(is_25: bool) -> str:
    """The parts of the OFFICIAL guide that govern a generation prompt with references —
    by section, so the .md files under byteplus-genius/references stay the source of truth.
    2.5: the sd25-pe skill's principles, its reference template, storyboard grids, the
    emotion/cinematography/audio chapter and the output contract (~25 KB). 2.0: its own
    guide's basic and advanced formulas, shot sequencing, action, camera and the image
    quality / style / constraint words — which 2.5's principle 8 forbids and 2.0 calls
    necessary. Each version reads its own guide and never the other's."""
    try:
        if is_25:
            t = _GUIDE_25.read_text(encoding="utf-8")
            parts = [
                _md_section(t, "## Non-Negotiable Principles"),
                _md_section(t, "### Generation with Reference Materials"),
                _md_section(t, "### Storyboard Grids"),
                _md_section(t, "## Emotion, Cinematography, and Audio"),
                _md_section(t, "## Output Contract"),
            ]
        else:
            t = _GUIDE_20.read_text(encoding="utf-8")
            parts = [
                _star_section(t, "Basic formula", "Advanced formula"),
                _star_section(t, "Advanced formula", "2. Shot sequencing"),
                _star_section(t, "2. Shot sequencing", "3. Action description"),
                _star_section(t, "3. Action description", "4. Camera movement"),
                _star_section(t, "4. Camera movement", "5. Image quality"),
                _star_section(t, "5. Image quality", "6. Cases"),
            ]
        return "\n\n".join(p for p in parts if p)
    except OSError:
        return ""


class ClaudeQCAgents:
    def __init__(self):
        api_key = os.getenv("ANTHROPIC_API_KEY", "")
        # Soft init: NEVER raise here. A missing key must surface as a clear 503
        # at call time (server.get_claude), not an opaque 500 on the first request
        # — the latter is the classic "the app does nothing and won't say why".
        self.config_error = None if api_key else (
            "ANTHROPIC_API_KEY not set — add it to .env and restart the backend"
        )
        self.client = anthropic.Anthropic(api_key=api_key) if api_key else None

        # ── QC backend: Seed 2.0 Pro via BytePlus/ARK (OpenAI-compatible) ──────
        # Judges gate verdicts WITHOUT touching Anthropic credits. Same key/base
        # as byteplus_generative so it rides the enterprise account.
        self._qc_backend = QC_BACKEND
        self._qc_model = QC_MODEL
        self._breakdown_backend = BREAKDOWN_BACKEND   # 1a: breakdown gen backend (Claude default)
        self._qc_client: OpenAI | None = None
        bp_key = os.getenv("BYTEPLUS_API_KEY", "")
        bp_base = os.getenv(
            "BYTEPLUS_BASE_URL",
            "https://ark.ap-southeast.bytepluses.com/api/v3",
        )
        if bp_key:
            try:
                self._qc_client = OpenAI(api_key=bp_key, base_url=bp_base)
            except TypeError as e:
                # Older/newer openai SDKs choke on an implicit proxies kwarg —
                # same httpx fallback byteplus_generative uses.
                if "proxies" in str(e):
                    try:
                        self._qc_client = OpenAI(
                            api_key=bp_key, base_url=bp_base,
                            http_client=httpx.Client(timeout=90.0, follow_redirects=True),
                        )
                    except Exception as fe:  # noqa: BLE001
                        logger.warning("[QC] seed client init failed (fallback): %s", fe)
                else:
                    logger.warning("[QC] seed client init failed: %s", e)
            except Exception as e:  # noqa: BLE001
                logger.warning("[QC] seed client init failed: %s", e)
        if self._qc_backend == "seed" and self._qc_client is None:
            logger.warning(
                "[QC] backend=seed but BytePlus client unavailable — QC will fall "
                "back to Claude (set BYTEPLUS_API_KEY, or QC_BACKEND=claude)."
            )
        else:
            logger.info("[QC] gate backend=%s model=%s", self._qc_backend, self._qc_model)
        logger.info("[BreakdownGen] backend=%s (QC verdicts stay on %s)",
                    self._breakdown_backend, self._qc_backend)

    def _llm(self, timeout: float | None = None, max_retries: int | None = None,
             **kwargs: Any) -> Any:
        """messages.create + per-project usage metering (real token counts).

        Long-form: the SDK refuses non-streaming requests whose projected duration
        exceeds 10 minutes ("Streaming is required for operations that may take
        longer…") — which the scaled max_tokens budgets for long scripts/breakdowns
        trigger. Those requests stream under the hood and return the same final
        Message object, so callers don't change.

        `timeout`/`max_retries` are PER REQUEST and default to None = the SDK's own
        settings, i.e. every existing caller keeps the 600 s read + 2 retries it has
        always had. Only the two calls inside the render queue's claim window pass them
        (see SUBMIT_PATH_TIMEOUT_SECS) — bounding the shared client instead would cut
        off the long-form script/breakdown streams that legitimately run for minutes."""
        client = self.client
        if timeout is not None or max_retries is not None:
            opts: dict[str, Any] = {}
            if timeout is not None:
                opts["timeout"] = timeout
            if max_retries is not None:
                opts["max_retries"] = max_retries
            client = client.with_options(**opts)
        if kwargs.get("max_tokens", 0) > 8192:
            with client.messages.stream(**kwargs) as stream:
                resp = stream.get_final_message()
        else:
            resp = client.messages.create(**kwargs)
        try:
            usage.record_llm(getattr(resp, "usage", None), kind="llm")
        except Exception:
            pass  # metering must never break a generation
        return resp

    def identity_match(self, ref_image: tuple[str, str], cand_image: tuple[str, str]) -> dict:
        """Consistency score via Claude vision (the BytePlus vision + embedding
        endpoints are not enabled on this account). Each arg is (media_type, base64).
        Shows the APPROVED reference (image 1) and a candidate (image 2) and rates how
        well the candidate keeps the SAME identity. Returns
        {consistency, face, wardrobe, differs, notes} — the 0-100 evaluator behind the
        consistency harness (best-of-N / prompt A/B)."""
        if not self.client:
            raise RuntimeError("ANTHROPIC_API_KEY not configured")
        prompt = (
            "Image 1 is the APPROVED reference for a film character; image 2 is a candidate "
            "generation. Rate how consistently image 2 keeps the SAME character — face shape, "
            "features, hair and wardrobe — as image 1. Ignore pose, camera angle, lighting and "
            "background; judge identity only. Reply with ONLY this JSON, no prose:\n"
            '{"consistency": <0-100 int, 100 = unmistakably the same person and outfit>, '
            '"face": <0-100 int>, "wardrobe": <0-100 int>, '
            '"differs": "<short phrase on the biggest mismatch, or none>", "notes": "<one sentence>"}'
        )
        resp = self._llm(
            model=MODEL,
            max_tokens=400,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": "Image 1 — approved character reference:"},
                {"type": "image", "source": {"type": "base64", "media_type": ref_image[0], "data": ref_image[1]}},
                {"type": "text", "text": "Image 2 — candidate generation:"},
                {"type": "image", "source": {"type": "base64", "media_type": cand_image[0], "data": cand_image[1]}},
                {"type": "text", "text": prompt},
            ]}],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        import json as _json
        return _json.loads(raw.strip())

    def panel_composition(self, board_image: tuple[str, str], rows: int = 1, cols: int = 1) -> str:
        """Describe the FIRST panel (top-left cell) of a shot's storyboard grid as a
        compact composition block for the keyframe prompt. This is how the keyframe
        stays faithful to the board WITHOUT attaching the board as an image ref —
        photographic keyframes must be pure t2i (any ref strips the trusted watermark
        → Seedance rejects the face). Text grounding keeps the trust chain intact.
        board_image = (media_type, base64)."""
        if not self.client:
            raise RuntimeError("ANTHROPIC_API_KEY not configured")
        grid = (f"a grid of {rows} row(s) x {cols} column(s); the FIRST panel is the TOP-LEFT cell"
                if rows * cols > 1 else "a single full-frame panel")
        prompt = (
            f"This storyboard image is {grid}. Describe ONLY the first panel, as a compact "
            "composition spec for an image-generation prompt that must REPRODUCE it:\n"
            "- shot type / framing (wide, medium, close-up…) and camera angle\n"
            "- subject: position in frame, pose, gaze/action, visible wardrobe details\n"
            "- key props and where they sit in frame\n"
            "- environment elements visible and depth layout\n"
            "- lighting direction and mood\n"
            "One dense paragraph, ≤90 words, purely visual, no panel numbers, no meta talk. "
            "Do NOT describe any other panel."
        )
        resp = self._llm(
            model=MODEL,
            max_tokens=300,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": board_image[0], "data": board_image[1]}},
                {"type": "text", "text": prompt},
            ]}],
        )
        return resp.content[0].text.strip()

    def revise_prompt(self, prompt: str, notes: str) -> str:
        """Rewrite an existing image-generation prompt applying director notes
        EVERYWHERE they matter. The naive alternative (appending "revise per these
        notes" to the old prompt) loses to the prompt's own detailed spec — e.g. a
        FACE LOCK block describing the OLD face beats a one-line ethnicity note, so
        the change never lands. Claude instead rewrites every affected block
        ([SUBJECT], FACE LOCK, [WARDROBE], close-ups…) and REMOVES contradicting
        details, keeping everything the notes don't touch."""
        if not self.client:
            raise RuntimeError("ANTHROPIC_API_KEY not configured")
        system = (
            "You revise an existing image-generation prompt per a film director's notes. "
            "Output ONLY the revised prompt — no preamble, no markdown, no commentary.\n"
            "RULES:\n"
            "- Apply the notes EVERYWHERE they matter: every block/section that mentions a "
            "trait the notes change (face, ethnicity, hair, age, wardrobe, props, mood…) "
            "must be updated CONSISTENTLY — including face-lock/close-up lines.\n"
            "- REMOVE or replace every detail that contradicts the notes. The revised "
            "prompt must not argue with itself.\n"
            "- The notes may be in any language; apply their meaning, keep the prompt's "
            "original language.\n"
            "- Keep the prompt's structure, block labels, style/camera/quality lines and "
            "overall length. Change ONLY what the notes require.\n"
            "- Never name real or famous people."
        )
        user = f"DIRECTOR NOTES: {notes.strip()}\n\nCURRENT PROMPT:\n{prompt.strip()}"
        resp = self._llm(
            model=MODEL,
            max_tokens=2048,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
        )
        revised = resp.content[0].text.strip()
        if revised.startswith("```"):
            revised = revised.split("\n", 1)[1] if "\n" in revised else revised[3:]
        if revised.endswith("```"):
            revised = revised.rsplit("```", 1)[0].strip()
        return revised or prompt

    # Map persona key → skill file
    _SKILL_FILES: dict[str, str] = {
        "film_director":     "film-director.md",
        "producer":          "producer.md",
        "art_director":      "art-director.md",
        "layout_director":   "layout-director.md",
        "camera_director":   "camera-director.md",
        "animation_director":"animation-director.md",
        # skills/qc/final-director.md has been on disk all along and was never in this
        # map, so qc_final_cut fell through to the film_director persona and the file
        # was never loaded by anything.
        "final_director":    "final-director.md",
    }

    def _run(self, user_prompt: str, persona: str = "film_director", max_tokens: int = 1024) -> dict[str, Any]:
        """Send a QC request with the given persona system prompt.
        Prefers skill file over inline prompt when available. Routes to the
        configured QC backend (Seed 2.0 Pro by default; Claude fallback)."""
        if self._qc_client is None and self.client is None:
            raise RuntimeError(
                self.config_error or "No QC backend configured (set BYTEPLUS_API_KEY or ANTHROPIC_API_KEY)"
            )
        # Try skill file first (0.3)
        skill_file = self._SKILL_FILES.get(persona)
        skill_content = _load_skill(skill_file) if skill_file else None
        if skill_content:
            system_text = (
                skill_content
                + "\n\n---\n"
                + _BASE_SCHEMA
            )
            logger.info("[QC] Using skill file: %s", skill_file)
        else:
            system_text = _PERSONAS.get(persona, _PERSONAS["film_director"])

        raw = self._qc_complete(system_text, user_prompt, max_tokens)

        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        raw = raw.strip()

        if not raw:
            raise ValueError("Empty response from QC agent")

        result = json.loads(raw)
        # Ensure persona is always present in the response
        if "persona" not in result:
            result["persona"] = persona.replace("_", " ").title()
        return result

    def _run_vision(self, user_prompt: str, images: list[tuple[str, str]],
                    persona: str = "film_director", max_tokens: int = 2048,
                    extra_checks: list[dict] | None = None) -> dict[str, Any]:
        """_run, but the reviewer can SEE. images = [(media_type, base64)] in order.

        Always Claude: this needs a vision model and the QC backend may be routed to the
        text path. `extra_checks` are deterministic verdicts computed by the caller; they
        are prepended and they can fail the whole review on their own, which is the point
        — a measured runtime overshoot is not a matter of opinion.
        """
        if self.client is None:
            raise RuntimeError("Vision QC needs ANTHROPIC_API_KEY")
        skill_file = self._SKILL_FILES.get(persona)
        skill = _load_skill(skill_file) if skill_file else None
        system_text = (skill + "\n\n---\n" + _BASE_SCHEMA) if skill else _PERSONAS.get(
            persona, _PERSONAS["film_director"])

        content: list[dict[str, Any]] = [
            {"type": "image", "source": {"type": "base64", "media_type": mt, "data": b64}}
            for mt, b64 in images[:20]          # Claude's per-request image ceiling
        ]
        content.append({"type": "text", "text": user_prompt})
        resp = self._llm(model=MODEL, max_tokens=max_tokens,
                         system=[{"type": "text", "text": system_text}],
                         messages=[{"role": "user", "content": content}])
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        try:
            result = json.loads(raw.strip())
        except Exception as e:
            logger.warning("[QC] vision verdict unparseable: %s", e)
            result = {"passed": True, "checks": [], "summary": raw[:400], "regen_prompt": ""}
        result.setdefault("persona", persona.replace("_", " ").title())
        checks = list(extra_checks or []) + list(result.get("checks") or [])
        result["checks"] = checks
        # A deterministic failure is not overridable by an opinion.
        result["passed"] = all(c.get("passed") for c in checks) if checks else result.get("passed", True)
        return result

    # ── QC completion backends ────────────────────────────────────────────────
    def _qc_complete(self, system_text: str, user_prompt: str, max_tokens: int) -> str:
        """Return the raw text verdict from the configured QC backend.

        Default: Seed 2.0 Pro (BytePlus/ARK) — no Anthropic spend. If seed is
        unavailable or errors, transparently fall back to Claude when configured
        so QC never hard-stops the pipeline."""
        if self._qc_backend == "seed" and self._qc_client is not None:
            try:
                return self._qc_seed(system_text, user_prompt, max_tokens)
            except Exception as e:  # noqa: BLE001
                if self.client is None:
                    raise
                logger.warning("[QC] seed backend failed (%s) — falling back to Claude", e)
                return self._qc_claude(system_text, user_prompt, max_tokens)
        if self.client is None:
            # backend=claude requested (or seed disabled) but no Claude key —
            # last resort: use seed if we have it.
            if self._qc_client is not None:
                return self._qc_seed(system_text, user_prompt, max_tokens)
            raise RuntimeError(self.config_error or "No QC backend configured")
        return self._qc_claude(system_text, user_prompt, max_tokens)

    def _qc_seed(self, system_text: str, user_prompt: str, max_tokens: int) -> str:
        """Seed 2.0 Pro verdict via the OpenAI-compatible ARK Chat API.

        Billed to the BytePlus enterprise account, NOT the Anthropic budget, so it
        is intentionally NOT recorded in the Claude usage meter."""
        kwargs: dict[str, Any] = dict(
            model=self._qc_model,
            max_tokens=max_tokens,
            temperature=0.2,
            messages=[
                {"role": "system", "content": system_text},
                {"role": "user", "content": user_prompt},
            ],
        )
        try:
            resp = self._qc_client.chat.completions.create(
                response_format={"type": "json_object"}, **kwargs
            )
        except Exception as e:  # noqa: BLE001
            # Some ARK models reject response_format — the persona schema already
            # forces JSON, so retry without it (fence-stripping handles the rest).
            msg = str(e).lower()
            if "response_format" in msg or "json_object" in msg or "unsupported" in msg:
                resp = self._qc_client.chat.completions.create(**kwargs)
            else:
                raise
        return (resp.choices[0].message.content or "").strip()

    def _qc_claude(self, system_text: str, user_prompt: str, max_tokens: int) -> str:
        """Claude verdict (fallback / QC_BACKEND=claude). Metered against Anthropic."""
        if self.client is None:
            raise RuntimeError(self.config_error or "Claude client not configured")
        response = self._llm(
            model=MODEL,
            max_tokens=max_tokens,
            system=[
                {
                    "type": "text",
                    "text": system_text,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_prompt}],
        )
        return response.content[0].text.strip()

    # ── Studio: Seedream 5.0 prompt enhancer (standalone, no project) ──────────

    def enhance_prompt_seedream(self, prompt: str, mode: str = "image") -> str:
        """Rewrite a rough idea into a production-ready Seedream 5.0 prompt.

        mode='image'  → a full text-to-image prompt (content as natural language +
                        short aesthetic phrases; literal text in double quotes).
        mode='refine' → a concise image-to-image EDIT instruction ('change action +
                        change object + change feature') describing only the change.
        Returns the prompt/instruction text only."""
        if not self.client:
            raise RuntimeError(self.config_error or "Claude client not configured")
        if mode == "refine":
            system = (
                "You are refining an existing image with the Seedream 5.0 image-to-image "
                "model. Rewrite the user's edit request into ONE clear, concise editing "
                "instruction using the formula 'change action + change object + change "
                "feature' (e.g. 'add a small horse and rider on the distant ridge, "
                "backlit and to scale with the horizon'). Describe ONLY the change and "
                "how it should blend in (placement, scale, lighting, perspective) — do "
                "NOT re-describe the whole scene. Output ONLY the instruction: no "
                "preamble, no surrounding quotes, no markdown."
            )
            max_tokens = 200
        elif mode == "video":
            system = (
                "You are a prompt engineer for the Seedance 2.0 video model. Rewrite the "
                "user's idea into ONE vivid video prompt using the formula: precise subject "
                "+ action details (quantify motion — direction, speed, inertia) + scene / "
                "environment + lighting & color + camera movement + visual style + image "
                "quality + constraints. Externalize emotion physically (clenched fists, tense "
                "jaw) rather than naming it. CRITICAL: preserve EXACTLY any reference tokens "
                "such as <Image_1>, <Subject_1>, <Video_1>, <Audio_1> — keep them verbatim, "
                "unchanged, and in a sensible place; never rename, renumber, drop, or wrap "
                "them. Output ONLY the final prompt as one paragraph: no preamble, no "
                "surrounding quotes, no markdown."
            )
            max_tokens = 500
        else:
            system = (
                "You are a prompt engineer for the Seedream 5.0 text-to-image model. "
                "Rewrite the user's idea into ONE vivid, production-ready image prompt that "
                "maximizes Seedream 5.0 quality. Lead with the content as coherent natural "
                "language (subject + action + environment), then append short phrases for "
                "aesthetics (style, lighting, color, composition, lens). Be concrete and "
                "specific; prefer correct technical terms; keep any text-to-render inside "
                "double quotes. Preserve the user's intent — do NOT invent unrelated subjects "
                "and do NOT explain. Output ONLY the final prompt as a single paragraph: no "
                "preamble, no surrounding quotes, no markdown."
            )
            max_tokens = 400
        # Seed 2.0 Pro first, Anthropic only as fallback (_text_llm). Every Enhance in the
        # Studio — the composer, Animate, the video edit note, the extend note — lands
        # here, and hard-wiring it to the separately billed API meant an exhausted balance
        # took the whole button out with a 400 (observed 2026-08-01) even though Seedream
        # and Seedance, which do the actual work, were fine. Same reasoning as the sheet
        # prompts: rewriting a prompt is not where a single-provider dependency belongs.
        out = self._text_llm(system, prompt.strip(), max_tokens=max_tokens, temperature=0.7).strip()
        if out.startswith("```"):
            out = out.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        if len(out) >= 2 and out[0] in "\"'" and out[-1] == out[0]:
            out = out[1:-1].strip()
        return out or prompt.strip()

    # ── Prompt Doctor (0.2) ───────────────────────────────────────────────────

    def doctor_prompt(
        self,
        raw_description: str,
        asset_type: str = "general",
        style_label: str = "cinematic",
        style_suffix: str = "",
    ) -> str:
        """
        Rewrites a raw visual description into a Seedream 5.0 generation prompt
        that already satisfies the project style — so the Art Director QC has
        little left to flag.

        The rewritten prompt embeds:
          - Explicit palette (2-3 specific color names)
          - Motivated lighting (direction + temperature + quality)
          - Render mode matching the declared style
          - Style suffix keywords
          - Asset-type-appropriate quality markers
        """
        photographic = _is_photographic(style_label, style_suffix)
        photo_rule = (
            "6. PHOTOREAL ANCHOR (this style IS photographic): name a real camera body + lens + "
            "natural film grain (e.g. 'shot on Arri Alexa 35, wide anamorphic lens, fine film "
            "grain') and real surface texture; write it as a REAL PHOTOGRAPH captured on a camera, "
            "never a render or CGI — this is what separates a photo from a 3D look.\n\n"
            if photographic else
            "6. Keep the render mode faithful to the illustrated style (linework, shading, brushwork).\n\n"
        )
        system = (
            f"You are a production AI prompt engineer for a {style_label}-style short film.\n"
            f"Task: rewrite the raw visual description into an optimized Seedream 5.0 generation prompt.\n\n"
            f"The rewritten prompt MUST contain:\n"
            f"1. Explicit palette: 2-3 specific color names (e.g. 'deep cobalt blue, warm amber highlights')\n"
            f"2. Motivated lighting: direction + temperature + quality (e.g. 'side-lit golden sunset, soft diffused shadows')\n"
            f"3. Render mode that matches the style '{style_label}'\n"
            f"4. Style keywords (include verbatim if non-empty): {style_suffix or style_label}\n"
            f"5. Production quality markers appropriate for a {asset_type}\n\n"
            + photo_rule +
            f"Rules:\n"
            f"- 60–90 words total\n"
            f"- THE FIRST WORDS of the prompt are the render medium/style (e.g. "
            f"'Photorealistic DSLR photograph of…', '3D animated render of…') — the "
            f"model weights early words heaviest; a style named only at the end loses\n"
            f"- The API has NO working negative channel: express any must-not as a "
            f"positive ('clean empty background', not 'no clutter')\n"
            f"- Present tense, concrete visual language only\n"
            f"- No abstract concepts or emotional language — only visual details\n"
            f"- CONTENT-FILTER SAFETY (the image model blocks outputs that read as gore,\n"
            f"  body horror, medical violence or injury — and the block costs a full render):\n"
            f"  rewrite any visceral phrasing into cinematic VFX language that keeps the\n"
            f"  visual intent. Examples: 'melting skin' → 'chrome surface texture flowing\n"
            f"  like liquid mercury'; 'under the skin' → 'glowing circuit traces across the\n"
            f"  surface'; 'wounds/burns/blood' → 'fractured emissive seams of light'.\n"
            f"  Never describe broken/pierced/burning flesh literally.\n"
            f"- Output ONLY the rewritten prompt, no explanation, no markdown"
        )
        response = self._llm(
            model=MODEL,
            max_tokens=300,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": f"Asset type: {asset_type}\n\nRaw description:\n{raw_description}"}],
        )
        doctored = response.content[0].text.strip()
        logger.info("[PromptDoctor] %s → %r", asset_type, doctored[:120])
        return doctored

    # ── Script + Breakdown generation (Claude, per spec) ─────────────────────
    # Spec: "Claude (Anthropic API) generates the script. DeepSeek must not be
    # in the script or QC pipeline."

    def generate_script(self, concept: str, target_duration_secs: int = 60,
                        spine: list[dict] | dict | None = None) -> str:
        """Generate a screenplay using Claude (Film Director voice).

        WITH a spine (a bible dict or a bare sequence list) the script is written
        SEQUENCE BY SEQUENCE — see _script_from_spine. WITHOUT one, this is byte-for-byte
        the single call it has always been: `spine` defaults to None, every existing
        caller passes two arguments, and the branch below is the only new code they
        execute.
        """
        seqs = _spine_sequences(spine)
        if seqs:
            head: list[str] = []
            if isinstance(spine, dict):
                if spine.get("logline"):
                    head.append(f"LOGLINE: {spine['logline']}")
                if spine.get("tone"):
                    head.append(f"TONE: {spine['tone']}")
            return self._script_from_spine(concept, target_duration_secs, seqs,
                                           "\n".join(head))
        mins = target_duration_secs / 60
        # Estimate realistic shot count: average 4s/shot with brief padding for titles/transitions
        shot_estimate = max(4, round(target_duration_secs / 4.5))
        scene_estimate_lo, scene_estimate_hi = _scene_target(target_duration_secs, shot_estimate)

        if target_duration_secs <= 45:
            length_guidance = (
                f"This is a MICRO short — final cut must be approximately {target_duration_secs} seconds. "
                f"Write exactly 1-2 scenes and {shot_estimate} shots maximum. "
                "Every scene must be essential. No subplots."
            )
        elif target_duration_secs <= 90:
            length_guidance = (
                f"This is a 1-minute short film — final cut approximately {target_duration_secs} seconds. "
                f"Write {scene_estimate_lo}–{scene_estimate_hi} scenes, {shot_estimate} shots. "
                "Tight story arc: setup → single complication → resolution. No padding."
            )
        else:
            length_guidance = (
                f"Target runtime: approximately {mins:.1f} minutes ({target_duration_secs} seconds). "
                f"Write {scene_estimate_lo}–{scene_estimate_hi} scenes, "
                f"aiming for roughly {shot_estimate} shots at 3–6 seconds each. "
                "Complete story arc with clear beginning, middle, end."
            )

        logger.info(
            "[ScriptGen] target=%ds → ~%d shots, %d–%d scenes",
            target_duration_secs, shot_estimate, scene_estimate_lo, scene_estimate_hi
        )

        # Long-form: a fixed 4096 cap truncates any script past ~5 minutes.
        # ~12 output tokens per second of runtime, floor 4096, ceiling 24k.
        script_max_tokens = max(4096, min(24000, round(target_duration_secs * 12)))
        system_text = (
            "You are a professional screenwriter for short films and TV with the voice of a "
            "seasoned auteur. Given a concept, produce a formatted script with:\n"
            "  SCENE headings (INT./EXT., location, time)\n"
            "  ACTION lines\n"
            "  DIALOGUE with character names\n"
            f"{length_guidance}\n"
            "Output ONLY the script text, no commentary."
        )
        # CLAUDE FIRST here, unlike the other writers — not preference, but because the
        # truncation guard below reads `stop_reason`, which only the Anthropic response
        # carries. A script that hit the output cap comes back mid-sentence and is still
        # perfectly valid text, so nothing downstream can detect it; losing that check
        # would be a worse failure than the one this fallback fixes.
        # Seed 2.0 Pro takes over when Claude is UNAVAILABLE (exhausted balance, missing
        # key): a dead Anthropic account used to stop the pipeline at its very first
        # button while BytePlus, which draws every image and video, was funded and idle.
        stop_reason = None
        try:
            response = self._llm(
                model=MODEL,
                max_tokens=script_max_tokens,
                system=[{"type": "text", "text": system_text,
                         "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": concept}],
            )
            text = response.content[0].text
            stop_reason = response.stop_reason
        except Exception as e:  # noqa: BLE001
            logger.warning("[Script] Claude unavailable (%s) — writing on Seed 2.0 Pro", e)
            text = self._seed_text(system_text, concept,
                                   max_tokens=script_max_tokens, temperature=0.8)
            if not text.strip():
                raise
            # No stop_reason on this leg, so the cap check below cannot run. The
            # runtime estimate stays as the honest, weaker substitute.
            logger.info("[Script] Seed wrote %d chars (~%.1f min est.)",
                        len(text), estimate_script_seconds(text) / 60)

        # Truncation guard — the same one the storyboard path has had all along
        # (see the max_tokens check in write_storyboard_beats). Without it a script
        # that hit the output cap was returned mid-sentence, saved to Script/script.txt
        # and handed to the breakdown, which then built hundreds of shots on top of a
        # story with no third act. Nothing downstream can detect that, because a
        # truncated screenplay is still perfectly valid text.
        #
        # There is no "retry higher" here the way there is for the storyboard: the cap
        # is already at the ceiling (24000) for anything past ~33 minutes, so a longer
        # target cannot be rescued by asking again — it needs to be written act by act.
        if stop_reason == "max_tokens":
            # How much film survived, on the shared maths (estimate_script_seconds)
            # rather than the words/130 page rule this used to use: that rule reads a
            # dense prose script as roughly TWICE the film it becomes, so the message
            # under-reported the loss — "~9 of the 10 min requested" for a script that
            # would have cut to five.
            got_mins = estimate_script_seconds(text) / 60.0
            raise RuntimeError(
                f"The script hit the {script_max_tokens}-token output cap and was cut off "
                f"mid-sentence (~{got_mins:.0f} min of the {mins:.0f} min requested). "
                "It has NOT been saved — a truncated script would have produced a breakdown "
                "with no ending. Generate a shorter target, or write the episode act by act."
            )
        return text

    def _script_from_spine(self, concept: str, target_duration_secs: int,
                           seqs: list[dict], head: str = "") -> str:
        """Write the screenplay one SEQUENCE at a time, against the approved spine.

        The one-call script is why this exists. Its entire structural instruction was the
        line "Tight story arc: setup → single complication → resolution. No padding.", and
        one call cannot hold a shape it was never told: ROBOTECH came out as 16 scenes
        where Wakanda Forever has 334 and Severance's pilot has 40, and every stretch of it
        reads in the same register at the same intensity.

        Each call sees FOUR things and nothing else it does not need:
          · this sequence's full object — mode, tension, obstacle, cost, question
          · the previous sequence's value_out, so the value chain cannot break at the seam
          · the last ~200 characters actually written, so the prose continues instead of
            restarting (the whole script would not fit, and does not need to)
          · a word budget derived from seconds_share × target through the shared runtime
            maths (_sequence_word_budget / estimate_script_seconds)

        The system block is IDENTICAL on every call so the ephemeral cache actually hits;
        everything that varies is in the user turn.
        """
        shares = spine_shares(seqs)
        system = (
            "You are a professional screenwriter for short films and TV with the voice of a "
            "seasoned auteur. You are writing ONE SEQUENCE of a film that is already "
            "structured — not the whole film, not a summary of it.\n"
            "FORMAT, exactly:\n"
            "  SCENE headings (INT./EXT., LOCATION, TIME)\n"
            "  ACTION lines\n"
            "  DIALOGUE under an ALL-CAPS character cue\n"
            "RULES:\n"
            "· Output ONLY screenplay text. No sequence titles, no 'SEQUENCE 4', no notes, "
            "no commentary, no summary of what came before.\n"
            "· Continue mid-story. The previous text is already on the page; do not "
            "re-establish characters the audience has met or restate what they know.\n"
            "· The obstacle you are given must be VISIBLE on the page — something a camera "
            "sees resisting the protagonist, not a feeling they have about it.\n"
            "· Leave the protagonist exactly at the stated value_out. That is where the next "
            "sequence starts; a different ending breaks the film.\n"
            "· If this sequence is marked as costing something irreversible, the loss must "
            "HAPPEN on the page, not be discussed after the fact."
        )
        parts: list[str] = []
        prev_out = ""
        for i, (seq, share) in enumerate(zip(seqs, shares)):
            secs = share * target_duration_secs
            words, ceiling = _sequence_word_budget(secs)
            mode = _seq_mode(seq)
            tension = _seq_tension(seq)
            ev = _seq_event(seq)
            tail = ("\n\n".join(parts))[-200:] if parts else ""

            lines = [f"CONCEPT: {concept}"]
            if head:
                lines.append(head)
            lines.append(f"\nSEQUENCE {i + 1} OF {len(seqs)} — id {seq.get('id', f'SEQ_{i+1}')}")
            if mode:
                lines.append(f"MODE: {mode.upper()} — {_MODE_TEXTURE[mode]}")
            if tension is not None:
                lines.append(f"TENSION: {tension}/10 — {_tension_texture(tension)}")
            if seq.get("question_opened"):
                lines.append(f"THE QUESTION THIS PUTS IN THE AUDIENCE'S HEAD: {seq['question_opened']}")
            if seq.get("answers"):
                ans = seq["answers"] if isinstance(seq["answers"], list) else [seq["answers"]]
                if ans:
                    lines.append("IT ANSWERS, HERE, ON THE PAGE: "
                                 + ", ".join(str(a) for a in ans))
            if _has_obstacle(seq):
                who = str(seq.get("obstacle_owner") or "").strip()
                kind = _seq_obstacle_type(seq)
                lines.append(f"WHAT RESISTS: {seq['obstacle']}"
                             + (f" (a {kind.replace('_', ' ')}"
                                + (f": {who}" if who else "") + ")" if kind else ""))
            if seq.get("purpose"):
                lines.append(f"PURPOSE: {seq['purpose']}")
            v_in = str(seq.get("value_in") or "").strip() or prev_out
            if v_in or seq.get("value_out"):
                lines.append(f"THE PROTAGONIST ENTERS: {v_in or '(as the last sequence left them)'}"
                             f"\nTHEY MUST LEAVE: {seq.get('value_out') or '(changed)'}")
            if prev_out and v_in and prev_out != v_in:
                # The seam the spine editor draws in orange. Naming it beats silently
                # writing over it: the model is the only one who can bridge two states
                # the spine says are contiguous and are not.
                lines.append(f"(The previous sequence ended at '{prev_out}' — bridge that "
                             f"to '{v_in}' in the first beat, do not skip it.)")
            if ev.get("loses"):
                lines.append(f"WHAT IS PAID HERE, ON SCREEN: {ev.get('who') or 'the protagonist'} "
                             f"loses {ev['loses']}"
                             + (" — permanently, and it is never recovered."
                                if _as_bool(ev.get("irreversible")) else "."))
            if tail:
                lines.append(f"\nTHE PAGE SO FAR ENDS WITH:\n…{tail}")
            lines.append(f"\nLENGTH: this sequence must cut to about {secs:.0f} seconds of "
                         f"screen — roughly {words} words, and NEVER more than {ceiling}. "
                         "Dialogue runs at ~2 words/sec of screen time, action at ~4.5.")
            user = "\n".join(lines)

            # ~14 output tokens per second of this sequence's runtime, floored so a short
            # beat still has room for a scene heading, ceilinged well under the SDK's
            # non-streaming limit. Per SEQUENCE, so a long episode can no longer hit the
            # single 24k cap that made generate_script raise instead of returning a film.
            max_toks = max(900, min(8000, round(secs * 14)))
            resp = self._llm(
                model=MODEL, max_tokens=max_toks,
                system=[{"type": "text", "text": system,
                         "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user}],
            )
            text = (resp.content[0].text or "").strip()
            if resp.stop_reason == "max_tokens":
                # Same contract as the one-call path: a truncated sequence is not saved
                # and not silently appended. Unlike that path this one CAN say which
                # stretch died, and the rest of the film is not lost work — the caller
                # can re-run with a smaller share on that sequence.
                raise RuntimeError(
                    f"Sequence {seq.get('id', i + 1)} ({i + 1}/{len(seqs)}) hit its "
                    f"{max_toks}-token cap and was cut off mid-sentence. The script has NOT "
                    "been saved. Give that sequence a smaller seconds_share, or split it.")
            parts.append(text)
            prev_out = str(seq.get("value_out") or "").strip() or prev_out
            logger.info("[ScriptGen] %s (%s t%s) asked %.0fs/%dw → wrote %.0fs/%dw",
                        seq.get("id", f"SEQ_{i+1}"), mode or "—",
                        tension if tension is not None else "—",
                        secs, words, estimate_script_seconds(text), len(text.split()))

        script = "\n\n".join(parts)
        got = estimate_script_seconds(script)
        logger.info("[ScriptGen] spine-written: %d sequence(s), target %ds → %.0fs (%+.0f%%)",
                    len(parts), target_duration_secs, got,
                    100 * (got - target_duration_secs) / max(1, target_duration_secs))
        return script

    def propose_spine(self, concept: str, target_duration_secs: int = 60,
                      tone_hint: str = "") -> dict:
        """The spine BEFORE the script — the inverse of derive_film_bible.

        derive_film_bible reads a finished screenplay and reports its structure. That
        makes it a post-mortem: it can describe that nothing resisted the protagonist, but
        it can never make something resist him. FARO is the proof — its best spine has 5
        of 6 obstacles that ARE the protagonist's own passivity, and SEQ_1 declares
        obstacle NONE with value_in 'Alone, ordered, numb' → value_out 'Still alone,
        unbroken routine'. The document was accurate. The film was the problem.

        This method is the input side: 8-15 sequences with a tension curve, a mode per
        sequence, a named adversary, an irreversible cost at every peak and an uneven
        runtime split — the shape measured off 13 produced sci-fi screenplays. Feed the
        result to _script_from_spine (generate_script(spine=...)) and the script is
        written to fit it, instead of being scored after the fact.

        Same engine split as derive_film_bible — Seed 2.0 Pro first, Claude as fallback,
        via _text_llm — so it works with EITHER key configured. Returns the
        shape_film_bible shape (identical to derive_film_bible's, so both feed the same
        consumers) or {} when the answer will not parse; never raises for that.
        """
        mins = target_duration_secs / 60
        n_lo, n_hi = (8, 11) if target_duration_secs < 600 else (10, 15)
        system = (
            "You are a story architect. Given a concept, design the SPINE of the film "
            "BEFORE a word of script exists. You are not writing scenes; you are deciding "
            "what each stretch of the film costs.\n"
            "Return ONLY this JSON, no prose, no fences:\n"
            '{"logline": "<one sentence: who wants what, and what is in the way>", '
            '"tone": "<3-6 words: the register>", '
            '"characters": [{"name": "<NAME>", "wants": "<consciously pursuing>", '
            '"needs": "<what they actually require, unknown to them>", '
            '"arc": "<the shift, one clause>"}], '
            '"sequences": [{"id": "SEQ_1", '
            '"purpose": "<what this stretch is FOR, one clause>", '
            '"question_opened": "<the question it puts in the audience\'s head>", '
            '"answers": ["<ids of EARLIER sequences whose questions this one closes; [] if none>"], '
            '"value_in": "<the protagonist\'s situation entering, 3-6 words>", '
            '"value_out": "<their situation leaving, 3-6 words>", '
            '"direction": "up|down", '
            '"obstacle": "<what actively resists them, as something a CAMERA CAN SEE>", '
            f'"obstacle_type": "{"|".join(SEQ_OBSTACLE_TYPES)}", '
            '"obstacle_owner": "<the character resisting, when obstacle_type is external_agent>", '
            '"tension": <1-10>, '
            f'"mode": "{"|".join(SEQ_MODES)}", '
            '"event": {"irreversible": true|false, "who": "<who pays>", '
            '"loses": "<what they can NEVER get back>"}, '
            '"cost_level": <0-3: how much the protagonist has given up by the END of this '
            'sequence; it never goes down>, '
            '"seconds_share": <this sequence\'s fraction of the runtime; the shares sum to 1.0>}]}\n'
            f"\nWrite {n_lo}-{n_hi} sequences. These rules are measured off 13 produced "
            "screenplays, not preferences:\n"
            "1. CAUSALITY. A sequence exists because an EARLIER one opened a question. "
            "Before writing each one, name which sequence forced it. If nothing forced it, "
            "it does not belong in the film. Every question except the last one's is closed "
            "by name in a later sequence's `answers`.\n"
            "2. COST. Every sequence with tension >= 8 MUST take something the protagonist "
            "can never get back — a person, a body part, a belief, the way home, their own "
            "innocence. `loses` names the thing, and it stays lost. A loud sequence that "
            "costs nothing is the single most common way a film reads as a series of "
            "events instead of a story.\n"
            "3. THE CURVE OSCILLATES, it does not ramp. The Tomorrow War, by sequence: "
            "3,6,6,7,6,8,10,7,9,5,6,10,4,6,9. Both 10s drop immediately — to 7 and to 4. "
            "Design the numbers first, as a curve, then write the sequences to them.\n"
            "4. RELIEF. Within two sequences of any peak (tension >= 8) put a comedy, "
            "quiet or wonder sequence. In The Tomorrow War the sequence before the finale "
            "is COMEDY. Use at least 4 different modes and let no single mode be more than "
            "40% of the film.\n"
            "5. THE OBSTACLE IS USUALLY SOMEONE ELSE. Prefer external_agent with a named "
            "obstacle_owner who has their own agenda and wants something incompatible with "
            "the protagonist's want — ideally the same adversary in 3 or more sequences. "
            "obstacle_type 'self' (the hero hesitating, not speaking, not opening the door) "
            "is legitimate at most twice in the whole film: a protagonist who is only ever "
            "stopped by their own hesitation cannot be beaten, so nothing costs anything.\n"
            "6. THE SHARES ARE UNEVEN ON PURPOSE. The third act is not the same size as the "
            "first. Some sequences are 3% of the film and some are 15%. They sum to 1.0.\n"
            "7. The highest tension in the film belongs in the LAST QUARTER of the runtime "
            "(measured by cumulative seconds_share, not by sequence count).\n"
            "8. cost_level is CUMULATIVE and never returns to 0 once it has risen; by the "
            "final third it is at least 1 everywhere."
        )
        user = (f"Target runtime {mins:.0f} min ({target_duration_secs}s).\n"
                + (f"Tone: {tone_hint}\n" if tone_hint.strip() else "")
                + f"\nCONCEPT:\n{concept}")
        raw = ""
        try:
            # Seed-first with the Claude fallback, exactly like the other generators —
            # a story spine must not be the one thing that stops working when a single
            # provider's balance runs out.
            # 5000, not derive_film_bible's 2600: this writes up to 15 sequences with
            # eight more fields each. A spine truncated mid-JSON parses as nothing and
            # returns {}, which reads to the user as "the model refused".
            raw = self._text_llm(system, user, max_tokens=5000, temperature=0.6).strip()
        except Exception as e:  # noqa: BLE001
            logger.warning("[Spine] proposal failed (%s) — no spine", e)
            return {}
        bible = shape_proposed_spine(raw)
        if not bible:
            return {}
        failed = [c["label"] for c in (bible.get("story_checks") or []) if not c["passed"]]
        logger.info("[Spine] proposed %d sequence(s) · tension %s · tone=%r%s",
                    len(bible["sequences"]),
                    ",".join(str(_seq_tension(s) or "-") for s in bible["sequences"]),
                    bible["tone"],
                    f" · STORY GATES FAILED: {', '.join(failed)}" if failed else "")
        return bible

    def derive_film_bible(self, script: str, target_duration_secs: int = 60) -> dict:
        """The story spine, read out of the finished script.

        A STANDALONE entry point — phase 1's, not phase 2's. It needs a script and a
        target runtime and nothing else: no breakdown, no shots, no assets, no project
        on disk. That matters because the user's requirement is "Take One Studio proposes the
        story and I approve it, before the shot list exists", and for a long time the
        only caller was generate_breakdown, which made the spine a side effect of
        writing 600 shots. Callable directly:

            from claude_agents import ClaudeQCAgents
            ClaudeQCAgents().derive_film_bible(open("script.txt").read(), 300)

        Derived from the SCRIPT rather than the concept on purpose: expand_concept is
        only reachable through "Develop idea", which Autopilot skips entirely, so a
        concept-derived bible would be missing from exactly the path that generates
        whole episodes unattended. The script exists in every path.

        Every field here has a consumer — that rule has not changed, the list has.
        logline and tone go into the breakdown's per-batch premise; characters'
        wants/needs/arc ground the `performance` and dialogue subtext the breakdown writes,
        which until now came from nothing but the action line; and since 2026-08-12 the
        DRAMA LAYER (tension, mode, obstacle_type/owner, cost_level, seconds_share, event)
        is written here too. It is read by the eight drama gates in _check_drama_layer, by
        the tension curve and runtime strip in the spine editor, by _batch_story_context
        (which maps sequences onto breakdown batches by share), and by the per-sequence
        script writer's word budget.

        It is written here because there is nowhere else left. propose_spine wrote it and
        propose_spine is out of the product (it invented a cast: CLARA and DANIEL over a
        script about JOEL and MARA), so a derived spine reaching the editor with an empty
        curve meant those eight gates never ran at all — they are each guarded by "does
        any sequence declare the field I read", so an absent layer is not a failed layer,
        it is an unasked question. The difference between the two prompts survives: this
        one MEASURES the script, propose_spine DESIGNED a film. See the drama-layer
        paragraph in `system` — the rules there are deliberately the opposite of that
        method's, because a report that bends until the gates approve of it measures
        nothing.

        Acts, setups/payoffs and a look bible still belong here eventually and are NOT
        included, because nothing would read them yet: this codebase already carries four
        fields that are written and never read, and adding a fifth helps no one.

        Runs on Seed 2.0 Pro with Claude as fallback, so it works with EITHER key
        configured. Returns the shape_film_bible() shape —
        {logline, tone, characters:[{name, wants, needs, arc}], sequences:[…]} plus
        story_checks when there is a spine to score — or {} when the model's answer
        could not be parsed (never raises for that: a missing bible costs richness,
        it must not take the caller down).
        """
        import json as _json
        mins = target_duration_secs / 60
        system = (
            "You are a script editor. Read the screenplay and state its SPINE — not a "
            "summary, the underlying structure a director would need.\n"
            "Return ONLY this JSON, no prose, no fences:\n"
            '{"logline": "<one sentence: who wants what, and what is in the way>", '
            '"tone": "<3-6 words: the register, e.g. \'restrained domestic realism\'>", '
            '"characters": [{"name": "<exactly as written in the script>", '
            '"wants": "<what they are consciously pursuing IN THIS STORY>", '
            '"needs": "<what they actually require, usually unknown to them>", '
            '"arc": "<the shift from first appearance to last, in one clause>"}], '
            # ONE ENTRY PER SPEAKING CHARACTER, and it has to be said. THE DIVORCE DRAMA
            # QUEEN came back with a spine listing ONLY Nadia (2026-08-12) — Tomás speaks
            # eight of the script's eighteen lines and is the antagonist the spine's own
            # "recurring adversary" check names ("'tomás' resists in 3 sequences"), and he
            # had no wants, no needs, no arc. Everything downstream that grounds a
            # performance reads this list, so half the cast was acting off nothing: the
            # breakdown writes each character's ACTING MASTER PROFILE from wants/needs/arc,
            # and an absent character gets a temperament invented per shot instead.
            "EVERY character who SPEAKS in the script needs an entry here, antagonists and "
            "secondary characters included - not only the protagonist. A speaking character "
            "with no wants/needs/arc has nothing for their performance to be built from.\n"
            # ── The story layer. A film is legible when each stretch answers a question
            # an earlier one raised and leaves the protagonist measurably better or worse
            # off. Both are checkable, unlike "dramatic function", which is a label.
            '"sequences": [{"id": "SEQ_1", '
            '"covers": "<the scene headings this sequence spans, comma separated>", '
            '"question_opened": "<the question this sequence puts in the audience\'s head>", '
            '"answers": ["<ids of the EARLIER sequences whose questions this one closes; '
            '[] only if it closes nothing>"], '
            '"value_in": "<the protagonist\'s situation entering it, 3-6 words>", '
            '"value_out": "<their situation leaving it, 3-6 words>", '
            '"direction": "up|down", '
            '"obstacle": "<what actively resists them here, as something a CAMERA CAN SEE: '
            'a behaviour, an object, another person\'s action, a physical limit. If nothing '
            'resists them, write NONE>", '
            # ── THE DRAMA LAYER. Until 2026-08-12 only propose_spine wrote these, so every
            # DERIVED spine — which is now the only kind there is — reached the editor with
            # the tension curve empty, the runtime split empty and EIGHT of the fourteen
            # gates silently not running: each one is guarded by "does any sequence declare
            # the field I read". Six gates out of fourteen reads as a score and is not one;
            # it is half the exam left blank.
            f'"obstacle_type": "{"|".join(SEQ_OBSTACLE_TYPES)}", '
            '"obstacle_owner": "<the person resisting, named EXACTLY as the script writes '
            'them — only when obstacle_type is external_agent; empty for environment, rule '
            'and self>", '
            '"tension": <1-10: the pressure this stretch actually carries as written>, '
            f'"mode": "{"|".join(SEQ_MODES)}", '
            '"cost_level": <0-3: how much the protagonist has given up by the END of this '
            'sequence, counting everything lost so far; it never goes down>, '
            '"seconds_share": <this sequence\'s fraction of the finished runtime; they sum '
            'to 1.0>, '
            '"event": {"irreversible": true|false, "who": "<who pays>", '
            '"loses": "<what they can NEVER get back>"}}]}\n'
            "Only characters who SPEAK or drive action. Skip extras. If the script is "
            "too short to support an arc, say so in that character's arc field rather "
            "than inventing one.\n"
            "SEQUENCES: 3-8 of them, covering the whole script in order. Be honest — if a "
            "stretch has no obstacle and nothing changes, say so with direction unchanged "
            "and obstacle NONE. A flat report is useful; an invented conflict is not.\n"
            "OBSTACLE must be a BEHAVIOUR OR A THING, never a feeling. \"He stands at the "
            "door and does not open it\" is an obstacle; \"his fear of opening the door\" is "
            "not — it names the emotion behind the behaviour and leaves nothing to shoot. "
            "\"Water in the mechanism housing\", \"she keeps her back to the wall\", \"he "
            "answers in fragments\" are obstacles. \"His unresolved grief\" is not.\n"
            "VALUE must be CONTINUOUS: each sequence's value_in has to match the previous "
            "one's value_out. Walking the value backwards between sequences to manufacture "
            "a rise is the most common way this document lies about the story.\n"
            "ANSWERS is the part most often left empty and it is the one that decides "
            "whether the film is legible. Work BACKWARDS from the end: for each question "
            "you opened, find the later sequence where the audience learns the answer and "
            "list the opener's id there. Every question except the last sequence's should "
            "be closed by name. If a question genuinely goes unanswered, leave it — that "
            "is a real finding about this script, not a formatting failure.\n"
            # MEASURED, NOT DESIGNED. propose_spine asks for the same eight fields with the
            # opposite instructions — "make the curve oscillate", "put relief within two
            # sequences of a peak", "the shares are uneven on purpose" — because it is
            # inventing a film. Those rules here would make the model bend its report until
            # the gates approve of it, and a document that always passes measures nothing.
            "THE DRAMA LAYER — tension, mode, cost_level, seconds_share, event — is READ "
            "OFF this script, never designed for it:\n"
            "· TENSION is the pressure the stretch carries as written. A quiet exchange is "
            "a 2 or a 3. Never raise a number so the curve looks like a film.\n"
            "· MODE is the register the stretch is actually in, from the list above. If "
            "none fits exactly, choose the closest — a word outside the list is read as no "
            "mode at all.\n"
            "· COST_LEVEL counts what the protagonist has ACTUALLY given up by the end of "
            "the stretch. Cumulative, never decreasing. If this script takes nothing from "
            "them it is 0 throughout, and that is a true and useful answer.\n"
            "· EVENT.irreversible is true ONLY where the script really takes something for "
            "good — a person, a possibility, a way back. A loud scene that costs nothing "
            "is false, and `loses` stays empty.\n"
            "· SECONDS_SHARE is how much of the finished film this stretch occupies, judged "
            "by how much script it covers. They sum to 1.0.\n"
            "· OBSTACLE_OWNER is a PERSON, spelled as the script spells them, and only when "
            "a person is what resists. Leave it empty when the obstacle is a place, a rule "
            "or the protagonist's own hesitation: naming a room or the hero there would "
            "report an antagonist this film does not have.\n"
            # THE TWO-HANDER. DRAMA QUEEN 2 came back with obstacle_type 'self' on all
            # three sequences of a two-person argument — including one whose own obstacle
            # text was "both interrupt and talk over one another", which is plainly the
            # OTHER PERSON. The Agency gate then reported a film in which nobody resists
            # anybody, and WHO RESISTS was empty on every row, for a scene with the
            # antagonist standing in it. 'self' is the rarest label, not the default.
            "· OBSTACLE_TYPE 'self' is ONLY for a stretch where nothing and nobody pushes "
            "back and the protagonist simply does not move. If what blocks them is ANOTHER "
            "PERSON'S behaviour — interrupting, refusing, walking out, staying silent at "
            "them, answering in fragments — that is external_agent, and obstacle_owner is "
            "that person. This holds in a two-hander where both do it to each other: each "
            "is the other's obstacle, and the sequence takes the name of whoever is "
            "resisting the character it follows. obstacle_owner is EXACTLY ONE name — "
            "never a list, never \"A and B\". If two people block each other, name the one "
            "resisting the character this sequence follows.\n"
            "A flat curve, one mode throughout and a cost that never rises are legitimate "
            "answers about a script. The director reads them and decides what to change — "
            "a curve invented to look correct hides the one thing this document is for."
        )
        # Seed 2.0 Pro, with the Anthropic path as fallback — the same split the wardrobe
        # and QC passes already use. Measured with a blind four-judge panel (2026-07-31):
        # the only consistent quality gap between the two engines was that one wrote
        # obstacles as filmable behaviour and the other as emotional state, and naming
        # that ambiguity in the prompt above closed it (5/5 obstacles became shots, and
        # the value chain went from 4 broken seams to 0). So this is not a downgrade —
        # it removes a hard dependency on a separately-billed API from the one call that
        # decides what the film is about, and the story spine keeps working when that
        # balance runs out.
        # THE CAST, READ OFF THE SCRIPT AND HANDED OVER — not requested in prose. The
        # schema line above already says every speaking character needs an entry, and
        # DRAMA QUEEN 2 still came back with one character out of two AND invented both
        # their names (CLARA and DANIEL for a script about JOEL and MARA). A list is not
        # something the model can compress; a request is. The cue reader is the same one
        # the cast gates score the answer with, so the instruction and the check cannot
        # disagree.
        _cast = script_speaking_cast(script)
        _cast_msg = (f"\n\nThese {len(_cast)} characters SPEAK in this screenplay: "
                     f"{', '.join(_cast)}. Return one entry in \"characters\" for each of "
                     f"them, named exactly as written here, and do not invent a character "
                     f"who does not appear above.") if _cast else ""
        user_msg = (f"Target runtime {mins:.0f} min.{_cast_msg}"
                    f"\n\nSCREENPLAY:\n{script[:60000]}")
        raw = ""
        try:
            # 5000, was 2600, for the same reason propose_spine has always used 5000: each
            # sequence now carries eight more fields. A spine truncated mid-JSON does not
            # parse, this returns {}, and on screen that reads as "the model refused".
            raw = self._seed_text(system, user_msg, max_tokens=5000, temperature=0.3).strip()
        except Exception as e:
            logger.warning("[Bible] Seed unavailable (%s) — falling back to Claude", e)
        if not raw:
            # Same soft-init contract every other entry point here honours: with no
            # Anthropic key self.client is None and _llm would die on an attribute of
            # None. A standalone caller (a script, the story endpoint) deserves the
            # configured reason, not "'NoneType' object has no attribute 'messages'".
            if not self.client:
                raise RuntimeError(self.config_error or "ANTHROPIC_API_KEY not configured")
            response = self._llm(
                # 4000, was 2000 — the fallback has to be able to answer the same schema
                # the Seed path does, or an exhausted BytePlus balance quietly downgrades
                # every spine to a truncated one.
                model=MODEL, max_tokens=4000,
                system=[{"type": "text", "text": system,
                         "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": user_msg}],
            )
            raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1].lstrip("json").strip()
        try:
            data = _json.loads(raw)
        except Exception as e:
            logger.warning("[Bible] unparseable — continuing without one: %s", e)
            return {}
        bible = shape_film_bible(data)
        failed = [c["label"] for c in (bible.get("story_checks") or []) if not c["passed"]]
        logger.info("[Bible] %d character(s) · %d sequence(s) · tone=%r%s",
                    len(bible["characters"]), len(bible["sequences"]), bible["tone"],
                    f" · STORY GATES FAILED: {', '.join(failed)}" if failed else "")
        return bible

    def expand_concept(self, concept: str, target_duration_secs: int = 60) -> dict:
        """Item 1c — interactive "Develop idea": expand a one-line concept into a richer
        premise, then draft 3-5 multiple-choice SELECTION questions whose answers most
        shape the eventual script. Runs on Seed 2.0 Pro with a Claude fallback (_text_llm)
        so it survives an exhausted Anthropic balance. The answered
        questions are folded back into the concept and sent to the EXISTING generate_script
        path, so the one-shot Generate flow is untouched.
        Returns {expanded_concept, questions:[{id,question,options:[...]}]}."""
        mins = target_duration_secs / 60
        system = (
            "You are a film development executive helping a writer shape a short film "
            "BEFORE the script is written. Given a one-line concept, do TWO things:\n"
            "1. EXPANDED_CONCEPT: a richer 2-4 sentence premise (protagonist, world, "
            "central tension) — do NOT write the script itself.\n"
            "2. QUESTIONS: 3-5 multiple-choice questions whose answers most shape the "
            "script (genre/tone, protagonist identity, setting/era, central conflict, "
            "ending). Each has 3-4 concrete, mutually-distinct options.\n"
            f"Final film ~{mins:.1f} min — keep scope achievable.\n"
            "Output ONLY valid JSON, no markdown, no preamble:\n"
            '{"expanded_concept":"<string>","questions":[{"id":"q1",'
            '"question":"<string>","options":["<string>","<string>","<string>"]}]}'
        )
        # Seed 2.0 Pro FIRST, Claude as the fallback (_text_llm). This used to be a bare
        # _llm(model=MODEL) call, so an exhausted Anthropic balance took out the very
        # first button of the pipeline: "Develop idea" answered 400 "credit balance is
        # too low" while BytePlus — which draws every image and video — was funded and
        # idle. A development pass is not where a single-provider dependency belongs,
        # the same reasoning that already moved the sheet writers onto _text_llm.
        raw = self._text_llm(system, concept, max_tokens=1500, temperature=0.7)
        try:
            # Reuse the generic fence-strip + first-object decoder (never re-inline it).
            data = _parse_breakdown_json(raw)
        except Exception as e:  # noqa: BLE001
            # _text_llm only falls back to Claude when the API itself ERRORS — a
            # successful but malformed Seed answer would surface here as a 500 on the
            # user's first click. Retry once on Claude, which writes strict JSON
            # reliably; mirrors derive_wardrobes and _breakdown_batch.
            logger.warning("[Develop] seed JSON unusable (%s) — retrying on Claude", e)
            data = _parse_breakdown_json(self._qc_claude(system, concept, 1500))
        # Defensively re-shape so a malformed slot can never break the frontend panel.
        questions = []
        for i, q in enumerate(data.get("questions") or [], 1):
            opts = [str(o).strip() for o in (q.get("options") or []) if str(o).strip()]
            text = str(q.get("question") or "").strip()
            if text and opts:
                questions.append({"id": q.get("id") or f"q{i}", "question": text, "options": opts})
        return {"expanded_concept": str(data.get("expanded_concept") or concept).strip(),
                "questions": questions}

    def generate_breakdown(self, script: str, target_duration_secs: int = 60,
                           segment_max_secs: float = SEGMENT_MAX_SECS,
                           story_context: "str | Any" = "", spine_len: int = 0) -> dict:
        """Production breakdown (assets + shots). LONG-FORM SAFE up to feature length
        (150 min ≈ 1800 shots): the script is split into scenes, grouped into
        runtime-bounded BATCHES, each batch generated in one call (concurrently),
        then merged — deduping assets by name and renumbering shots continuously.
        Routes to the configured BREAKDOWN backend (Claude by default; Seed 2.0 Pro
        opt-in via BREAKDOWN_BACKEND=seed) with a fallback to the other.

        `story_context` is a string, or a CALLABLE (secs_before, batch_secs) -> str asked
        once per batch. The callable exists because the batching happens HERE — the
        caller cannot know where the batch boundaries fall without re-deriving them, and
        two copies of that arithmetic would drift. It lets the server hand each batch the
        sequences of the spine that actually own its scenes: _breakdown_batch gives this
        block a 2000-character budget, and a 15-sequence spine rendered whole loses its
        last act to that truncation for every batch, including the ones writing it.
        A plain string is used for every batch, which is what every existing caller
        passes and is byte-for-byte the prompt they get today."""
        from concurrent.futures import ThreadPoolExecutor
        import math as _math

        scenes = _split_script_scenes(script)
        # Batch size follows the SPINE when there is one. At the fixed 300s a 6-minute
        # film is two batches, so the first is handed 13 of 15 sequences at once and asked
        # to write the shots for all of them — and the model does not distinguish them, it
        # clusters. Measured on BLOOM: 15 planned sequences came back as 7, with S7..S14
        # absorbed into S6 (the whole second act), 193s against a 347s plan. _attach_
        # sequence_ids then correctly refused to invent the missing tags, so the loss was
        # visible but not recoverable. Roughly three sequences per batch is few enough to
        # tell apart and still gives the batch its neighbours for context.
        batch_secs = 300
        if spine_len > 3 and target_duration_secs > 0:
            batch_secs = max(45, int(target_duration_secs * 3 / spine_len))
        batches = _batch_scenes(scenes, target_duration_secs, batch_secs=batch_secs)
        # Shared location vocabulary for every batch — concurrent batches otherwise
        # each invent their own name for the same place (see _script_locations).
        locations = _script_locations(script)
        # …and the map that lets the MERGE enforce that vocabulary instead of trusting the
        # writer to have used it. See _location_state_index for the run that made it code.
        loc_index = _location_state_index(script) if locations else {}
        logger.info("[BreakdownGen] target=%ds → %d scene(s), %d batch(es), engine=%s",
                    target_duration_secs, len(scenes), len(batches),
                    self._breakdown_backend if (self._breakdown_backend == "seed" and self._qc_client) else "claude")

        # Resolve the per-batch context BEFORE the pool: the renderer walks the spine and
        # must see the batches in order, which concurrent workers cannot guarantee.
        if callable(story_context):
            ctxs: list[str] = []
            secs_before = 0.0
            for _txt, _secs in batches:
                ctxs.append(story_context(secs_before, float(_secs)) or "")
                secs_before += _secs
        else:
            ctxs = [story_context] * len(batches)

        # Generate batches concurrently (seed is ~45-60s/call; bounded so a 150-min
        # film finishes in a few minutes, not ~20). Results kept in batch order.
        parts: list[dict] = [{} for _ in batches]
        workers = min(5, len(batches))
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = {ex.submit(self._breakdown_batch, txt, secs, i + 1, len(batches), ctxs[i], locations,
                              segment_max_secs=segment_max_secs): i
                    for i, (txt, secs) in enumerate(batches)}
            for fut in futs:
                i = futs[fut]
                parts[i] = fut.result()   # exceptions propagate (a failed batch fails the run)

        # Merge: dedup assets by name, remap local ids → global, renumber shots.
        merged_assets: list[dict] = []
        name_to_global: dict[str, str] = {}
        all_shots: list[dict] = []
        asset_seq = shot_seq = 0
        # Stable scene identity. The breakdown only ever emitted the LLM's free-text
        # heading, and the frontend used that STRING as the scene's identity — so every
        # return to "INT. KITCHEN - DAY" across a 45-minute episode collapsed into one
        # pseudo-scene, and anything keyed on scene (continuity chaining, wardrobe by
        # scene, storyboard grouping) could jump from act 1 to act 3. Assign an id that
        # increments on every CHANGE of heading, so two visits to the same location are
        # two scenes. Emitted alongside `scene`, never replacing it: a project generated
        # before this field exists still normalises exactly the way it always did.
        scene_seq = 0
        last_heading: str | None = None
        for bi, part in enumerate(parts, 1):
            local_to_global: dict[str, str] = {}
            for a in part.get("assets", []):
                nm = str(a.get("name") or "").strip()
                if not nm:
                    continue
                # ENVIRONMENTS ONLY: snap the writer's spelling back onto the script's own
                # vocabulary. Characters/props/fx are untouched — they have no slug line to
                # be canonical against, and _split_slug_state would happily read a prop
                # called "LANTERN - NIGHT" as a location state.
                if loc_index and str(a.get("type") or "").lower() == "environment":
                    canon = _canonical_env_name(nm, loc_index)
                    if canon != nm:
                        logger.info("[BreakdownGen] environment %r → canonical %r", nm, canon)
                        nm = canon
                        a = {**a, "name": nm}
                key = _norm_name(nm)  # fold separators so "School - Hallway" ≡ "School Hallway"
                if key not in name_to_global:
                    asset_seq += 1
                    name_to_global[key] = f"ASSET_{asset_seq:03d}"
                    merged_assets.append({**a, "id": name_to_global[key]})
                if a.get("id"):
                    local_to_global[a["id"]] = name_to_global[key]
            for sh in part.get("shots", []):
                if not isinstance(sh, dict):
                    continue
                shot_seq += 1
                sh["id"] = f"SHOT_{shot_seq:03d}"
                sh["scene"] = sh.get("scene") or f"SC_{bi:02d}"
                if sh["scene"] != last_heading:
                    scene_seq += 1
                    last_heading = sh["scene"]
                sh["scene_id"] = f"SC-{scene_seq:03d}"
                sh["assets_used"] = [local_to_global.get(x, x) for x in (sh.get("assets_used") or [])]
                for d in (sh.get("dialogue") or []):
                    if isinstance(d, dict) and d.get("characterId"):
                        d["characterId"] = local_to_global.get(d["characterId"], d["characterId"])
                all_shots.append(sh)

        if not all_shots:
            raise RuntimeError("Breakdown produced no shots — the script may be empty or unparseable.")

        # Size each shot so its dialogue can actually be SPOKEN, splitting any shot
        # whose dialogue does not fit in one take rather than clipping it.
        all_shots, _splits = _size_and_split_shots(all_shots)
        if _splits:
            logger.info("[BreakdownGen] split %d shot(s) whose dialogue exceeded %ds",
                        _splits, SHOT_MAX_SECS)

        # Deterministic completeness: every scene location gets an environment
        # asset even when the LLM forgot one (the #1 recurring Producer-QC fail).
        added_envs = _ensure_scene_environments(merged_assets, all_shots)
        if added_envs:
            logger.info("[BreakdownGen] synthesized %d environment asset(s) for uncovered scene locations", added_envs)

        # An asset that DEPICTS a character must render from that character's approved
        # sheet, never from its own description. Runs BEFORE wardrobe variants on purpose:
        # the scan must only ever land on base characters, not on an outfit of one.
        _link_depicted_assets(merged_assets)

        # CHARACTER STATES across the story — what they wear and what has happened to
        # them, as separate assets the render can reference per scene.
        #
        # ON by default now. It was opt-in "until the AG/SG UI phases land", and the cost
        # of that default was measured: in ROBOTECH all 44 shots referenced the same
        # UNIT-7/v001.png, so the robot that crosses a destroyed city is pixel-identical
        # in the first shot and the fortieth — no dirt, no damage, nothing it picked up.
        # A protagonist who does not change cannot carry a story, and no amount of
        # continuity or pacing work compensates for it. Set CHARACTER_STATES=0 to revert.
        if os.getenv("CHARACTER_STATES", os.getenv("WARDROBE_VARIANTS", "1")) != "0":
            try:
                plan = self.derive_wardrobes(script, merged_assets, all_shots)
                added_wd = _apply_wardrobe_variants(merged_assets, all_shots, plan)
                if added_wd:
                    logger.info("[BreakdownGen] added %d character state(s) — the cast "
                                "now changes across the film", added_wd)
                else:
                    logger.info("[BreakdownGen] no character states derived — every "
                                "character looks the same from first shot to last")
            except Exception as e:
                logger.warning("[BreakdownGen] character-state pass failed (non-fatal): %s", e)

        # Group the flat shot list into the units that are actually RENDERED. The shots
        # stay in the payload as the transport (every existing consumer reads them); the
        # segments are what stage 5 calls Seedance with, one per call.
        # The ceiling comes from the project's chosen video model: 15 s on the 2.0
        # family, 30 s on 2.5. Planning long takes is the POINT of picking 2.5 — a
        # 30 s segment is one continuous render instead of six cuts to drift across.
        segments = _group_into_segments(all_shots, segment_max_secs)
        multi = sum(1 for s in segments if len(s["shots"]) > 1)
        short = sum(1 for sh in all_shots if float(sh.get("duration_sec") or 0) < SHOT_MIN_SECS)
        logger.info("[BreakdownGen] done: %d assets, %d shots in %d segment(s) "
                    "(%d multi-shot) across %d batch(es); %d shot(s) under %ds — "
                    "impossible before segments",
                    len(merged_assets), len(all_shots), len(segments), multi,
                    len(batches), short, SHOT_MIN_SECS)
        # EL IDIOMA DEL DIÁLOGO, una vez por película. La guía 2.5 §1.3 lo quiere delante
        # de cada línea hablada porque el modelo habla chino por defecto; sin declararlo,
        # una línea inglesa o española puede volver doblada. Se pregunta aquí, que es el
        # único punto del pipeline que ha leído el guion entero, y no en cada render.
        # No fatal y sin valor por defecto: si esto falla el campo va vacío y el prompt
        # queda como estaba — adivinar el idioma es peor que no decirlo.
        dialogue_language = ""
        try:
            dialogue_language = (self._text_llm(
                "Answer with ONE word and nothing else: the language the SPOKEN DIALOGUE "
                "in this screenplay is written in (for example: English, Spanish, "
                "Japanese). If there is no dialogue, answer NONE.",
                script[:4000], max_tokens=8, temperature=0.0) or "").strip().rstrip(".")
            if dialogue_language.upper() == "NONE" or len(dialogue_language) > 24:
                dialogue_language = ""
        except Exception as e:
            logger.warning("[BreakdownGen] dialogue language undetermined (non-fatal): %s", e)
        logger.info("[BreakdownGen] dialogue language: %s", dialogue_language or "(undeclared)")
        return {"assets": merged_assets, "shots": all_shots, "segments": segments,
                "dialogue_language": dialogue_language}

    def derive_wardrobes(self, script: str, characters: list[dict], shots: list[dict]) -> dict:
        """Detect per-character wardrobe VARIANTS from the script. For each HUMAN
        character, decide the distinct outfits worn and which SCENES each covers
        (e.g. Eli: pyjamas in the bedroom-night scenes, day clothes at school/kitchen).
        Returns {char_name: [{"label","wardrobe","scenes":[scene headings]}]} — the
        FIRST entry is the default look. Single-outfit / non-human characters yield
        ≤1 entry (no variant). Best-effort: returns {} on any failure so the breakdown
        proceeds outfit-agnostic. Seed 2.0 Pro (no Anthropic spend), Claude fallback."""
        chars = [c for c in characters
                 if str(c.get("type") or "").lower() == "character" and not c.get("parentCharacterId")]
        if not chars or not shots:
            return {}
        id_to_name = {c.get("id"): c.get("name") for c in chars}
        appears: dict = {}
        for sh in shots:
            scene = str(sh.get("scene") or "").strip()
            if not scene:
                continue
            for aid in (sh.get("assets_used") or []):
                nm = id_to_name.get(aid)
                if nm:
                    appears.setdefault(nm, set()).add(scene)
        roster = "\n".join(
            f"- {c.get('name')}: {str(c.get('visual_description') or '')[:200]} "
            f"| scenes: {'; '.join(sorted(appears.get(c.get('name'), set()))) or '(none)'}"
            for c in chars
        )
        # Costume was too narrow. What a shot actually needs is the character's STATE —
        # what they wear AND what has happened to them: the cut over the eye, the soaked
        # coat, the missing sleeve, what they are carrying now that they were not before.
        # Without it every shot references the same clean reference sheet, so the
        # protagonist is pixel-identical in shot 1 and shot 40 and the film has no visible
        # arc. A character who does not change cannot carry a story.
        system = (
            "You are a film COSTUME DESIGNER and CONTINUITY SUPERVISOR. Given a script and "
            "its characters (with the scenes each appears in), decide how each character "
            "LOOKS at each point of the story — clothes AND physical condition. Return "
            "STRICT JSON, no markdown:\n"
            '{"CharacterName":[{"label":"short state name","wardrobe":"one vivid sentence '
            'head-to-toe: garments, and the visible condition of the body — dirt, damage, '
            'wounds, wetness, what they now carry","scenes":["EXACT scene heading string as '
            'given",...]}]}\n'
            "Rules:\n"
            "- The FIRST entry per character is how they START.\n"
            # Dos clases de estado, y tratarlas igual es lo que puso a una náufraga con el
            # pelo CONGELADO sentada junto a una estufa encendida dentro del faro. Un
            # supervisor de continuidad sabe que el hielo se derrite y que el corte no.
            "- Two KINDS of change, and they behave differently:\n"
            "  · PERMANENT — cuts, bruises, a swollen eye, torn cloth, a missing button, "
            "soot, a scar. These ACCUMULATE: every later state carries everything the "
            "earlier ones had, plus what this stretch adds. A cut does not heal.\n"
            "  · TRANSIENT — soaked clothes, ice in the hair, blue lips, shivering, "
            "breathlessness, snow on the shoulders, mud that is still wet. These RESOLVE "
            "once the cause is gone: a fire dries and thaws, rest steadies the breath, "
            "shelter stops the shivering. Describing a character as frozen while they sit "
            "by a lit stove is a continuity error, not accumulated damage.\n"
            "- So: check WHERE each state happens and how long they have been there. "
            "Indoors by a fire, after a stretch inside, the wet and the ice are gone but "
            "the wounds and the torn cloth remain. Never describe a later state as cleaner "
            "or more intact in its PERMANENT damage than an earlier one.\n"
            "- Give a character more than ONE entry when the story visibly marks them: a "
            "change of clothes, a fight, weather, a wound, a long journey, time passing. A "
            "character who goes through the whole story untouched gets one entry — but say so "
            "because the script shows nothing happening to them, not by default.\n"
            "- Assign EVERY scene the character appears in to exactly one state, using ONLY "
            "the scene headings provided verbatim.\n"
            "- NON-HUMAN characters (robots, animals, creatures) get states too: scuffs, "
            "dents, cracked plating, lost panels, dust. Return an empty array only for a "
            "character who never appears on screen.\n"
            "Output ONLY the JSON."
        )
        user = f"SCRIPT:\n{script[:6000]}\n\nCHARACTERS AND THEIR SCENES:\n{roster}"
        data: Any = None
        try:
            raw = self._seed_text(system, user, max_tokens=1400, temperature=0.3)
            data = _parse_breakdown_json(raw)
        except Exception as e:
            # _seed_text only falls back to Claude when the API itself errors — a
            # SUCCESSFUL but malformed Seed answer used to discard the whole costume plan
            # silently (observed 2026-07-27: valid-looking JSON that broke at char 581, so
            # every character stayed single-outfit). Retry ONCE on Claude, which writes
            # strict JSON reliably; only then give up. Mirrors _breakdown_batch's retry.
            logger.warning("[Wardrobe] seed JSON unusable (%s) — retrying on Claude", e)
            try:
                data = _parse_breakdown_json(self._qc_claude(system, user, 1400))
            except Exception as e2:
                logger.warning("[Wardrobe] detection failed (non-fatal): %s", e2)
                return {}
        if not isinstance(data, dict):
            return {}
        logger.info("[Wardrobe] plan: %s",
                    {k: len(v) for k, v in data.items() if isinstance(v, list)})
        return data

    def _breakdown_batch(self, script_chunk: str, target_secs: int, batch_no: int, total: int,
                         story_context: str = "", locations: list | None = None,
                         # LAST on purpose: the only caller passes the first six
                         # POSITIONALLY, so inserting anything earlier would silently
                         # rebind story_context and locations to the wrong values.
                         segment_max_secs: float = SEGMENT_MAX_SECS) -> dict:
        """One breakdown call for a batch of scenes → {assets, shots}. Retries once
        at a higher token cap if the JSON came back truncated/invalid.

        story_context is the film's premise. Batches run CONCURRENTLY and, until now,
        each one saw nothing but its own slice of scene text — five workers inventing
        characters and locations for the same film with no idea what the film is about,
        held together only by the instruction to spell names consistently. Passing the
        premise into every batch is the cheapest thing that makes them agree.
        """
        max_shots   = max(4, round(target_secs / 4))
        ideal_shots = max(3, round(target_secs / 5))
        per_shot    = max(SHOT_MIN_SECS, min(SHOT_MAX_SECS, round(target_secs / max(1, ideal_shots))))
        # The number in the PROMPT must be the number the grouper enforces, or the model
        # plans to one ceiling and gets regrouped against another.
        system_text = _breakdown_system_prompt(target_secs, max_shots, ideal_shots, per_shot,
                                               segment_max_secs)
        if story_context:
            # 4000, was 2000. The cap is there so a batch spends its attention on its own
            # scene text, and at 2000 it was already amputating the spine: FARO's SIX
            # sequences render at 2362 characters, so every batch of that film was told
            # what SEQ_1..SEQ_4 were for and never saw the ending it was writing towards.
            # It stopped being a matter of richness when this block became the LIST OF IDS
            # each shot must tag itself with — an id cut off mid-word is a contract the
            # model cannot satisfy. A project whose context is under 2000 (no bible, or a
            # bible with no spine) is unaffected: same bytes, same prompt.
            system_text += (
                "\n\nTHE FILM (context for the whole picture — this segment is one part of it; "
                "keep characters, locations and tone consistent with it):\n"
                f"{story_context[:4000]}\n"
            )
        if locations:
            # The whole film's slug lines, not just this batch's. Concurrent batches
            # cannot see each other's asset lists, so without a shared vocabulary each
            # one names the same place its own way and the merge misses it — six
            # environments for three locations, measured on BLOOM. See _script_locations.
            # HELL GRIND, quoted: "Every state of a character is a separate asset. […]
            # LOCATIONS WORK THE SAME WAY: day, night and rain are three different assets."
            # _script_locations now hands the batches "ARROYO FARM - DAY" and "ARROYO FARM
            # - NIGHT" as two entries, so the instruction that makes them use the list
            # verbatim is ALSO what splits the states — no second mechanism. The extra
            # paragraph exists because "use the exact string" alone was not enough: a
            # writer that sees two near-identical entries assumes one is a typo and
            # collapses them, which is precisely the mixing the rule warns about.
            system_text += (
                "\n\nCANONICAL LOCATIONS (every location in the WHOLE film, from its slug "
                "lines). When a scene in this segment happens in one of these, the "
                "environment asset MUST be named with the EXACT string below — do not "
                "rephrase, abbreviate or expand it. Only invent a name for a place that is "
                "genuinely not in this list:\n- " + "\n- ".join(locations[:60]) + "\n"
                "Entries that share a place name and differ only by a trailing state "
                "(DAY / NIGHT / DAWN / DUSK, optionally RAIN / STORM / SNOW / FOG) are NOT "
                "duplicates and MUST NOT be merged: they are the SAME place under a "
                "different light, and each one is its own environment asset with its own "
                "visual_description written for THAT light (sun direction, colour "
                "temperature, practicals on or off, sky, shadows, what is visible at all). "
                "A shot references the entry matching ITS scene heading's time of day. "
                # MEASURED 2026-08-06, first live run of this block: shown two entries
                # ending in "- DAY"/"- NIGHT", the writer generalised and appended the
                # heading's time to ALL 22 environments — including "- LATER" and
                # "- CONTINUOUS", which are not states at all. Harmless only as long as
                # every batch guesses the same suffix; two batches guessing differently
                # is exactly the duplicate this list exists to prevent. So the ban is
                # explicit and stated right after the licence.
                "Do NOT append a time of day to any OTHER entry: an entry printed above "
                "WITHOUT a trailing state is used EXACTLY as printed, even when its scene "
                "heading names an hour.\n"
            )
        base_toks = max(4096, min(32000, ideal_shots * 260 + 4000))
        retry_toks = min(48000, base_toks * 2)
        logger.info("[BreakdownGen] batch %d/%d: ~%ds → ~%d shots (cap %d)%s%s",
                    batch_no, total, target_secs, ideal_shots, base_toks,
                    " +premise" if story_context else "",
                    f" +{len(locations)} locations" if locations else "")
        raw = self._breakdown_complete(system_text, script_chunk[:60000], base_toks)
        try:
            return _parse_breakdown_json(raw)
        except Exception:
            logger.warning("[BreakdownGen] batch %d truncated/invalid — retrying at %d tokens", batch_no, retry_toks)
            raw = self._breakdown_complete(system_text, script_chunk[:60000], retry_toks)
            return _parse_breakdown_json(raw)

    def _breakdown_complete(self, system_text: str, user_text: str, max_toks: int) -> str:
        """Breakdown completion — routes to the configured BREAKDOWN backend.

        Default is CLAUDE (the breakdown is a 'brain' writing task); flip
        BREAKDOWN_BACKEND=seed to run it on Seed 2.0 Pro (BytePlus billing) with a
        transparent Claude fallback. QC verdicts keep their OWN independent flag
        (QC_BACKEND) — that split is the 1a fix (2026-07-15). Mirrors
        _qc_complete's structure, including the no-Claude-key last resort.
        Returns raw JSON text."""
        if self._breakdown_backend == "seed" and self._qc_client is not None:
            try:
                return self._qc_seed(system_text, user_text, max_toks)
            except Exception as e:  # noqa: BLE001
                if self.client is None:
                    raise
                logger.warning("[BreakdownGen] seed failed (%s) — falling back to Claude", e)
                return self._qc_claude(system_text, user_text, max_toks)
        if self.client is None:
            # backend=claude requested (or seed disabled) but no Claude key —
            # last resort: use seed if we have it.
            if self._qc_client is not None:
                return self._qc_seed(system_text, user_text, max_toks)
            raise RuntimeError(self.config_error or "No breakdown backend configured")
        return self._qc_claude(system_text, user_text, max_toks)

    # ── Director assist: character enrichment + per-field enhance (Seed 2.0 Pro) ──
    @staticmethod
    def _openai_content(user: str | list[dict]) -> str | list[dict]:
        """Anthropic user content → the OpenAI-compatible shape ARK's Chat API takes.

        A plain string passes through UNTOUCHED, so every _seed_text caller that predates
        this helper sends the identical request body it always sent. A content-block list
        (the MULTIMODAL case — vision_video_prompt interleaves an "[Image N] — label"
        text block with the picture itself) is translated block for block: an image block
        becomes the {"type":"image_url","image_url":{"url":"data:<mt>;base64,<data>"}}
        form byteplus_generative already drives on this SAME model — analyze_image_vision
        (1 image), describe_character_refs (4) and analyze_storyboard_continuity (8).

        Measured 2026-08-07 before this was written, on BLOOM SHOT_011's real four
        references through the very client built in __init__: seed-2-0-pro-260328
        returned a correct per-image description of all four (the character turnaround,
        the seawall location, the 4-panel board, the bayou plate) in 12.4 s. The Seed leg
        can therefore SEE, which is the whole reason vision_video_prompt can route to it
        rather than being handled as a text-only degradation.
        """
        if isinstance(user, str):
            return user
        out: list[dict] = []
        for blk in user:
            if blk.get("type") == "image":
                src = blk.get("source") or {}
                out.append({"type": "image_url", "image_url": {
                    "url": f"data:{src.get('media_type', 'image/jpeg')};base64,{src.get('data', '')}"}})
            elif blk.get("type") == "text":
                out.append({"type": "text", "text": blk.get("text", "")})
        return out

    def _text_llm(self, system: str, user: str | list[dict], max_tokens: int = 900,
                  temperature: float = 0.7, timeout: float | None = None,
                  max_retries: int | None = None) -> str:
        """A plain-text completion for the prompt-writing passes, on Seed 2.0 Pro with the
        Anthropic path as fallback.

        These calls (character sheets, prop sheets, wardrobe sheets) sit on the critical
        path of EVERY asset a project needs, and they were hard-wired to a separately
        billed API: when that balance ran out, 22 of 22 assets failed with a 400 and the
        film could not be made at all — even though Seedream, which draws them, was fine.
        A prompt-writing pass is not where a single-provider dependency belongs.

        `user` may be a STRING (every caller before 2026-08-07) or a list of Anthropic
        content blocks. The list form is what lets the two STAGE-5 writers ride this same
        route: vision_video_prompt has to show the model the reference pixels, and both
        providers can be handed the same blocks — Anthropic natively, Seed through
        _openai_content.

        `timeout`/`max_retries` are PER PROVIDER ATTEMPT and default to None = each SDK's
        own settings, i.e. every caller that predates them is unchanged. Only the two
        writers inside the render queue's claim window pass them — see
        SUBMIT_PATH_PROVIDER_RETRIES for why the budget is one attempt EACH rather than
        two at one provider.
        """
        try:
            # claude_fallback=False: this method has its OWN Claude fallback three lines
            # down, and letting _seed_text run a second one would put TWO Anthropic
            # requests on a failing leg — 90 s of claim window bought for nothing, and
            # double the (identical) request _qc_claude and the block below both send.
            out = self._seed_text(system, user, max_tokens=max_tokens,
                                  temperature=temperature, timeout=timeout,
                                  max_retries=max_retries, claude_fallback=False).strip()
            if out:
                return out
        except Exception as e:
            logger.warning("[TextLLM] Seed unavailable (%s) — falling back to Claude", e)
        response = self._llm(
            model=MODEL, max_tokens=max_tokens,
            timeout=timeout, max_retries=max_retries,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
        )
        return response.content[0].text.strip()

    def _seed_text(self, system_text: str, user_text: str | list[dict], max_tokens: int = 600,
                   temperature: float = 0.7, timeout: float | None = None,
                   max_retries: int | None = None, claude_fallback: bool = True) -> str:
        """Plain-text completion on Seed 2.0 Pro (BytePlus, not the Anthropic budget);
        Claude fallback. No JSON forcing — returns the model's text as-is.

        `user_text` may be a content-block list (see _openai_content). `timeout` /
        `max_retries` bound THIS request only, via the same with_options idiom
        byteplus_generative uses on its vision calls — the shared client keeps the SDK
        defaults so the long QC verdicts are not clipped. `claude_fallback=False` makes a
        Seed failure RAISE instead of costing an Anthropic request; the caller then owns
        the fallback (that is what _text_llm does)."""
        if self._qc_client is not None:
            try:
                client = self._qc_client
                if timeout is not None or max_retries is not None:
                    opts: dict[str, Any] = {}
                    if timeout is not None:
                        opts["timeout"] = timeout
                    if max_retries is not None:
                        opts["max_retries"] = max_retries
                    client = client.with_options(**opts)
                resp = client.chat.completions.create(
                    model=self._qc_model, max_tokens=max_tokens, temperature=temperature,
                    messages=[{"role": "system", "content": system_text},
                              {"role": "user", "content": self._openai_content(user_text)}],
                )
                return (resp.choices[0].message.content or "").strip()
            except Exception as e:  # noqa: BLE001
                # A content-block list has no _qc_claude form (it takes a string), so the
                # multimodal caller always owns its own fallback too.
                if self.client is None or not claude_fallback or not isinstance(user_text, str):
                    raise
                logger.warning("[Assist] seed failed (%s) — falling back to Claude", e)
        if not claude_fallback or not isinstance(user_text, str):
            raise RuntimeError("Seed text backend unavailable (BYTEPLUS_API_KEY not configured)")
        return self._qc_claude(system_text, user_text, max_tokens).strip()

    def enhance_edit_instruction(self, instruction: str, has_markup: bool = False,
                                 has_refs: bool = False) -> str:
        """Refine an image-EDIT instruction for Seedream 5.0 Pro (Seed 2.0 Pro text,
        NOT the Anthropic budget). Returns the instruction text only."""
        system = (
            "You refine image-EDIT instructions for the Seedream 5.0 Pro image model. "
            "Rewrite the user's request into ONE clear, concise editing instruction: what to "
            "change / add / remove, where, and how it blends in (placement, scale, lighting, "
            "perspective). Describe ONLY the change, not the whole scene. "
            "If the image carries drawn annotations (boxes / circles / arrows / crosshair targets), "
            "refer to them as the guide and state that all annotation marks must be REMOVED from the "
            "result. If reference images are provided, say how to use them (e.g. take the face/likeness "
            "from the reference, or add the accessory shown in the reference), preserving the subject's "
            "identity otherwise. Write the instruction in ENGLISH (translate if the request is in "
            "another language). Output ONLY the instruction — no preamble, quotes, or markdown."
        )
        user = (
            f"Edit request: {instruction.strip()}\n"
            f"On-image annotations present: {'yes' if has_markup else 'no'}\n"
            f"Reference images provided: {'yes' if has_refs else 'no'}"
        )
        return self._seed_text(system, user, max_tokens=240, temperature=0.6).strip().strip('"')

    def enrich_character(self, name: str, description: str, context: str = "") -> dict:
        """Director pass: write a character's personality, backstory, wardrobe and
        ACTING master profile from the name + visual description (+ optional script
        context). Returns {personality, backstory, wardrobe, acting}."""
        system = (
            "You are a film director developing a character for an AI film pipeline. Write in "
            "ENGLISH regardless of the script's language. Write the "
            "character's dossier, GROUNDED in the SCRIPT CONTEXT (their actual lines and actions) "
            "when provided — infer temperament, history and costume from what they say and do, do "
            "NOT contradict it. Only invent where the script is silent. "
            'Return ONLY JSON, no markdown: {"personality":"2-3 sentences — temperament, drives, '
            'how they carry themselves","backstory":"3-4 sentences — where they come from, the '
            'wound/goal that moves them","wardrobe":"1-2 sentences — their costume: garments, '
            'materials, footwear, distinctive wear",'
            + _ACTING_PROFILE_FIELD +
            "}. Concrete, production-ready, consistent with "
            "the description. Do NOT restate the visual description verbatim."
        )
        user = f"NAME: {name}\nVISUAL DESCRIPTION: {description}\n" + (f"SCRIPT CONTEXT:\n{context[:6000]}" if context else "")
        # 900 tokens covered three prose fields; the acting profile alone targets
        # 150-220 words (~300 tokens), so the old cap would have truncated the JSON
        # and _parse_breakdown_json would have returned {} — an empty dossier reported
        # as success, which is the failure mode this codebase keeps re-learning.
        raw = self._qc_seed(system, user, 1500) if self._qc_client is not None else self._qc_claude(system, user, 1500)
        try:
            out = _parse_breakdown_json(raw)
        except Exception:
            return {}

        # THE ACCENT, RE-ASKED ONCE. The field asks for it and the writer still drops it:
        # measured on BLACKMIRROR 4, 1 of 7 profiles named an accent before the field was
        # made explicit and 5 of 7 after — including neither of two leads. Seed Audio then
        # picks one per synthesis, so the same character was American in one shot and
        # British in the next, in a series set in Downing Street. Same shape as the
        # content-filter retries in byteplus_generative: ask again, once, naming exactly
        # what was missing. Never fatal — a second miss returns the first answer, which is
        # a dossier without an accent rather than no dossier at all.
        act = str(out.get("acting") or "")
        if act and not _ACCENT_NAMED.search(act):
            try:
                fix = self._qc_seed(system, user + (
                    "\n\nYOUR PREVIOUS ANSWER OMITTED THE ACCENT. Rewrite the dossier, identical "
                    "in substance, and name the accent explicitly inside the vocal profile — a "
                    "real one grounded in the script's setting, or the word 'neutral' if the "
                    "script names no region."), 1500) if self._qc_client is not None else self._qc_claude(
                    system, user, 1500)
                retry = _parse_breakdown_json(fix)
                if str(retry.get("acting") or "") and _ACCENT_NAMED.search(str(retry["acting"])):
                    logger.info("[Acting] %s: accent recovered on retry", name)
                    return retry
                logger.info("[Acting] %s: accent still unnamed after one retry", name)
            except Exception as e:
                logger.warning("[Acting] %s: accent retry failed (non-fatal): %s", name, e)
        return out

    def enhance_shots(self, shots: list[dict], characters: list[dict] | None = None) -> dict:
        """Batch-direct a GROUP of shots in ONE Seed 2.0 Pro call (≈15 shots/call).
        As the DIRECTOR: rewrites 'action' + 'visual' AND writes the 'performance'
        (acting direction — how the character plays the beat: emotion, subtext,
        physicality, delivery), grounded in the shot's action + dialogue.

        `characters` is the cast's ACTING MASTER PROFILES ([{name, acting}]) — the
        permanent record of how each person moves, speaks and hides what they feel. Without
        it the director re-invents a temperament per batch, which is precisely how a
        character's performance drifts across a film; the skill's own rule is that the
        master profile is RE-EXPRESSED per scene, never re-derived. Optional and defaulted,
        so every existing caller keeps working unchanged.

        A shot MAY carry `characters`: the names of the character assets in it (the caller
        resolves assetsUsed against the asset table — it is the only side that knows an
        asset's TYPE). An EMPTY list means "nobody is in this frame" and the shot comes back
        with performance == "" (see _shot_cast). A shot that omits the key says nothing about
        its cast and is treated exactly as before this parameter existed.

        Each dialogue line SHOULD carry `character` — the speaker's NAME, resolved by the
        caller from characterId against the asset table. `characterId` alone still works
        (every project on disk stores only that) and a line with neither key behaves
        exactly as it always has. See _speaker.

        Returns {shotId: {action, visual, performance}}. Silent on failure.

        A shot whose `characters` or `dialogue` is the wrong SHAPE is REJECTED
        (ShotPayloadError → 422), never guessed at. See _validate_shot_payload."""
        shots = [s for s in shots if s.get("id")]
        if not shots:
            return {}
        # Refuse a malformed body BEFORE any work is done — see _validate_shot_payload for
        # the contract and for the four shapes that used to pass through it silently.
        _validate_shot_payload(shots)
        # WHO SPEAKS — the defect that made BOTH helpers below lie for as long as they
        # have existed. A DialogueLine's storage shape is {characterId, text, emotion}
        # (pipeline.types.ts DialogueLine) and characterId is an ASSET ID ("ASSET_004"),
        # but both helpers read d["character"] — a key the breakdown has never written.
        # Measured on BLOOM through /api/shots/enhance: 27 of 27 dialogue lines reached
        # the model with an EMPTY speaker, rendered as a bare colon —
        #     SHOT_006 | dialogue: : "Come out Sunday. The east field's coming back."
        # — so the pass whose entire purpose is grounding the acting in what is SAID could
        # not tell one speaker from another, and in a two-hander could not tell whose line
        # was whose. It reached the OUTPUT: BLOOM SHOT_024's line is Beni's and all 6
        # unfixed runs gave it to Tomás, who is silently receiving an auger ("He speaks dry
        # and amused"); with the name, all 6 runs direct him as the LISTENER instead ("He
        # does not look up at Beni"). Over the 13 multi-character dialogue shots × 6 runs,
        # blind-judged: mis-attributed lines 9/78 → 0/78 (Fisher p=0.0031).
        # BOTH shapes are accepted because projects on disk carry characterId and nothing
        # migrates them; the NAME itself is resolved by the CALLER (directorPass.ts),
        # the only side that holds the asset table.
        def _speaker(d: dict) -> str:
            """Who says this line: the resolved NAME when the caller sent one, else the raw
            characterId. The id is printed on purpose, and that decision was reversed by
            measurement. The first version of this fix filtered opaque ids out of the
            prompt, arguing that 'ASSET_017:' invites the director to write about
            ASSET_017. Measured (2026-08-07, BLOOM 41 shots × 3 runs with the raw id as
            the speaker label): the string "ASSET" appears in 0 of 351 returned
            action/visual/performance fields — the leak the filter existed to prevent does
            not happen. What the id DOES do is disambiguate: mis-attributed lines on the 13
            multi-character dialogue shots ran 9/78 with no speaker at all, 2/39 with the
            raw id, 0/78 with the real name. Dropping the id therefore threw away a real
            (if partial) signal to prevent something that was never observed. Measured on
            Seed 2.0 Pro, the configured breakdown backend."""
            return (str((d or {}).get("character") or "").strip()
                    or str((d or {}).get("characterId") or "").strip())

        # ACTING SKILL §8 rule 1: "No character in frame → no paragraph." Measured over
        # BLOOM's 41 shots × 3 runs through /api/shots/enhance: 6 shots have no character
        # asset (the bioluminescent ocean, the tide line, the empty farmland) and 17 of
        # those 18 performances answered the question they were wrongly asked — "No human
        # present.", "No human movement." — 30 of the run's 107 negative fragments, plus
        # every camera leak in the sample ("no pan, no zoom", "Camera locked off").
        # The gate is CODE, not prompt: the model is never asked to write nothing (asking
        # for a blank is how you get "N/A" or an apology), it is simply not believed on a
        # shot the caller has told us is unpeopled.
        def _shot_cast(s: dict) -> list[str] | None:
            """Who is in this shot. None = the caller told us nothing (legacy payload)."""
            v = s.get("characters")
            # The `(str, bytes)` half of this test is now UNREACHABLE — _validate_shot_payload
            # rejects a non-list `characters` with a 422 before we get here — and it is kept
            # only as a belt on a second caller that might skip the validator. It must never
            # again be the thing that decides the contract: silently mapping a string to
            # "the caller said nothing" is what switched the whole gate off for a caller who
            # sent `characters: "Beni"`, with no log and no warning (measured 2026-08-07).
            if v is None or isinstance(v, (str, bytes)):
                return None
            names = [str(x).strip() for x in v if str(x or "").strip()]
            # A speaking part IS a character in the shot even when assetsUsed forgot to
            # list them — a mislabelled asset must never silently delete acting direction.
            # This rescue had NEVER fired: it read the same non-existent "character" key,
            # so for every project on disk `nm` was "" and the loop was a no-op. Verified
            # dead 2026-08-07 (a shot with dialogue and characters:[] came back with
            # performance "" on 3/3 runs) and alive after (3/3 runs kept the paragraph).
            seen = {n.lower() for n in names}
            for d in (s.get("dialogue") or []):
                nm = _speaker(d)
                if nm and str((d or {}).get("text") or "").strip() and nm.lower() not in seen:
                    names.append(nm); seen.add(nm.lower())
            return names
        no_actor = {s["id"] for s in shots if _shot_cast(s) == []}
        def _dlg(s: dict) -> str:
            lines = s.get("dialogue") or []
            parts = [f'{_speaker(d)}: "{(d.get("text") or "").strip()}"'
                     f'{(" (" + d["emotion"] + ")") if d.get("emotion") else ""}'
                     for d in lines if (d.get("text") or "").strip()]
            return " | ".join(parts)[:300]
        lines = "\n".join(
            f"{s['id']} | action: {(s.get('action') or '')[:220]} | visual: "
            f"{(s.get('visual_description') or s.get('visualDescription') or '')[:200]} | dialogue: {_dlg(s) or '(none)'}"
            for s in shots)
        # The cast, in the USER half — it is per-project DATA, and the system half above is
        # what gets prompt-cached across the batches of one film.
        cast = ""
        for c in (characters or []):
            nm = str(c.get("name") or "").strip()
            prof = str(c.get("acting") or "").strip()
            if nm and prof:
                cast += f"- {nm}: {prof[:900]}\n"
        if cast:
            lines = ("THE CAST — acting master profiles. Re-express each one INTO this shot's "
                     "moment (select, emphasise, displace); never contradict it and never paste "
                     "it back verbatim:\n" + cast + "\nSHOTS:\n" + lines)
        system = (
            "You are the FILM DIRECTOR working a shot list. For EACH shot line below, return three "
            "fields grounded in the story (the action + the dialogue) — never invent new characters "
            "or events. Write all three fields in ENGLISH regardless of the input language "
            "(generation models adhere best to English):\n"
            "- 'action': the same beat, rewritten vivid, concrete and cinematic (present tense, "
            "quantified body movement, motivated physical detail), same intent + ~length.\n"
            "- 'visual': the same, tightened.\n"
            "- 'performance': the ACTING DIRECTION — HOW the character plays this beat: emotion and "
            "subtext, where their focus is, physical performance (posture, hands, breath, eyes), and "
            "line delivery if there is dialogue. 1-2 concise sentences. Consistent with the character "
            "and the scene's arc. Keep it to the BODY, the face, the breath and the voice: camera "
            # THE SENTENCE BELOW HAS NOT BEEN SHOWN TO REMOVE ANYTHING (2026-08-07, same
            # 3-arm experiment as _POSITIVE_ONLY, N=6 per arm): real camera leaks on PEOPLED
            # shots were 0/210 WITH it and 0/210 WITHOUT it — there was nothing there to
            # remove, because the camera leaks that motivated it ("no pan, no zoom", "Camera
            # locked off") were all on UNPEOPLED shots, and those are killed by the `no_actor`
            # code gate below, not by this wording. Its only measured effect is a 18% WORSE
            # suppression-phrasing score, p=0.12 — a trend, NOT established. Kept for the same
            # reason _POSITIVE_ONLY is: p=0.12 does not license a behaviour change either way.
            # If someone wants it gone, the evidence needed is a powered run, not this one.
            "move, lens, framing, shot size, colour and light already have their own fields on this "
            "shot, and a camera or lighting note written here fights the shot's own camera "
            "direction. Direct the actor; leave the camera to the camera field.\n"
            + _ACTING_BEAT_RULES + "\n"
            + _POSITIVE_ONLY + "\n"
            'Return ONLY JSON, no markdown: {"shots":[{"id":"SHOT_001","action":"…","visual":"…","performance":"…"}]}. '
            "Include every shot id you were given."
        )
        max_toks = min(32000, len(shots) * 320 + 2000)
        try:
            raw = self._breakdown_complete(system, lines, max_toks)
            data = _parse_breakdown_json(raw)
        except Exception as e:  # noqa: BLE001
            logger.warning("[EnhanceShots] batch of %d failed: %s", len(shots), e)
            return {}
        out: dict[str, dict] = {}
        for s in data.get("shots", []):
            if isinstance(s, dict) and s.get("id"):
                row = {"action": (s.get("action") or "").strip(),
                       "visual": (s.get("visual") or "").strip()}
                # THREE DISTINGUISHABLE ANSWERS about acting direction — the caller cannot
                # merge safely without them, and until 2026-08-07 two of them looked alike.
                #   · `performance` non-empty → the director WROTE direction for this shot.
                #   · `performance` == ""     → the director DELIBERATELY CLEARED it: the
                #                               caller told us nobody is in frame (no_actor).
                #   · key ABSENT              → the director SAID NOTHING (the model dropped
                #                               the field for a peopled shot). Not a verdict.
                # The old code collapsed the last two into "": a peopled shot the model
                # simply skipped was indistinguishable from an unpeopled shot we mean to
                # blank, so the caller could only ever treat "" as "no opinion" — which is
                # why every stale performance survived the gate (measured on BLOOM: 6/6
                # character-less shots KEPT camera notes like "Locked off static frame").
                if s["id"] in no_actor:
                    row["performance"] = ""          # deliberate clear
                else:
                    perf = (s.get("performance") or "").strip()
                    if perf:
                        row["performance"] = perf    # wrote a value
                    # else: leave the key out — said nothing, so the caller keeps what it has.
                out[s["id"]] = row
        if no_actor:
            logger.info("[EnhanceShots] %d/%d shot(s) have no character in frame → no acting "
                        "direction written (%s)", len(no_actor), len(shots),
                        ", ".join(sorted(no_actor)[:6]))
        return out

    def enhance_text(self, field: str, current: str, context: str = "") -> str:
        """Rewrite/enhance ONE field (personality, backstory, wardrobe, action, visual
        description, a dialogue line…) for an AI film pipeline. Returns improved text only."""
        empty = not (current or "").strip()
        system = (
            f"You are a film script doctor improving the '{field}' field of a shot/character in "
            "an AI film pipeline. Make it vivid, concrete and production-ready, KEEP the same "
            "intent and roughly the same length. Write the result in ENGLISH (translate first "
            "if the input is in another language — generation models adhere best to English); "
            "verbatim dialogue lines are the only exception and keep their language. Return "
            "ONLY the improved text — no quotes, no labels, no preamble, no markdown."
            + (" The field is empty: WRITE it from the context." if empty else "")
        )
        user = (f"CONTEXT:\n{context[:3000]}\n\n" if context else "") + \
               f"CURRENT {field.upper()}:\n{current or '(empty)'}"
        return self._seed_text(system, user, max_tokens=700)

    # ── Stage 5 · Enhance for a SEEDANCE DIRECTION, by the official guide ─────────────
    def enhance_seedance_direction(self, current: str, model: str = "v25") -> tuple[str, list[str]]:
        """Rewrite a Seedance direction prompt UNDER THE OFFICIAL GUIDE of the model it is
        going to, and refuse the result if it breaks that guide.

        The generic enhance_text above is a script doctor: it makes prose vivid and knows
        nothing of Seedance. Pointed at a direction prompt it invented reference numbers,
        wrote durations into stages and dropped the blocks the sd25-pe contract requires —
        exactly what the project's rules 9 and 10 forbid. So this path builds its system prompt
        FROM the guide's own text (loaded by section, never pasted: the .md stays the single
        source of truth), pins the parts of the prompt the app owns, and then runs the
        result through check_prompt_guides in the model's mode. One retry with the failure
        list; if it still fails, the caller keeps the director's text and sees why.

        Returns (text, warnings). `text` is "" when nothing acceptable came back.
        """
        import contextlib
        import io

        is_25 = (model or "").strip().lower() in ("v25", "2.5", "seedance-2.5", "25")
        guide = _seedance_guide_text(is_25)
        if not guide:
            raise RuntimeError("Seedance prompt guide not found under byteplus-genius/references — cannot enhance by the guide")

        version = "Seedance 2.5" if is_25 else "Seedance 2.0"
        system = (
            f"You are the {version} prompt optimizer. Rewrite the director's prompt below into a "
            f"stronger prompt for {version}, following the OFFICIAL guide reproduced after these rules. "
            "The rules of this application come first:\n"
            "1. Keep every line under [Reference Material Roles] and [Unused Materials] EXACTLY as "
            "given, character for character — the references are attached by the application and "
            "their numbering is fixed. Never add, drop or renumber an @Image, @Video or @Audio.\n"
            "2. Keep every [Subject Profile: …] block and every line of dialogue written between "
            "curly braces verbatim.\n"
            "3. Do not write durations, timestamps, aspect ratio, resolution, frame rate or the audio "
            "toggle into the prompt. Do not add quality, watermark, logo or subtitle boilerplate"
            + ("." if is_25 else " beyond what the 2.0 guide itself recommends.") + "\n"
            "4. Keep the same characters, events, order of stages, props and locations; make the "
            "action, blocking, performance and camera more concrete and filmable — that is the "
            "whole job.\n"
            "5. Output ONLY the prompt body: no headings, no code fences, no commentary before or "
            "after, no 'Optimized prompt:'.\n\n"
            "OFFICIAL GUIDE:\n" + guide
        )
        user = "DIRECTOR'S PROMPT:\n" + (current or "").strip()

        checker = None
        try:
            import check_prompt_guides as _cpg
            checker = _cpg.check if is_25 else _cpg.check_20
        except Exception as e:  # noqa: BLE001
            logger.warning("[Enhance] guide checker unavailable (%s) — result will not be verified", e)

        def _verify(text: str) -> list[str]:
            if checker is None or not text.strip():
                return []
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                fails = checker("enhanced", text)
            lines = [ln.strip()[len("FALLO"):].strip() for ln in buf.getvalue().splitlines()
                     if ln.strip().startswith("FALLO")]
            return lines if fails else []

        def _pinned_intact(text: str) -> list[str]:
            """The blocks the app owns must come back untouched."""
            out: list[str] = []
            for block in ("[Reference Material Roles]", "[Unused Materials]"):
                want = _block_lines(current, block)
                if want and _block_lines(text, block) != want:
                    out.append(f"{block} was altered — the references are fixed by the application")
            for m in re.findall(r"\{[^}]{2,400}\}", current):
                if m not in text:
                    out.append("a dialogue line in braces was changed or dropped")
                    break
            return out

        def _pin(text: str) -> str:
            for block in ("[Reference Material Roles]", "[Unused Materials]"):
                text = _splice_block(text, block, current)
            return text

        text = _pin(self._seed_text(system, user, max_tokens=3000, temperature=0.4).strip())
        problems = _pinned_intact(text) + _verify(text)
        if problems:
            retry_user = (user + "\n\nYOUR PREVIOUS ATTEMPT BROKE THESE RULES OF THE GUIDE — fix every one and "
                          "output the corrected prompt body only:\n- " + "\n- ".join(problems))
            text2 = _pin(self._seed_text(system, retry_user, max_tokens=3000, temperature=0.3).strip())
            problems2 = _pinned_intact(text2) + _verify(text2)
            if not problems2:
                return text2, []
            logger.warning("[Enhance] guide check failed twice (%s): %s", version, problems2[:4])
            return "", problems2
        return text, []


    # ── Stage 3: Character Identity Board prompt (production template) ───────

    def identity_board_prompt(
        self,
        name: str,
        description: str,
        style_label: str = "cinematic",
        style_suffix: str = "",
        face_block: str = "",
        # ── Studio Character Creator knobs. The DEFAULT changed 2026-08-06 from "4+2"
        #    to "headless" (HELL GRIND rule 1 — see _SHEET_LAYOUTS): a caller that
        #    passes nothing now gets ONE large 3/4 portrait + a HEADLESS front figure
        #    + a back figure, i.e. exactly ONE face on the sheet instead of six. The
        #    old sheets are still reachable by name and are byte-identical to before.
        layout: str = SHEET_LAYOUT_DEFAULT,  # "headless" = 3/4 portrait + headless front
                                    # + back | "4+2" = 4 full-body + 2 close-ups | "2+2" = 2 + 2
        grey_bg: bool = True,       # False → let the style/prompt decide the backdrop
        pose_labels: bool = True,   # False → no rendered text at all on the sheet
        # The character's want/need/arc out of the film bible (server: _bible_character_note).
        # Kept OUT of `description` on purpose: description feeds _looks_non_human and
        # _is_photographic, and story prose has no business shifting those verdicts.
        # Empty (no bible, or a bible that does not name this character) → the writer
        # receives exactly the message it received before this parameter existed.
        story: str = "",
        # HELL GRIND rule (see _NEUTRAL_SHEET_BLOCK): the film's look must NOT be baked
        # into the document every later shot takes the face from. The server turns this
        # on for character sheets and hands `style_suffix` the neutral studio treatment
        # instead of the project's cinematic suffix (server._sheet_style). Default False
        # so a direct caller gets exactly the prompt it got before.
        neutral_sheet: bool = False,
    ) -> str:
        """
        Build the Seedream prompt for a CHARACTER REFERENCE SHEET — by default the
        HELL GRIND sheet (one large 3/4 face portrait + a HEADLESS front full-body +
        a back full-body), or the older turnarounds with layout="4+2" / "2+2"
        on a neutral gray studio background. Follows the Seedream 5 template
        (bracketed blocks, concise) so realistic styles read as a real photographic
        casting session (mandatory [CAMERA]+[SKIN] blocks) instead of a 3D
        turnaround. The sheet is both the human-approval artwork AND the downstream
        Seedance reference. 100% visual: only the pose labels, no ID/text block.
        """
        # An unknown layout string must not silently produce a sheet with no spec at all
        # (the three restatements below would then contradict [COMPOSITION], which is the
        # exact failure the _SHEET_LAYOUTS comment records) — fall back to the default.
        #
        # The fallback has to rewrite `layout` ITSELF, not just pick a spec, because the
        # name is read in three more places below: _composition_block, the headless
        # restatement's `layout == "headless"` gate, and (via the client) _derive_headshot's
        # crop box. MEASURED 2026-08-06 with layout="garbage-layout": the spec fell back to
        # headless while _composition_block fell through its own `two = layout == "2+2"`
        # test to the FOUR-POSE block — one prompt asking for a 4-pose turnaround in
        # [COMPOSITION] and for "TWO full-body figures, one headless" in IDENTITY LOCK and
        # SHEET SPEC, with no headless restatement at the end. That is precisely the
        # disagreement that made the writer LLM revert to the turnaround it knows.
        # /api/assets/board-prompt takes `layout` as a free string, so this is reachable
        # from a typo, not only from a code change.
        if layout not in _SHEET_LAYOUTS:
            logger.warning("[IdentityBoard] unknown sheet layout %r — falling back to %r",
                           layout, SHEET_LAYOUT_DEFAULT)
            layout = SHEET_LAYOUT_DEFAULT
        spec = _SHEET_LAYOUTS[layout]
        system = (
            "You write ONE image-generation prompt for a CHARACTER REFERENCE SHEET, following "
            "the Seedream 5 template. Output ONLY the final prompt — no markdown, no preamble. "
            "Use short bracketed blocks, each on its own line, in THIS order. Keep the WHOLE "
            "prompt TIGHT (~160-220 words — long prompts lose model control; early blocks weigh "
            "most). Use natural descriptive language, never measurements.\n\n"
            f"[MEDIUM] the render medium/intent of the whole image, from the locked style: "
            f"{style_suffix or style_label}. State it as a genre — realistic styles → 'studio "
            "character-reference photography for film pre-production'; illustrated styles → "
            "'character concept art'.\n"
            + _composition_block(layout, grey_bg, pose_labels) +
            "[SUBJECT] for a HUMAN: gender, age range, ethnicity, build, face shape, eyes, nose, "
            "jaw, skin. For a NON-HUMAN creature (beast, alien, spirit, anthropomorphic animal, "
            "luminous being): DROP the human-anatomy list entirely and instead give the creature's "
            "TRUE body plan — overall silhouette/species, head & face structure, number and kind of "
            "limbs, wings/tail/hands, skin/fur/feathers/scales, size — PRESERVING the exact "
            "non-human morphology from the description VERBATIM (e.g. 'heron-like body with hands "
            "instead of wings' stays a tall BIRD-BODIED being with hands where wings would be, NOT "
            "a humanoid with feathers). Never humanize a creature. "
            "Include scars/tattoos/marks ONLY if the description explicitly gives the character "
            "one — never invent them.\n"
            "[WARDROBE] garments top-to-bottom naming material + texture + fit, footwear, and "
            "any held prop/weapon with material and combat wear.\n"
            "[HAIR] colour variation, texture, styling.\n"
            "[EXPRESSION] neutral, grounded gaze, relaxed mouth.\n"
            "[FORBIDDEN] 3-4 short anchor words locking the look (realistic → 'no CGI gloss, no "
            "plastic skin, no smoothing; photographic, lifelike, cinematic').\n\n"
            "For PHOTOGRAPHIC/REALISTIC styles you MUST also insert the [CAMERA] and [SKIN] "
            "blocks (specified below) right after [WARDROBE]. For illustrated styles, instead "
            "add one brief [RENDER] line (linework/shading/brushwork of the style).\n\n"
            # This line used to hardcode "all four poses" + the pose-label list, which
            # CONTRADICTED a non-default [COMPOSITION] — Claude followed this one and wrote a
            # 4-pose labeled sheet no matter what was asked (caught by the layout test).
            "IDENTITY LOCK: identical facial features, fixed proportions, consistent hairstyle, "
            f"identical outfit and the same props in {spec['lock']}. "
            + ("NO rendered TEXT except the pose labels " + str(spec["labels"])
               if pose_labels else
               "NO rendered TEXT ANYWHERE — no pose labels, ")
            + " — no ID block, no captions, no logos, no "
            "watermarks.\n\n"
            "CONTENT-FILTER SAFETY: the image model blocks gore/body-horror/injury (faces extra "
            "sensitive). Translate visceral wording (melting/under-skin/wounds/burning flesh) "
            "into cinematic VFX surface language — liquid-mercury chrome, emissive circuit "
            "traces, fractured seams of light — keeping the intent. Never describe damaged flesh "
            "literally."
            # Final, closing restatement of the panel spec. The writer LLM weights the END of
            # the system prompt heavily, and without this it drifted back to the canonical
            # 4-pose labeled turnaround even when [COMPOSITION] asked for 2 (verified live).
            + f"\n\nSHEET SPEC — the prompt you write MUST specify exactly "
            + (f"{spec['spec']}"
               f"{', each full-body panel labeled with its pose name' if pose_labels else ', and NO text or labels rendered anywhere in the image'}"
               f"{', on a grey seamless studio backdrop' if grey_bg else ''}. ")
            + "Do not add, drop or rename panels."
            # HELL GRIND rule 1 restated where the writer LLM weights hardest. Every
            # instinct it has says a character sheet's figures have heads, so the ONE
            # thing that must survive to the image is said last, alone, and in full.
            + (" THE FRONT FULL-BODY FIGURE HAS NO HEAD — it stops at the base of the neck "
               "like a dress-form mannequin (a clean tailoring crop, not an injury: no blood, "
               "no wound). The finished image must show EXACTLY ONE face, the large 3/4 "
               "portrait. Say so explicitly in the prompt you write."
               if layout == "headless" else "")
        )
        photographic = _is_photographic(style_label, style_suffix)
        # #1 (2026-07-17): the photographic directive used to force EVERY character to be
        # "a real person / real professional actor" — which flattened non-human creatures
        # (Loom = 'heron-like being with hands instead of wings') into humanoid actors.
        # Route creatures through a photoreal-but-NON-human subject so their anatomy holds;
        # _photo_directive already swaps [SKIN]→[SURFACE] for non-person subjects.
        non_human = _looks_non_human(description)
        photo_subject = (
            "a real physical non-human creature (practical creature effects / a live-action VFX "
            "plate) — photoreal but NOT humanoid, keeping its exact non-human anatomy"
            if non_human else "a real person (a real professional actor)"
        )
        if photographic:
            system = system + _photo_directive(photo_subject, neutral=neutral_sheet)
        # Before FACE LOCK, so FACE LOCK keeps the last (heaviest) position it has held
        # since identity unification — the neutral block governs LIGHT, not identity.
        if neutral_sheet:
            system = system + _NEUTRAL_SHEET_BLOCK
        if face_block:
            # IDENTITY UNIFICATION: the face is FIXED to the cached fictional-distinctive
            # block — the SAME block Stage 5 uses to build the shot face anchor. So the
            # approved sheet and every shot share one locked face. (No image ref here — a
            # ref collapses the 4-pose grid; the shared TEXT block keeps them matched.)
            system = system + (
                "\n\nFACE LOCK (critical — same identity must appear in every later shot): render "
                "a distinctive specific individual (not a celebrity or copyrighted character), "
                # Was hardcoded "in all four poses and both close-ups" — on the headless
                # sheet there is ONE face and no close-ups at all, and naming panels that
                # are not there is how the writer talks itself back into drawing them.
                f"with EXACTLY this face in {spec['lock']}: {face_block} Take ONLY build, "
                "hair length, wardrobe and props from the character description above — the FACE "
                "is fixed by this block and must not deviate."
            )
        prompt = self._text_llm(system, f"CHARACTER NAME: {name}\nDESCRIPTION: {description}{story}",
                                max_tokens=900, temperature=0.4)
        if photographic:
            prompt = _enforce_photographic(prompt, photo_subject, neutral=neutral_sheet)
        logger.info("[IdentityBoard] %s prompt (neutral=%s): %r…", name, neutral_sheet, prompt[:140])
        return prompt

    # ── Stage 3: Prop Sheet prompt (production template) ─────────────────────
    def prop_sheet_prompt(
        self,
        name: str,
        description: str,
        style_label: str = "cinematic",
        style_suffix: str = "",
        neutral_sheet: bool = False,   # see identity_board_prompt / _NEUTRAL_SHEET_BLOCK
    ) -> str:
        """
        Build the Seedream prompt for a PROP / OBJECT REFERENCE SHEET — a clean
        multi-view of one inanimate object, following the Seedream 5 template
        (bracketed blocks, concise; mandatory [CAMERA]+[SURFACE] for realistic
        styles so it reads as real product photography, not a 3D render). The
        approved sheet is the downstream Seedance reference (no longer a derived
        single hero shot). 100% visual: tiny view labels only, no ID/text block.
        Same signature as identity_board_prompt so the generation path is shared.
        """
        system = (
            "You write ONE image-generation prompt for a PROP / OBJECT REFERENCE SHEET (one "
            "inanimate object — a weapon, gadget, vehicle, garment, artifact), following the "
            "Seedream 5 template. Output ONLY the final prompt — no markdown, no preamble. Use "
            "short bracketed blocks, each on its own line, in THIS order. Keep the WHOLE prompt "
            "TIGHT (~150-200 words — long prompts lose model control). Natural descriptive "
            "language, never measurements.\n\n"
            f"[MEDIUM] the render medium/intent of the whole image, from the locked style: "
            f"{style_suffix or style_label}. State it as a genre — realistic styles → 'studio "
            "product-reference photography'; illustrated styles → 'industrial-design concept "
            "art'.\n"
            "[COMPOSITION] one {object} shown as a clean multi-view set on a solid off-white "
            "sweep: one large hero 3/4 view slightly off-center, plus front, side, back and a "
            "top/angled view, ONE detail close-up of a key feature, and ONE small scale "
            "reference (the object beside a simple human silhouette or hand). Clear spacing, no "
            "overlapping panels, no scene or environment. The SAME object in every view.\n"
            "[SUBJECT] the object's form, proportions, parts, and distinctive "
            "markings/engravings/wear WITH placement.\n"
            "[MATERIALS] the true materials (metal, wood, glass, fabric) naming finish, texture "
            "and surface wear, and how light reads on each.\n"
            "[FORBIDDEN] 3-4 short anchor words locking the look (realistic → 'no CGI gloss, no "
            "plastic sheen; photographic, tactile, real').\n\n"
            "For PHOTOGRAPHIC/REALISTIC styles you MUST also insert the [CAMERA] and [SURFACE] "
            "blocks (specified below) right after [MATERIALS]. For illustrated styles, instead "
            "add a brief [RENDER] line (linework/shading of the style).\n\n"
            "CONSISTENCY LOCK: the SAME object in every view — identical shape, proportions, "
            "materials, colours, surface wear and markings. NO rendered TEXT except tiny 1-3 "
            "word view labels; no ID block, no logos, no watermarks.\n\n"
            "CONTENT-FILTER SAFETY: render weapons/dangerous props as clean inert industrial "
            "design — no blood, gore, injury, or a person being harmed; translate visceral "
            "wording into surface/material language."
        )
        photographic = _is_photographic(style_label, style_suffix)
        if photographic:
            system = system + _photo_directive(
                "a real physical object (a real studio product photograph)", neutral=neutral_sheet)
        if neutral_sheet:
            system = system + _NEUTRAL_SHEET_BLOCK
        prompt = self._text_llm(system, f"OBJECT NAME: {name}\nDESCRIPTION: {description}", max_tokens=800, temperature=0.4)
        if photographic:
            prompt = _enforce_photographic(prompt, "a real physical object", neutral=neutral_sheet)
        logger.info("[PropSheet] %s prompt (neutral=%s): %r…", name, neutral_sheet, prompt[:140])
        return prompt

    # ── Stage 3: Wardrobe Sheet prompt (production template) ─────────────────
    def wardrobe_sheet_prompt(
        self,
        name: str,
        description: str,
        style_label: str = "cinematic",
        style_suffix: str = "",
        neutral_sheet: bool = False,   # see identity_board_prompt / _NEUTRAL_SHEET_BLOCK
    ) -> str:
        """
        Build the Seedream prompt for a WARDROBE / COSTUME REFERENCE SHEET — one
        complete outfit shown as a costume-department lookbook on a neutral gray
        seamless sweep: worn on an invisible/ghost mannequin, a flat-lay of the
        separate garments, and a fabric/detail close-up. Same neutral-gray backdrop
        as the character + prop sheets so all approved assets share one lighting
        context and matte cleanly for downstream refs. Same signature as the other
        sheet prompts so the generation path is shared. 100% visual: tiny labels only.
        """
        system = (
            "You write ONE image-generation prompt for a WARDROBE / COSTUME REFERENCE SHEET "
            "(one complete outfit — the garments, footwear and accessories a character wears), "
            "following the Seedream 5 template. Output ONLY the final prompt — no markdown, no "
            "preamble. Use short bracketed blocks, each on its own line, in THIS order. Keep the "
            "WHOLE prompt TIGHT (~150-200 words — long prompts lose model control). Natural "
            "descriptive language, never measurements.\n\n"
            f"[MEDIUM] the render medium/intent of the whole image, from the locked style: "
            f"{style_suffix or style_label}. State it as a genre — realistic styles → 'studio "
            "costume-department lookbook photography'; illustrated styles → 'costume concept "
            "art'.\n"
            "[COMPOSITION] the SAME outfit shown three ways on a clean neutral gray seamless "
            "studio sweep: (1) a large hero view of the complete outfit worn on an invisible / "
            "ghost mannequin (no visible person, no face — an empty-body form), (2) a tidy "
            "flat-lay of the separate garments and footwear laid out, and (3) ONE fabric / detail "
            "close-up of a key material or fastening. Clear spacing, no overlapping panels, no "
            "scene or environment. Identical garments in every view.\n"
            "[GARMENTS] every layer top-to-bottom naming material, texture, cut/fit, colour, "
            "trims/fastenings, plus footwear and accessories, with distinctive wear or markings "
            "and WHERE they sit.\n"
            "[MATERIALS] the true fabrics and finishes (leather, wool, denim, silk, metal "
            "hardware) — weave, sheen, drape and how light reads on each.\n"
            "[FORBIDDEN] 3-4 short anchor words locking the look (realistic → 'no CGI gloss, no "
            "plastic fabric; photographic, tactile, real garments').\n\n"
            "For PHOTOGRAPHIC/REALISTIC styles you MUST also insert the [CAMERA] and [SURFACE] "
            "blocks (specified below) right after [MATERIALS]. For illustrated styles, instead "
            "add a brief [RENDER] line (linework/shading of the style).\n\n"
            "CONSISTENCY LOCK: the SAME outfit in every view — identical garments, materials, "
            "colours, trims and wear. NO rendered TEXT except tiny 1-3 word view labels; no ID "
            "block, no logos, no watermarks.\n\n"
            "CONTENT-FILTER SAFETY: render on an empty ghost mannequin, never a nude or partially "
            "nude person; no injury or gore; translate visceral wording into surface/material "
            "language."
        )
        photographic = _is_photographic(style_label, style_suffix)
        if photographic:
            system = system + _photo_directive(
                "real physical garments on a ghost mannequin (a real studio costume photograph)",
                neutral=neutral_sheet)
        if neutral_sheet:
            system = system + _NEUTRAL_SHEET_BLOCK
        prompt = self._text_llm(system, f"OUTFIT NAME: {name}\nDESCRIPTION: {description}", max_tokens=800, temperature=0.4)
        if photographic:
            prompt = _enforce_photographic(prompt, "real physical garments", neutral=neutral_sheet)
        logger.info("[WardrobeSheet] %s prompt (neutral=%s): %r…", name, neutral_sheet, prompt[:140])
        return prompt

    def fictional_face_block(self, name: str, description: str,
                             style_label: str = "", style_suffix: str = "",
                             observed_features: str = "") -> str:
        """Turn a character into a DISTINCTIVE, ENTIRELY FICTIONAL facial-feature
        block (the SeeDream bypass recipe). A photoreal face that resembles no
        real/famous person passes Seedance 2.0's IP/real-person filter. Generated
        once per character, then cached + reused so every shot keeps the same face.

        When observed_features is given (a vision read of the APPROVED character
        image), the block PRESERVES that actual look so the pure-t2i keyframe
        matches the approved character — only nudged enough to stay non-celebrity.
        See [[seedance-identity-filter]]."""
        if observed_features:
            system = (
                "You are given the OBSERVED facial features of an approved character "
                "(read from their reference image). Rewrite them into a facial-feature "
                "block for a photorealistic text-to-image prompt that REPRODUCES THIS "
                "SAME face as closely as possible, so every shot stays consistent. The "
                "image is pure text-to-image (trusted watermark), so the face may look "
                "fully real; it only must not be a specific celebrity or copyrighted "
                "character.\n"
                "RULES:\n"
                "- PRESERVE the observed traits faithfully (face shape, eyes, nose, "
                "lips, brows, cheekbones, jaw, skin, hair, facial hair, age). Keep the "
                "likeness — this is for character consistency.\n"
                "- Make the identity distinctive through the SPECIFIC combination of the "
                "observed features themselves (bone structure, eye shape/set, nose, lips, "
                "cheekbones, jaw, skin) — do NOT invent scars, tattoos or marks the character "
                "does not have. Do NOT change ethnicity, age, or overall look.\n"
                "- NEVER name or imply any specific real celebrity or copyrighted character.\n"
                "- Output ONE line, no preamble, exactly: 'a distinctive specific "
                "individual, not a celebrity or copyrighted character. Facial features: "
                "<comma-separated specific traits>.'"
            )
            user = f"CHARACTER: {name}\nOBSERVED FACIAL FEATURES: {observed_features}"
        else:
            system = (
                "You convert a character description into a DISTINCTIVE, photorealistic "
                "facial-feature block for an image prompt. The image is generated PURE "
                "text-to-image by Seedream 5.0 Lite, whose trusted watermark lets Seedance "
                "accept it — so the face may look fully real; it only must NOT be a specific "
                "celebrity or copyrighted character (an original individual).\n"
                "RULES:\n"
                "- NEVER use a real person's or character's name, nor 'looks like "
                "<name>'. Deconstruct any such reference into concrete physical traits.\n"
                "- Specify concrete, unusual specifics: face shape, bone structure, "
                "eyes (shape/set/color), nose, lips, brows, cheekbones, jaw, and skin "
                "texture, so the face is a specific real-looking individual, not generic "
                "or celebrity-like. Add scars/tattoos/marks ONLY if the description gives "
                "the character one — never invent them.\n"
                "- Preserve the character's age, gender and essential look.\n"
                "- Output ONE line, no preamble, in exactly this form: 'a distinctive "
                "specific individual, not a celebrity or copyrighted character. Facial "
                "features: <comma-separated specific traits>.'"
            )
            user = f"CHARACTER: {name}\nDESCRIPTION: {description}"
        resp = self._llm(
            model=MODEL,
            max_tokens=320,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
        )
        return resp.content[0].text.strip()

    # ── Stage 5: conversational shot direction ("Magic Box", P5a) ────────────
    def direct_shot(
        self,
        instruction: str,
        action: str = "",
        camera: str = "",
        lighting: str = "",
        notes: str = "",
        char_name: str = "",
        env_hint: str = "",
        style_label: str = "cinematic",
    ) -> dict[str, Any]:
        """Interpret a natural-language directing instruction against the shot's
        current context into a concrete refined direction + the cheapest regen
        scope. Returns {notes, scope, summary}."""
        if not self.client:
            raise RuntimeError(self.config_error or "Claude not configured")
        system = (
            "You are a film director's assistant. The user gives a short natural-language "
            "instruction to change ONE shot. Interpret it against the shot's current "
            "context and return ONLY a JSON object (no markdown, no prose):\n"
            '{"notes": "<refined director note>", "scope": "animate" | "keyframe", "summary": "<one line>"}\n\n'
            "notes: rewrite the instruction into a concrete, production-ready director note "
            "for a video model — name ONE camera move, the lighting / time-of-day, motion "
            "pacing (slow, gentle, body-part level), framing, and externalize any emotion as "
            "physical detail. Keep the established subject, wardrobe and location unless the "
            "instruction changes them. One or two sentences; no abstract verbs.\n"
            "scope: 'animate' when the change is only motion / camera / pacing / lighting / "
            "mood (re-animate the existing first frame — cheaper). 'keyframe' when it changes "
            "composition, framing, subject placement, location, or what appears on screen (a "
            "new first frame is required).\n"
            "summary: one short human sentence describing the change you will make.\n"
            "Never invent new characters. Follow Seedance 2.0 guidance: one camera move per "
            "shot, slow continuous motion."
        )
        ctx = (
            f"INSTRUCTION: {instruction}\n\n"
            "SHOT CONTEXT:\n"
            f"- action: {action or '(none)'}\n"
            f"- camera: {camera or '(none)'}\n"
            f"- lighting: {lighting or '(none)'}\n"
            f"- current notes: {notes or '(none)'}\n"
            f"- subject: {char_name or '(unspecified)'}\n"
            f"- environment: {env_hint or '(unspecified)'}\n"
            f"- style: {style_label}"
        )
        response = self._llm(
            model=MODEL,
            max_tokens=500,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": ctx}],
        )
        raw = response.content[0].text.strip()
        # Tolerant JSON parse: strip fences, take the outermost object.
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1].lstrip("json").strip() if "```" in raw[3:] else raw.strip("`")
        try:
            start, end = raw.index("{"), raw.rindex("}") + 1
            data = json.loads(raw[start:end])
        except (ValueError, json.JSONDecodeError):
            # Fall back to a safe keyframe regen using the raw instruction as the note.
            logger.warning("[DirectShot] non-JSON response, falling back: %r", raw[:120])
            data = {"notes": instruction, "scope": "keyframe", "summary": f"Applying: {instruction}"}
        scope = "animate" if str(data.get("scope", "")).lower() == "animate" else "keyframe"
        result = {
            "notes": (data.get("notes") or instruction).strip(),
            "scope": scope,
            "summary": (data.get("summary") or f"Applying: {instruction}").strip(),
        }
        logger.info("[DirectShot] scope=%s notes=%r", result["scope"], result["notes"][:120])
        return result

    # ── Stage 5: Video Direction prompt (production template) ────────────────

    def video_direction(
        self,
        mode: str,                      # 'storyboard' (sections 1-6) | 'keyframe' (sections 3-6)
        duration: int,
        beats: list[dict],              # [{label, name?, desc, ...}] from the shot's board
        char_name: str,
        char_signature: str,            # one-line visual signature
        environment: str,
        lighting: str,
        camera: str,
        ref_map: list[str],             # e.g. ["@Image 1 = storyboard", "@Image 2 = face", ...]
        director_notes: str = "",       # per-shot "Direct this shot" note — MUST be honored (4E)
    ) -> str:
        """
        Fill the production Video Direction template for one shot. The scaffold
        sentences are fixed; Claude writes the shot-specific slots (beat names,
        transition example, movement vocabulary, closing image).
        """
        # Same annotations as the vision path — this is its text-only twin, and it was
        # dropping even motion and camera.
        # The FOV and the declared screen sides ride here too — see panel_fov for the
        # boundary measurement that says neither did. `[FOV]` leads the annotations because
        # it is the lens the beat is framed on, and `[screen]` closes them because it is
        # geometry rather than look. Both are conditional, so a board that carries neither
        # builds the byte-identical message this call built before.
        beat_lines = "\n".join(
            f'- {b.get("label")}: "{b.get("name", "")}" {b.get("desc", "")}'
            + (f' [FOV: {panel_fov(b)}]' if panel_fov(b) else "")
            + (f' [motion: {_strip_generation_params(b.get("red"))}]' if _strip_generation_params(b.get("red")) else "")
            + (f' [camera: {_strip_generation_params(b.get("blue"))}]' if _strip_generation_params(b.get("blue")) else "")
            + (f' [framing: {_strip_generation_params(b.get("green"))}]' if _strip_generation_params(b.get("green")) else "")
            + (f' [light: {_strip_generation_params(b.get("orange"))}]' if _strip_generation_params(b.get("orange")) else "")
            + (f' [emphasis: {_strip_generation_params(b.get("purple"))}]' if _strip_generation_params(b.get("purple")) else "")
            + (f' [screen: {b.get("screen_side")}]' if b.get("screen_side") else "")
            + (f' [left in place: {b.get("leaves_behind")}]' if b.get("leaves_behind") else "")
            for b in beats
        ) or "- (no board beats — derive 2-3 beats from the action)"
        refs = "; ".join(ref_map)

        # Build the section list per mode — telling the model to "skip" sections
        # leaks them anyway (observed live), so keyframe mode never sees them.
        sections: list[str] = []
        if mode == "storyboard":
            subject_src = "the character face reference image (use its <Image_N> tag)"
            sections.append(
                "SOURCE LOCK: 'Utilize the referenced storyboard <Image_1> as the sole "
                f"source for the full visual and emotional storytelling of this {duration}-second "
                "video. Follow all beats sequentially. Do not reinterpret movements, "
                "composition or camera angles, nor alter the narrative arc from "
                "{opening beat name} to {closing beat name}. Preserve the original shot "
                "sequence, {one clause naming this shot's contrast or framing progression}.'"
            )
            sections.append(
                f"CONDENSATION: 'Condense the full {len(beats) or 2}-beat sequence into "
                f"{duration} seconds. Every beat manifests as dynamic action snapshots. "
                "Deploy {hard cuts / match-on-action edits / kinetic tracking — choose what "
                "fits}' plus ONE concrete transition example built from the actual beats."
            )
        else:
            subject_src = "the provided first frame"
            sections.append(
                f"OPENING: one sentence committing the {duration}-second video to executing "
                "the beats below sequentially from the provided first frame. The first frame "
                "is the source image — NEVER mention a storyboard or <Image_N> references."
            )
        # Documented subject-tagging syntax (prompt guide §2.3) — skipping it
        # causes mid-clip subject mutation. The tag opens the prompt.
        sections.insert(0,
            f"SUBJECT TAG: 'Define the {{one-phrase look}} in {subject_src} as "
            "<Subject_1>.' Refer to the protagonist ONLY as <Subject_1> afterwards."
        )
        sections.append(
            "IDENTITY LOCK: 'Strictly retain <Subject_1>: "
            "{one-line visual signature}. Never modify facial features or costume "
            "details.' Then a vivid comma-separated movement vocabulary list (8-14 "
            "items) written from the beats — concrete, body-part-level (e.g. "
            "'shoulders pivoting through the turn, fingers uncurling from the holster')."
        )
        sections.append(
            "NO FEATURE BLEED: 'Keep every HUMAN character's features natural — natural eye "
            "colour, no glowing or luminous eyes, no bioluminescence — and never transfer a "
            "non-human creature's traits (glowing golden eyes, luminous skin, feathers, sparks) "
            "onto a human character, even with a creature referenced in the same shot' — UNLESS "
            "this shot's action explicitly scripts it (e.g. a written eye-glow beat)."
        )
        sections.append("ENVIRONMENT + LIGHTING: exactly two sentences from the given environment and lighting.")
        sections.append("CAMERA: one sentence listing the shot's camera moves with intent.")
        sections.append(
            "FINAL BEAT: a fully described held closing image — framing, light, "
            "the one-second hold, and its emotional note."
        )
        numbered = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(sections))
        system = (
            "You write a VIDEO DIRECTION prompt for an AI video model, filling this "
            "exact template. Output ONLY the final prompt text (no markdown, no "
            "section numbers), under 220 words. Reference images are addressed with "
            f"the documented <Image_N> syntax, mapping: {refs or 'none'}.\n\n"
            f"Write these sections, in order:\n{numbered}\n\n"
            "MOTION RULES: quantify every motion with vector, speed and inertia "
            "('slowly raise', 'push hard off the ground', 'use the inertia of the "
            "turn') — never abstract verbs alone. Never name an emotion; write the "
            "body language that shows it.\n\n"
            f"{_SEEDANCE_UNITS}\n\n"
            f"<Subject_1> stays visible in frame throughout. Character: {char_name} "
            f"— {char_signature}."
            + (f"\n\nDIRECTOR NOTES (must be honored): {director_notes.strip()}"
               if director_notes.strip() else "")
            # EL CONTRATO DE LA PLATAFORMA, por fin leído. Este es el único paso donde un
            # modelo REDACTA el prompt que se envía a Seedance, así que es el único sitio
            # donde los principios de sd25-pe se pueden aplicar: el resto del prompt lo
            # arma Python y ya los cumple. 941 líneas vendorizadas en el repo, citadas en
            # comentarios de tres módulos y abiertas por ningún código hasta hoy — el
            # mismo estado en que estaba ACTING SKILL.md esta mañana. Van sólo los siete
            # que describen el artefacto; ver _SD25_PRINCIPLES.
            + (f"\n\n{sd25_contract()}" if sd25_contract() else "")
        )
        user = (
            f"MODE: {mode}\nDURATION: {duration}s\nBEATS:\n{beat_lines}\n"
            f"ENVIRONMENT: {environment}\nLIGHTING: {lighting}\nCAMERA: {camera}"
        )
        # Seed-first with the Claude fallback, the same route (_text_llm) the bible, the
        # script, the breakdown, the three sheet prompts and the storyboard beat writer
        # already take. The beat writer's comment called ITSELF "the LAST generative step
        # still pinned to Anthropic"; it was wrong by two, and these were the two. With
        # that account out of credit this line raised a bare 400 and 17 of BLOOM's 41
        # phase-5 cards could not be assembled AT ALL — measured 4/4 HTTP 500 on
        # SHOT_011, traceback ending here (claude_agents.py:5327, `response = self._llm`).
        # The other 24 take the segment assembler, which is pure Python, which is exactly
        # why the outage was invisible until someone rendered a single-shot segment.
        #
        # Bounded: this runs inside render_queue.py's claim window (see
        # SUBMIT_PATH_TIMEOUT_SECS). 600 tokens of template filling has no business
        # taking 90 s, let alone the SDK default's 1800 s worst case — and the bound now
        # covers BOTH providers, one attempt each (SUBMIT_PATH_PROVIDER_RETRIES).
        direction = self._text_llm(
            system, user, max_tokens=600, temperature=0.5,
            timeout=SUBMIT_PATH_TIMEOUT_SECS,
            max_retries=SUBMIT_PATH_PROVIDER_RETRIES,
        ).strip()
        logger.info("[VideoDirection] %s mode, %d beats → %d chars", mode, len(beats), len(direction))
        return direction

    # ── Stage 5: VISION-grounded video prompt (item 7b) ──────────────────────

    @staticmethod
    def _image_block(path_or_url: str, max_side: int = 768) -> dict | None:
        """Load an image (local path or URL), downscale, return an Anthropic
        image content block. Returns None if unreadable."""
        import io, base64 as _b64
        try:
            from PIL import Image
            if path_or_url.startswith(("http://", "https://")):
                import requests as _req
                # Bounded for the same reason as the vision call below it: up to 9 refs
                # are fetched serially inside the render queue's claim window.
                raw = _req.get(path_or_url, timeout=SUBMIT_PATH_IMAGE_FETCH_SECS).content
            else:
                p = path_or_url[7:] if path_or_url.startswith("file://") else path_or_url
                raw = open(p, "rb").read()
            im = Image.open(io.BytesIO(raw)).convert("RGB")
            im.thumbnail((max_side, max_side), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=85)
            return {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg",
                           "data": _b64.b64encode(buf.getvalue()).decode()},
            }
        except Exception as e:
            logger.warning("[VisionPrompt] could not load image %r: %s", path_or_url[:80], e)
            return None

    def vision_video_prompt(
        self,
        images: list[dict],             # [{label, path}] in Seedance attachment ORDER
        mode: str,                      # 'storyboard' | 'keyframe'
        duration: int,
        beats: list[dict],
        char_name: str,
        char_signature: str,
        environment: str,
        lighting: str,
        camera: str,
        action: str,
        director_notes: str = "",
        dialogue: list[dict] | None = None,      # [{speaker/character, text, emotion, timbre?}]
        first_frame_label: str = "",             # which attached image is the locked first frame
        geo_layout: str = "",                    # the scene's GEO SPATIAL LAYOUT (Hell Grind rule 1)
    ) -> str:
        """
        Stage 5 shot prompt, written by Claude while LOOKING at the actual
        reference images, in the OFFICIAL AI-native film structure (Seedance 2.0
        solution guide §7): REFERENCES (a full per-[Image N] description, never
        dropped) → SHOT DESCRIPTION (locked first frame + the storyboard beats as
        timed CUTs) → CINEMATOGRAPHY → AUDIO (dialogue with timbre + ambient).
        Reference tokens use the official [Image N] form; order matches the
        attachment order. Falls back to the text template upstream if no image
        loads.

        `geo_layout` is the scene's floor plan (Hell Grind rule 1), the same bytes every
        shot of the scene is written against. It is given to the WRITER, not only appended
        to the finished prompt, because a direction that places the altar frame-left while
        the pasted map places it frame-right is two contradictory maps in one prompt.
        "" → this call is byte-identical to what it was.
        """
        content: list[dict] = []
        labels: list[str] = []
        for img in images:
            block = self._image_block(img.get("path", ""))
            if block is None:
                continue
            n = len(labels) + 1
            # Official Seedance reference token (solution guide §7): [Image N]
            content.append({"type": "text", "text": f"[Image {n}] — {img.get('label', 'reference')}"})
            content.append(block)
            labels.append(f"[Image {n}] = {img.get('label', 'reference')}")
        if not labels:
            raise RuntimeError("vision_video_prompt: no reference image could be loaded")

        # Every annotation the storyboard produced, not just motion and camera.
        # green (framing), orange (light) and purple (emotional/audio emphasis) were
        # written by the beat writer, saved to the board's meta sidecar, carried all the
        # way into this payload — and then dropped on this line. The board was doing
        # the work of describing the shot's framing and lighting and the render never
        # heard about it.
        # Same two additions as the text template's twin (see panel_fov): the FOV degrees
        # out of `shot_type` and the DECLARED screen sides. This section of the system
        # prompt asks for "FOV in DEGREES (nearest anchor step)" while the beats it is
        # written from never carried one — the writer was picking the step itself,
        # 0 of 82 times from the board. Both clauses are conditional → a board without
        # them produces the byte-identical message this call produced before.
        beat_lines = "\n".join(
            f'- {b.get("time", "?")}: "{b.get("name", "")}" — {b.get("desc", "")} '
            f'[motion: {_strip_generation_params(b.get("red", ""))}] [camera: {_strip_generation_params(b.get("blue", ""))}]'
            + (f' [FOV: {panel_fov(b)}]' if panel_fov(b) else "")
            + (f' [framing: {_strip_generation_params(b.get("green"))}]' if _strip_generation_params(b.get("green")) else "")
            + (f' [light: {_strip_generation_params(b.get("orange"))}]' if _strip_generation_params(b.get("orange")) else "")
            + (f' [emphasis: {_strip_generation_params(b.get("purple"))}]' if _strip_generation_params(b.get("purple")) else "")
            + (f' [screen: {b.get("screen_side")}]' if b.get("screen_side") else "")
            + (f' [left in place: {b.get("leaves_behind")}]' if b.get("leaves_behind") else "")
            for b in beats
        ) or "- derive 2-3 timed CUTs spanning the duration from the action"

        dlg_lines = ""
        if dialogue:
            parts = []
            for d in dialogue:
                text = (d.get("text") or "").strip()
                if not text:
                    continue
                spk = d.get("speaker") or d.get("character") or "the character"
                emo = (d.get("emotion") or "").strip()
                tmb = (d.get("timbre") or "").strip()
                note = ", ".join(x for x in (tmb, f"{emo} tone" if emo else "") if x)
                parts.append(f'{spk}{f" ({note})" if note else ""}: "{text}"')
            dlg_lines = "\n".join(parts)

        system = (
            "You are a film director writing the FINAL prompt for the Seedance 2.0 video model, "
            "in the OFFICIAL AI-native film structure. You are looking at the ACTUAL reference "
            "images that will be attached to the request, in the same order and numbering. "
            "Ground every description in what you SEE — exact face, wardrobe, set dressing, the "
            "storyboard's drawn poses and coloured arrows — never in assumptions. Output ONLY the "
            "final prompt as PLAIN TEXT (~350-500 words) with these labelled sections, in order:\n\n"
            f"Reference mapping (attachment order): {'; '.join(labels)}.\n\n"
            "REFERENCES\n"
            "  One line per [Image N]: the tag, then a faithful detailed description of what that "
            "image shows. For a CHARACTER → face + hair + wardrobe + 'identity consistent across "
            "front, three-quarter, side and back views', AND assign a subject tag inline: 'Define "
            "<Subject_N> = this character from [Image N]' (number the characters 1, 2, 3…). "
            "Location → the place + its lighting state. Prop → the object + materials. KEEP every "
            "reference description in full — never drop or abbreviate them (this is what locks "
            "consistency across shots).\n\n"
            "SHOT DESCRIPTION:\n"
            + (f"  Begin: 'STRICTLY open on [Image …] ({first_frame_label}) as the locked first "
               "frame — held ~1 second, matching its exact composition.' "
               if first_frame_label else "")
            # NOT "CUT". On Seedance 2.5 the word CUT OPENS A NEW SHOT, so writing the
            # beats of ONE continuous take as "CUT (0.0s): …" asks for a cut at every beat.
            # Measured by an audit of BLOOM's 41 prompts: 96 of these markers across 17
            # takes, and on screen SHOT_020 asked for a locked 13.1s take and came back
            # with 7 hard cuts and 8 framings. Reproduced on BLACKMIRROR 4: 9 markers in
            # the two takes that reach this branch. The time range is kept — it is the
            # form the 2.5 guide itself uses for pacing ("0-5 seconds: …") — and only the
            # word that means "new shot" is gone.
            + "Then execute the storyboard beats IN ORDER as consecutive moments of ONE "
            "continuous take — write each as '<start>-<end> seconds: <action>'. This take "
            "does not cut: the camera keeps rolling from the first beat to the last. "
            "Refer to each character ONLY by their <Subject_N> tag "
            "(never re-describe a character mid-shot — that mutates the face); "
            "quantify each motion with vector + speed + inertia (slowly raise, push hard off the "
            "ground, carry the turn's inertia) and state DIRECTION (screen-left/right, "
            "toward/away from camera), following the drawn arrows. Never name an emotion — write "
            "the body language that shows it (fists clenched, jaw tight, chest heaving).\n\n"
            "CINEMATOGRAPHY:\n"
            "  One line: FOV in DEGREES (nearest anchor step) + depth of field + lighting (grounded "
            "in the location image) + film grain + colour grade + the camera move(s) and intent.\n\n"
            f"{_SEEDANCE_UNITS}\n\n"
            "AUDIO:\n"
            "  Each spoken line VERBATIM with its speaker, timbre and delivery note, then ambient, "
            "foley and any deliberate silence. If there is no dialogue, ambient + foley only.\n\n"
            f"End with: 'Total runtime: {duration}s.'\n\n"
            "IDENTITY LOCK: strictly retain each character's face and costume from their reference "
            f"images; never modify facial features or wardrobe. Keep the main subject(s) visible "
            f"and consistent for the entire {duration}-second shot. "
            "NO FEATURE BLEED: keep every HUMAN character's features fully natural — natural eye "
            "colour, ordinary skin, NO glowing or luminous eyes, NO bioluminescence — and NEVER carry "
            "a non-human creature's traits (glowing golden eyes, luminous skin, feathers, sparks) onto "
            "a human character, even when a creature is referenced in the SAME shot. The ONLY exception "
            "is when the SHOT ACTION explicitly scripts it (e.g. a written eye-glow beat)."
            + (f"\n\nMain subject signature: {char_signature or char_name}." if (char_signature or char_name) else "")
            + (f"\n\nDIRECTOR NOTES (must be honored): {director_notes}" if director_notes.strip() else "")
        )
        content.append({"type": "text", "text": (
            f"SHOT ACTION: {action}\n"
            f"STORYBOARD BEATS (use these as the timed CUTs, in order):\n{beat_lines}\n"
            f"ENVIRONMENT: {environment}\nLIGHTING: {lighting}\nCAMERA: {camera}\n"
            f"DURATION: {duration}s\n"
            # The scene's floor plan, identical in every shot of the scene. It is DATA in
            # the user half (the images and the beats are here too) — the instruction that
            # tells the writer it outranks its own invention is in the system half.
            + (f"GEO SPATIAL LAYOUT — this is the FIXED map of the place, identical in "
               f"every shot of this scene. Every landmark you name must be on the side it "
               f"says, the camera must stay on the side it names, and you must not invent "
               f"a structure it does not have:\n{geo_layout.strip()}\n"
               if geo_layout.strip() else "")
            + (f"DIALOGUE (place VERBATIM in the AUDIO section):\n{dlg_lines}\n" if dlg_lines else "")
        )})
        # Seed-first with the Claude fallback, through the SAME _text_llm route the beat
        # writer and the sheet prompts take — the list form of `user` is what carries the
        # PIXELS to whichever provider answers. This leg is multimodal and that was the
        # open question: measured 2026-08-07 on BLOOM SHOT_011's four real references,
        # seed-2-0-pro-260328 described all four correctly in 12.4 s through the client
        # __init__ already builds, and byteplus_generative drives up to 8 images per call
        # on that same model. So it is NOT handled as a text-only degradation.
        #
        # Bounded: this is the FIRST of the two prompt-writer calls inside
        # render_queue.py's claim window (see SUBMIT_PATH_TIMEOUT_SECS). Blowing past the
        # grace here is what got a live claim re-queued and the same shot paid for twice.
        # One attempt per provider keeps the per-leg worst case at the same 180 s the
        # queue's arithmetic counts (SUBMIT_PATH_PROVIDER_RETRIES).
        direction = self._text_llm(
            system, content, max_tokens=1200, temperature=0.5,
            timeout=SUBMIT_PATH_TIMEOUT_SECS,
            max_retries=SUBMIT_PATH_PROVIDER_RETRIES,
        ).strip()
        logger.info("[VisionPrompt] %s mode, %d images, %d beats, %d dlg → %d chars",
                    mode, len(labels), len(beats), len(dialogue or []), len(direction))
        return direction

    # ── Stage 4: the scene's floor plan (HELL GRIND · GEO SPATIAL LAYOUT) ────

    def scene_geo_layout(self, scene_heading: str, shots: list[dict],
                         location: str = "") -> str:
        """The scene's floor plan, in a few lines, written ONCE and reused verbatim.

        HELL GRIND, quoted: "The most expensive problem of our early takes: characters
        teleport, swap places, the camera jumps to the wrong side. The reason is simple:
        the model does not remember who stood where in the previous shot. The cure is the
        GEO SPATIAL LAYOUT block. It is a floor plan of the place in a few lines: the
        landmark objects, what is on the right, what is on the left, where the camera
        stands. No heroes, no action — only the place itself. You write it ONCE PER SCENE
        and paste it into EVERY shot of that scene WITHOUT CHANGES."

        WHY IT IS DIFFERENT FROM WHAT THIS CODEBASE ALREADY DOES. The axis here is held
        by a PER-BEAT `screen_side` the writer declares, a gate that reads the flips
        (check_screen_direction) and a carry that threads the last declaration into the
        next shot (carry_screen_side). Measured 2026-08-05 it works — 0 cross-board flips
        in 5 runs with the carry, 4 of 5 without — but every link of it depends on the
        model declaring correctly, every shot, every run. A scene-level CONSTANT depends
        on nothing: it is the same bytes in every prompt of the scene. The two coexist on
        purpose (this change deletes none of the screen_side machinery) — and the round
        that was meant to measure which one does the work has now run, below.

        WHAT MEASURED ON BLOOM SC-011 (3 boards, so 2 cross-board cuts per run), 4 runs
        per arm, 2026-08-06. THE BLOCK DOES NOT DO WHAT THE BRIEF SAYS IT DOES, and it
        does something else that matters more here:

          arm                          cuts broken /8   foreign structure spread
          carry on,  no geo (today)          0               3 runs of 4
          carry on,  geo                     0               0 runs of 4
          carry OFF, no geo                  3               4 runs of 4
          carry OFF, geo                     3               0 runs of 4

        Characters: the floor plan fixes NOTHING. With the carry disabled the cross-board
        180 survives it untouched (3 broken cuts either way — always Beni, always at the
        SHOT_028→SHOT_030 cut). The brief blames the teleporting on the model not
        remembering the previous shot, and on that point this codebase's own answer, the
        per-beat screen_side carry, is what holds: 0 broken cuts with it, 3 without,
        whether or not the map is present. The block is NOT a replacement for it.

        The PLACE: this is what the block buys. The beat writer places landmarks in ~12
        beat-mentions per 4 runs without it and ~22 with it, and it never once contradicts
        the map — 37 placements matched against the stored floor plan, 0 clashes. The
        measurable defect it kills is IMPORTED GEOGRAPHY: Beni's character sheet says he
        leans against a "hangar stanchion", a structure that belongs to another location,
        and the beat writer drags it into a flooded street at night. Mentions of it fall
        31 → 6 with the carry on and 48 → 2 with it off, and — the part that is really the
        scene's geometry — it stops spreading past the one board whose shot actually
        carries Beni's sheet: 3 of 4 runs → 0 of 4, and 4 of 4 → 0 of 4 without the carry.
        So: the carry holds the FIGURES, the floor plan holds the SET.

        Returns "" when it cannot be written (empty answer, no model). Every caller treats
        "" as ABSENT and emits exactly the prompt it emitted before this existed.
        """
        # The PLACE, not the people: the location asset's approved look is the one input
        # that describes the set. Characters are deliberately NOT passed — "No heroes, no
        # action — only the place itself".
        env_bits: list[str] = []
        for s in (shots or []):
            for a in (s.get("assets") or []):
                if str(a.get("type", "")).lower() in ("environment", "location", "set"):
                    nm = (a.get("name") or "").strip()
                    ap = (a.get("appearance") or a.get("visualDescription") or "").strip()
                    bit = f"{nm}: {ap}" if (nm and ap) else (nm or ap)
                    if bit and bit not in env_bits:
                        env_bits.append(bit)
        # The ACTION is needed to know WHICH corners of the place matter (where the
        # confrontation happens, which door is used) — the brief's own example places a
        # "RITUAL CENTER", which is an anchor position, not a person.
        action_bits = []
        for s in (shots or []):
            act = (s.get("action") or "").strip()
            lay = " | ".join(str(x.get("layout") or "").strip()
                             for x in (s.get("segmentShots") or [])
                             if str(x.get("layout") or "").strip())
            if act:
                action_bits.append(f"- {act}" + (f"  [layout: {lay}]" if lay else ""))

        system = (
            "You write the GEO SPATIAL LAYOUT block for ONE scene of a film: a floor plan "
            "of the PLACE in a few lines, which will be pasted UNCHANGED into every shot "
            "prompt of that scene so the model never forgets what stands where.\n"
            "RULES:\n"
            "- NO HEROES, NO ACTION. Never name a character and never describe anything "
            "that moves or happens. Only the place itself: the landmark objects, the "
            "anchor positions figures occupy, the camera, the light.\n"
            "- SIDES EXIST ONLY FROM THE CAMERA. Write 'frame-left', 'frame-right', "
            "'centre', 'foreground', 'background' — NEVER 'to the left of the hero' or "
            "'stage left'. The model does not understand a side relative to a person.\n"
            "- POSITIONS ARE SET FROM THE LANDMARK OBJECTS AND IN METRES: name one "
            "landmark as the anchor and give every other position relative to it, with a "
            "distance in metres (~3 m, ~12 m).\n"
            "- SAY WHERE THE CAMERA STANDS, explicitly, and WHICH LINE IT NEVER CROSSES "
            "(the 180° axis) — name the side of that line the camera stays on.\n"
            "- SAY WHERE THE LIGHT COMES FROM, as a direction relative to the frame "
            "(behind, frame-left, high frame-right).\n"
            "- THIS IS ONLY THE MAP. The LOOK of the place — texture, mood, colour, "
            "weather, grade — comes from the location asset and does NOT belong here. No "
            "adjectives about atmosphere.\n"
            "FORMAT: the header line exactly as given below, then 4 to 7 lines each "
            "starting with '— '. No preamble, no markdown, no closing remark.\n"
            "GEO SPATIAL LAYOUT (locked across every shot — pure spatial map):\n"
            "— <ANCHOR LANDMARK> = <what it is and where it sits in frame>.\n"
            "— <LANDMARK>: <frame-left/frame-right/centre>, ~<N> m from <the anchor>.\n"
            "— <ANCHOR POSITION>: <side>, ~<N> m from <the anchor>.\n"
            "— 180° AXIS: the camera ALWAYS stays on the <...> side — it NEVER crosses "
            "<the line>.\n"
            "— LIGHT: <which direction the key light comes from, relative to frame>."
        )
        user = (
            f"SCENE: {scene_heading}\n"
            + (f"LOCATION ASSET (the approved look of this place — use it for WHAT is "
               f"there, not for how it looks): {' ; '.join(env_bits)}\n" if env_bits else "")
            + ("WHAT HAPPENS HERE (only so you know which parts of the place matter — "
               "never write the action itself):\n" + "\n".join(action_bits) + "\n"
               if action_bits else "")
            + "\nWrite the GEO SPATIAL LAYOUT block for this scene."
        )
        try:
            out = (self._text_llm(system, user, max_tokens=600, temperature=0.2) or "").strip()
        except Exception as e:                       # noqa: BLE001 — richness, not correctness
            logger.warning("[Geo] layout unwritable (%s) — boards fall back to no geo block", e)
            return ""
        if out.startswith("```"):
            out = out.split("\n", 1)[1] if "\n" in out else out[3:]
            out = out.rsplit("```", 1)[0].strip()
        # A one-liner is not a floor plan. Below this the block costs tokens in every
        # prompt of the scene and buys nothing, so it is treated as ABSENT — which is the
        # branch that leaves every prompt byte-identical to what it was.
        if len(out) < 60 or out.count("\n") < 2:
            logger.warning("[Geo] layout too thin (%d chars) — treated as absent", len(out))
            return ""
        return out

    # ── Stage 4: Storyboard generation (panel descriptions) ──────────────────

    def storyboard_panels(self, scene_heading: str, shots: list[dict],
                          prev_screen_side: str = "",
                          prev_leaves_behind: str = "",
                          prev_anchored: str = "",
                          geo_layout: str = "",
                          scene_opening: bool = False,
                          opening_tail: str = "",
                          cast_names: list[str] | None = None) -> list[dict]:
        """
        Annotated action-board beats (production template): each beat carries a
        quoted NAME, a shot-type opener, 2-4 sentences of body-part-level
        blocking, and five color-coded annotation lines (red=body/weapon paths,
        blue=camera movement, green=framing notes, orange=lighting cues,
        purple=audio/emotional beat). Returns
        [{label, name, shot_type, desc, screen_side, crossing, leaves_behind,
        state_change, red, blue, green, orange, purple}].

        `prev_leaves_behind` is the SET STATE the previous shot of this scene left
        standing ("plate:on the wooden table, Nuria hair:tied bun", from
        carry_leaves_behind). Exactly the same wiring, and exactly the same failure
        without it, as prev_screen_side below: the beats were written blind to what the
        previous ones had put where, so BLOOM's SC-021 lost the agronomist's overalls
        across SHOT_062_2 and got them back in SHOT_063, and SC-015 gave Nuria a bun
        between two panels with no beat showing her tie it.

        `prev_screen_side` is the axis the PREVIOUS shot of the same scene left behind
        ("Tomás:left, Beni:left", from carry_screen_side). Without it every shot was
        written blind: server._assemble_storyboard called this once per shot IN PARALLEL,
        so the writer of SHOT_030 could not know what SHOT_028 had established, and the
        axis held inside a board and died at its edge. Measured on BLOOM SC-011, 5 runs
        per arm, 2026-08-05: WITHOUT the carry, SHOT_028 closed with Beni frame-LEFT and
        SHOT_030 opened her frame-RIGHT in 4 of 5 runs (run 2 flipped Tomás as well) — a
        cross-board 180 with nothing on screen showing the move, and one that
        check_screen_direction cannot see because it reads inside a single board. WITH the
        carry, 0 of 5. "" (the first shot of a scene, or a caller that does not thread it)
        → the prompt is exactly what it was, byte for byte.

        `geo_layout` is the scene's GEO SPATIAL LAYOUT (see scene_geo_layout) — the SAME
        bytes for every shot of the scene. Where prev_screen_side is a per-shot carry of
        something the model DECLARED, this is a constant nothing has to declare or hand
        on. "" → the prompt is byte-identical to what it was.

        `scene_opening` marks the FIRST shot of the scene. HELL GRIND, quoted: "The first
        second is always a wide shot. One second at the start of the scene, no lines and
        no action: the model 'photographs' the arrangement — who stands where, what lies
        where, where the light comes from — and holds it in every following shot. Remove
        that second, and characters start swapping places." So the skeleton grows one
        extra beat at 0-1s and the shot's own beats are re-timed into the seconds that
        remain — the second is CARVED OUT of the scene's first shot, never added to it,
        because the shot's length is what phase 5 pays Seedance for and the segment's
        declared sub-shot durations are what the model is told to cut on. The cost is
        real and it is one second of ACTION per scene.

        THE COST, MEASURED (BLOOM SC-011, 4 runs, 2026-08-06). Runtime does not move:
        SHOT_028 stays 11.0s and its segment cut stays at 5.0s — 2 beats (0-5, 5-11)
        become 3 (0-1, 1-5, 5-11), and SHOT_030/SHOT_033 are untouched. Nothing is paid
        twice. What is spent is one second of the scene's first shot, once per scene.

        THE BENEFIT, MEASURED — AND IT IS NOT THERE. "Remove that second, and characters
        start swapping places" does not reproduce on this scene. With the screen_side
        carry on, the wide changes nothing that can be counted: 0 broken cross-board cuts
        out of 8 with it and 0 without. With the carry disabled — the world the brief is
        describing, where nothing remembers the previous shot — it was WORSE, not better:
        4 of 8 cuts broken with the wide against 3 of 8 without, and the flips it produced
        were the wide's own arrangement (Beni closing SHOT_028 frame-RIGHT where the
        no-wide runs closed him frame-LEFT) contradicted by the next board, which is still
        written blind. 4 runs per arm is too few to call 4-vs-3 a regression; it is more
        than enough to say the improvement the brief promises is absent. The beat is kept
        because it is what a scene's establishing second is FOR and because it costs no
        runtime — not because it was shown to hold the axis. It did not.

        `opening_tail` is the last spoken line before this scene, for the seam trick,
        quoted: "If the shot is an answer to the previous one, feed the tail of the
        previous clip's line into that first second — then the actor answers the right
        thing in the right tone, and the two clips glue at the seam." "" → the opening
        wide simply holds the arrangement in silence.
        """
        import json as _json
        def _fmt(x: float) -> str:
            return str(int(round(x))) if abs(x - round(x)) < 0.05 else f"{x:.1f}"
        shot_lines = []
        skeleton: list[dict] = []   # the beats are CREATED here (count + time fixed)
        # The label of the scene's opening wide, or "" — set inside the loop, read by BOTH
        # prompt halves after it, so it is bound OUT here: `shots` can be empty and the
        # loop body may never run.
        opening_label = ""
        # True cuando esa viñeta ES la primera etapa (segmento) en vez de un
        # segundo extra carvado antes de ella (plano suelto). Cambia lo que se le
        # puede pedir: una etapa real tiene acción, el segundo extra no.
        opening_is_stage = False
        for s in shots:
            dur = float(s.get("estimatedDuration") or s.get("duration_sec") or 5)
            # Beat count + time ranges are computed HERE (deterministic) — the model is
            # unreliable at honouring a "produce N beats" instruction (it dropped beats).
            # It is given the skeleton below and only FILLS each beat.
            #
            # When the shot is a SEGMENT, its own shots ARE the beats: the breakdown has
            # already decided how many cuts there are and how long each runs, so deriving
            # a uniform ~1-beat-per-1.5s grid on top would board a rhythm the render is
            # not going to have. Only an ungrouped shot falls back to the grid.
            subs = [x for x in (s.get("segmentShots") or [])
                    if float(x.get("duration_sec") or x.get("durationSecs") or 0) > 0]
            # UN SEGMENTO DE UNA SOLA ETAPA SIGUE SIENDO UN SEGMENTO. La condición era
            # `> 1`, así que un segmento de un beat caía a la rejilla uniforme de abajo y
            # recibía de 4 a 8 viñetas para UNA etapa — BLACK MIRROR V3/SHOT_039: 7 viñetas
            # para 1 etapa, de las que `_merge_plan` conserva una y tira seis. El board es
            # el plan de cámara DE LA ETAPA; una etapa es una toma sin cortes y le
            # corresponde una viñeta. La rejilla queda para lo que de verdad no es un
            # segmento, que es lo único que no declara sus propios cortes.
            if len(subs) >= 1:
                pts, acc = [0.0], 0.0
                for x in subs:
                    acc += float(x.get("duration_sec") or x.get("durationSecs") or 0)
                    pts.append(acc)
                ranges = [f"{_fmt(pts[i])}-{_fmt(pts[i + 1])}s" for i in range(len(subs))]
            else:
                n_beats = max(4, min(8, round(dur / 1.5)))
                pts = [dur * i / n_beats for i in range(n_beats + 1)]
                ranges = [f"{_fmt(pts[i])}-{_fmt(pts[i + 1])}s" for i in range(n_beats)]
            sid = s.get("id") or "SHOT"
            # THE OPENING WIDE (HELL GRIND rule 2, quoted in the docstring): one second at
            # the START OF THE SCENE that photographs the arrangement and carries no
            # action. It exists only on the scene's FIRST shot, and the second is CARVED
            # OUT of that shot rather than added to it — the shot's length is what phase 5
            # buys from Seedance and, in a segment, the sub-shot durations are the cuts the
            # model is told to make. Adding a second here would put the board out of step
            # with both.
            #
            # HOW the second is taken differs by branch, for the reason each branch exists:
            #   * SEGMENT (the beats ARE the breakdown's cuts) — take it from the FIRST
            #     sub-shot only, so every later cut lands on exactly the second it was
            #     declared on and the board still matches assemble_segment_prompt.
            #   * GRID (a uniform ~1.5s scaffold nothing downstream reads) — rescale the
            #     whole grid into the seconds that remain; there is no declared boundary
            #     to preserve.
            # Refused (and logged) when the shot is too short to give a second away or the
            # board is already at the 8-panel ceiling _assemble_storyboard slices at —
            # a 9th beat would be silently dropped, which is worse than no opening wide.
            if scene_opening and s is shots[0]:
                if dur < 4.0 or len(ranges) >= 8 or (len(subs) > 1 and pts[1] < 2.5):
                    logger.info("[Geo] %s: no opening wide (dur=%.1fs, %d beats) — "
                                "the second cannot be carved without starving a cut",
                                sid, dur, len(ranges))
                else:
                    if len(subs) > 1:
                        # ONE PANEL PER STAGE, ALWAYS. Inserting the wide as an extra panel
                        # is what put the board out of step with the prompt: a 7-stage
                        # segment came back with 8 panels, and `_merge_plan` then handed
                        # stage 6 the annotation written for panel 7 — so the prompt told
                        # Seedance "he presses the lamp switch" and, in the same stage,
                        # "his hand closes around the phone and lifts it". Measured on
                        # BLACK MIRROR V3: 3 of 11 segments were misaligned, and both of
                        # the +1 cases are this insert (the third is the ungrouped-shot
                        # grid below). The wide is now the FIRST STAGE'S OWN panel — the
                        # stage still opens on the arrangement, it just does not cost an
                        # extra beat the render never bought.
                        ranges[0] = f"0-{_fmt(pts[1])}s"
                        opening_label = f"{sid}-A"
                        opening_is_stage = True
                    else:
                        ranges = [f"{_fmt(1 + (pts[i] * (dur - 1) / dur))}-"
                                  f"{_fmt(1 + (pts[i + 1] * (dur - 1) / dur))}s"
                                  for i in range(len(ranges))]
                        ranges.insert(0, "0-1s")
                        opening_label = f"{sid}-A"      # letters are re-assigned below
            # Conceptual thread: name the assets in THIS shot with their approved look
            # so the beats describe the REAL characters (wardrobe, helmet) — not a
            # generic figure the model invents.
            asset_bits = []
            for a in (s.get("assets") or []):
                nm = (a.get("name") or "").strip()
                ap = (a.get("appearance") or a.get("visualDescription") or "").strip()
                if nm:
                    asset_bits.append(f'{nm}: {ap[:160]}' if ap else nm)
            assets_line = (" assets_in_shot=[" + " | ".join(asset_bits) + "]") if asset_bits else ""
            shot_lines.append(
                f'- {sid}: action="{s.get("action", "")}" '
                f'camera="{s.get("cameraAngle") or s.get("camera") or "unspecified"}" '
                f'lighting="{s.get("lighting") or "unspecified"}" duration={dur}s'
                # The acting direction, so the beats describe how the character PLAYS
                # the moment rather than only what happens in it.
                + (f' performance="{s.get("performance")}"' if s.get("performance") else "")
                + (" [FINAL SHOT OF SCENE]" if s.get("isSceneFinal") else "")
                + assets_line
            )
            for i, tr in enumerate(ranges):
                skeleton.append({
                    "label": f"{sid}-{chr(65 + i)}", "time": tr,
                    "name": "", "shot_type": "", "desc": "",
                    # DECLARED geometry: which side of frame each character is on in THIS
                    # beat. It is a field, not prose, because check_screen_direction() has
                    # to be able to READ it — 488 beats on disk describe direction inside
                    # `desc` and not one of them is auditable.
                    "screen_side": "",
                    # DECLARED INTENT. A side swap is either the action (two people walk
                    # past each other in a locked frame — BLOOM SHOT_004 swaps them in 2
                    # of 4 baseline runs and is RIGHT to) or a continuity break, and no
                    # amount of reading the desc separates them: the old prose heuristic
                    # forgave 8 flips in 90 beats on the word "exit" in "gym exit lights".
                    # The writer says which one it meant; the gate checks the flip against
                    # what was said. Default False = "this beat claims no crossing".
                    "crossing": False,
                    # DECLARED SET STATE: what this beat LEAVES BEHIND — what is now
                    # where, and how each character is dressed/coiffed at the end of it.
                    # A field and not prose for the same reason screen_side is one:
                    # check_object_continuity() has to be able to READ it. 636 beats on
                    # BLOOM's disk describe props inside `desc` and not one of them lets
                    # a gate answer "is the plate still on the table in beat C?".
                    "leaves_behind": "",
                    # DÓNDE ESTÁ CADA PERSONA RESPECTO A LOS MUEBLES. Ni `screen_side` ni
                    # `leaves_behind` lo dicen: el primero es relativo al CUADRO y además
                    # se normaliza a left/right/centre, así que "a la izquierda de la cama"
                    # se convierte en "left" y el mueble se pierde; el segundo excluye a las
                    # personas a propósito ("a figure's place is screen_side's field"). El
                    # resultado medido: BLACKMIRROR 4 dibujó a Michael a la derecha de la
                    # cama en SHOT_004 y a la izquierda en SHOT_008 — la escena entera
                    # reflejada — y las dos puertas la dieron por buena, porque una toma
                    # invertida cumple "Michael:left" mientras cruza el eje.
                    "anchored": "",
                    # DECLARED INTENT, the `crossing` of this axis. An object that moves
                    # is either the action (Clara picks the plate back up) or a
                    # continuity break (the plate evaporates), and the desc cannot
                    # separate them. The writer says which; the gate checks the change
                    # against what was said. Default False = "nothing was moved here".
                    "state_change": False,
                    "red": "", "blue": "", "green": "", "orange": "", "purple": "",
                })
        system = (
            "You are a storyboard artist breaking each SHOT into TIMED action-board beats. "
            "These beats double as the CUTs of the final Seedance video prompt, so each carries "
            "a TIME RANGE.\n"
            "You are GIVEN a JSON array of beats with \"label\" and \"time\" ALREADY filled (the "
            "beat count and time ranges are FIXED — do not change them). FILL IN each beat's "
            "empty content fields. Return the SAME array — same length, same order, same "
            "label+time on every beat. NEVER add, drop, merge or reorder beats. Each beat is a "
            "DISTINCT visual moment with its own motion — vary framing/angle across beats, no "
            "repeats.\n"
            "ASSET FIDELITY: each SHOT line lists 'assets_in_shot' with each character/prop's "
            "APPROVED appearance. Depict those exact characters with that wardrobe and gear "
            "(e.g. helmet only if their look includes one) — never invent or substitute a generic "
            "look. Name them in the desc so the artist draws the right person.\n"
            # A NAME WITHOUT A REFERENCE IS AN INVENTED FACE. `assets_in_shot` is not a
            # suggestion — it is the exact set of images the board render will receive, and
            # the budget for them is 6 (BOARD_MAX_REFS). Naming anyone else asks the render
            # for a face nobody sent: BLACK MIRROR, 2026-08-15 — SHOT_029 carried Walker
            # alone, its beats named Michael Callow, Julian and Alex Cairns and added "all
            # seated aides", and the board came back with SIX people, five of them
            # strangers. Those strangers are then the reference stage 5 animates, which is
            # how a film ends up with actors nobody cast. Background humans are fine; named
            # ones are not.
            "NAME ONLY WHO YOU WERE GIVEN: the characters in 'assets_in_shot' are the only "
            "people whose face this board can render — never name, and never write blocking "
            "for, a character who is not in that list, not even one the script has elsewhere. "
            "If the space needs other bodies, keep them ANONYMOUS and out of focus (\"an aide\", "
            "\"two officers at the far end\", \"a seated figure, back to camera\") and never give "
            "them dialogue, a name or a readable face.\n"
            "EVERY beat shows tangible motion or momentum — static upright standing poses are "
            "prohibited (a held pose is allowed only as the scene-closing beat).\n"
            # NOBODY HOLDS ABSOLUTELY STILL. The rule above covers the SUBJECT; it said
            # nothing about everyone else in frame, and the writer filled that silence with
            # freeze orders. BLACK MIRROR SHOT_029's beats, verbatim: "All seated aides hold
            # perfectly still", "eyes remain unblinking", "Princess Susannah remains
            # perfectly frozen … no motion", "Every person remains perfectly motionless".
            # Those sentences reach Seedance unchanged, so the render is not hallucinating
            # when it returns a room of statues — it is obeying. seed-2-0-lite watching the
            # finished clip: "All seated conference attendees are frozen motionless."
            # ACTING SKILL.md already forbids exactly this and had never been read by any
            # code: §12 lists "Dead eyes — frozen stare, no blinks" as defect 15 and
            # "Synchronized ensemble — everyone reacts identically and at once" as 10, and
            # §11 asks for "constant ensemble micro-movement … and at the key threat
            # everything STOPS" — stillness as PUNCTUATION, once, not as the default state.
            # THE CRAFT ITSELF, not my paraphrase of it. ACTING SKILL.md is the document
            # this pipeline's performance rules come from, and until 2026-08-15 no code had
            # ever opened it: the rules below were transcribed by hand years apart and had
            # drifted from the source. Three sections, by name, for exactly the failures
            # this writer produces — §7 eye life (the render returns glassy dead stares),
            # §11 ensemble (it writes "all the aides hold still", which the section forbids
            # and replaces with a staggered wave), §12 the atlas of bad acting, whose entry
            # 15 IS the defect the finished clips show. The file stays the single source of
            # truth: edit the .md and this prompt changes.
            + "".join(
                f"\nFROM THE PROJECT'S ACTING CRAFT DOCUMENT — apply it, do not summarise it:\n{_sec}\n"
                for _sec in filter(None, (_load_skill_section("ACTING SKILL.md", h)
                                          for h in ("7. Eye life", "11. Ensemble", "12. Atlas")))
            ) +
            # DOS COSAS CON EL MISMO NOMBRE CORTO NO SE PUEDEN DISTINGUIR. Un beat que
            # escribe "phone" en una escena con `Blackberry Mobile Phone` y `Corded
            # Bedside Desk Phone` no ha dicho cuál, y el render elige: BLACK MIRROR V3,
            # suena el fijo en una etapa y en la siguiente el personaje levanta el móvil.
            # La lista se calcula de los assets de ESTE board, así que sólo aparece cuando
            # de verdad hay colisión.
            "".join(
                f"AMBIGUOUS NAME — \"{h}\" names {len(ns)} different approved assets in this "
                f"scene ({', '.join(ns)}). NEVER write \"{h}\" on its own in a desc, a "
                f"screen_side or a leaves_behind: write the full name every time, so the "
                f"render knows which one is meant.\n"
                for h, ns in _ambiguous_nouns(shots)) +
            "NOBODY IN FRAME IS EVER COMPLETELY STILL — living people are never motionless, "
            "and a render told they are returns statues. NEVER write 'motionless', "
            "'perfectly still', 'frozen', 'unblinking', 'does not move', 'holds position' or "
            "'no motion' of a person. Every visible human, including background figures and "
            "anyone on a screen within the shot, carries small involuntary life: breath "
            "moving the shoulders, a blink, a shift of weight, a swallow, eyes flicking to "
            "the speaker. Background reactions arrive in a WAVE and never together — one "
            "person a beat before the next. Stillness is allowed ONCE, as deliberate "
            "punctuation at the moment of greatest threat, and even then the eyes stay "
            "alive.\n"
            "For the shot marked [FINAL SHOT OF SCENE], its last beat is a held pose under "
            "isolated light unless the action says otherwise.\n"
            # THE AXIS. The beats of one shot are ONE continuous action drawn as N panels,
            # and until now the rule was per-beat: every beat was told to state a DIRECTION
            # and nothing said beat B had to keep the geometry beat A established. Measured
            # on BLOOM: SHOT_004 put Tomás screen-left in beat A and screen-right in beat B
            # (one continuous walk, two incompatible geometries); SHOT_055 set a plate down
            # in beat B and by beat C the plate was gone and Clara had crossed the table;
            # SHOT_009 came back with two beats that drew the same image. None of the three
            # broke a rule that existed.
            "SCREEN AXIS (180° rule) — the beats of ONE shot are ONE continuous action, not "
            "separate images: the FIRST beat of a shot ESTABLISHES which side of frame each "
            "character occupies, and EVERY later beat of that SAME shot KEEPS it. A figure "
            "who exits frame-right enters the next beat from frame-left. Crossing the axis "
            "inside one board is PROHIBITED — a character may only change side if THAT beat "
            "SHOWS the move (they walk across frame, exit and re-enter, pass camera). Props "
            "hold their place too: what is set down in one beat is still there in the next.\n"
            # THE AXIS ACROSS THE CUT. The rule above stops at the board's edge and the
            # geometry does not: SHOT_030 is the same two people standing in the same
            # floodwater as SHOT_028. Before the carry, this call saw one shot at a time
            # and had nothing to keep faith with. Now the axis the previous shot left
            # behind arrives as CARRIED SCREEN AXIS in the user message; this is the rule
            # that tells the writer what to do with it.
            "CARRIED AXIS — when the user message gives you a CARRIED SCREEN AXIS, those "
            "characters are ALREADY on those sides of frame from the previous shot of this "
            "same scene. Your first beat INHERITS that geometry: same character, same side, "
            "unless the SHOT's own action says they moved. A new camera angle does NOT "
            "license a new side — cutting closer or wider keeps everyone where they were.\n"
            # THE FLOOR PLAN (HELL GRIND rule 1). The two rules above are about FIGURES and
            # they are carried, per shot, from something the model declared. This one is
            # about the PLACE and it is a constant: the identical block reaches every shot
            # of the scene, so there is nothing to declare and nothing to hand on. It is
            # stated CONDITIONALLY (only when a geo block is actually supplied) so a call
            # without one — a legacy caller, a project whose geo could not be written —
            # gets the system prompt byte for byte as it was, and the cached system half
            # is not invalidated for it. Measured on BLOOM SC-011, 4 baseline runs: the
            # writer gave a LANDMARK a side 0 times, so the set had no geometry to keep.
            + ("GEO SPATIAL LAYOUT — the user message carries a floor plan of this scene's "
               "place: the landmark objects, what is frame-left, what is frame-right, where "
               "the camera stands and the line it never crosses. It is IDENTICAL in every "
               "shot of this scene and it OUTRANKS your own invention: never put a landmark "
               "on the other side of frame from where the plan puts it, never move the "
               "camera across the axis line it names, never light the place from a direction "
               "it contradicts, and never introduce a structure the plan and the location do "
               "not have. Place the figures INSIDE that plan — name the landmarks they are "
               "near in the desc, and let the plan decide which side of frame they read on.\n"
               # THE PLAN IS NOT SET DRESSING. Measured on BLOOM SC-011, 4 runs per arm,
               # 2026-08-06: given the plan, the writer started listing the PLACE in
               # "leaves_behind" ("floodwater: still black surface"), and since water
               # legitimately ripples when a man wades through it, check_object_continuity
               # reported it as a silent continuity break — 4 of 12 boards with the plan
               # against 1 of 12 without. The findings were false and the field was the
               # wrong one: the plan already fixes the place, permanently, for the whole
               # scene. This line puts the landmarks back where they belong.
               "The plan's landmarks are the PLACE and the plan already fixes them for the "
               "whole scene, so they NEVER go in \"leaves_behind\" — that field is for "
               "props and clothing that a beat could move or change. Water, ground, walls, "
               "buildings, the street and the light are the place, not props.\n"
               if geo_layout.strip() else "")
            # THE OPENING WIDE (HELL GRIND rule 2). Conditional for the same reason as the
            # block above: a shot that is not the scene's first gets the prompt unchanged.
            + ((f"OPENING WIDE — beat {opening_label} is the SCENE'S FIRST BEAT and it "
                "OPENS on the arrangement: it starts on a wide that photographs every figure "
                "and every landmark in their places, exactly as the geo plan puts them, and "
                "only then plays its own action. Its screen_side and leaves_behind declare "
                "the FULL arrangement the rest of the scene inherits, and every later beat "
                "starts from exactly that arrangement.\n"
                if opening_is_stage else
                f"OPENING WIDE — beat {opening_label} (0-1s) is the SCENE'S FIRST SECOND and "
                "it is not a normal beat. It is a WIDE that photographs the arrangement: "
                "every figure and every landmark visible in their places, exactly as the geo "
                "plan puts them, holding still. NO action, NO gesture, NO camera move, NO "
                "spoken line in it — the motion rule above does not apply to this one beat. "
                "Its screen_side and leaves_behind declare the FULL arrangement the rest of "
                "the scene inherits. The beat after it starts the action from exactly that "
                "arrangement.\n") if opening_label else "")
            # THE DECLARATION. Two people walking past each other DO exchange sides and
            # that is the shot working, not failing. The gate cannot read that out of the
            # prose (it forgave 8 flips in 90 BLOOM beats on "gym exit lights"), so the
            # writer states the intent and the gate checks the flip against the statement.
            + "CROSSING (declare it) — set \"crossing\": true on a beat ONLY when the ACTION "
            "has the figures physically exchange sides IN FRAME during that beat: they pass, "
            "cross, overtake or walk past each other while the camera stays put. It means "
            "\"the swap you are about to see is the action\". It is FORBIDDEN on a beat that "
            "cuts to a new angle, and forbidden as an excuse for a side you simply changed "
            "your mind about — a cut is not a crossing. Every other beat: false.\n"
            # WHICH beat carries the flag. Left implicit, the writer answered it the same
            # way 6 times out of 6 on BLOOM SHOT_004 (2026-08-05): the flag goes on the beat
            # DURING which they pass, whose screen_side still shows the sides they START on,
            # and the swap first appears in the NEXT beat. That is the correct reading of
            # "during that beat" and the gate now licenses the flip from either end of the
            # gap — this line just stops the writer drifting to the other convention, which
            # would leave a real teleport undeclared on both beats.
            "WHERE the flag goes: on the beat in which the pass HAPPENS. That beat's "
            "\"screen_side\" still shows the sides they START on; the NEXT beat shows them "
            "swapped and declares crossing false. Do NOT put the flag on the later beat as "
            "well — one pass, one declaration.\n"
            # THE SET AND THE WARDROBE. Same defect as the axis, different axis: a beat was
            # written blind to what the one before it had put where. Measured in BLOOM's
            # storyboard QC (24 scenes, 2026-08-05): 5 of the 6 failures are this. SHOT_055
            # sets a plate down in beat B and beat C shows an empty table; SC-015 gives
            # Nuria a bun between two panels with nothing showing her tie it; SC-021 loses
            # the agronomist's overalls for a whole board and hands them back in the next;
            # SC-012 moves the lanterns, the window and the stair block between panels. None
            # of the five broke a rule that existed.
            "OBJECTS AND WARDROBE PERSIST — once something is set down it STAYS in frame "
            "for every later beat, and once a character's hair, clothing or gear is "
            "established it STAYS that way until a beat SHOWS it change. A prop does not "
            "leave the table because the next beat forgot about it; hair does not tie "
            "itself between two panels; a coat does not come off between two cuts. If a "
            "prop or a garment has to change, a beat must SHOW the hand that changes it.\n"
            "CARRIED STATE — when the user message gives you a CARRIED SET STATE, those "
            "objects are ALREADY where it says and those characters are ALREADY dressed "
            "that way, left by the previous shot of this same scene. Your first beat "
            "INHERITS it verbatim. A new camera angle does not empty the table or change "
            "anyone's clothes. "
            # The carry is a FLOOR, not a ceiling. Measured on BLOOM SC-021, 5 scenes per
            # arm, 2026-08-05: given a carried state naming only the truck, the writer
            # treated it as the whole list and declared nothing for the Old Agronomist,
            # who ENTERS on the second board — 0 of 5 carried runs declared his overalls,
            # while 5 of 5 uncarried runs did (and then lost them on the next board,
            # which is the SC-021 defect). Inheriting must not mean "declare only this".
            "It is a FLOOR, not a list: keep every carried entry AND add the props and "
            "wardrobe this shot brings in — a character who first appears here gets their "
            "clothing declared here.\n"
            "STATE CHANGE (declare it) — set \"state_change\": true on a beat ONLY when the "
            "ACTION physically moves an object or changes a character's appearance IN "
            "FRAME during that beat: a hand sets something down, picks it up, takes it "
            "away, ties hair back, pulls a coat off. It means \"the change you are about to "
            "see is the action\". It is FORBIDDEN as an excuse for a prop you simply "
            "stopped drawing or an outfit you changed your mind about. Every other beat: "
            "false.\n"
            "Each beat must ALSO differ visibly from the beat before it — a different "
            "framing, distance or angle. Two beats that would draw the same image are a "
            "failure, not a style.\n"
            "Fill these fields on EACH given beat (leave label + time exactly as provided):\n"
            '- "name": a punchy beat name, 1-3 words (e.g. "Shield Impact")\n'
            '- "shot_type": a shot-type opener sentence (e.g. "Aggressive tight low-angle shot.")\n'
            '- "desc": 2-4 sentences of concrete blocking with body-part-level action AND the '
            "DIRECTION of movement (screen-left/right, toward/away from camera, up/down)\n"
            '- "screen_side": WHERE each character stands in THIS beat, as a compact map — '
            'exactly "Name:left of frame | window side of the bed, Name:right of frame | '
            'door side of the bed" — entries separated by COMMAS, and inside each entry the '
            "two halves separated by a PIPE. Before the pipe: the side of the FRAME (left / "
            "right / centre, from the camera). After the pipe: WHICH SIDE OF WHICH PIECE OF "
            "FURNITURE they are on — name the object (the bed, the conference table, the "
            "nightstand) and their side of it. Never a second frame word after the pipe: "
            '"filling frame" and "right edge frame" say nothing about the room. Both halves, '
            "every time, for every character named in the desc. The frame half may mirror "
            "when the camera crosses; the furniture half may not change unless the action "
            "moves them there. This field is the axis declaration, it is checked, and it is "
            "drawn.\n"
            '- "crossing": true or false (JSON boolean). true ONLY if the figures exchange '
            "sides IN FRAME in THIS beat because the action has them pass each other; false "
            "on every other beat, including every beat that cuts to a new angle. A side that "
            "flips with crossing=false is reported as a 180° break.\n"
            '- "anchored": WHERE EACH NAMED PERSON IS RELATIVE TO THE FURNITURE, as '
            '"Name:anchor" — "Michael:on the window side of the double bed", '
            '"Walker:standing behind the far end of the conference table". Not the frame: '
            'the frame mirrors on a reverse angle and the room does not. A camera may cross '
            'to the other side and see the same person from behind; the person has still '
            'not moved. Say it for every named person the beat shows, and repeat it '
            'unchanged in later beats unless the written action moves them. '
            '- "leaves_behind": the state this beat LEAVES STANDING, as a compact map — '
            'exactly "thing:where it is, Character item:how it looks". Props use WHERE they '
            'are ("plate:on the wooden table", "lantern:hanging on the left wall hook", '
            '"case:in Clara\'s hands"); wardrobe/hair is keyed by owner '
            '("Nuria hair:tied in a bun", "Old Agronomist overalls:worn, sleeves rolled"). '
            # PROPS AND CLOTHES ONLY, and this has to be said. Measured on BLOOM SC-021,
            # 10 whole scenes generated 2026-08-05: asked to "list every character in the
            # beat", the writer filled the field with POSTURES — "Beni:leaning out cab
            # window", "Tomás:hand at jaw" — 86 of 86 entries that changed between beats
            # were a figure moving, i.e. the action, and not one was a prop or a garment.
            # A figure's place is screen_side's field; this one is for what they leave.
            "ONLY props and clothing/hair belong here. NEVER key an entry on a character "
            "or a body part — no \"Tomás:standing left\", no \"Beni:leaning out the "
            "window\", no \"Clara hands:on the table\". Where the figures are is "
            "screen_side's job and what they DO is the desc's; this field is what would "
            "still be there if everyone walked out. List every prop that is in play and "
            "every garment/hairstyle that is visible. CARRY EACH "
            "ENTRY FORWARD WORD FOR WORD into the next beat unless that beat changes it — "
            "rewording a value reads as the thing having moved. Only write a value like "
            '"taken"/"removed" when a beat SHOWS it go, or "out of frame" when the framing '
            "simply excludes it. This field is the continuity declaration and it is "
            "checked.\n"
            '- "state_change": true or false (JSON boolean). true ONLY if THIS beat shows an '
            "object being moved/placed/taken or a character's clothing or hair being "
            "changed, in frame; false on every other beat. A value in leaves_behind that "
            "changes with state_change=false is reported as a continuity break.\n"
            '- "red": body/weapon movement paths WITH direction (arrows to draw)\n'
            '- "blue": camera movement\n'
            '- "green": framing/composition note\n'
            # The Kelvin lives ONLY here — measured over 320 BLOOM panels, 100% of the
            # colour-temperature values in a board come from `orange` and none from any
            # other field. It used to arrive on the strength of _SEEDANCE_UNITS alone,
            # which is a block about CAMERA, and when the acting rules and the positive-
            # phrasing rule were added below it the writer drifted toward describing the
            # QUALITY of the light and away from naming its temperature: 53/148 panels
            # carried a Kelvin before those rules, 39/172 after (36% → 23%), while FOV —
            # which _SEEDANCE_UNITS names explicitly — went the other way, 89% → 99%.
            # That is the difference between a spec the prompt demands by name and one it
            # only implies. Stage 5 invents a colour temperature per shot when the board
            # does not state one, independently, which is how one kitchen scene came back
            # at three different temperatures.
            '- "orange": lighting cue (from the lighting field) — MUST name the white '
            'balance in KELVIN (≈3200K warm / 5600K neutral / 8500K cool, nearest step), '
            'and the same scene keeps the same value unless a beat SHOWS the light change\n'
            '- "purple": audio/emotional beat emphasis\n'
            "Annotation lines: under 12 words each.\n"
            # Make the board commit to MEASURABLE camera and light specs. Measured on an
            # 8-shot dialogue scene (32 beats, 2026-07-29):
            #
            #                          without        with
            #   beats naming a FOV      0 / 32       18 / 32   (all 18 on the table's scale)
            #   beats naming a Kelvin   0 / 32       36 mentions
            #
            # Without it phase 4 emits no numbers at all — "slow push in", "cool overhead
            # light" — and stage 5 invents a FOV and a colour temperature per shot while
            # translating, independently. That is why one kitchen scene came back at three
            # different colour temperatures. The decision belongs in the storyboard, where
            # a director makes it, and now reaches the render because blue/orange are
            # finally read. Set STORYBOARD_QUANTIFY=0 to go back to prose.
            + (f"{_SEEDANCE_UNITS}\n" if os.getenv("STORYBOARD_QUANTIFY", "1") == "1" else "")
            # The beats are the last text a human reads before the render, and they were
            # being written in the one form the Seedance guide singles out as harmful.
            # Measured over BLOOM's 40 boards / 148 panels BEFORE this line existed: 95
            # panels carried a negative clause, 146 occurrences, and the whole top of the
            # distribution is one shape — "Locked static, no camera motion" ×5, "No
            # movement, held static pose" ×3, "No moving elements present" ×3. Every one of
            # those is a locked-off frame asked for by naming the motion it must not have.
            + f"{_POSITIVE_ONLY}\n"
            # Acting, in the phase that draws the faces. The panel `desc` is what the board
            # renders and what phase 5 translates, so a beat written as a process ("reaches
            # in, pulls out, winds up") loses the moment twice.
            + f"{_ACTING_BEAT_RULES}\n"
            + "Return the SAME JSON array you are given (no fences), every beat's content filled, "
            "same length and order. Return ONLY valid, COMPLETE JSON — do not truncate."
        )

        user = (
            f"SCENE: {scene_heading}\n"
            # THE FLOOR PLAN, pasted WITHOUT CHANGES. It sits in the USER half like the two
            # carries below — it is data, not instruction (the rule that reads it is in the
            # system half) — but unlike them it is a per-SCENE constant, so the shots of one
            # scene receive the identical bytes here. That is the whole claim: nothing has
            # to be declared correctly for the next shot to get the same map.
            + (f"{geo_layout.strip()}\n" if geo_layout.strip() else "")
            # The one piece of state that crosses the board boundary. It goes in the USER
            # message, not the system prompt, because it is DATA that changes per shot —
            # the system half is cached (cache_control ephemeral on the Claude path) and
            # must stay identical across the shots of a scene.
            + (f"CARRIED SCREEN AXIS (established by the PREVIOUS shot of this scene — "
               f"inherit it): {prev_screen_side}\n" if prev_screen_side else "")
            # The other piece of state that crosses the board boundary, in the USER half
            # for the same reason: it is per-shot DATA and the system half is cached.
            + (f"CARRIED SET STATE (left standing by the PREVIOUS shot of this scene — "
               f"inherit it verbatim): {prev_leaves_behind}\n" if prev_leaves_behind else "")
            # WHERE THE PEOPLE ARE IN THE ROOM, which the two carries above cannot say: one
            # is normalised to left/right and the other excludes figures on purpose. This is
            # what a reverse angle is allowed to mirror and a person is not allowed to obey.
            + (f"CARRIED BLOCKING — where each person STANDS IN THE ROOM, established by the "
               f"PREVIOUS shot of this scene: {prev_anchored}\n"
               f"They have NOT moved. Your camera may cross to the other side and see them "
               f"from a new angle — that mirrors the FRAME, never the room. Nobody changes "
               f"which side of a piece of furniture they are on unless the written action "
               f"moves them there, and when it does, say so in \"anchored\".\n"
               if prev_anchored else "")
            # THE SEAM (HELL GRIND rule 2's second half, quoted): "If the shot is an answer
            # to the previous one, feed the tail of the previous clip's line into that first
            # second — then the actor answers the right thing in the right tone, and the two
            # clips glue at the seam." Only ever present on the opening wide, and only when
            # the material before this scene actually ended on a line.
            + (f"THE LINE THIS SCENE ANSWERS (spoken just before the scene starts, NOT "
               f"spoken again — beat {opening_label} opens on its tail still hanging in the "
               f"air, and the arrangement is the reaction to it): {opening_tail.strip()}\n"
               if (opening_label and opening_tail.strip()) else "")
            + "SHOTS (context for filling the beats):\n"
            + "\n".join(shot_lines)
            + "\n\nBEATS TO FILL (return this SAME array with content completed, keeping every "
            "label and time exactly):\n" + _json.dumps(skeleton, ensure_ascii=False)
        )

        # Seed-first with the Claude fallback, the same route the bible, the script, the
        # breakdown and the three sheet prompts already take. This was the LAST generative
        # step still pinned to Anthropic, and the failure mode was invisible: with that
        # account out of credit the beat writer raised, _assemble_storyboard swallowed it
        # (server.py:4386) and returned ONE flat panel per shot, the endpoint answered 200,
        # and BLOOM boarded 41/41 segments with zero beats — no time ranges, no framing,
        # lighting or emotion annotations, and none of the FOV/Kelvin numbers phase 5 reads.
        # Every layer reported success.
        def _call(max_toks: int) -> str:
            return self._text_llm(system, user, max_tokens=max_toks, temperature=0.5)

        # Truncation guard: a max_tokens stop cuts the JSON mid-string, so the parse is the
        # detector — _text_llm returns a plain string and has no stop_reason to read.
        def _strip(t: str) -> str:
            t = (t or "").strip()
            if t.startswith("```"):
                t = t.split("\n", 1)[1] if "\n" in t else t[3:]
            if t.endswith("```"):
                t = t.rsplit("```", 1)[0]
            return t.strip()

        try:
            panels = _json.loads(_strip(_call(4096)))
        except Exception:
            logger.warning("[Storyboard] beats truncated/invalid at 4096 — retrying at 8192")
            try:
                panels = _json.loads(_strip(_call(8192)))
            except Exception as e:
                raise RuntimeError(
                    f"Storyboard beats came back unparseable at 8192 tokens ({e}). "
                    "Split the scene into fewer shots (shorter scenes) and retry."
                ) from None
        if not isinstance(panels, list) or not panels:
            raise ValueError("Storyboard panel generation returned no panels")
        # Guard: enforce the skeleton. The model can still drop or rename beats, so re-key
        # by label and pad any missing beat from the skeleton — every shot keeps its full
        # computed 4-8 beats with the fixed time ranges.
        by_label = {p.get("label"): p for p in panels if isinstance(p, dict) and p.get("label")}
        out: list[dict] = []
        for skel in skeleton:
            p = by_label.get(skel["label"])
            if isinstance(p, dict):
                p["label"], p["time"] = skel["label"], skel["time"]   # enforce the fixed fields
                # screen_side is the model's to fill, but its PRESENCE is not optional: the
                # axis gate reads this key, and a key that may or may not be there is a
                # check that may or may not run. Absent → "" → read as "not declared".
                p.setdefault("screen_side", "")
                # Same contract for the crossing declaration, and the default MATTERS in a
                # way screen_side's does not: absent means "pre-2026-08-05 board, judge it
                # by the old prose heuristic" (see _beat_crossing). A beat this writer just
                # produced is never that, so it always carries an explicit boolean —
                # missing = the writer claimed no crossing = a flip here is a break.
                p["crossing"] = _as_bool(p.get("crossing"))
                # Same contract, same reasons, for the set-state pair: the key's PRESENCE
                # is what makes check_object_continuity runnable at all, and an explicit
                # state_change boolean is what tells _beat_declares_state_change apart
                # from a pre-2026-08-05 board (which has no such key anywhere).
                p.setdefault("leaves_behind", "")
                p["state_change"] = _as_bool(p.get("state_change"))
                out.append(p)
            else:
                out.append({**skel, "name": skel["label"].rsplit("-", 1)[-1],
                            "desc": "The action continues through this beat."})

        # WHO GOT NAMED WITHOUT A FACE. The rule above tells the writer not to; this
        # reports when it did anyway, because the consequence is silent and expensive —
        # the render invents that person, the board is approved with them in it, and
        # stage 5 then animates the stranger. Reported, never repaired: dropping a name
        # from a beat would break the blocking that references it, and the fix belongs
        # upstream (attach them in the breakdown) where a human can see it.
        try:
            import re as _re_nm
            _have = {str(a.get("name") or "").strip()
                     for s in (shots or []) for a in (s.get("assets") or [])
                     if str(a.get("type") or "").lower() == "character" and a.get("name")}
            _base = {n.split(" · ")[0] for n in _have}
            _txt = " ".join(f"{p.get('desc', '')} {p.get('screen_side', '')}" for p in out)
            _ghosts = sorted({
                n for n in (cast_names or [])
                if n and n.split(" · ")[0] not in _base
                and _re_nm.search(r'\b' + _re_nm.escape(n.split(" · ")[0]) + r'\b', _txt)
            })
            if _ghosts:
                logger.warning("[Storyboard] %s: beats name %s, and no reference is sent for "
                               "them — the render will invent those faces. Attach them to the "
                               "shot in stage 2 if they are really in frame.",
                               scene_heading[:40], ", ".join(_ghosts))
        except Exception:
            pass   # a diagnostic must never break board generation
        return out

    # ── Stage 4: Storyboard QC — Camera Director gate ────────────────────────

    def qc_storyboard(
        self,
        scene_heading: str,
        panels: list[dict],
        shots: list[dict],
        vision_observations: dict | None = None,
    ) -> dict[str, Any]:
        vision_section = ""
        if vision_observations:
            vision_section = f"""
RENDERED BOARD ANALYSIS (ModelArk vision — the ACTUAL pixels across ALL panels):
  Render style: {vision_observations.get('render_style', 'unknown')}
  VISUAL DRIFT: {vision_observations.get('drift', 'not analyzed')}
  Continuity notes: {vision_observations.get('observations', '')}"""
        # The declared axis rides WITH the panel line: the judge was being asked about
        # "screen direction" while seeing only the prose desc. A board written before
        # screen_side existed has none, and the prompt is then exactly what it was.
        panel_lines = "\n".join(
            f'  {p.get("label")}: {p.get("desc")}'
            + (f'  [screen_side: {p.get("screen_side")}]' if p.get("screen_side") else "")
            # The beat's own answer to "did you MEAN to swap them?". Only printed when the
            # beat declared it — a pre-2026-08-05 board has no such key and its panel line
            # is byte-identical to what it was.
            + ("  [crossing: the figures pass each other IN FRAME here]"
               if _as_bool(p.get("crossing")) else "")
            # What the beat says it LEAVES STANDING, and whether it means to change it.
            # Same reason as screen_side: the judge was being asked about continuity while
            # seeing only prose. Only printed when declared, so a pre-2026-08-05 board's
            # panel line is byte-identical to what it was.
            + (f'  [leaves_behind: {p.get("leaves_behind")}]' if p.get("leaves_behind") else "")
            + ("  [state_change: an object or an outfit visibly changes IN FRAME here]"
               if _as_bool(p.get("state_change")) else "")
            for p in panels[:16]
        )
        shot_lines = "\n".join(
            f'  {s.get("id")}: {s.get("action", "")} [{s.get("cameraAngle") or "?"}]' for s in shots[:16]
        )
        # The judge's reading rule for the set-state declarations, added ONLY when a panel
        # actually carries one. It is conditional, not static, so a board written before
        # leaves_behind existed gets a prompt that is byte-identical to today's — the
        # `crossing` clause below is static and every legacy board pays for it. Without the
        # clause the judge does to a DECLARED move what it used to do to a declared
        # crossing: report the action itself as the defect.
        estado_clause = ""
        if any(p.get("leaves_behind") or _as_bool(p.get("state_change")) for p in panels[:16]):
            estado_clause = (
                "\n- \"Object & wardrobe continuity\": each panel's [leaves_behind: ...] is what that "
                "panel LEAVES STANDING — where each prop is and how each character is dressed. "
                "It must persist into the panels after it: a plate set on a table is still on the "
                "table, hair stays as it was. A panel marked [state_change: ...] has DECLARED that "
                "the change is the action (a hand sets it down, ties the hair, takes the coat off) "
                "— do NOT report that one as a defect, nor the panel right after it. Report a break "
                "only when something placed or worn changes or disappears with no panel showing it "
                "happen.")
        prompt = f"""Review this scene storyboard against its shot breakdown.

SCENE: {scene_heading}
PANELS:
{panel_lines}
SHOTS (source of truth):
{shot_lines}
{vision_section}

Checks:
- "Coverage": Does every shot have a panel (two beats for long shots)?
- "Action fidelity": Does each panel depict its shot's scripted action?
- "Camera language": Do panel framings honor each shot's camera instruction?
- "Continuity": Do consecutive panels cut together (180° rule, eyelines, screen direction)?
  A CROSSING IS NOT A 180 BREAK. Two figures who walk PAST each other in a locked-off frame
  DO exchange sides — that is the action playing out, and a panel marked [crossing: ...]
  has declared exactly that. Do NOT report it as a screen-direction defect. The pass happens
  DURING the marked panel, so the marked panel still shows the sides they start on and the
  swap is first visible in the panel AFTER it — that following panel is covered by the same
  declaration and is not a defect either. Report a 180 break only when a figure is on the
  OTHER side with no pass, no exit-and-re-enter and no camera move to explain it — i.e. the
  geometry changed but nothing on screen moved.
- "Visual continuity": TRUST the RENDERED BOARD ANALYSIS above — if VISUAL DRIFT reports a
  concrete face/identity, wardrobe or render-style change across panels, that is a GENUINE
  blocking defect: fail this check and name it in regen_prompt. "none" / "consistent" = clean.
- "Readability": Are poses/blocking clear enough to steer keyframe composition?{estado_clause}"""
        # Storyboard QC reviews many panels — 1024 truncates the JSON (advisory
        # parse errors). 2048 fits the checks array + summary.
        #
        # _run routes through _qc_complete: Seed 2.0 Pro FIRST (BytePlus billing), Claude
        # only as fallback, so this gate already runs with no Anthropic key — measured
        # 2026-08-04 with ANTHROPIC_API_KEY unset: it reached seed-2-0-pro-260328 and
        # returned the same {passed, checks, summary, regen_prompt, persona}. Do NOT
        # "free" it by moving it to _text_llm: that path loses the camera-director skill
        # file AND the response_format=json_object this JSON verdict depends on.
        result = self._run(prompt, "camera_director", max_tokens=2048)
        # The DETERMINISTIC half of the same gate. The LLM check "Continuity" already
        # names the 180° rule, but it judges it from prose and the boards it judged carry
        # no geometry to judge (488 beats on disk, 0 declaring a side), so BLOOM's
        # SHOT_004 flip shipped. Screen direction is geometry, not taste: read it off what
        # each beat DECLARES. Prepended like qc_breakdown's objective checks, and a
        # deterministic failure is not overridable by an opinion. No beat declaring a side
        # → no check → the response is exactly today's.
        # Two deterministic gates, same shape, different axis: where the figures are, and
        # what they left standing. Both return [] when nothing declares their field, so a
        # board that predates either one produces exactly today's response.
        det_checks = check_screen_direction(panels) + check_object_continuity(panels)
        if det_checks:
            checks = det_checks + list(result.get("checks") or [])
            result["checks"] = checks
            result["passed"] = all(c.get("passed") for c in checks)
            # Scene Review renders the badge (label + Pass/Fail) and the SUMMARY; it never
            # renders a check's notes (QCResultBadge.tsx). A red "Screen direction" badge
            # with the reason parked in a field nothing displays is a finding nobody can
            # act on, so the reason goes where the director will actually read it.
            roto = next((c for c in det_checks if not c.get("passed")), None)
            if roto:
                result["summary"] = f"{roto['notes']} — {result.get('summary') or ''}".strip(" —")
        return result

    # ── Stage 1: Script — Film Director gate ──────────────────────────────────

    def qc_script(self, script: str, concept: str) -> dict[str, Any]:
        prompt = f"""Review this screenplay.

ORIGINAL CONCEPT:
{concept[:500]}

SCRIPT (first 2000 chars):
{script[:2000]}

Checks:
- "Tone match": Does the script match the concept's intended tone and genre?
- "Pacing": Is scene pacing and runtime distribution cinematically sound?
- "Continuity": Are character names and locations consistent throughout?
- "Visual potential": Can these scenes be compellingly visualized with AI generation?
- "Emotional arc": Does the story build and resolve emotionally?"""
        return self._run(prompt, "film_director")

    # ── Stage 2: Breakdown — Producer gate ───────────────────────────────────

    def qc_breakdown(self, breakdown: dict, script: str, target_secs: int = 0,
                     deterministic_only: bool = False,
                     max_call_secs: float = SEGMENT_MAX_SECS) -> dict[str, Any]:
        """QC the breakdown. OBJECTIVE checks (asset types valid, asset-shot links
        valid, shot count) are computed in CODE — LLMs are unreliable at exhaustive
        verification and, when the data isn't in the prompt, default to FAIL (the old
        prompt sent only asset NAMES, so "Asset types" always failed with "no types
        provided"). The LLM judges ONLY the subjective checks (completeness against the
        script, continuity), WITH the data it needs.

        `max_call_secs` is WHAT ONE SEEDANCE CALL CAN RENDER, and it is a parameter for the
        same reason `_group_into_segments`, `generate_breakdown` and the batch prompt take
        one: the number belongs to the model the project chose, and the module constant is
        only its 2.0 default. This was the last function of that family still reading the
        constant, and the cost was exact — from the day 2.5 landed (2026-08-07) every
        breakdown planned for it failed here. The planner is handed 30s
        (server.py: `model_caps(...)["max_duration"]`) because a long take is the whole
        point of 2.5; this then called the 17s and 20.5s takes it planned illegal, twice,
        with two BLOCKING checks. Measured: DryRUN 11 of 19 segments, and its stage 2 is
        approved anyway — the user had been overriding a verdict about a limit that did
        not apply. BLOOM is the control: also 2.5, but planned before the 30s ceiling
        existed, no segment over 15s, passes.

        Both ceilings below are this one number. A segment IS a call, and a shot alone in
        its segment is also a call, so nothing here can legitimately exceed it. Defaulted
        to the 2.0 constant, so a caller that does not pass it scores exactly what it
        scored before."""
        assets = breakdown.get("assets", [])
        shots = breakdown.get("shots", [])
        asset_ids = {a.get("id") for a in assets if a.get("id")}

        # The breakdown reaches this QC in TWO shapes: raw from the generator
        # (snake_case) and normalised by the frontend (camelCase, where duration_sec
        # became estimatedDuration and assets_used became assetsUsed). Reading only one
        # spelling is why the asset-shot link check has been passing vacuously on every
        # call from the UI — it looked for a key that was not there and found nothing
        # to complain about.
        def _f(d: dict, *names, default=None):
            for n in names:
                if d.get(n) not in (None, ""):
                    return d[n]
            return default

        def _dur(sh: dict) -> float:
            try:
                return float(_f(sh, "duration_sec", "estimatedDuration", default=0) or 0)
            except (TypeError, ValueError):
                return 0.0

        def _used(sh: dict) -> list:
            return _f(sh, "assets_used", "assetsUsed", default=[]) or []

        def _scene(sh: dict):
            return _f(sh, "scene_id", "sceneId", "scene")

        def _cam(sh: dict) -> str:
            return str(_f(sh, "camera", "cameraAngle", default="") or "")
        # "voice" joined the vocabulary 2026-08-15: a speaker with no body on screen.
        # It is a first-class asset (it holds dialogue and needs casting) that is never
        # rendered as an image — see the classification rule in the breakdown prompt.
        valid_types = {"character", "voice", "prop", "wardrobe", "environment", "vfx", "fx"}

        # ── Deterministic checks ──
        bad_types = [a.get("name") or a.get("id") for a in assets if a.get("type") not in valid_types]
        broken_links = sorted({s.get("id") for s in shots
                               for u in _used(s) if u not in asset_ids})
        # The shared Σ, not a fourth hand-written one: this is the number the Runtime
        # gate below compares against the target, and it has to be the same arithmetic
        # phase 1 reconciles a script with (estimate_shots_seconds reads both spellings
        # of the field, exactly as _dur does).
        total_secs = int(estimate_shots_seconds(shots))
        det_checks = [
            {"label": "Asset types", "passed": not bad_types, "blocking": True,
             "notes": "All assets have a valid type." if not bad_types
                      else f"Invalid/missing type on: {', '.join(map(str, bad_types[:6]))}"},
            {"label": "Asset-shot links", "passed": not broken_links, "blocking": True,
             "notes": "Every shot references assets that exist." if not broken_links
                      else f"Shots referencing missing assets: {', '.join(broken_links[:6])}"},
            {"label": "Shot count", "passed": len(shots) > 0, "blocking": True,
             "notes": f"{len(shots)} shots ≈ {total_secs}s runtime." if shots else "No shots produced."},
        ]

        # Coverage, judged WITHIN each scene — a run of three matching sizes only means
        # something inside one continuous piece of action, not across a whole episode.
        by_scene: dict[str, list[dict]] = {}
        for s in shots:
            by_scene.setdefault(str(_scene(s) or ""), []).append(s)
        cov: list[str] = []
        for scene, group in by_scene.items():
            for f in analyze_coverage(group):
                cov.append(f"{scene or '?'}: {f['detail']}")
        # Σ durations against the target. The badge in the UI has always shown this
        # number; nothing ever compared it to what was asked for, so a breakdown could
        # come back at half the requested runtime and pass.
        if target_secs:
            drift = abs(total_secs - target_secs) / target_secs
            det_checks.append({
                "label": "Runtime", "passed": drift <= 0.15, "blocking": False,
                "notes": f"{total_secs}s against a {target_secs}s target ({drift*100:.0f}% off)."
                         + ("" if drift <= 0.15 else " Re-balance the shot durations."),
            })

        # Every speaker must resolve to a real character asset. A dialogue line whose
        # characterId points at nothing has no voice anchor, so the line is either
        # spoken in a default voice or silently dropped at render time — and nothing
        # upstream notices, because assets_used is what gets validated, not dialogue.
        speakers = {d.get("characterId") for s in shots for d in (s.get("dialogue") or [])
                    if isinstance(d, dict) and d.get("characterId")}
        unresolved = sorted(sp for sp in speakers if sp not in asset_ids)
        det_checks.append({
            "label": "Speakers", "passed": not unresolved, "blocking": True,
            "notes": f"{len(speakers)} speaker(s), all resolved." if not unresolved
                     else f"Dialogue assigned to non-existent characters: {', '.join(map(str, unresolved[:6]))}",
        })

        # NOTHING THE FILM SAYS MAY BE SOMETHING THE WRITER DID NOT WRITE. The user's
        # rule, and the one direction of it that can be measured on every script format in
        # the tree — see dialogue_invention for why it aligns words against the whole
        # script rather than counting lines against the cue reader.
        #
        # BLOCKING, and it is the same line "Cast matches the script" is drawn on: this is
        # not a judgement about the writing, it is two documents disagreeing about what
        # comes out of an actor's mouth, and the render turns it into a paid, spoken
        # deliverable. Advisory would have been the softer call, but a breakdown that
        # doubles the dialogue used to pass with `covered: True` — the QC has been silent
        # about invention for as long as it has existed, and silence is what got us here.
        # The escape hatch is the one every other blocking check has: Override & Approve.
        #
        # Corpus check before shipping it as blocking: of the 15 projects on this machine,
        # 13 report zero added words — including every case that defeated the strict
        # readings (a merge, a split, a Spanish markdown treatment, a hard-wrapped
        # screenplay). The two that fire are `différent` for "different" and a duplicated
        # "DIE!". A gate that fires twice in fifteen films, on two real defects, is
        # calibrated.
        if (script or "").strip():
            _inv = dialogue_invention(script, shots)
            _added = _inv["added"]
            # THE SILENT FILM. With no dialogue at all the alignment has nothing to say,
            # and "nothing to say" was reading as consent: DRAMA QUEEN 2 and DRAMA QUEEN
            # both sit on a breakdown carrying ZERO spoken words for scripts that are
            # almost entirely argument. This is the one case where the cue reader can be
            # trusted as a precondition rather than as a measurement — it is not asked
            # WHICH lines are missing (it is wrong about that on three script formats),
            # only whether the script speaks at all.
            _script_lines = (0 if _inv["dialogue_words"]
                             else dialogue_coverage(script, shots)["script_lines"])
            if _script_lines:
                det_checks.append({
                    "label": "Dialogue fidelity", "passed": False, "blocking": True,
                    "notes": (f"the breakdown carries NO dialogue at all, and the script "
                              f"has {_script_lines} spoken line(s). The film would be "
                              f"silent."),
                })
            elif _inv["dialogue_words"]:
                det_checks.append({
                    "label": "Dialogue fidelity", "passed": not _added, "blocking": True,
                    "notes": (f"all {_inv['dialogue_words']} spoken word(s) are the "
                              f"script's." if not _added else
                              f"{len(_added)} spoken word(s) are not in the script "
                              f"({_inv['dialogue_words']} spoken, script has "
                              f"{_inv['script_words']}): "
                              + " ".join(_added[:12])
                              + (" …" if len(_added) > 12 else "")
                              + ". A repeated line counts here too — the film would say "
                                "it twice."),
                })

        # WHOEVER SPEAKS IN A SHOT IS PROBABLY IN IT — and often is not attached to it.
        # "Speakers" above proves the id EXISTS; nobody asked whether the person it names
        # is among the shot's own assets, which is what decides whether their face is sent
        # to the board and to the render. Measured across the 20 projects on this machine:
        # 25 shots speak with a voice they do not attach — GLADIATOR II's SHOT_030/031/036
        # among them, where Jugurtha and Lucius talk to each other and only one of the two
        # carries a face.
        #
        # ADVISORY, and it will stay advisory: a line can legitimately be spoken from OFF
        # SCREEN — an Archon hologram, an electronic voice, a shout from beyond the wall —
        # and `dialogue[]` carries no O.S./V.O. marker to tell the two apart. An automatic
        # attach would put the off-screen speaker IN FRAME, which is the exact defect this
        # check exists to find. So it reports and lets a human decide. (The room a scene
        # happens in has no such ambiguity, which is why THAT one repairs itself.)
        _cast_ids = {str(a.get("id")) for a in assets
                     if str(a.get("type") or "").lower() == "character" and a.get("id")}
        # A WARDROBE VARIANT IS THE SAME PERSON. The check compared raw ids, so a shot
        # that attaches "Michael · in crisis briefing" (a variant, parentCharacterId →
        # the base) while the line names the base read as a speaker out of frame. The
        # writer is right on both counts — dialogue belongs to the person, the frame
        # holds the look — so the comparison, not the breakdown, was wrong: BLACK MIRROR
        # 2026-08-15 raised 5 of these (SHOT_029/032/034/037/041) and every one was the
        # app's own wardrobe feature. Both sides collapse to the base identity first.
        _base_of = {str(a.get("id")): str(a.get("parentCharacterId") or a.get("id"))
                    for a in assets if a.get("id")}
        _root = lambda i: _base_of.get(str(i), str(i))  # noqa: E731
        _mute: list[str] = []
        for _sh in (shots or []):
            _attached = {_root(i) for i in _used(_sh)}
            for _d in (_sh.get("dialogue") or []):
                _cid = str((_d or {}).get("characterId") or (_d or {}).get("character_id") or "")
                if _cid and _cid in _cast_ids and _root(_cid) not in _attached:
                    _mute.append(str(_sh.get("id")))
                    break
        if _cast_ids:
            det_checks.append({
                "label": "Speaker in frame", "passed": not _mute, "blocking": False,
                "notes": ("every speaking character is attached to the shot that speaks."
                          if not _mute else
                          f"{len(_mute)} shot(s) carry a line from a character the shot does "
                          f"not attach, so no face is sent for them: "
                          + ", ".join(_mute[:6]) + (" …" if len(_mute) > 6 else "")
                          + ". Attach them if they are on screen; ignore if the line is off-screen."),
            })

        # WHOSE FACE IS INSIDE THIS OBJECT. An asset whose own words make it a container
        # for a likeness — a photograph, a screen, a portrait — and that declares nobody
        # in depends_on will be rendered from its description alone, and whoever appears
        # in it is invented. The scan in _link_depicted_assets fills the ones that NAME
        # someone; this reports the ones that do not, which are exactly the cases only a
        # human can settle ("hostage video feed" is Susannah; "security monitor showing
        # an empty corridor" is nobody). Advisory: plenty of screens show no one at all.
        # Bound HERE and not borrowed from the import further down this same function:
        # a function-local `import re` makes the name local to the WHOLE function, so
        # reading it above the import statement is an UnboundLocalError at runtime, not
        # a compile error. py_compile passes on it. (Caught 2026-08-15.)
        import re   # module-local, as everywhere else in this file
        _orphan_depictions = [
            f"{a.get('name') or a.get('id')}"
            for a in assets
            if str(a.get("type") or "").lower() not in {"character", "voice", "environment"}
            and not (a.get("depends_on") or a.get("dependsOn"))
            and any(re.search(r'\b' + w + r'\b',
                              f"{a.get('name') or ''} {a.get('visual_description') or ''}".lower())
                    for w in _DEPICTION_WORDS)
        ]
        if _orphan_depictions:
            det_checks.append({
                "label": "Depicted identities", "passed": False, "blocking": False,
                "notes": (f"{len(_orphan_depictions)} asset(s) depict something on their surface "
                          f"but name nobody in depends_on, so any person inside them will be "
                          f"invented: " + ", ".join(_orphan_depictions[:6])
                          + (" …" if len(_orphan_depictions) > 6 else "")
                          + ". Add the character ids they show; leave empty if they show no one."),
            })

        # THE ROOM EACH SHOT HAPPENS IN. "Asset-shot links" above checks that the ids a
        # shot names EXIST; nothing asked the opposite question — whether a shot in a
        # scene names the place that scene happens in. It is the same one-directional
        # blindness as the dialogue check, and it cost a visibly different kitchen on one
        # board of a four-board scene (DRAMA QUEEN 3, SHOT_003, 2026-08-14): the board
        # endpoint reserves its two environment slots from the SHOT's own asset list, so a
        # shot that does not name the room is drawn with no room reference at all.
        #
        # ADVISORY, deliberately. An insert of a prop on a table, a title card or a black
        # frame legitimately has no location, and this must not stop a run over one. Both
        # halves of the repair are elsewhere — the breakdown links them at source now, and
        # the board endpoint inherits the scene's room for breakdowns already on disk —
        # so by the time this fires it is reporting a breakdown the user can still edit,
        # not a render that already went out wrong.
        _envs = {str(a.get("id")) for a in assets
                 if str(a.get("type") or "").lower() == "environment" and a.get("id")}
        if _envs and shots:
            _by_scene: dict[str, list[str]] = {}
            for _sh in shots:
                _sc = str(_scene(_sh) or "")
                if _sc:
                    _by_scene.setdefault(_sc, []).append(_sh)
            _roomless: list[str] = []
            for _sc, _shs in _by_scene.items():
                # Only scenes that HAVE a room to be missing: a scene where no shot names
                # one is a different finding (no environment asset at all), and
                # _ensure_scene_environments is what answers for it.
                if not any(_envs & set(map(str, _used(_s))) for _s in _shs):
                    continue
                _roomless += [str(_s.get("id")) for _s in _shs
                              if not (_envs & set(map(str, _used(_s))))]
            det_checks.append({
                "label": "Scene continuity", "passed": not _roomless, "blocking": False,
                "notes": ("every shot names the location its scene happens in."
                          if not _roomless else
                          f"{len(_roomless)} shot(s) do not reference their scene's "
                          f"environment, so their boards are drawn with no room: "
                          + ", ".join(_roomless[:6])
                          + (" …" if len(_roomless) > 6 else "")),
            })

        # Every RENDER inside Seedance's range. [4,15] is the range of a CALL, and a call
        # is a segment — so a shot that SHARES a segment is allowed to be short. Judging
        # every shot against the 4s floor would fail a breakdown for doing exactly what
        # the prompt now asks of it (a 1.5s insert), and this check is blocking: it would
        # have killed every unattended autopilot run at stage 2.
        in_multi: set = set()
        for seg in (breakdown.get("segments") or []):
            subs = seg.get("shots") or []
            if len(subs) > 1:
                in_multi.update(str(x.get("id")) for x in subs if x.get("id"))
        floor = SHOT_MIN_IN_SEGMENT if in_multi else SHOT_MIN_SECS
        # The CEILING is max_call_secs, not SHOT_MAX_SECS, and the difference is not
        # pedantry: once a breakdown has segments, the `shots` this check receives from the
        # UI is the FLAT PROJECTION — one entry per SEGMENT, carrying the segment's total
        # (frontend lib/segments.ts: "the flat projection carries ONE ENTRY PER SEGMENT").
        # So a 17s take was measured here against a lone shot's 15s and again below against
        # the segment's, and failed twice for the same legal length.
        out_of_range = [s.get("id") for s in shots
                        if not ((SHOT_MIN_IN_SEGMENT if str(s.get("id")) in in_multi
                                 else SHOT_MIN_SECS) <= _dur(s) <= max_call_secs)]
        det_checks.append({
            "label": "Shot durations", "passed": not out_of_range, "blocking": True,
            "notes": (f"all within range ({floor}-{max_call_secs:g}s; "
                      f"{len(in_multi)} shot(s) share a segment and may be short)."
                      if not out_of_range
                      else f"Out of range for a {max_call_secs:g}s call: "
                           f"{', '.join(map(str, out_of_range[:6]))}"),
        })
        # And the SEGMENTS themselves — the thing that is actually submitted.
        seg_bad = [seg.get("id") for seg in (breakdown.get("segments") or [])
                   if not (SEGMENT_MIN_SECS
                           <= sum(float(x.get("duration_sec") or x.get("durationSecs") or 0)
                                  for x in (seg.get("shots") or []))
                           <= max_call_secs)]
        if breakdown.get("segments"):
            det_checks.append({
                "label": "Segment length", "passed": not seg_bad, "blocking": True,
                "notes": (f"every segment is {SEGMENT_MIN_SECS}-{max_call_secs:g}s."
                          if not seg_bad
                          else f"Outside {SEGMENT_MIN_SECS}-{max_call_secs:g}s — the API "
                               f"rejects these: {', '.join(map(str, seg_bad[:6]))}"),
            })

        # Física del estado: nadie sigue congelado junto a una estufa encendida.
        det_checks.extend(check_state_physics(shots, assets))

        # Did the breakdown cover the whole script? Count the slug lines and compare
        # with the scenes that came back — a batch that silently failed shows up here
        # as missing scenes rather than as a shorter film nobody noticed.
        import re as _re_sc
        slug_lines = _re_sc.findall(r"^\s*(?:INT\.|EXT\.|INT/EXT\.)[^\n]*", script or "",
                                    _re_sc.M | _re_sc.I)
        # A slug ending in CONTINUOUS continues the scene above it — that is what the
        # word means in a screenplay. Counting raw slug lines called a nine-slug
        # single-location sequence "nine scenes" and failed a perfectly normal script,
        # which is the worst kind of gate: one that fires on correct output.
        expected_scenes = 0
        for line in slug_lines:
            if not _re_sc.search(r"\bCONTINUOUS\b|\bSAME\b|\bLATER\b", line, _re_sc.I):
                expected_scenes += 1
        expected_scenes = max(expected_scenes, 1) if slug_lines else 0
        got_scenes = len({_scene(s) for s in shots if _scene(s)})
        if expected_scenes:
            det_checks.append({
                "label": "Scene coverage", "passed": got_scenes >= expected_scenes * 0.8,
                "blocking": True,
                "notes": f"{got_scenes} scene(s) broken down from {expected_scenes} in the script."
                         + ("" if got_scenes >= expected_scenes * 0.8
                            else " Scenes are missing — a batch may have failed."),
            })

        det_checks.append({
            "label": "Coverage", "passed": not cov, "blocking": False,
            "notes": "Shot sizes vary and the cut has a rhythm." if not cov
                     else " · ".join(cov[:4]) + (f" (+{len(cov) - 4} more)" if len(cov) > 4 else ""),
        })

        # ── Subjective checks via the LLM — WITH the asset types + more script ──
        asset_lines = "; ".join(f"{a.get('name')} ({a.get('type')})" for a in assets) or "(none)"
        n_scenes = len({s.get("scene") for s in shots if s.get("scene")})
        prompt = f"""Review this production breakdown for COMPLETENESS and CONTINUITY only.
Structural validity (types, links, counts) is already verified separately — do NOT re-check those.

ASSETS ({len(assets)}) with types: {asset_lines[:4000]}
SHOTS: {len(shots)} across {n_scenes} scene(s), ~{total_secs}s total runtime.

SCRIPT:
{script[:8000]}

Return JSON with EXACTLY these two checks (labels verbatim):
- "Completeness": Are all key characters, props and environments that appear in the script present in the asset list above?
- "Continuity risk": Any elements likely to break cross-shot continuity (a character described inconsistently, an environment that won't cut together)?"""
        if deterministic_only:
            # Autopilot's gate. Everything that BLOCKS an unattended run is arithmetic,
            # so the subjective pass is a paid LLM round-trip that cannot change the
            # outcome — and putting one in the middle of a 500-shot run just adds a
            # failure mode. A human reviewing the breakdown still gets the full pass.
            passed_d = all(c.get("passed") for c in det_checks)
            return {"passed": passed_d, "checks": det_checks,
                    "summary": "Structural checks only." if passed_d
                               else "Breakdown flagged — see checks.",
                    "regen_prompt": None, "persona": "Producer"}
        try:
            llm = self._run(prompt, "producer")
        except Exception as e:
            logger.warning("[QC] breakdown subjective pass failed (%s) — objective checks only", e)
            llm = {"checks": [], "summary": "", "regen_prompt": None}
        wanted = {"completeness", "continuity risk"}
        subj = [c for c in llm.get("checks", []) if str(c.get("label", "")).strip().lower() in wanted]

        checks = det_checks + subj
        passed = all(c.get("passed") for c in checks)
        summary = llm.get("summary") or (
            "Breakdown is structurally valid and complete." if passed
            else "Breakdown flagged — see checks.")
        return {"passed": passed, "checks": checks, "summary": summary,
                "regen_prompt": llm.get("regen_prompt") if not passed else None,
                "persona": "Producer"}

    # ── Stage 3: Asset QC — Art Director gate ─────────────────────────────────

    def qc_asset(self, asset: dict, image_url: str | None) -> dict[str, Any]:
        prompt = f"""Review this generated asset for production quality.

ASSET: {asset.get('name')} ({asset.get('type')})
DESCRIPTION: {asset.get('visual_description', '')}
IMAGE URL: {image_url or 'not yet generated'}

Checks:
- "Design quality": Is the design specific, distinctive, and production-ready?
- "Palette discipline": Is the color palette cohesive and cinematically appropriate?
- "Silhouette": Is the silhouette immediately readable as this character/prop?
- "Style consistency": Will this asset look consistent when regenerated across shots?
- "Production fit": Does this design fit a professional film/TV production?"""
        return self._run(prompt, "art_director")

    def qc_asset_vision(
        self,
        asset: dict,
        image_url: str | None,
        vision_observations: dict | None,
        drift_score: float | None,
        style_label: str = "cinematic",
        drift_calibrated: bool = False,
    ) -> dict[str, Any]:
        """P4: Enhanced asset QC using vision analysis + style-drift score. Art Director gate.

        `drift_calibrated` says WHICH measurement produced `drift_score`. With style
        anchor images it is an image↔image cosine and the 55% threshold means something.
        Without them compute_style_drift falls back to a text↔image cosine that its own
        docstring calls "uncalibrated as a percentage" — and a normal cross-modal cosine
        on this platform sits near 0.35 (ARCHITECTURE.md), i.e. ~0.65 "drift" for a
        perfectly on-style image. Thresholding THAT number fails everything: measured
        2026-08-15 on BLACK MIRROR, a plasma screen and a character sheet both scored
        0.76 with all four artistic checks green, and the endpoint had been passing
        `None` for anchors since it was written — so no asset had ever passed this gate.
        A gate that always fails is a gate the user learns to override.
        """
        vision_section = ""
        if vision_observations:
            vision_section = f"""
VISION ANALYSIS:
  Dominant palette: {vision_observations.get('dominant_palette', 'unknown')}
  Lighting: {vision_observations.get('lighting', 'unknown')}
  Render style: {vision_observations.get('render_style', 'unknown')}
  Observations: {vision_observations.get('observations', '')}"""

        drift_section = ""
        drift_check = ('- "Drift": Is style drift acceptable (< 55%)? HIGH drift MUST fail.'
                       if drift_calibrated else
                       '- "Drift": Judge style consistency from the VISION OBSERVATIONS ALONE. '
                       'The percentage below is an uncalibrated cross-modal estimate — never '
                       'fail this check on the number, and pass it when the render looks '
                       'on-style.')
        if drift_score is not None:
            drift_pct = round(drift_score * 100)
            if drift_calibrated:
                drift_label = "LOW" if drift_score < 0.25 else "MEDIUM" if drift_score < 0.55 else "HIGH"
                drift_section = f"""
STYLE DRIFT (anchor cosine — calibrated): {drift_pct}% ({drift_label})
  Divergence from the project's own style anchor images. Only fail on drift
  alone when ≥ 55% AND the vision observations agree."""
            else:
                drift_section = f"""
STYLE DRIFT: {drift_pct}% — MEANINGLESS AS A PERCENTAGE. This project declares no
  style anchor images, so this is a text-vs-image cosine, and a perfectly on-style
  render scores around 65% on it. It is NOT evidence of drift. Ignore the number
  and judge style from the vision observations."""

        prompt = f"""Review this generated asset with vision data.

ASSET: {asset.get('name')} ({asset.get('type')})
DESCRIPTION: {asset.get('visual_description', '')}
PROJECT STYLE: {style_label}
{vision_section}
{drift_section}

Checks:
- "Style match": Does the render style match the declared project style ({style_label})?
- "Palette discipline": Is the palette appropriate and consistent with the project?
- "Lighting quality": Is lighting direction and mood cinematically appropriate?
- "Asset quality": Is the asset detailed enough for consistent cross-shot use?
{drift_check}"""
        result = self._run(prompt, "art_director")
        result["drift_score"] = drift_score
        result["visual_observations"] = vision_observations
        return result

    # ── Stage 4: Scene — Camera Director + Layout Director gate ──────────────

    def qc_scene(self, shot: dict, asset_names: list[str]) -> dict[str, Any]:
        dialogue = shot.get("dialogue", [])
        dialogue_text = " | ".join(
            f"{d.get('characterId')}: \"{d.get('text', '')}\"" for d in dialogue[:3]
        )
        prompt = f"""Review this shot breakdown for cinematic quality.

SHOT: {shot.get('id')} — {shot.get('action', '')[:200]}
CAMERA: {shot.get('cameraAngle', 'unspecified')}
ASSETS IN SHOT: {', '.join(asset_names)}
DIALOGUE: {dialogue_text or 'none'}
DURATION: {shot.get('estimatedDuration', '?')}s

Checks:
- "Framing": Is the camera angle appropriate for the dramatic intent?
- "Motivation": Does this shot advance the story or reveal character?
- "Asset logic": Are asset placements physically and narratively plausible?
- "Dialogue sync": Is dialogue length compatible with estimated duration?
- "Cut potential": Will this shot cut cleanly with adjacent shots?"""
        return self._run(prompt, "camera_director")

    # ── Stage 3.1: Environment angles — Layout Director gate ─────────────────

    def qc_environment_angles(self, env_name: str, angle_descriptions: list[str]) -> dict[str, Any]:
        prompt = f"""Review these environment angles for spatial coherence.

ENVIRONMENT: {env_name}
ANGLES GENERATED: {len(angle_descriptions)}
DESCRIPTIONS:
{chr(10).join(f'  {i+1}. {d}' for i, d in enumerate(angle_descriptions[:6]))}

Checks:
- "Spatial coherence": Do the angles describe the same believable space?
- "Geography consistency": Are lighting axis and shadow direction consistent?
- "Camera range": Do the angles provide sufficient coverage for scene blocking?
- "Top-view map": Does the described space make logical sense in plan view?
- "Scale": Is the environment's scale consistent across all angles?"""
        return self._run(prompt, "layout_director")

    # ── Stage 5: Final shot — Animation Director gate ─────────────────────────

    def qc_final_scene(
        self,
        shot_id: str,
        video_url: str,
        shot_description: str,
        vision_observations: dict | None = None,
        identity_drift: float | None = None,
        media_observations: str | None = None,
    ) -> dict[str, Any]:
        identity_section = ""
        if identity_drift is not None:
            pct = round(identity_drift * 100)
            # Calibrated live (2026-06-10): a verified same-character clip vs its
            # own headshot measured 0.35 — cross-modal video↔image cosine runs
            # high even on positives, so LOW extends to 0.45.
            label = "LOW" if identity_drift < 0.45 else "MEDIUM" if identity_drift < 0.65 else "HIGH"
            identity_section = f"""
OBJECTIVE IDENTITY DRIFT (multimodal embedding, rendered video vs approved character image): {pct}% ({label})
  Calibration note: verified same-character clips measure ~35%; treat LOW as a
  match. Only HIGH (≥65%) should fail "Asset fidelity" on its own; MEDIUM needs
  corroboration from the frame analysis."""
        # THE CLIP ITSELF, WATCHED AND HEARD. Until this existed the gate saw ONE frame,
        # which is why the two defects the user kept reporting were structurally
        # invisible to it: a still cannot show that nobody moves, and a duplicate of a
        # character that appears for part of the shot is simply not in the frame you
        # sampled. Measured on GLADIATOR TEST/SHOT_001 (2026-08-15) — "this exact same
        # character appears twice simultaneously" and "all people stay nearly perfectly
        # still" — neither of which the frame pass had reported.
        media_section = ""
        if media_observations:
            media_section = f"""
THE CLIP, WATCHED AND HEARD END TO END ({', '.join(['motion', 'cast', 'dialogue'])} — seed-2-0-lite):
{media_observations.strip()[:2500]}

This is a report of the ACTUAL RENDERED CLIP, not of a single frame: it is direct
evidence about motion, about who is on screen, and about what is said aloud. Weigh
it above the frame analysis wherever the two disagree."""
        vision_section = ""
        if vision_observations:
            vision_section = f"""
EXTRACTED FRAME ANALYSIS (ModelArk vision, frame at t=1s of the rendered video):
  Dominant palette: {vision_observations.get('dominant_palette', 'unknown')}
  Lighting: {vision_observations.get('lighting', 'unknown')}
  Render style: {vision_observations.get('render_style', 'unknown')}
  Observations: {vision_observations.get('observations', '')}

Judge the shot from this frame analysis plus the description below. You cannot
play the video yourself — the frame analysis is your visual evidence. Do NOT
fail checks merely because the video reference is a file path, and do NOT fail
"Motion quality"/"Performance" merely because you only see one frame — judge
their plausibility from the action description; fail them only on positive
evidence of a problem (frozen pose contradicting scripted motion, artifacts)."""

        prompt = f"""Review this rendered video shot for final delivery quality.

SHOT ID: {shot_id}
VIDEO: {video_url}
DESCRIPTION: {shot_description[:500]}
{media_section}
{vision_section}
{identity_section}

Checks:
- "Motion quality": Is motion fluid with no temporal artifacts or freezes?
- "Lighting tone": Does lighting match the described mood and time of day?
- "Asset fidelity": Do characters and props match approved reference designs?
- "Performance": Does character movement serve the dramatic intent?
- "Technical quality": No compression artifacts, banding, or rendering failures?"""
        # Two checks that only became answerable when the gate could watch the clip.
        # They are the two defects this pipeline actually produces, and asking for them
        # by name is what turns the report above into a verdict.
        if media_observations:
            prompt += """
- "Cast in frame": Is every person on screen someone the description calls for, and does
  NO character appear duplicated or doubled? A person the shot does not call for, or the
  same face twice at once, MUST fail this.
- "Dialogue delivered": Are the words spoken aloud the ones this shot's dialogue calls
  for — not paraphrased, not invented, not missing? Silence where lines were written
  MUST fail this. If the shot has no dialogue, pass it."""
        return self._run(prompt, "animation_director")

    # ── Stage 6: Final cut — Film Director gate ───────────────────────────────

    def qc_final_cut(self, sequence: list[str], shot_data: list[dict],
                     frames: list[tuple[str, str]] | None = None,
                     target_secs: int = 0, loudness: dict | None = None,
                     story: str = "") -> dict[str, Any]:
        """Review the assembled cut.

        This used to be asked to judge "visual flow", "rhythm" and "transitions" from
        nothing but a list of shot IDs and a list of durations — none of which are
        knowable from that input, so the verdict could only ever be a guess dressed as
        a review. It now gets two things it can actually reason about:

        - MEASURED editorial metrics (average shot length, how much the lengths vary,
          the longest stretch without a change of pace, runtime against target). These
          are arithmetic; the ones with a right answer are returned as their own
          deterministic checks so they can fail on their own.
        - Sampled FRAMES from the rendered file, when the caller can supply them, so
          the "does it look like one film" question is answered by looking.

        frames: [(media_type, base64)] sampled across the cut, in order.
        story: the film bible's ACT STRUCTURE (server: _bible_delivery_note), so "does
          this read as one film" can be asked against the shape the story was built on
          instead of against the reviewer's imagination. "" for a project with no bible,
          which leaves the prompt exactly as it was before this parameter existed.
        """
        import statistics as _stats

        # Pacing has to be measured on SHOTS, not on clips. A clip is one Seedance call
        # and may hold several shots the model cut between, so reading its total would
        # report a 9.5s average on a segment whose real cutting rhythm is 1.5/5/3 — the
        # metric would say "slow and even" about the one thing it exists to catch.
        # `sub_durations` is the segment's shot lengths; absent → the clip IS one shot.
        #
        # A clip with no recorded duration is UNKNOWN, not five seconds. The `else 5.0`
        # that used to stand here fed a made-up number straight into the runtime verdict,
        # the average and the spread — so the gate that judges the finished film was
        # measuring it against a fiction. Unknowns are now EXCLUDED from the arithmetic and
        # COUNTED, and every note below says what it was measured on. Excluded rather than
        # probed because this method never sees a file: shot_data carries ids and numbers,
        # not paths. Length now comes from clip_seconds — the same rule estimate_shots_seconds
        # sums with, so phases 2 and 6 agree about what a clip's length is.
        durations: list[float] = []
        clip_lengths: list[float] = []
        unknown = 0
        dialogue_lines = 0
        for s in shot_data:
            subs = [float(x) for x in (s.get("sub_durations") or []) if float(x or 0) > 0]
            secs = clip_seconds(s)
            if secs is None and subs:
                secs = sum(subs)          # no clip length, but its own shots say how long it is
            if secs is None:
                unknown += 1
            elif secs > 0:
                clip_lengths.append(secs)
            durations.extend(subs or ([secs] if secs else []))
            sd = s.get("sub_dialogue")
            dialogue_lines += (sum(1 for x in sd if int(x or 0) > 0) if isinstance(sd, list)
                               else (1 if s.get("dialogue") else 0))
        clip_total = sum(clip_lengths)
        total = sum(durations)
        # Said in every note that quotes a number, so a tick can never stand for a
        # measurement that was not taken.
        missing = (f" {unknown} of {len(shot_data)} clip(s) have no recorded duration and are "
                   f"NOT counted — these numbers are a lower bound." if unknown else "")
        # The two must agree; if they drift, the EDL and the shot list disagree about how
        # long the film is and every runtime check below is measuring the wrong film.
        if shot_data and abs(total - clip_total) > max(1.0, 0.02 * clip_total):
            logger.warning("[QC:FinalCut] shot durations sum to %.1fs but clips sum to "
                           "%.1fs — the sub-shot data is out of step with the cut",
                           total, clip_total)
            total = clip_total
        n = len(durations)

        # ── Measured, not judged ──
        asl = total / n if n else 0.0
        spread = (_stats.pstdev(durations) if n > 1 else 0.0)
        # Longest run of near-identical lengths: a stretch with no change of pace.
        longest_flat, run = 1, 1
        for i in range(1, n):
            run = run + 1 if abs(durations[i] - durations[i - 1]) < 0.75 else 1
            longest_flat = max(longest_flat, run)
        dialogue_shots = dialogue_lines

        det: list[dict] = []
        if target_secs:
            drift = abs(total - target_secs) / target_secs
            # An unknown clip makes `total` a lower bound, so "within 10% of target" is no
            # longer something this can assert — and a green Runtime tick is the one number
            # the user reads straight off this panel. Say it could not be verified instead.
            det.append({"label": "Runtime", "passed": drift <= 0.10 and not unknown,
                        "notes": (f"at least {total/60:.1f} min against a "
                                  f"{target_secs/60:.1f} min target — runtime could NOT be "
                                  f"verified." if unknown else
                                  f"{total/60:.1f} min against a {target_secs/60:.1f} min target "
                                  f"({drift*100:.0f}% off).") + missing})
        det.append({
            "label": "Pacing variety", "passed": n < 4 or spread >= 1.0,
            # Excluding unknowns makes an empty sample reachable, so the note has to be able
            # to say "nothing was measured" — and the scolding clause is tied to the verdict
            # instead of to `spread`, which used to print it under a PASS on a 3-shot cut.
            "notes": (f"average shot {asl:.1f}s, spread ±{spread:.1f}s." if n
                      else "no clip length could be measured.")
                     + ("" if (n < 4 or spread >= 1.0) else " Nearly every shot is the same length — the cut has no pulse.")
                     + missing,
        })
        det.append({
            "label": "Rhythm", "passed": longest_flat < 5,
            "notes": f"longest run at one pace: {longest_flat} shots."
                     + ("" if longest_flat < 5 else " That stretch will feel mechanical.")
                     + missing,
        })
        if loudness:
            lufs = loudness.get("measured_lufs")
            det.append({"label": "Loudness", "passed": bool(loudness.get("applied")),
                        "notes": (f"normalised to {loudness.get('target_lufs')} LUFS "
                                  f"(was {lufs:.1f})" if loudness.get("applied") and lufs is not None
                                  else f"NOT normalised: {loudness.get('reason', 'unknown')}")})

        # How the cut is built: N shots across M render calls. A film whose shots and
        # clips are the same number has no internal cutting at all — every clip is one
        # continuous take, which is the "string of unrelated videos" failure mode.
        n_clips = len(shot_data)
        band = next((lbl for lo, hi, lbl in DURATION_BANDS if lo <= asl <= hi), "")
        metrics = (f"SHOTS: {n} across {n_clips} render call(s) · "
                   f"RUNTIME: {total/60:.1f} min"
                   + (f" (target {target_secs/60:.1f} min)" if target_secs else "")
                   + f"\nAVERAGE SHOT LENGTH: {asl:.1f}s · SPREAD: ±{spread:.1f}s"
                   + (f" — that average sits in the '{band}' band" if band else "")
                   + f"\nLONGEST RUN AT ONE PACE: {longest_flat} shots"
                   + f"\nSHOTS WITH DIALOGUE: {dialogue_shots}/{n}"
                   + (f"\nNOT MEASURED: {unknown} clip(s) have no recorded duration, so every "
                      f"number above is a lower bound — do not call the cut short on them."
                      if unknown else ""))

        seen = ("You are shown FRAMES SAMPLED IN ORDER across the finished cut."
                if frames else
                "NOTE: no frames were available, so judge ONLY what the numbers below support "
                "and say plainly that you could not see the picture.")
        prompt = (
            "You are the editor reviewing an assembled cut.\n\n" + seen + "\n\n"
            + metrics + "\n\nSEQUENCE: " + " → ".join(sequence[:120])
            + story
            + "\n\nJudge ONLY these, and tie every note to a specific shot id:\n"
            '- "Continuity": do the frames read as one film — same world, same people, '
            "same grade — or do they look separately generated?\n"
            '- "Coverage": does the shot size actually change across the cut, or does it '
            "sit on one size?\n"
            '- "Pacing": are the lengths carrying the drama, or is it uniform?\n'
            + ('- "Structure": does the cut still move through the act structure above, '
               "or has it flattened?\n" if story else "")
            + "Be concrete. 'Improve the pacing' is useless; 'SHOT_014 holds 4s too long "
            "after the line lands' is a note."
        )
        if frames:
            return self._run_vision(prompt, frames, "final_director", extra_checks=det)
        out = self._run(prompt, "final_director")
        out["checks"] = det + list(out.get("checks") or [])
        out["passed"] = all(c.get("passed") for c in out["checks"])
        return out

# ── Import-time guard against the failure that shipped in 18097ce ───────────────────
# A module-level `def` pasted INSIDE the class body ends the class right there; every
# method after it is then parsed as a nested function of that def, and the server only
# finds out at click time ("'ClaudeQCAgents' object has no attribute 'prop_sheet_prompt'").
# py_compile cannot see it. This can: the process refuses to start without its gates.
_REQUIRED_METHODS = (
    "qc_script", "qc_breakdown", "qc_asset", "qc_storyboard", "qc_scene", "qc_final_cut",
    "identity_board_prompt", "prop_sheet_prompt", "wardrobe_sheet_prompt", "video_direction",
    "storyboard_panels", "enhance_text", "enhance_seedance_direction",
)
_missing = [m for m in _REQUIRED_METHODS if not callable(getattr(ClaudeQCAgents, m, None))]
if _missing:
    raise ImportError(f"ClaudeQCAgents lost methods — a module-level def is inside the class body: {_missing}")
