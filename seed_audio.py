"""
BytePlus Seed Audio 1.0 — REST text-to-speech with per-actor voice cloning.

This is a DIFFERENT product from byteplus_tts.py (Seed TTS 2.0, the WebSocket
bidirectional protocol used by the Studio). Seed Audio 1.0 is a simple JSON REST
endpoint whose headline feature is *voice cloning by reference audio*: pass one
short clip of an actor and every line is spoken in that same cloned voice —
which is exactly how we lock a consistent voice per character across the film
(the audio analogue of the face anchor).

Reference: byteplus-models-genius/references/audio-generation.md
- Model:    seed-audio-1.0
- Endpoint: POST https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/create
            (host is `voice.*`, NOT the ARK `ark.*` host)
- Auth:     single header X-Api-Key
- Body:     {model, text_prompt (≤2048 chars), references?, audio_config?, watermark:{}}
- Clone:    references=[{audio_url | audio_data | speaker}]; cite "@Audio1" in the
            text_prompt so the model binds that reference as the voice.
- Output:   {code, message, audio (base64), duration, url (2h)}
"""

from __future__ import annotations

import base64
import logging
import os
import uuid
from pathlib import Path
from typing import Any

import requests

logger = logging.getLogger(__name__)

TTS_URL = "https://voice.ap-southeast-1.bytepluses.com/api/v3/tts/create"
DEFAULT_MODEL = "seed-audio-1.0"

# Reference-audio hard limits (audio-generation.md §5).
MAX_REF_SECONDS = 30
MAX_REF_BYTES = 10 * 1024 * 1024
REF_AUDIO_EXTS = {".wav", ".mp3", ".pcm", ".ogg", ".opus"}

#: text_prompt hard cap. audio-generation.md says 2048 twice — §4 ("Max 2048 characters")
#: and §9 ("≤ 2048 characters") — which is the number synthesize() has always sliced at.
#: Exported because the SCENE path needs to check a prompt's length BEFORE it pays for the
#: identity clips that call needs (server._render_dialogue_scene).
#: ⚠️ MAX_PROMPT_CHARS = 3000 further down governs generate() only and contradicts this;
#: I could find no source for 3000 in this repo or in that reference. Left as it is rather
#: than guessed at — but do not copy 3000 into a new call site.
MAX_TEXT_PROMPT_CHARS = 2048

# text_prompt is a PROMPT, not raw text — the model interprets an instruction plus
# the content. To keep a cloned line clean we wrap the spoken text in quotes and
# bind the reference voice with @Audio1. Override via SEED_AUDIO_CLONE_TEMPLATE if
# your account reads the wrapper aloud (see module docstring / verify note).
CLONE_TEMPLATE = os.getenv(
    "SEED_AUDIO_CLONE_TEMPLATE",
    'Speak the following line in the exact voice, timbre and accent of @Audio1, '
    'with natural delivery{emotion}.{voice} Line: "{text}"',
)

#: ACTING SKILL §9: "Each character gets one Voice prompt — their permanent vocal identity.
#: When the character has a spoken line, paste the Voice prompt VERBATIM into the audio/voice
#: field." Until 2026-08-09 the only acting information that reached Seed Audio was the
#: line's one-word `emotion` ("flat tired", "worried"), so every character in a film was
#: delivered by the same generic actor wearing different timbres. The master profile that the
#: breakdown already writes CONTAINS the missing half — the skill's own template puts it in a
#: fixed "Vocal profile: …" block covering pitch/timbre, accent, pace and how the voice breaks
#: under pressure — and it was never read by anything.
#:
#: Only that clause is lifted. The rest of the profile is gait, posture and facial tics: it
#: cannot be heard, and handing a TTS model a paragraph about how someone walks invites it to
#: narrate. The budget is not the constraint — the documented cap is 2048 chars and a line
#: with its wrapper runs ~100 — the relevance is.
_VOCAL_RE = None


def vocal_profile_of(acting: str | None) -> str:
    """The `Vocal profile: …` sentence of an ACTING MASTER PROFILE, or "".

    PURE. Returns "" for anything that does not carry the block, so a character written
    before the acting pass — or by a model that ignored the template — changes nothing.
    """
    global _VOCAL_RE
    if not (acting or "").strip():
        return ""
    if _VOCAL_RE is None:
        import re
        # Up to the next sentence that starts a NEW named block of the template, or the end.
        _VOCAL_RE = re.compile(
            r"vocal profile\s*:\s*(.+?)(?=\s+(?:key physical habits|walking style|however, when)\b|$)",
            re.IGNORECASE | re.DOTALL)
    m = _VOCAL_RE.search(acting)
    if not m:
        return ""
    return " ".join(m.group(1).split()).rstrip(" .;,")


def _mime_for(ext: str) -> str:
    ext = ext.lower().lstrip(".")
    return {
        "mp3": "audio/mpeg", "wav": "audio/wav", "pcm": "audio/pcm",
        "ogg": "audio/ogg", "opus": "audio/ogg",
    }.get(ext, "audio/mpeg")


def _ref_from_path(path: str) -> dict[str, Any]:
    """Build a reference item from a local audio file, embedded as base64 audio_data.
    Enforces the documented format + size limits (raises on violation).

    audio-generation.md §5 describes audio_data only as 'Base64-encoded reference
    audio' (no `data:` prefix, unlike the Seedream image API). We therefore send
    BARE base64 by default; set SEED_AUDIO_REF_DATAURI=1 if your account instead
    expects a data-URI."""
    p = Path(path)
    if not p.is_file():
        raise RuntimeError(f"reference audio not found: {path}")
    if p.suffix.lower() not in REF_AUDIO_EXTS:
        raise RuntimeError(
            f"reference audio format {p.suffix!r} unsupported — use wav/mp3/pcm/ogg_opus"
        )
    raw = p.read_bytes()
    if len(raw) > MAX_REF_BYTES:
        raise RuntimeError(
            f"reference audio is {len(raw) // (1024 * 1024)}MB — Seed Audio limit is 10MB"
        )
    b64 = base64.b64encode(raw).decode()
    if os.getenv("SEED_AUDIO_REF_DATAURI", "").strip() in ("1", "true", "yes"):
        return {"audio_data": f"data:{_mime_for(p.suffix)};base64,{b64}"}
    return {"audio_data": b64}


def _image_ref_from_path(path: str) -> dict[str, Any]:
    """Build an IMAGE reference item (design mode: infer a voice from a portrait).
    Sends bare base64 by default; set SEED_AUDIO_REF_DATAURI=1 for a data-URI."""
    p = Path(path)
    if not p.is_file():
        raise RuntimeError(f"reference image not found: {path}")
    raw = p.read_bytes()
    if len(raw) > MAX_REF_BYTES:
        raise RuntimeError(f"reference image is {len(raw) // (1024 * 1024)}MB — Seed Audio limit is 10MB")
    b64 = base64.b64encode(raw).decode()
    ct = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(
        p.suffix.lower().lstrip("."), "image/png")
    if os.getenv("SEED_AUDIO_REF_DATAURI", "").strip() in ("1", "true", "yes"):
        return {"image_data": f"data:{ct};base64,{b64}"}
    return {"image_data": b64}


def synthesize(
    text: str,
    *,
    reference_audio_path: str | None = None,
    reference_audio_url: str | None = None,
    reference_audio_paths: list[str] | None = None,   # SCENE mode — ordered @Audio1..@AudioN
    image_reference_path: str | None = None,
    image_reference_url: str | None = None,
    speaker: str | None = None,
    fmt: str = "mp3",
    sample_rate: int = 24000,
    speech_rate: int = 0,
    pitch_rate: int = 0,
    loudness_rate: int = 0,
    emotion: str | None = None,
    voice_profile: str | None = None,   # ACTING SKILL §9 vocal identity; see vocal_profile_of
    api_key: str | None = None,
    model: str | None = None,
    timeout: int = 120,
    meta: dict | None = None,
) -> bytes:
    """One-shot Seed Audio 1.0 synthesis → audio bytes.

    Voice source (choose ONE; reference wins over speaker):
      - reference_audio_paths → SCENE mode: SEVERAL identity clips in one call, kept in
        the order given so the prompt can address them as @Audio1..@AudioN. `text` is
        then a FINISHED prompt and is sent VERBATIM — no cloning wrapper. This is the
        only shape in which two characters can speak OVER each other: one call per line
        can only ever be concatenated afterwards, so nobody can interrupt anybody.
      - reference_audio_path / reference_audio_url → cloned voice (@Audio1)
      - speaker → a Doubao/clone voice ID (no @Audio mention)
      - none → default text-only voice

    Omitting reference_audio_paths (or passing an empty list) leaves every byte of the
    request exactly as it was before scene mode existed — the branch below is entered
    only by a caller that asked for it.

    Raises RuntimeError on auth/HTTP/synthesis error. On a voiceprint-sensitive
    rejection it retries ONCE without the reference (falls back to a generic voice)
    rather than failing the whole dialogue render.

    `meta` is an OUT parameter: pass a dict and, if that fallback fires, it comes
    back carrying meta["voice_fallback"]=True and meta["voice_fallback_reason"].
    The return stays bare `bytes` so no existing caller breaks — but a caller that
    wants to know the voice changed now can, instead of the fact dying at the return.
    """
    api_key = api_key or os.getenv("SEED_AUDIO_API_KEY", "") or os.getenv("SEED_TTS_API_KEY", "")
    if not api_key:
        raise RuntimeError("SEED_AUDIO_API_KEY not set — add it to .env and restart the backend")
    model = model or os.getenv("SEED_AUDIO_MODEL", DEFAULT_MODEL)

    audio_config: dict[str, Any] = {"format": fmt, "sample_rate": sample_rate}
    if speech_rate:
        audio_config["speech_rate"] = max(-50, min(100, int(speech_rate)))
    if pitch_rate:
        audio_config["pitch_rate"] = max(-12, min(12, int(pitch_rate)))
    if loudness_rate:
        audio_config["loudness_rate"] = max(-50, min(100, int(loudness_rate)))

    references: list[dict[str, Any]] = []
    cloning = False       # audio-reference (clone) — uses the @Audio1 template
    image_mode = False    # image-reference (design) — text_prompt is text ONLY
    scene = False         # N audio-references — `text` IS the prompt, sent VERBATIM
    # NEVER mix image references with audio references in one request (doc §4).
    scene_refs = [p for p in (reference_audio_paths or []) if (p or "").strip()]
    if scene_refs:
        # SCENE MODE, first in the chain because it SUPERSEDES the single-reference
        # params: a caller holding N identity clips has already decided every voice.
        # @AudioN is POSITIONAL — audio-generation.md §9: "@AudioN ordering must match
        # the order of items in references — mis-ordering swaps voices" — so this list
        # is never sorted, deduped or reordered here. The caller owns the order.
        if len(scene_refs) > MAX_REF_AUDIOS:   # defined with the Studio constants below
            raise RuntimeError(
                f"{len(scene_refs)} reference clips — Seed Audio accepts at most "
                f"{MAX_REF_AUDIOS} audio references per request (doc §5)")
        references = [_ref_from_path(p) for p in scene_refs]
        scene = True
    elif reference_audio_url:
        references = [{"audio_url": reference_audio_url}]; cloning = True
    elif reference_audio_path:
        references = [_ref_from_path(reference_audio_path)]; cloning = True
    elif image_reference_url:
        references = [{"image_url": image_reference_url}]; image_mode = True
    elif image_reference_path:
        references = [_image_ref_from_path(image_reference_path)]; image_mode = True
    elif speaker:
        references = [{"speaker": speaker}]

    emo = f", conveying {emotion}" if emotion else ""
    # The vocal identity rides ONLY the clone path. In image-reference mode the docs are
    # explicit that the picture infers the voice and no voice description belongs in the
    # prompt, and in `speaker` mode the preset already fixes the timbre — adding a second,
    # possibly contradictory description to either is how a locked voice stops being locked.
    voc = f" The speaker's vocal identity: {voice_profile.strip()}." if (voice_profile or "").strip() else ""
    if cloning:
        text_prompt = CLONE_TEMPLATE.format(text=text.strip(), emotion=emo, voice=voc)
    else:
        # text-only, image-reference AND scene: text_prompt is sent as given
        # (image-reference infers the voice; NO @Audio, no voice description. In scene
        # mode `text` is ALREADY a complete instruction — VOICES block, @AudioN binding,
        # numbered overlap beats — and the clone wrapper would turn the whole direction
        # into something for the model to read aloud).
        text_prompt = text.strip()
    if scene and len(text_prompt) > MAX_TEXT_PROMPT_CHARS:
        # Slicing a scene prompt cuts it off mid-beat and the caller pays for audio that
        # stops early. A scene caller always holds a per-line fallback, so fail loudly and
        # let it take that. The single-line paths keep the silent slice below: a LINE long
        # enough to reach 2048 characters is already broken upstream.
        raise RuntimeError(
            f"scene prompt is {len(text_prompt)} characters — the documented text_prompt "
            f"cap is {MAX_TEXT_PROMPT_CHARS} (audio-generation.md §4)")
    text_prompt = text_prompt[:MAX_TEXT_PROMPT_CHARS]  # documented hard cap

    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": api_key,
        "X-Api-Request-Id": str(uuid.uuid4()),   # optional trace id (audio-generation.md §3)
    }

    def _post(refs: list[dict[str, Any]], prompt: str) -> requests.Response:
        body: dict[str, Any] = {"model": model, "text_prompt": prompt,
                                "audio_config": audio_config, "watermark": {}}
        if refs:
            body["references"] = refs
        # NEVER log the auth header; log a redacted shape for troubleshooting.
        mode = "scene" if scene else "clone" if cloning else "image" if image_mode else "text"
        logger.info("[SeedAudio] POST create (mode=%s, refs=%d, fmt=%s, sr=%d)",
                    mode, len(refs), fmt, sample_rate)
        return requests.post(TTS_URL, headers=headers, json=body, timeout=timeout)

    resp = _post(references, text_prompt)
    data = _decode(resp)

    # Voiceprint/content-sensitive false positives: retry once WITHOUT the reference
    # so the line still renders (generic voice) instead of hard-failing the dialogue.
    #
    # NOT in scene mode, deliberately: dropping the references there bills a SECOND render
    # whose entire cast is one generic voice, while the caller already holds a per-line
    # fallback that keeps every character's LOCKED voice. Raise and let it take that —
    # cheaper and better. (`scene` is excluded via the flag, not via `cloning`, which is
    # why scene mode never sets `cloning`.)
    if data is None and (cloning or image_mode):
        logger.warning("[SeedAudio] reference rejected (sensitive?) — retrying text-only")
        resp = _post([], text.strip()[:MAX_TEXT_PROMPT_CHARS])
        data = _decode(resp)
        # This retry drops the voice reference, so the line comes back in a GENERIC
        # voice — the character audibly changes mid-film. That used to be invisible:
        # synthesize() returns bare bytes, so the swap was destroyed at the return and
        # nothing downstream could warn. Report it through `meta` instead. Only flagged
        # once the retry actually produced audio; if it did not we raise below and
        # nobody reads meta anyway.
        if data is not None and meta is not None:
            meta["voice_fallback"] = True
            meta["voice_fallback_reason"] = (
                "voice reference rejected as voiceprint/content-sensitive — "
                "line rendered in a generic voice"
            )

    if data is None:
        raise RuntimeError(f"Seed Audio returned no audio (HTTP {resp.status_code}): {resp.text[:200]}")
    return data


def _decode(resp: requests.Response) -> bytes | None:
    """Parse a /tts/create response → audio bytes, or None if the call was a
    (recoverable) content/voiceprint rejection. Raises on hard auth/HTTP errors."""
    log_id = resp.headers.get("X-Tt-Logid", "")
    if resp.status_code in (401, 403):
        raise RuntimeError(f"Seed Audio auth failed (HTTP {resp.status_code}) — check SEED_AUDIO_API_KEY")
    try:
        payload = resp.json()
    except Exception:
        if resp.status_code >= 400:
            raise RuntimeError(f"Seed Audio HTTP {resp.status_code}: {resp.text[:200]}")
        return None
    code = payload.get("code")
    audio_b64 = payload.get("audio")
    if audio_b64:
        try:
            return base64.b64decode(audio_b64)
        except Exception as e:
            raise RuntimeError(f"Seed Audio returned undecodable audio: {e}")
    msg = str(payload.get("message", "")).lower()
    # Recoverable rejections → caller may retry without the reference.
    if any(k in msg for k in ("voiceprint", "sensitive", "voice clone", "content")):
        logger.warning("[SeedAudio] recoverable rejection code=%s msg=%s logid=%s",
                        code, payload.get("message"), log_id)
        return None
    raise RuntimeError(f"Seed Audio error code={code}: {payload.get('message')} (logid={log_id})")


# ── Studio: full Seed Audio 1.0 surface ──────────────────────────────────────
# synthesize() above is the PIPELINE's path (one line, one voice) and is deliberately
# left alone. generate() below exposes what the model can actually do — a whole scene
# in one render — for the Studio only:
#   • T2A   — describe environment + score + SFX + who says what; no references.
#   • TA2A  — up to THREE reference clips, cited as @Audio1..@Audio3 in the prompt,
#             so a multi-character scene keeps a distinct voice per speaker.
#   • image — one portrait; text_prompt is then only the line to speak.
# Only `seed-audio-1.0-multilingual` covers the 20 languages AND timestamp control
# ("[5.5s:8.0s]" markers); the base model is English/Chinese and ignores them.
MULTILINGUAL_MODEL = "seed-audio-1.0-multilingual"
MAX_PROMPT_CHARS = 3000        # documented text_prompt ceiling
MAX_REF_AUDIOS = 3             # @Audio1..@Audio3
MAX_OUTPUT_SECONDS = 120       # hard cap on generated audio
USD_PER_MINUTE = 0.15          # billed on original_duration, per second


def generate(
    text_prompt: str,
    *,
    audio_refs: list[str] | None = None,   # ≤3 local paths / urls → @Audio1..@Audio3
    image_ref: str | None = None,          # 1 portrait; never mixed with audio refs
    speaker: str | None = None,            # a TTS 2.0 / cloned voice id
    multilingual: bool = True,
    fmt: str = "mp3",
    sample_rate: int = 44100,              # documented default for mp3
    speech_rate: int = 0,
    pitch_rate: int = 0,
    loudness_rate: int = 0,
    subtitles: bool = False,               # word + sentence timestamps in the response
    api_key: str | None = None,
    model: str | None = None,
    timeout: int = 180,
) -> dict[str, Any]:
    """One Seed Audio render → {audio: bytes, duration, original_duration, subtitle, cost_usd}.

    The prompt is sent VERBATIM — unlike synthesize(), which wraps a line in a cloning
    template. That is the whole point here: the prompt IS the scene description, and
    wrapping it would destroy the environment/score/SFX direction the user wrote.

    Raises RuntimeError on auth/HTTP/synthesis failure.
    """
    api_key = api_key or os.getenv("SEED_AUDIO_API_KEY", "") or os.getenv("SEED_TTS_API_KEY", "")
    if not api_key:
        raise RuntimeError("SEED_AUDIO_API_KEY not set — add it to .env and restart the backend")
    prompt = (text_prompt or "").strip()
    if not prompt:
        raise RuntimeError("text_prompt is empty")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise RuntimeError(f"prompt is {len(prompt)} characters — the limit is {MAX_PROMPT_CHARS}")

    refs_in = [r for r in (audio_refs or []) if (r or "").strip()]
    if refs_in and image_ref:
        raise RuntimeError("an image reference cannot be combined with audio references")
    if len(refs_in) > MAX_REF_AUDIOS:
        raise RuntimeError(f"{len(refs_in)} reference clips — at most {MAX_REF_AUDIOS} are allowed")

    # Reference order defines the @AudioN numbering, so build it in the order given.
    references: list[dict[str, Any]] = []
    for r in refs_in:
        references.append({"audio_url": r} if r.startswith(("http://", "https://"))
                          else _ref_from_path(r))
    if image_ref:
        references.append({"image_url": image_ref} if image_ref.startswith(("http://", "https://"))
                          else _image_ref_from_path(image_ref))
    if speaker and not references:
        references.append({"speaker": speaker})

    audio_config: dict[str, Any] = {"format": fmt, "sample_rate": sample_rate}
    if speech_rate:
        audio_config["speech_rate"] = max(-50, min(100, int(speech_rate)))
    if pitch_rate:
        audio_config["pitch_rate"] = max(-12, min(12, int(pitch_rate)))
    if loudness_rate:
        audio_config["loudness_rate"] = max(-50, min(100, int(loudness_rate)))
    if subtitles:
        audio_config["enable_subtitle"] = True

    body: dict[str, Any] = {
        "model": model or (MULTILINGUAL_MODEL if multilingual else DEFAULT_MODEL),
        "text_prompt": prompt,
        "audio_config": audio_config,
        "watermark": {},
    }
    if references:
        body["references"] = references

    mode = "image" if image_ref else f"refs×{len(refs_in)}" if refs_in else "speaker" if speaker else "t2a"
    logger.info("[SeedAudio] generate (mode=%s, model=%s, chars=%d, subs=%s)",
                mode, body["model"], len(prompt), subtitles)
    resp = requests.post(
        TTS_URL,
        headers={"X-Api-Key": api_key, "Content-Type": "application/json"},
        json=body, timeout=timeout,
    )
    if resp.status_code in (401, 403):
        raise RuntimeError(f"Seed Audio auth failed (HTTP {resp.status_code}) — check SEED_AUDIO_API_KEY")
    try:
        payload = resp.json()
    except Exception:
        raise RuntimeError(f"Seed Audio HTTP {resp.status_code}: {resp.text[:200]}")
    if not payload.get("audio"):
        raise RuntimeError(
            f"Seed Audio error code={payload.get('code')}: {payload.get('message')} "
            f"(logid={resp.headers.get('X-Tt-Logid', '')})")

    billed = float(payload.get("original_duration") or 0.0)
    return {
        "audio": base64.b64decode(payload["audio"]),
        "duration": float(payload.get("duration") or 0.0),
        "original_duration": billed,        # what BytePlus bills, capped at 120s
        "subtitle": payload.get("subtitle"),
        "cost_usd": round(billed / 60.0 * USD_PER_MINUTE, 4),
    }
