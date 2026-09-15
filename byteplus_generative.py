"""
BytePlus Volcano Engine - Generative AI Pipeline Module
Implements real API calls for:
  - DeepSeek-V4-Flash (text/logic via OpenAI-compatible endpoint)
  - Seedream-5.0 (image generation + character sheets, with reference image support)
  - Seedance-2.0 / Dreamina (video generation with reference images/videos/audio)
"""

import math as _math
import os
import re          # module level: four callers imported it locally, and _OUTPUT_SETTING_TOKENS is compiled at import time
import time
import json
import base64
import random
import logging
import requests
import httpx
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Any, Callable, Iterable, List, Optional
import usage
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _url_to_data_uri(url_or_data: str, timeout: int = 30) -> str:
    """
    Convert a URL or local file path to a base64 data URI.

    Priority order:
      1. Already a data URI → return as-is.
      2. Local absolute path (starts with '/') or file:// → read from disk directly.
         This never expires and avoids the signed-URL 403 problem.
      3. HTTP/HTTPS URL → download with timeout.
    """
    if url_or_data.startswith("data:"):
        return url_or_data

    # Local file path — read directly from disk (no expiry, no HTTP)
    local_path = None
    if url_or_data.startswith("file://"):
        local_path = url_or_data[7:]
    elif url_or_data.startswith("/"):
        local_path = url_or_data

    if local_path:
        try:
            import mimetypes as _mt
            ct = _mt.guess_type(local_path)[0] or "image/png"
            with open(local_path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            logger.debug("[DataURI] Read local file %r (%s)", local_path, ct)
            return f"data:{ct};base64,{b64}"
        except Exception as e:
            logger.warning("[DataURI] Local file read failed for %r: %s", local_path, e)
            return url_or_data

    # Remote URL — try HTTP download
    try:
        resp = requests.get(url_or_data, timeout=timeout)
        resp.raise_for_status()
        ct = resp.headers.get("Content-Type", "image/png").split(";")[0].strip()
        b64 = base64.b64encode(resp.content).decode()
        return f"data:{ct};base64,{b64}"
    except Exception as e:
        logger.warning("[DataURI] HTTP fetch failed (URL may be expired): %s — %s",
                       url_or_data[:80], e)
        return url_or_data


#: Longest single audio reference Seedance accepts, from the API's own rejection:
#: "the parameter audio duration (seconds) … must be less than or equal to 30.2 for model
#: dreamina-seedance-2-5 in r2v". Kept just under it — a container's reported duration and
#: the decoder's can differ by a frame, and being 0.05 s over costs the whole render.
_AUDIO_REF_MAX_SECS = float(os.getenv("SEEDANCE_AUDIO_REF_MAX_SECS", "30.0"))

#: SHORTEST single audio reference Seedance accepts, from the API's own words:
#: "the parameter audio duration (seconds) specified in the request must be greater than or
#: equal to 1.8 for model dreamina-seedance-2-5 in r2v". There was a ceiling and no floor,
#: and a floor is what a film keeps hitting: a line like "Yes." or "Don't kill me." renders
#: to well under two seconds. It took down BLACKMIRROR 4 SHOT_017 (four attempts) and
#: BLACK MIRROR V3 SHOT_029 and SHOT_031 — all three the same shape, one character with one
#: short line, and all three reported upstream as a bare "Bad Request".
_AUDIO_REF_MIN_SECS = float(os.getenv("SEEDANCE_AUDIO_REF_MIN_SECS", "2.0"))


def _pad_audio_to_min(path: str, min_secs: float) -> str:
    """Pad a too-short clip with trailing silence. Returns the padded file, or the original.

    Dropping it would be the other option and it is worse: the prompt has already been
    assembled with an `@Audio N` role naming that voice, so a dropped clip leaves the model
    addressing something that is not there — the very failure the roles exist to prevent.
    Silence after the line changes nothing the model takes from it (voice, accent, pace),
    and the words come from the written dialogue either way. Best-effort: without ffmpeg
    the original path is returned and the caller's own guard decides.
    """
    import subprocess, tempfile
    try:
        out = os.path.join(tempfile.mkdtemp(),
                           os.path.splitext(os.path.basename(path))[0] + "_padded.mp3")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path,
                        "-af", f"apad=whole_dur={min_secs:.2f}", out], check=True)
        return out if os.path.getsize(out) else path
    except Exception as e:
        logger.warning("[Seedance] could not pad %s to %.1fs (non-fatal): %s",
                       os.path.basename(path), min_secs, e)
        return path


def _audio_seconds(path_or_url: str) -> float | None:
    """Duration of an audio file in seconds, or None when it cannot be measured.

    None means "unknown", and every caller must treat it as "let it through": refusing to
    attach a reference we merely failed to MEASURE would silently strip the performance
    from every take on a machine without ffprobe.
    """
    try:
        if not path_or_url or path_or_url.startswith(("http://", "https://", "data:")):
            return None
        import subprocess as _sp
        out = _sp.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                       "-of", "csv=p=0", path_or_url],
                      capture_output=True, text=True, timeout=20).stdout.strip()
        return float(out) if out else None
    except Exception:
        return None


def _audio_data_uri(url_or_data: str, timeout: int = 30) -> str:
    """Like `_url_to_data_uri`, but labelled the way SEEDANCE accepts.

    `mimetypes.guess_type("x.mp3")` returns `audio/mpeg` — the correct IANA type, and the
    one BytePlus REFUSES:

        400 InvalidParameter: The parameter `audio_url` specified in the request is not
        valid: Invalid base64 audio_url

    Probed 2026-08-11 against dreamina-seedance-2-5-260628 with the same 110 KB file:
    `data:audio/mpeg;base64,…` → 400, `data:audio/mp3;base64,…` → 200. Only the label
    differs; the bytes are identical.

    This was not a cosmetic failure. The 400 sent create_video_task down its legacy
    fallback, which strips the audio content item and resubmits the clip in the top-level
    `audio_url` field — a field that received a LOCAL FILESYSTEM PATH BytePlus cannot
    fetch — while `generate_audio` stayed true. So every take invented its own dialogue,
    no audio reference ever reached the model, and `@Audio N` in the prompt addressed
    nothing. Measured across four renders: peak cross-correlation between the attached
    take and the returned audio was 0.027-0.039, i.e. unrelated recordings.

    Kept separate from `_url_to_data_uri` because that one is shared with images, where
    the IANA labels are accepted and must not be rewritten.
    """
    uri = _url_to_data_uri(url_or_data, timeout)
    if uri.startswith("data:audio/mpeg;base64,"):
        return "data:audio/mp3;base64," + uri.split(",", 1)[1]
    return uri


# ── Reverse-angle "is this just the base again (or its mirror)?" detector ─────────────
#
# WHY this exists at all: a REVERSE that is the base image again — or, worse, the base
# HORIZONTALLY FLIPPED — is not a neutral miss. server._env_angle_sheet makes the angle
# sheet the DOMINANT environment reference for every board of that location, so a mirrored
# base propagates: the BLOOM board of the school car park rendered the "COMMUNITY GYM" sign
# as reversed lettering because the reference itself had the sign flipped. A missing reverse
# costs coverage; a mirrored reverse actively corrupts every downstream render.
#
# INSTRUMENT: dHash-8 (a 64-bit difference hash — 9x8 greyscale, one bit per
# left-to-right gradient) Hamming distance. Same instrument the ENVIRONMENT_VIEWS note
# below was measured with; there was no shared implementation, only that measurement, so
# this is the first one in the codebase — reuse it rather than adding a second.
# The candidate is scored against the base AND against the horizontally flipped base and
# the SMALLER distance wins, because either answer means "this is the reference again".
#
# THRESHOLD, FROM DATA (measured 2026-08-06 over every environment sheet on disk in the
# BLOOM project — 39 sheets, newest base vs newest reverse; ground truth set by eye from
# base | base-mirrored | reverse contact sheets):
#   3 BAD, min-Hamming:  1  School Gymnasium - Parking Lot (literal mirror, px corr 0.998)
#                        3  Field Lab                      (literal mirror, px corr 0.860)
#                        6  TomásS House - Kitchen         (the base again, NOT flipped)
#   36 GOOD, min-Hamming: 11, 11, 14, 14, 14, 15, 16, 16, 18, 19 … 35
#                        (closest good: DEPOT and Flooded Stairwell, both 11)
#   741 cross-location base pairs — the "two unrelated images" floor: min 11, p1 13, med 26.
# So the cut is 8: two bits of margin above the worst bad (6), three below the best good
# (11), and strictly below the closest that ANY two different BLOOM locations ever come to
# each other (11). At <= 8 bits the candidate is nearer the reference than two genuinely
# different rooms have ever been.
#
# dHash-16 (256 bits) was measured on the same 39 and REJECTED: it does not separate the
# classes at all (bad 9 / 38 / 42 vs good 34 / 66 / 70 — Flooded Stairwell, a plainly
# different shot, lands closer to its base than two of the three known-bad do). Pixel
# correlation was rejected for the same reason: it scores DEPOT (a real reverse) at 0.909
# against the mirrored base, above Field Lab's 0.860, which is a genuine mirror.
_REVERSE_DHASH_SIDE = 8
REVERSE_DHASH_BITS = _REVERSE_DHASH_SIDE * _REVERSE_DHASH_SIDE   # 64
REVERSE_REUSE_MAX_HAMMING = 8


def _dhash_bits(raw: bytes, side: int = _REVERSE_DHASH_SIDE) -> tuple:
    """(hash, mirrored_hash) of raw image bytes as ints, or (None, None) if unreadable.

    The mirrored hash is taken from the flipped IMAGE, not by reversing the bits: dHash
    encodes the SIGN of each left-to-right gradient, so a horizontal flip both reverses
    the column order and inverts every bit — cheaper and less error-prone to just flip
    the pixels once.
    """
    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(raw))
        out = []
        for im in (img, img.transpose(Image.FLIP_LEFT_RIGHT)):
            g = im.convert("L").resize((side + 1, side), Image.LANCZOS)
            px = list(g.getdata())
            bits = 0
            for r in range(side):
                row = px[r * (side + 1):(r + 1) * (side + 1)]
                for c in range(side):
                    bits = (bits << 1) | (1 if row[c] < row[c + 1] else 0)
            out.append(bits)
        return out[0], out[1]
    except Exception as e:  # noqa: BLE001
        logger.warning("[EnvAngles] dHash failed (%s) — candidate cannot be scored", e)
        return None, None


def score_reverse_against_base(candidate_bits: Optional[int],
                               base_bits: Optional[int],
                               base_mirror_bits: Optional[int]) -> Dict[str, Any]:
    """PURE. Answer "is this candidate the base, or the base mirrored?" from three hashes.

    Returns {measured, hamming_base, hamming_mirror, hamming, score, mirrored, is_reuse}.
    `score` is 1.0 for an identical image and 0.0 for a fully inverted one, so it reads the
    same way as the correlations this defect was first reported with; `hamming` (the raw bit
    count) is what the threshold is actually applied to.

    measured=False (hash unavailable) NEVER rejects: a PIL failure must not start burning
    retries on an image nobody could look at. It is reported so the caller can say so.
    """
    if candidate_bits is None or base_bits is None or base_mirror_bits is None:
        return {"measured": False, "hamming_base": None, "hamming_mirror": None,
                "hamming": None, "score": None, "mirrored": False, "is_reuse": False}
    hb = bin(candidate_bits ^ base_bits).count("1")
    hm = bin(candidate_bits ^ base_mirror_bits).count("1")
    h = min(hb, hm)
    return {
        "measured": True,
        "hamming_base": hb,
        "hamming_mirror": hm,
        "hamming": h,
        "score": round(1.0 - h / REVERSE_DHASH_BITS, 4),
        "mirrored": hm < hb,          # which failure it is, for the log and the metadata
        "is_reuse": h <= REVERSE_REUSE_MAX_HAMMING,
    }


def reverse_reuse_check(candidate_src: str, base_src: str, timeout: int = 30) -> Dict[str, Any]:
    """IO wrapper: fetch/read both images (URL, data URI or local path) and score them."""
    def _raw(src: str) -> Optional[bytes]:
        uri = _url_to_data_uri(src, timeout=timeout)
        if not uri.startswith("data:"):
            return None                      # fetch failed — _url_to_data_uri returns the URL
        try:
            return base64.b64decode(uri.split(",", 1)[1])
        except Exception:  # noqa: BLE001
            return None

    craw, braw = _raw(candidate_src), _raw(base_src)
    cb, _ = _dhash_bits(craw) if craw else (None, None)
    bb, bm = _dhash_bits(braw) if braw else (None, None)
    return score_reverse_against_base(cb, bb, bm)


# ── Is the "top view map" an OVERHEAD, and is it THAT place? ──────────────────────────
# The reverse above is scored with a hash because its failure mode is "the base again" —
# a SIMILARITY failure. The top view's failure is the opposite shape and no perceptual
# hash can see it: a correct overhead of a room is legitimately nothing like the
# eye-level base, so "very different" is exactly what a good top view looks like. The
# two questions that matter — is it an OVERHEAD at all, and is it THIS location — can
# only be asked of the picture, so this one goes to vision.
#
# analyze_image_vision and identity_match_vision were both read first and neither fits:
# analyze_image_vision takes ONE image (palette/lighting/render_style) so it cannot
# answer "same place", and identity_match_vision is built for character identity and
# explicitly instructs the model to IGNORE camera angle — the one thing being judged
# here. This is a third, purpose-written read on the same VISION_MODEL and the same
# two-image call shape identity_match_vision already proved works on this account.
#
# MEASURED over BLOOM's 20 breakdown environments (every top view on disk), each read
# 3x, ground truth by eye:
#   invented_interior  flagged on 15/15 reads of the five known-bad sheets (TIDELINE →
#                      beach-shack interior, ARROYO FARM → attic room, Drowned Town →
#                      living room, Seawall → apartment, Flooded Stairwell → furnished
#                      room) and on 0/45 reads of the other fifteen. This is the signal
#                      that separates the classes.
#   pitch_deg          20-35 on four of those five; >= 50 on the good ones EXCEPT
#                      TRANSPORT, read 35 in 3/3 (a genuine second room-level shot, so a
#                      correct reject), and two that FLAP on the same file — GLASS
#                      CONFERENCE ROOM and RESERVOIR STATION each read 35 once and 70
#                      twice. Hence the confirmation read in generate_environment_angles:
#                      every flap was a 1-in-3 while every true failure was unanimous.
#   same_place         a WEAK discriminator, unusable on its own: the bad sheets still
#                      score 60-90 because the materials and palette do carry over. Kept
#                      only as a floor, and low, so it cannot reject by itself.
# An earlier prompt that did not tell the model a correct overhead is SUPPOSED to look
# different flagged 10/20 — including STATION GANTRY and STAGING HANGAR, both genuine
# overheads, on "same_place". That is the false-positive trap this one is written
# against: a validator that rejects good work just doubles the Seedream bill.
TOP_VIEW_MIN_PITCH_DEG = 40
TOP_VIEW_MIN_SAME_PLACE = 40


def score_top_view(fields: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """PURE. Turn ONE vision read of a top view into a verdict.

    Returns {measured, pitch_deg, same_place, invented_interior, invented_what,
             ref_type, top_type, reason, is_overhead, is_same_place, rejected, score}.
    `score` (same_place + pitch, minus a flat 100 for an invented interior) exists only
    to pick the least-bad candidate when every attempt is rejected.

    measured=False (the vision read failed or came back unparseable) NEVER rejects —
    same rule as score_reverse_against_base: an unreadable candidate must not start
    burning retries on an image nobody could look at.
    """
    empty = {"measured": False, "pitch_deg": None, "same_place": None,
             "invented_interior": False, "invented_what": "", "ref_type": "",
             "top_type": "", "reason": "", "is_overhead": True, "is_same_place": True,
             "rejected": False, "score": None}
    if not isinstance(fields, dict) or not fields:
        return empty

    def _int(key: str) -> Optional[int]:
        try:
            return int(float(fields.get(key)))
        except (TypeError, ValueError):
            return None

    pitch, same = _int("pitch_deg"), _int("same_place")
    if pitch is None or same is None:
        return {**empty, "reason": str(fields.get("reason") or "")[:200]}
    pitch, same = max(0, min(90, pitch)), max(0, min(100, same))
    ref_t = str(fields.get("ref_type") or "").strip().lower()
    top_t = str(fields.get("top_type") or "").strip().lower()
    # Two ways to be an invented interior: the model says so, or its own scene-type
    # answers say so (exterior location, interior picture). Both are read because the
    # boolean is the thing the model can waver on while the pair of labels stayed right
    # in every measured case — the five bad sheets were exterior>interior 15/15.
    invented = bool(fields.get("invented_interior")) or (ref_t == "exterior" and top_t == "interior")
    is_overhead = pitch >= TOP_VIEW_MIN_PITCH_DEG
    is_same_place = same >= TOP_VIEW_MIN_SAME_PLACE
    return {
        "measured": True,
        "pitch_deg": pitch,
        "same_place": same,
        "invented_interior": invented,
        "invented_what": str(fields.get("invented_what") or "")[:120],
        "ref_type": ref_t,
        "top_type": top_t,
        "reason": str(fields.get("reason") or "")[:200],
        "is_overhead": is_overhead,
        "is_same_place": is_same_place,
        "rejected": bool(invented or not is_overhead or not is_same_place),
        "score": same + pitch - (100 if invented else 0),
    }


# BytePlus vision + multimodal-embedding APIs reject images > 10 MB
# (InvalidParameter.OversizeImage). 4k frames and full character sheets exceed it,
# which silently broke the "Check consistency" drift score AND face-anchor
# vision-grounding. Seed 2.0 uses a fixed 1280 tokens/image regardless of size, so
# downscaling costs no quality — a 2048px JPEG carries all the detail vision needs.
_VISION_MAX_BYTES = 10 * 1024 * 1024

# Resolution ceilings per Seedance model. Source: the live ModelArk model list
# (docs.byteplus.com/en/docs/ModelArk/1330310, read 2026-09-04) — base 2.0 renders up
# to 4k; Fast and Mini stop at 720p; 2.5 renders 480p/720p/1080p and NOT 4k. The
# codebase knew the ceilings in a comment but never enforced them, so a capped model
# handed a 4k request became an opaque vendor 400 after the user had already waited
# out the render.
_RESOLUTION_ORDER = ("480p", "720p", "1080p", "4k")
_MODEL_MAX_RESOLUTION = {
    "dreamina-seedance-2-0-260128":      "4k",
    "dreamina-seedance-2-0-fast-260128": "720p",
    "dreamina-seedance-2-0-mini-260615": "720p",
    # 2.5 renders 1080p (10-bit) but not 4k. Until 2026-09-04 this row said 720p, on
    # the strength of a 2026-08-04 internal capture that read "1080p: not supported
    # yet"; the live model list now lists 1080p, and the account rendered seven 2.5
    # tasks at 1080p on 2026-09-02 (cgt-20260902154416-w4tt2 … -161947-mgvqv). Verified
    # 2026-09-04 with cgt-20260904152427-w9xn5: 1920×1080, HEVC Main 10, yuv420p10le,
    # 24 fps, 196,425 tokens for 4 s 16:9 — i.e. 10-bit H.265, the same browser-playback
    # caveat as 2.0's 4k (server._needs_h264_preview). 4k is still base 2.0 only, which
    # is why Final Cut's 4k export stays there.
    "dreamina-seedance-2-5-260628":      "1080p",
}

# Per-model multimodal ceilings. Every one of these differs between 2.0 and 2.5, so a
# single hardcoded cap would either silently truncate 2.5's references or send 2.0 a
# payload it rejects with an opaque 400:
#   2.0 → 9 images / 3 videos / 3 audio, 4-15 s, at least one image or video required
#   2.5 → 30 images / 10 videos / 10 audio (the documented 50-material budget), 4-30 s,
#         audio-only input allowed, and `output_format` (mp4|mov) accepted
# Videos and audio additionally cap at 30 s TOTAL across all clips on 2.5 (15 s on 2.0);
# that is a duration budget the caller owns, since we only ever see URLs here.
_SEEDANCE_20_CAPS = {
    "images": 9, "videos": 3, "audios": 3,
    "min_duration": 4, "max_duration": 15,
    "ref_seconds_total": 15, "audio_only": False, "output_format": False,
}
_MODEL_CAPS: Dict[str, Dict[str, Any]] = {
    "dreamina-seedance-2-0-260128":      _SEEDANCE_20_CAPS,
    "dreamina-seedance-2-0-fast-260128": _SEEDANCE_20_CAPS,
    "dreamina-seedance-2-0-mini-260615": _SEEDANCE_20_CAPS,
    "dreamina-seedance-2-5-260628": {
        "images": 30, "videos": 10, "audios": 10,
        "min_duration": 4, "max_duration": 30,
        "ref_seconds_total": 30, "audio_only": True, "output_format": True,
    },
}


def model_caps(model: str) -> Dict[str, Any]:
    """Reference/duration ceilings for `model`.

    An UNKNOWN id degrades to the 2.0 numbers rather than raising, for the same reason
    _assert_model_resolution only warns: the ids are env-overridable and BytePlus ships
    new ones, so a stale table here must never become the thing that blocks a render.
    Degrading DOWN is the safe direction — too few references renders, too many 400s.
    """
    caps = _MODEL_CAPS.get(model)
    if caps is None:
        logger.warning("[Seedance] unknown model %r — applying the conservative 2.0 reference caps", model)
        return _SEEDANCE_20_CAPS
    return caps


def _assert_model_resolution(model: str, resolution: str) -> None:
    """Raise before the HTTP call when `model` cannot render `resolution`.

    An UNKNOWN model id is allowed with a warning, not rejected: the ids are
    env-overridable and BytePlus ships new ones, so a stale table here must never
    become the thing that blocks a render.
    """
    if resolution not in _RESOLUTION_ORDER:
        raise ValueError(
            f"Unsupported resolution {resolution!r} — expected one of {', '.join(_RESOLUTION_ORDER)}"
        )
    ceiling = _MODEL_MAX_RESOLUTION.get(model)
    if ceiling is None:
        logger.warning("[Seedance] unknown model %r — skipping the resolution capability check", model)
        return
    if _RESOLUTION_ORDER.index(resolution) > _RESOLUTION_ORDER.index(ceiling):
        raise ValueError(
            f"{model} cannot render {resolution} — it tops out at {ceiling}. "
            f"Only dreamina-seedance-2-0-260128 renders 4k; it and 2.5 render 1080p."
        )


# ── Where a failed submit died, and therefore whether it can be billed ────────
# A submit that fails leaves exactly one question that costs money: did the request
# bytes reach BytePlus? If they never did, no task was created and nothing can be
# billing. If they did, a task may exist even though we never saw its id.
#
# Those two used to be ONE bucket: every non-HTTP exception out of the POST returned
# decided=False, which is what keeps server.py's submit-intent marker alive, so a
# connection that was REFUSED produced the same "a render may be running and BILLABLE
# right now" as a read timeout. That is not academic on this machine — a corporate VPN
# intercepts TLS, so CERTIFICATE_VERIFY_FAILED against ark.ap-southeast.bytepluses.com
# is a standing condition (measured while writing this) and the alarm fired on POSTs
# that never left the laptop. An alarm that cries wolf gets ignored, which costs
# precisely the real one.
#
# PHASE_PREFLIGHT is returned ONLY when the failure proves the request never left: DNS
# never resolved, the TCP connect never completed, the TLS handshake never finished,
# the URL was unusable. Everything else — a read timeout, a reset after the request was
# written, a 5xx, a body we cannot parse — is PHASE_POSTFLIGHT, because "we sent it and
# heard nothing" is indistinguishable from "they accepted it and the answer was lost".
# The asymmetry is deliberate and one-directional: a wrong "preflight" HIDES a real
# charge, a wrong "postflight" costs one warning.
PHASE_PREFLIGHT = "preflight"
PHASE_POSTFLIGHT = "postflight"

# urllib3 exception classes that can only be raised while a connection is being MADE.
# Matched by class NAME while walking the cause chain requests wraps them in
# (ConnectionError(MaxRetryError(reason=NewConnectionError(...)))), because the classes
# differ across urllib3 versions — NameResolutionError does not exist in 1.x — and an
# import that fails on the wrong one must not take the classifier down with it.
_PREFLIGHT_CAUSES = {
    "NewConnectionError",     # TCP connect refused / host unreachable
    "NameResolutionError",    # DNS (urllib3 2.x; 1.x reports it as NewConnectionError)
    "ConnectTimeoutError",    # connect() itself timed out
    "SSLError",               # TLS handshake, incl. CERTIFICATE_VERIFY_FAILED
    "ProxyError",             # the proxy's own CONNECT failed
}


# ── How long a SUBMIT may take ────────────────────────────────────────────────────────
# A submit is not a small request just because its body is small. Every reference is sent
# as a URL, and BytePlus FETCHES AND VALIDATES each one before it answers — so the wait is
# set by the media attached, not by the JSON. A flat 30 s was the timeout for a text
# submit, and a 20-second reference video blew straight through it
# ("Read timed out. (read timeout=30)", 2026-09-12), which is the worst possible failure
# here: a read timeout is POSTFLIGHT, i.e. the task may already exist and be billing.
#
# So the read budget is built from the content itself. Videos dominate (tens of MB for a
# 20 s 1080p clip); images and audio are small but still a fetch each. Env-overridable
# like every other tuned constant in this file.
_SUBMIT_CONNECT_SECS = float(os.getenv("SEEDANCE_SUBMIT_CONNECT_SECS", "10"))
_SUBMIT_READ_BASE = float(os.getenv("SEEDANCE_SUBMIT_READ_SECS", "45"))
_SUBMIT_READ_PER_VIDEO = float(os.getenv("SEEDANCE_SUBMIT_READ_PER_VIDEO_SECS", "60"))
_SUBMIT_READ_PER_ITEM = float(os.getenv("SEEDANCE_SUBMIT_READ_PER_ITEM_SECS", "10"))
_SUBMIT_READ_CAP = float(os.getenv("SEEDANCE_SUBMIT_READ_CAP_SECS", "300"))


def _submit_timeout(content: Optional[List[Dict[str, Any]]] = None) -> tuple:
    """(connect, read) for a task submit, scaled by the references BytePlus must fetch."""
    items = content or []
    vids = sum(1 for c in items if isinstance(c, dict) and c.get("type") == "video_url")
    others = sum(1 for c in items if isinstance(c, dict)
                 and c.get("type") in ("image_url", "audio_url"))
    read = _SUBMIT_READ_BASE + vids * _SUBMIT_READ_PER_VIDEO + others * _SUBMIT_READ_PER_ITEM
    return (_SUBMIT_CONNECT_SECS, min(read, _SUBMIT_READ_CAP))


def _submit_failure_phase(exc: BaseException) -> str:
    """PHASE_PREFLIGHT when this exception PROVES the request never left the machine;
    PHASE_POSTFLIGHT otherwise — including "cannot tell", which is the whole point."""
    # Unambiguous by class. ConnectTimeout subclasses BOTH ConnectionError and Timeout,
    # so it has to be tested first or it would fall into one of the buckets below.
    if isinstance(exc, (requests.exceptions.ConnectTimeout,
                        requests.exceptions.SSLError,
                        requests.exceptions.ProxyError,
                        requests.exceptions.InvalidURL,
                        requests.exceptions.MissingSchema,
                        requests.exceptions.InvalidSchema,
                        requests.exceptions.URLRequired)):
        return PHASE_PREFLIGHT
    # A read timeout is NOT pre-flight even though nothing came back: the request was
    # fully written before the wait started, so BytePlus may be holding it right now.
    if isinstance(exc, requests.exceptions.ReadTimeout):
        return PHASE_POSTFLIGHT
    # Plain ConnectionError is the ambiguous one and must not be waved through: it
    # covers both "could not connect" and "connection aborted" (RemoteDisconnected /
    # ECONNRESET), and the second happens AFTER the request went out. Only the wrapped
    # urllib3 cause separates them.
    if isinstance(exc, requests.exceptions.ConnectionError):
        cur: Any = exc
        for _ in range(8):          # bounded: __context__ chains can be cyclic
            if cur is None:
                break
            if type(cur).__name__ in _PREFLIGHT_CAUSES:
                return PHASE_PREFLIGHT
            nxt = getattr(cur, "reason", None)          # MaxRetryError.reason
            if not isinstance(nxt, BaseException):
                args = getattr(cur, "args", ())
                nxt = args[0] if args and isinstance(args[0], BaseException) else None
            cur = nxt or cur.__cause__ or cur.__context__
    return PHASE_POSTFLIGHT


def _vision_data_uri(url_or_data: str, timeout: int = 30, max_bytes: int = _VISION_MAX_BYTES) -> str:
    """Like _url_to_data_uri, but GUARANTEES an image payload under the BytePlus
    vision/embedding 10 MB cap — downscales (+ JPEG re-encode) only when needed.
    Non-images (video) and already-small images pass through untouched. Use this
    for every image that goes to vision/embedding; NEVER for Seedance references
    (those need full resolution and their own trust rules)."""
    uri = _url_to_data_uri(url_or_data, timeout=timeout)
    if not uri.startswith("data:image"):
        return uri  # raw-URL fallback or a video → let the caller/API handle it
    try:
        raw = base64.b64decode(uri.split(",", 1)[1])
    except Exception:
        return uri
    if len(raw) <= max_bytes:
        return uri
    try:
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(raw))
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        out = None
        for longest in (2048, 1536, 1280, 1024):
            scale = min(1.0, longest / max(img.size))
            w, h = max(1, round(img.width * scale)), max(1, round(img.height * scale))
            buf = io.BytesIO()
            img.resize((w, h), Image.LANCZOS).save(buf, "JPEG", quality=85)
            out = buf.getvalue()
            if len(out) <= max_bytes:
                logger.info("[Vision] downscaled %dMB → %dKB (%dx%d) for the 10MB cap",
                            len(raw) // (1024 * 1024), len(out) // 1024, w, h)
                break
        if out:
            return "data:image/jpeg;base64," + base64.b64encode(out).decode()
    except Exception as e:
        logger.warning("[Vision] downscale failed (%s) — sending original", e)
    return uri


def resolve_reference_strict(url_or_data: str, timeout: int = 30) -> str:
    """
    Resolve a reference image to a data URI, raising if it cannot be loaded.

    _url_to_data_uri silently falls back to the raw URL on failure, which is
    fine for best-effort callers — but a shot keyframe whose identity reference
    silently drops is exactly how characters drift. Keyframe generation uses
    this strict variant so a dead reference becomes a visible error instead.
    """
    resolved = _url_to_data_uri(url_or_data, timeout=timeout)
    if not resolved.startswith("data:"):
        raise RuntimeError(
            f"Reference image unreachable (expired URL or missing file): {url_or_data[:120]}"
        )
    return resolved


# ─────────────────────────────────────────────────────────────────────────────
# Central prompt assemblers — used by EVERY Seedream/Seedance call.
# These are the ONLY place prompts are assembled; no generation call bypasses them.
# ─────────────────────────────────────────────────────────────────────────────

def assemble_image_prompt(
    raw_description: str,
    style_suffix: str = "",
    extra_context: str = "",
) -> str:
    """
    Central assembler for ALL Seedream prompts.
    Formula: raw_description [+ extra_context] [+ style_suffix]
    Logs the fully assembled prompt so style injection can be verified.
    """
    parts = []
    if raw_description.strip():
        parts.append(raw_description.strip())
    if extra_context.strip():
        parts.append(extra_context.strip())
    if style_suffix.strip():
        parts.append(style_suffix.strip())
    final = ", ".join(p.rstrip(",").strip() for p in parts if p)
    logger.info("[PromptAssembler:Image] ASSEMBLED=%r", final[:160])
    return final


#: Vocabulary for the `[Action] <size>|<move>` tag. Mirrors SHOT_SIZES / CAMERA_MOVES in
#: frontend/lib/types/pipeline.types.ts — keep the two in sync; they are the fields the
#: coverage gates read, and a value outside the set silently disables those checks.
SHOT_SIZES = ("establishing", "wide", "full", "medium", "medium close-up", "close-up",
              "extreme close-up", "insert", "pov", "ots", "two-shot")
CAMERA_MOVES = ("locked", "pan", "tilt", "dolly-in", "dolly-out", "push-in", "tracking",
                "handheld", "crane", "whip-pan", "zoom")

#: Never negotiable, and stated in the POSITIVE prompt because Seedance ignores the
#: `negative_prompt` body field (A/B verified with a fixed seed, 2026-06-10). The BGM ban
#: is not stylistic: each clip otherwise composes its own score, so every cut jumps
#: musically. ByteDance's own Dramagic ships the same line.
_SEGMENT_BANS = ("No subtitles, text overlays, text-only screens, BGM, or background "
                 "music are allowed to appear in the video.")


# ── What each attached reference is FOR ───────────────────────────────────────────────
#
# HELL GRIND rule (quoted from the production brief): "When you feed assets to Seedance,
# name the role of every reference… or the model decides by itself, and decides wrong: it
# copies the composition instead of the face, or the face instead of the color palette."
# Their form is a named handle per asset — `@roco` for character reference, `@loc_cave_front`
# for location reference — and location references get an explicit ban: "do not use as a
# starting frame, do not inherit the composition, the angle or the color — take only the
# space and the texture."
#
# WHY IT APPLIES HERE: Take One Studio attaches up to nine reference images per Seedance call — a
# character sheet, an environment, the storyboard frame, props, the previous shot's closing
# frame, style anchors — and until now the SEGMENT and CLASSIC assemblers stated nothing
# about any of them. The frontend does build a `<Image_N> = <label>` list (FinalGenView's
# refAddressing) but it only reaches the two Claude direction writers; both assemblers in
# this module received the pictures with no statement of what each one was for.
#
# The ADDRESS stays `<Image_N>` — that is the syntax the Seedance prompt guide documents
# (§2.3) and the one refAddressing already uses. The Hell Grind `@handle` rides alongside
# it as an alias so the action text ("Tomás reaches across…") and the reference list use
# the same name for the same asset.
#
# An unknown kind gets NO invented instruction: it falls back to the label the caller
# already wrote. Making up a role for a reference nobody classified would be the same class
# of error as making up a duration.
SEEDANCE_REF_ROLES: Dict[str, str] = {
    "character": ("CHARACTER reference — take the face, hair, build and wardrobe from it. "
                  "Do not copy its pose, its framing or its background"),
    # The one with the explicit ban, quoted almost verbatim from the brief. This is the
    # reference the model most often mis-uses, because an environment plate looks like a
    # perfectly good first frame.
    "location":  ("LOCATION reference — take ONLY the space and the texture from it. Do not "
                  "use it as a starting frame, do not inherit its composition, its camera "
                  "angle or its colour"),
    # EL TABLERO ES EL TIRO DE CÁMARA Y EL MOVIMIENTO. NADA MÁS.
    #
    # Este rol llegó a tener siete líneas, y seis eran prohibiciones: "no identity, no
    # faces, no lighting, no texture, no colour, no drawing style", y después un párrafo
    # entero nombrando el medio — graphite, pencil strokes, hatching, paper grain,
    # smudged shading, flat greys. Todas escritas para IMPEDIR el acabado a lápiz.
    #
    # Medido en los prompts reales de BLACKMIRROR 4 (2026-08-31): el medio del dibujo se
    # nombraba 14-15 veces por prompt, y las tomas que salieron pintadas fueron justo las
    # cuatro de la rehén — SHOT_021, 025, 027 y la pantalla de 018. Un modelo de vídeo no
    # procesa la negación de forma fiable: escribir "pencil" para prohibirlo mete "pencil"
    # en el prompt. La prosa anti-lápiz era la que estaba invocando el lápiz.
    #
    # La decisión del usuario, y es la correcta: el tablero sirve para UNA cosa, el tiro
    # de cámara y el movimiento, y el rol dice eso y se calla. Lo demás se nombra en
    # positivo — de dónde SÍ sale cada cosa — en vez de con una lista de noes. Queda una
    # sola frase acotando el papel (plan, no fotograma) porque lo que evitaba era que la
    # toma ABRIERA sobre el tablero, que es un fallo de rol y no de medio.
    #
    # EL ORDEN DE LECTURA lo exige la plantilla oficial (sd25-pe, seccion 'Storyboard
    # Grids'): "@Image 1 provides an <N-panel storyboard grid> ... Read it <left to
    # right, top to bottom>". Nunca lo habiamos mandado, y sin el una rejilla de 2x2 no
    # dice cual de las cuatro vinetas va primera. La misma plantilla lleva ademas una
    # exclusion de estilo de UNA linea; aqui se omite a proposito: nuestro tablero es
    # grafito, no line art, asi que esa frase tendria que nombrar el grafito — y el A/B
    # de 2026-08-31 (SHOT_021 y SHOT_025 rerodados a 720p con el mismo tablero y las
    # mismas referencias) muestra que sin ninguna mencion del medio el acabado sale
    # fotografico. Se reevalua si el tablero pasa alguna vez a line art limpio, que es
    # lo que la guia recomienda.
    #
    # LAS FLECHAS. Al vaciar este rol se fue tambien la unica frase que impedia que
    # los simbolos del tablero acabaran DENTRO del plano, y el 2026-08-31 SHOT_018
    # volvio con la flecha convergente de push-in y la cruz de tilt grabadas sobre la
    # mesa de la sala de reuniones — 1 de 4 tomas rerodadas, y justo la del plano con
    # una superficie grande y vacia donde caber. La guia lo ordena con estas palabras
    # en 'Space and Blocking': "Do not reproduce arrows, annotation boxes, or
    # explanatory text from the diagram in the output video", y la plantilla de
    # 'Storyboard Grids' repite "text labels". Se nombran las FLECHAS y las
    # ANOTACIONES, que es lo que hay que excluir; no el medio del dibujo, que es lo
    # que invocaba el lapiz.
    #
    # DOS COSAS: PERSPECTIVA DE CÁMARA Y MOVIMIENTO. Nada más.
    #
    # Este rol se fue engordando hasta cerrar con una enumeración de treinta palabras
    # ("Everything else comes from elsewhere: the people from the character references,
    # the place from the location reference, the action and the look from the written
    # description") que no dice nada que los otros roles no digan ya en su sitio. El
    # principio 4 del contrato lo desaconseja: "Once a slot is covered, do not add an
    # unmentioned material merely to reinforce the same role". Y cuanto más largo es este
    # rol, más pesa el tablero en un prompt donde su trabajo es el más pequeño de todos.
    #
    # Lo que queda es lo que alguien tendría que volver a añadir si lo quitara:
    #   · "plan de cámara, no un fotograma" — sin eso la toma ABRE sobre el tablero;
    #   · el vocabulario de las flechas — es el decodificador del "movimiento", sin él
    #     nuestra convención de flechas no significa nada para el modelo;
    #   · no reproducir flechas ni anotaciones — lo ordena la guía en "Space and Blocking"
    #     y sin esa frase los símbolos acaban dibujados dentro del plano (medido);
    #   · el orden de lectura — lo exige la plantilla de "Storyboard Grids".
    "board":     ("STORYBOARD reference — the CAMERA PLAN for this take, not a frame of "
                  "the film. Use it for one thing: the camera. Its shot size, its angle "
                  "and height, where each subject sits in the frame, and the move its "
                  "arrows draw (horizontal = pan or lateral travelling, vertical = tilt, "
                  "converging = push in, diverging = pull out, vibration strokes = "
                  "handheld). Never reproduce its arrows, annotation marks or text in the "
                  "output video. Read its panels in order, left to right and top to "
                  "bottom, as the consecutive stages of this one take"),
    # LO QUE SE VE DENTRO DEL OBJETO SALE DE AQUÍ, NO DEL BOARD. Un prop con superficie
    # —una pantalla, un monitor, un marco, un espejo— aparece dibujado a lápiz en el
    # storyboard, y el board y esta lámina describen entonces el MISMO rectángulo. Medido
    # en BLACK MIRROR V3: de 14 tomas, 12 salieron fotorrealistas limpias y las dos de
    # SHOT_040 salieron mezcladas siempre en el mismo sitio — "la mujer del monitor tiene
    # apariencia dibujada, con trama de lápiz y textura de papel". El modelo tomó esa
    # región del board. La regla del board ya dice que no se le copie el estilo; ésta dice
    # de dónde SÍ sale, que es la mitad que faltaba.
    "prop":      ("PROP reference — take the object's design, scale and materials, nothing "
                  "else. If the object has a screen, a display, a photograph or any surface "
                  "showing an image, WHAT IS ON IT comes from this reference and from the "
                  "written description. "
                  # UNA PANTALLA ES UN OBJETO, NO UNA PROYECCIÓN. Medido en BLACKMIRROR 4
                  # SHOT_018: la pantalla de la sala de crisis salió como una imagen gigante
                  # semitransparente fundida con el panelado de madera y un resplandor naranja
                  # sobre la mesa — un holograma donde el tablero dibuja un monitor con marco.
                  # El rol decía QUÉ se ve en ella y nunca que tuviera bordes.
                  "A screen is a solid object with a frame and a hard edge: its picture stays "
                  "inside it, lights only what is near it, and never spreads across the wall, "
                  "floats in the air or becomes a projection or a hologram"),
    "wardrobe":  "WARDROBE reference — take the garment's cut, colour and materials, nothing else",
    # LA CÁMARA SE HA MOVIDO; EL MUNDO NO. Esta referencia decía "iguala su iluminación y
    # su gradación ÚNICAMENTE; no repitas su composición" — acotada al color para que el
    # corte no pareciera el mismo plano repetido, y esa misma acotación PROHIBÍA lo único
    # que sostiene la continuidad: dónde está cada cosa. Medido en BLACK MIRROR V3: al
    # encadenar los renders por escena el fotograma pasó de llegar en 1 de 8 juntas a 7 de
    # 7, y las roturas no bajaron — un hombre y su mesilla siguieron cambiando de lado de
    # la cama entre dos planos. Llegaba con instrucciones de ignorarlo.
    #
    # La distinción que faltaba: no repetir el ENCUADRE no es lo mismo que no conservar la
    # ESCENA. El nuevo plano se ve desde otro sitio y a otro tamaño; la habitación, la
    # gente y los objetos siguen donde ese fotograma los deja.
    #
    # SIN MUEBLES INVENTADOS. Esta frase llegó a decir "the same side of the bed, the same
    # chair, the same side of the room": ejemplos sacados de la continuidad de UN plano de
    # dormitorio y luego cableados en un rol que se emite en todos los planos de todos los
    # proyectos. El resultado, visto en prompts reales, es una sala de reuniones a la que
    # se le ordena conservar "el mismo lado de la cama". Nombrar un mueble que no está en
    # la escena es pedirle al modelo que lo invente para poder obedecer. La regla se dice
    # sin ejemplos concretos: el sitio de cada cosa lo da el fotograma adjunto, no esta
    # frase.
    "continuity": ("CONTINUITY reference — the closing frame of the shot immediately "
                   "before this one, the same place a moment earlier. The camera has "
                   "moved; the world has NOT. Every person and every object stays exactly "
                   "where this frame puts them, against the same furniture and on the same "
                   "side of the room, and its lighting and colour grade carry over. Nobody "
                   "may move to a place this frame does not put them unless the written "
                   "action shows them moving there. Do NOT reuse its framing: "
                   "this shot is seen from its own angle and shot size"),
    "style":     ("STYLE reference — take the rendering medium, palette and grain from it. "
                  "Take no object, person, layout or location from it"),
    "first_frame": "the STARTING FRAME of this take — the shot opens on it",
    "fx":        ("EFFECT reference — take the look of the effect itself (its shape, colour "
                  "and behaviour), nothing else"),
    "motion":    ("MOTION reference — replicate its movement, timing and camera path. Take no "
                  "subject, location or colour from it"),
    # A performance is two signals, and one role could only ever address them as one. The
    # 2.5 capability table lists motion reference as "actions, expressions, camera
    # movement", i.e. body and face together — so a clip of a body and a clip of a face
    # both arrived under a sentence that says "movement, timing and camera path", and the
    # face clip's expression work had nothing addressing it. Split so each clip is told
    # what to take, and — the half that matters more — what NOT to take: a face clip that
    # is allowed to carry identity overwrites the character sheet.
    "motion_body": ("BODY MOTION reference — replicate the whole-body performance it shows: "
                    "posture, gait, gesture, weight, and the timing of every move. Take no "
                    "face, identity, clothing, location or colour from it"),
    "motion_face": ("FACIAL MOTION reference — replicate the facial performance it shows: "
                    "expression, eyeline, blinks, brow, and the timing of the mouth. Take no "
                    "identity, hair, clothing, location or colour from it — the face that "
                    "performs is the one the character sheet defines"),
}

# Every kind that is addressed as @Video N rather than @Image N. A kind missing from here
# silently numbers a video among the images, which shifts every image address after it.
MOTION_KINDS = ("motion", "motion_body", "motion_face")


def assemble_unused_materials(unused: Optional[List[str]]) -> str:
    """PURE. `[Unused Materials]` — the scene's approved subjects this take does NOT show.

    WHY. sd25-pe non-negotiable principle 3: "List every available but unassigned material
    individually under `[Unused Materials]` so downstream PE does not reactivate it." Without
    it the model is free to walk a character the scene established into a take they are not
    in — Garth appearing in a two-hander between Moe and Barb — or to tint the shot with
    another location's palette. It is the mirror of the reference loss fixed in a7aa652:
    that was subjects MISSING from a prompt that named them; this is subjects appearing in a
    prompt that never asked for them.

    ONE DELIBERATE DEVIATION, stated so nobody "fixes" it back. The contract's own examples
    address unused material by NUMBER (`@Images 5 and 6`), because it assumes every candidate
    was uploaded and some were left unassigned. Take One Studio never uploads what a take does not
    use, so those assets have no number to cite — naming a number that was not sent would be
    an address pointing at nothing, which the same contract calls a direct cause of character
    confusion. They are therefore named, and the wording says plainly that they are not
    attached.

    Scope is the SCENE, not the project, by the user's decision (2026-08-09): the contract
    warns against padding a prompt with inactive material, and cross-scene assets are not
    what bleeds into a take.

    Returns "" when nothing is unused, so the prompt is unchanged in that case.
    """
    names = [n.strip() for n in (unused or []) if isinstance(n, str) and n.strip()]
    if not names:
        return ""
    if len(names) == 1:
        listed, verb = names[0], "is"
    else:
        listed, verb = ", ".join(names[:-1]) + f" and {names[-1]}", "are"
    return ("[Unused Materials]\n"
            f"{listed} {verb} approved elsewhere in this scene but {verb} NOT attached to "
            "this take. They must not appear in it, and must not define any person, scene, "
            "prop, action, camera treatment or audio.")


_CAST_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
               7: "seven", 8: "eight", 9: "nine", 10: "ten"}


def assemble_cast_consistency(references: Optional[List[Dict[str, str]]]) -> str:
    """PURE. The `[Maintain Consistency]` block — WHO is in the take and HOW MANY. "" when
    no character reference is attached.

    Take One Studio never emitted this block at all, and the omission is visible in the footage:
    a take with three character sheets rendered FOUR people, one of them a second copy of
    Barb (2026-08-12, SCENE_TURNS_3V). Naming three subjects does not tell the model there
    are exactly three; the contract's template carries the count as its own clause —
    "Keep <character identities AND COUNT, clothing, prop ownership, spatial direction,
    and audio relationships> consistent" — and its multi-view section says plainly to
    "state the number of entities that must appear in the output".

    Written as a POSITIVE statement of the cast, never as "do not duplicate anyone".
    Principle 8 forbids exactly that: "Do not automatically add unrequested quality or
    stability boilerplate, watermarks, logos, subtitles, DUPLICATE-SUBJECT RESTRICTIONS,
    or other generic negative constraints." Saying who is present is specific and
    requested; a blanket anti-duplication negative is the boilerplate it bans.
    """
    names = [str(r.get("name") or "").strip() for r in (references or [])
             if isinstance(r, dict) and str(r.get("kind") or "").strip().lower() == "character"]
    names = [n for n in names if n]
    if not names:
        return ""
    n = len(names)
    who = names[0] if n == 1 else ", ".join(names[:-1]) + f" and {names[-1]}"
    count = _CAST_WORDS.get(n, str(n))
    person = "person" if n == 1 else "people"
    # Agreement matters here: this text goes to a language model, and "one person appear"
    # is the kind of malformed clause that makes the whole sentence easier to ignore.
    # NAMED cast, not total population. "No one else is present" was a flat contradiction
    # of the take's own beats whenever the scene has extras: BLACK MIRROR SHOT_029 described
    # a briefing room of seated aides and then closed with "Exactly one person appears in
    # this take: Section Chief Walker. No one else is present." Two mutually exclusive
    # orders in one prompt, and the render answered with a room of frozen strangers and a
    # cut to an empty room. The clause exists to stop DUPLICATION (three sheets rendering a
    # fourth person, SCENE_TURNS_3V) — that is about the referenced identities, and it
    # survives here intact. Bodies nobody named are the director's business, not this
    # block's; what they must not do is wear a face the film has cast.
    # ...and ALIVE. This clause said only what a background figure must not be, so the
    # render gave the take a room of people holding perfectly still — measured on
    # BLACKMIRROR 4 SHOT_013 with seed-2.0-lite watching the clip: "the six matching suited
    # men seated on both sides of the conference table are completely statue-still, no
    # movement". The comment above records the same symptom from an earlier film; what was
    # fixed then was the duplication and the empty room, not the stillness. The segment
    # branch — the one every real film takes — carries no anti-freeze line at all: "Motion
    # begins in the first frame" lives in the CLASSIC assembler only. This is not a blanket
    # constraint of the kind principle 8 forbids: it is performance direction about people
    # already in frame, in the clause that already describes them.
    extras = ("Anyone else in frame is an unnamed background figure: keep their faces "
              "away from camera or unresolved, and never give them the face of a named "
              "character. They are alive — breathing, shifting their weight, reacting to "
              "what is happening in front of them. An unresolved face is not a still body. "
              # ...and not the SAME body six times. With no reference of their own, the
              # model reuses the one face it was given: seed-2.0-lite on BLACKMIRROR 4
              # SHOT_013 called them "the row of identical suited doppelgängers" — six men
              # at a cabinet table wearing one face between them. Telling them apart costs
              # nothing here; nothing else in the prompt asks for it.
              "No two of them share a face, a build, an age or a hairline: they are "
              "different people who happen to be dressed alike.")
    if n == 1:
        head = (f"One named character appears in this take: {who}, and {who} appears exactly "
                f"once. {extras}")
        tail = "Keep their identity, clothing and spatial position consistent throughout."
    else:
        head = (f"{count.capitalize()} named {person} appear in this take: {who}. Each of "
                f"them appears exactly once. {extras}")
        tail = ("Keep their identities, clothing, count and spatial positions consistent "
                "throughout.")
    return f"[Maintain Consistency]\n{head}\n{tail}"


def assemble_scene_audio_role(speakers: Optional[List[str]], at_addressing: bool = False) -> str:
    """PURE. ONE attached clip carrying SEVERAL voices — the scene-mode dialogue take.

    assemble_audio_roles says "@Audio 1 defines X's voice" and assumes one clip per
    speaker, which is what per-line mode produces. Scene mode renders the whole exchange in
    a single Seed Audio call for the sake of the interplay, so there is nothing to split:
    _spk_clips stays empty and, until this existed, no role was emitted at all. Measured on
    BLACKMIRROR 4 SHOT_009 — "SCENE mode, 5 line(s), 2 speaker(s)" — Seedance received one
    unlabelled track holding both Jane and Michael, which is the exact failure the roles
    exist to prevent.

    Naming one speaker over a clip that holds two would be a false label, so the sentence
    says what is true: one clip, these voices, in the order written. "" when there is
    nothing to name.
    """
    names = [str(s or "").strip() for s in (speakers or [])]
    names = [n for n in names if n]
    if not names:
        return ""
    addr = "@Audio 1" if at_addressing else "<Audio_1>"
    who = names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" and {names[-1]}"
    return (f"{addr} is a single reference take of this scene's dialogue and carries the "
            f"voices of {who}, in the order the lines are written. Take each character's "
            f"voice characteristics, accent, pace and emotional delivery from the part of "
            f"it that is theirs. Take the words from the written dialogue, not from this "
            f"clip.")


def assemble_audio_roles(speakers: Optional[List[str]], at_addressing: bool = False) -> str:
    """PURE. Name what each ATTACHED audio reference is FOR. "" when none are attached.

    `speakers` are the character names in ATTACHMENT ORDER — the same order the audio
    content items are appended in, because `@Audio N` addresses the Nth attachment, not the
    Nth entry of any list we happen to hold.

    Until now nothing emitted this. The clips were attached (when they arrived at all — see
    `_audio_data_uri`) and the prompt never said whose voice they were, so the model was
    handed an unlabelled voice and left to guess who it belonged to. The sd25-pe template is
    explicit about the form:

        @Audio 1 defines <character or sound type>'s <voice characteristics, dialogue,
        ambience, or music>.

    "voice characteristics", not the take: the contract states that by default a reference
    audio supplies only voice characteristics, accent, speed and emotion, and the words come
    from the `{}` dialogue written into the action. Confirmed by ear 2026-08-12 — a Seed
    Audio identity clip bound this way came back in the render as that character's voice.
    """
    names = [str(s or "").strip() for s in (speakers or [])]
    names = [n for n in names if n]
    if not names:
        return ""
    lines = []
    for i, name in enumerate(names, start=1):
        addr = f"@Audio {i}" if at_addressing else f"<Audio_{i}>"
        lines.append(f"{addr} defines {name}'s voice characteristics, accent, pace and "
                     f"emotional delivery. Take the words from the written dialogue, not "
                     f"from this clip.")
    return "\n".join(lines)


def assemble_subject_profiles(subjects: Optional[List[Dict[str, str]]],
                              at_addressing: bool = False) -> str:
    """PURE. `[Subject Profile: NAME]` blocks — who each character IS, bound to their picture.

    WHY this exists (2026-08-09). The ACTING SKILL writes a 150-220 word master profile per
    recurring character at breakdown time — physique as biography, the psychological engine,
    vocal profile, tics WITH their triggers, eye life, a named gait, and the "However, when
    X" clause that cracks the mask. §8.6 says to "lead with the character's reference tag…
    so the model binds the acting to the right person". None of it ever reached Seedance:
    the render got the per-beat `performance` (what the character does in THIS moment) and
    nothing about who they are, which is why the acting reads as generic — the complaint
    that opened this whole thread.

    The sd25-pe contract has the matching slot: `[Subject Profile: Character A]`, listing a
    subject's fixed attributes and its reference. Putting the master profile there resolves
    the tension between the two guides — the profile is stated ONCE, so the per-beat text
    can still keep to the "small number of the clearest cues" the contract asks for instead
    of piling micro-expressions onto every shot.

    `subjects` items: {name, acting, addr} where `addr` is the 1-based index of that
    character's reference image, or 0/absent when they have no picture attached. Returns ""
    when nothing has a profile, so a project whose breakdown predates the acting pass
    assembles exactly the prompt it assembles today.
    """
    items = [s for s in (subjects or []) if isinstance(s, dict) and (s.get("acting") or "").strip()]
    if not items:
        return ""
    out: List[str] = []
    for s in items:
        name = (s.get("name") or "the character").strip()
        acting = " ".join((s.get("acting") or "").split())
        # Sólo en 2.5: la prohibición de cadencias es de SU página oficial. La guía de 2.0
        # habla de "degree quantification" pero referida a rango, velocidad y fuerza
        # ("slowly raise a hand", "push hard off the ground"), y no dice nada de
        # frecuencias por unidad de tiempo. Silencio no es respaldo, pero tampoco es
        # motivo para cambiar una rama cuyo comportamiento está medido: cada versión
        # sigue su propia guía.
        if at_addressing:
            acting = _strip_frequency_directions(acting)
        try:
            n = int(s.get("addr") or 0)
        except (TypeError, ValueError):
            n = 0
        # The reference tag leads, per ACTING SKILL §8.6 — the profile is useless if the
        # model cannot tell which attached face it describes.
        if n > 0:
            addr = f"@Image {n}" if at_addressing else f"<Image_{n}>"
            out.append(f"[Subject Profile: {name}]\nAppearance: {addr}. Acting: {acting}")
        else:
            out.append(f"[Subject Profile: {name}]\nActing: {acting}")
    # QUIÉN MANDA CUANDO SE CONTRADICEN. Un perfil describe la COSTUMBRE de un personaje
    # ("su mirada no se aparta de quien le habla", "mira siempre por encima de la cabeza
    # del oyente"), y la acción de la etapa describe lo que pasa AHORA ("todas las miradas
    # fijas en la pantalla"). Emitimos las dos y nunca dijimos cuál gana, así que un plano
    # con cuatro personajes puede llegar con cinco órdenes incompatibles sobre dónde mira
    # la gente y el modelo tiene que desobedecer casi todas.
    #
    # No es boilerplate de los que prohíbe el principio 8: no añade una restricción nueva,
    # resuelve una ambigüedad entre dos cosas que ya escribimos nosotros.
    # 2.5 sólo, por la misma razón: es la rama cuyo prompt lleva `[Event Script]` con
    # acciones por etapa, y por tanto la que puede contradecirse consigo misma. En 2.0 no
    # se añade una frase que su guía no pide y cuya ausencia está medida.
    if out and at_addressing:
        out.append("These profiles describe each character's habits. Where a stage's "
                   "action says what someone does or where they look, the action wins.")
    return "\n".join(out)


#: Cadencias por unidad de tiempo dentro de una descripción de actuación: "blinks exactly
#: once every seven seconds", "pace locked to three syllables per second", "blink rate
#: doubling once every three sentences". La página oficial de 2.5 las prohíbe por su
#: nombre — "Do not use timestamps for frequency ('shake your head 3x per second')" — y no
#: son inofensivas: un modelo de vídeo no puede rendir una cadencia, así que la frase
#: ocupa atención sin producir imagen, y dos personajes distinguidos por "una vez cada
#: siete segundos" frente a "dos veces cada siete" se piden diferenciar por una cantidad
#: que no se ve. El perfil se recorta al emitirlo, no al escribirlo, para que los
#: proyectos ya escritos también se beneficien.
_FREQ_DIRECTION = re.compile(
    r",?\s*(?:and\s+)?[^,.;]*?\b(?:once|twice|three times|\d+\s*(?:x|times))\b[^,.;]*?"
    r"\bevery\s+(?:\w+|\d+)\s*(?:second|seconds|sentence|sentences|beat|beats)\b[^,.;]*"
    r"|,?\s*(?:and\s+)?[^,.;]*?\b(?:locked to|at)\s+(?:\w+|\d+)\s+"
    r"(?:syllables?|words?|beats?)\s+per\s+second\b[^,.;]*",
    re.I)


def _strip_frequency_directions(text: str) -> str:
    """Quita de un perfil las cadencias por unidad de tiempo. Ver `_FREQ_DIRECTION`.

    Conservador por diseño: recorta la cláusula, no la frase, y si el resultado quedara
    vacío o casi, devuelve el texto original — un perfil mutilado es peor que uno con una
    cadencia que el modelo ignorará.
    """
    if not text:
        return text
    out = _FREQ_DIRECTION.sub("", text)
    out = re.sub(r"\s+([,.;])", r"\1", out)
    out = re.sub(r"([,;])\s*([,.;])", r"\2", out)
    # Cuando la cadencia abría la frase, el recorte deja la coma colgando ("…, gaze never
    # wavers…"). Se quita el separador huérfano y se recapitaliza, o el arreglo mete un
    # defecto de texto donde quitaba otro.
    out = re.sub(r"(?:^|(?<=\. ))\s*[,;]\s*", "", out)
    out = re.sub(r"\s{2,}", " ", out).strip()
    out = re.sub(r"(?:^|(?<=\. ))([a-z])", lambda m: m.group(1).upper(), out)
    return out if len(out) >= max(40, len(text) // 2) else text


def reference_handle(name: str, kind: str = "") -> str:
    """`@loc_glass_conference_room` / `@char_tomas` — the Hell Grind handle for one asset.

    PURE. Prefix by kind so two assets that share a name (a prop and the location it sits
    in) cannot collapse to the same handle. Non-alphanumerics fold to underscores because
    the handle is read back by the model as one token.
    """
    prefix = {"character": "char", "location": "loc", "board": "board", "prop": "prop",
              "wardrobe": "fit", "continuity": "prev", "style": "style",
              "first_frame": "frame", "fx": "fx", "motion": "motion",
              "motion_body": "body", "motion_face": "face"}.get(kind, "ref")
    slug = "".join(c.lower() if c.isalnum() else "_" for c in (name or kind or "ref"))
    while "__" in slug:
        slug = slug.replace("__", "_")
    slug = slug.strip("_") or "ref"
    # A handle is a NAME the model can hold, not a sentence. A caller that has no asset
    # name falls back to the label, and one BLOOM label produced
    # `@prev_the_closing_frame_of_the_previous_shot_match_its_lighting_and…` — 4 words is
    # the cap that keeps it a token.
    slug = "_".join(slug.split("_")[:4])
    return f"@{prefix}_{slug}"


def assemble_reference_roles(references: Optional[List[Dict[str, str]]],
                             at_addressing: bool = False) -> str:
    """PURE. Turn the ordered list of ATTACHED references into the block that names each
    one and what it is for. Returns "" when there is nothing attached.

    `references` items: {kind, name, label} — `kind` keys SEEDANCE_REF_ROLES, `name` seeds
    the handle, `label` is the caller's own wording and is the ONLY thing said about a
    reference whose kind is unknown. Order MUST match the attachment order the request
    actually sends, because the address counts attachments, not list entries.

    `at_addressing` switches `<Image_N>` → `@Image N` for Seedance 2.5. That is not
    cosmetic: 2.5's own prompt contract assigns `<>` a different job — it is the
    sound-effect delimiter, alongside `{}` for dialogue, `()` for music and `【】` for
    subtitles — and states plainly that subject names must not also live in angle brackets
    "so one symbol does not perform two roles". 2.0 keeps `<Image_N>`, the form ITS guide
    documents, so no 2.0 prompt changes by a byte.
    """
    items = [r for r in (references or []) if isinstance(r, dict)]
    if not items:
        return ""
    lines = ["References — each attached file is listed with what it is FOR. Use each one "
             "ONLY for its stated purpose:"]
    # Images and videos are numbered on SEPARATE counters: Seedance addresses them as
    # <Image_N> and <Video_N>, and create_video_task sends them as different content-item
    # types, so one shared counter would hand the model an address that does not exist.
    n_img = n_vid = 0
    for r in items:
        kind = str(r.get("kind") or "").strip().lower()
        role = SEEDANCE_REF_ROLES.get(kind, "")
        name = str(r.get("name") or "").strip()
        label = str(r.get("label") or "").strip().rstrip(".")
        handle = reference_handle(name or label or kind, kind)
        what = role or (label or "reference")
        # The label survives next to the role: it carries the ASSET ("Tomás's face", "the
        # DEPOT - YARD setting") while the role carries the INSTRUCTION. Dropping it would
        # trade a named reference for a typed one.
        detail = f" — {label}" if (role and label) else ""
        if kind in MOTION_KINDS:
            n_vid += 1
            addr = f"@Video {n_vid}" if at_addressing else f"<Video_{n_vid}>"
        else:
            n_img += 1
            addr = f"@Image {n_img}" if at_addressing else f"<Image_{n_img}>"
        # NINGÚN ID INTERNO EN EL CUERPO DEL PROMPT. El paréntesis emitía el slug de
        # nuestro almacén, p. ej. `@Image 1 (@char_jane_doe_shocked_at) = …`, y el
        # contrato lo prohíbe dos veces: "The final Prompt must not expose raw Asset IDs"
        # y, en su checklist final, "The Prompt body contains no unavailable material
        # number or raw Asset ID".
        #
        # El daño es concreto: el modelo recibe DOS tokens con @ por cada material y nada
        # que le diga que son el mismo. Esa es la condición de mapeo mal numerado que la
        # página oficial ata a "character confusion or duplication", y se paga justo en
        # los planos con varias caras que separar. Además `reference_handle` trunca el
        # slug a cuatro palabras, así que la cola que queda ("…shocked_at") se lee como
        # una instrucción a medias.
        #
        # En 2.0 se conserva: su guía direcciona con `<Image_N>` y el handle es la forma
        # en que ese prompt nombra al sujeto cada vez que lo menciona.
        lines.append(f"{addr} = {what}{detail}." if at_addressing
                     else f"{addr} ({handle}) = {what}{detail}.")
    # The contract carries this in EVERY multi-character example, and it is the one
    # instruction that names the failure directly: "Do not interchange the two characters'
    # appearances, clothing, actions, or dialogue." Naming each reference says what each
    # one IS; this says they must not trade places — a different claim, and the one that
    # matters once a take has three faces and three voices to keep straight.
    if sum(1 for r in items if str(r.get("kind") or "").strip().lower() == "character") > 1:
        lines.append("Do not interchange these characters' appearances, clothing, actions, "
                     "or dialogue.")
    return "\n".join(lines)


#: A board panel's FOV degrees live inside `shot_type` ("Neutral medium shot, 47° FOV.").
#: Measured on BLOOM's 148 panels: of the 163 degree-values a board carries, 132 sit in
#: that one field (green 16, red 8, desc 4, blue 3) — so a merge that skips `shot_type`
#: skips 81% of the numbers _SEEDANCE_UNITS exists to produce.
_FOV_DEGREES = None   # compiled lazily in _beat_fov (this module has no top-level `re`)


def _beat_fov(beat: Dict[str, Any]) -> str:
    """The FOV degrees a panel committed to, or "". ONLY the number is lifted out of
    `shot_type`: the size WORDS in the same string ("Neutral medium shot") restate the
    shot's own `shotSize` token, and a second size statement can only fight the first."""
    global _FOV_DEGREES
    if _FOV_DEGREES is None:
        import re
        _FOV_DEGREES = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*°")
    m = _FOV_DEGREES.search(str(beat.get("shot_type") or ""))
    return f"{m.group(1)}°" if m else ""


def _beat_time(beat: Dict[str, Any]) -> Optional[tuple]:
    """`"5-10.5s"` → (5.0, 10.5); None when the panel carries no readable range."""
    import re
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*s",
                 str(beat.get("time") or ""))
    return (float(m.group(1)), float(m.group(2))) if m else None


def shot_dur(shot: Dict[str, Any]) -> float:
    """One declared shot's length in seconds. `duration_sec` (singular) is the breakdown's
    own key — the one the frontend actually sends; the other two spellings reach here from
    the storyboard and the queue worker. ONE implementation because three call sites
    (the beat windows, the `Shot{i} {dur}s` line and the mismatch report) have to agree
    exactly: a shot list built on 3.0s defaults and a beat grid built on the real numbers
    would mis-assign every panel after the first."""
    return float(shot.get("duration_sec") or shot.get("durationSecs")
                 or shot.get("duration_secs") or 0) or 3.0


def shot_windows(shots: List[Dict[str, Any]]) -> List[tuple]:
    """PURE. The (start, end) second each declared shot occupies inside the segment."""
    out: List[tuple] = []
    t = 0.0
    for sh in (shots or []):
        d = shot_dur(sh)
        out.append((t, t + d))
        t += d
    return out


def beats_by_shot(shots: List[Dict[str, Any]],
                  beats: Optional[List[Dict[str, Any]]]) -> List[List[Dict[str, Any]]]:
    """PURE. Group a board's panels under the segment shot each one belongs to.

    Matched by TIME, not by index, and that is not a nicety: phase 4 builds a segment's
    beat grid FROM the sub-shot durations (claude_agents.storyboard_panels — "when the
    shot is a SEGMENT, its own shots ARE the beats"), so the two schedules are the same
    schedule and the overlap is exact. But the same function inserts an extra "0-1s"
    OPENING WIDE panel on the first shot of a scene, which makes len(panels) ==
    len(shots) + 1 — an index match would then be off by one for every later cut of that
    segment. Measured on BLOOM's 23 boarded segment cards: time-matching agrees with
    index-matching on all 22 where the counts are equal, and is the only rule that has an
    answer for the 23rd (SHOT_004: a stale 4-panel board covering 0-5s against 2 shots
    totalling 9.5s → all 4 panels land on shot 1, and shot 2 is left un-annotated rather
    than annotated with a board that never described it).

    Falls back to positional matching only when NO panel carries a readable time and the
    counts happen to agree; otherwise the panels are dropped, because a wrong match writes
    one shot's lighting and framing onto another one.
    """
    groups: List[List[Dict[str, Any]]] = [[] for _ in (shots or [])]
    items = [b for b in (beats or []) if isinstance(b, dict)]
    if not items or not shots:
        return groups
    windows = shot_windows(shots)
    times = [_beat_time(b) for b in items]
    if all(x is not None for x in times):
        for b, (b0, b1) in zip(items, times):
            best, best_ov = 0, -1.0
            for i, (s0, s1) in enumerate(windows):
                ov = min(b1, s1) - max(b0, s0)
                if ov > best_ov:
                    best, best_ov = i, ov
            groups[best].append(b)
    elif len(items) == len(shots):
        for i, b in enumerate(items):
            groups[i].append(b)
    else:
        logger.warning("[PromptAssembler:Segment] %d panel(s) vs %d shot(s) and no readable "
                       "times — board annotations dropped rather than mis-assigned",
                       len(items), len(shots))
    return groups


#: A shot has exactly ONE state to assert, so when several panels time against it exactly
#: one of them can speak — and only if it is really describing that shot rather than a
#: sliver of it. "Really describing it" is defined, not tuned: MORE THAN HALF the shot's
#: running time. It is a definition of majority, not a threshold anyone measured a curve
#: for, and the two shapes it separates are both real:
#:   * the scene's OPENING WIDE (claude_agents.storyboard_panels carves 1s out of the
#:     scene's first sub-shot, so that shot legitimately collects 2 panels — 0-1s and
#:     1-5s). The second covers 80% of the shot: it IS the shot, the wide is the first
#:     second of it, and the wide's own frame still rides in the request as a PNG.
#:   * a STALE board (BLOOM SHOT_004): 4 panels of 1.2-1.3s each against a 5s shot, top
#:     coverage 26%. No panel describes that shot; the board describes a segment that no
#:     longer exists.
_BEAT_MAJORITY = 0.5


def _merge_plan(shots: List[Dict[str, Any]],
                beats: Optional[List[Dict[str, Any]]]) -> tuple:
    """PURE. The SINGLE decision "which panel speaks for which shot", plus the record of
    where the board and the shot list disagreed. Returns (kept, report).

    `kept[i]` is the panels whose clauses shot i+1 will assert — 0 or 1 of them. `report`
    is None when the board describes these shots, else the dict board_shot_mismatch()
    documents.

    WHY AT MOST ONE. The [Beat] grammar carries no timecode, on purpose (a second set of
    times inside a shot invites cuts that were never bought — see assemble_segment_prompt).
    So every clause it emits is a FLAT ASSERTION about one uncut take, and N panels become
    N simultaneous assertions. Measured on BLOOM SHOT_004 before this function existed: a
    single 5s `wide|locked` shot was handed four FOV values (63°, 47°, 47°, 63°), four
    framings ("Full lot width framed" / "Folding chairs anchored midground" / "Pass aligned
    dead centre" / "Empty negative space at frame centre"), four light states, the same
    motion restated four times, and a screen-direction REVERSAL inside the take
    ("Tomás:left, Nuria:right" in beats 1-3, "Tomás:right, Nuria:left" in beat 4). That is
    four incompatible instructions for one continuous shot.

    WHY NOT COLLAPSE THE AXES INSTEAD (one FOV, one screen_side, union the rest). It was
    tried on paper and rejected: there is no measurement that says WHICH FOV of 63/47/47/63
    a 5s take should get, the framings describe four different instants and cannot be
    unioned into one frame, and the light line survives the collapse as "Cool dusk light,
    10% dimmer than prior beat" — a reference to a prior beat the prompt no longer contains.
    Every one of those choices would be an invented default, which is the class of defect
    this file has spent the most time removing.

    WHY NOT CAP AT N, OR REFUSE THE WHOLE CARD. A cap picks arbitrarily among equals; and
    refusing the card also throws away the panels of the shots the board DID describe
    correctly (BLOOM SHOT_004's Shot2 has none either way, but a 3-shot segment with one
    stale shot would lose two good ones). The decision is per shot, so a shot the board
    still describes keeps everything it had.

    A shot that ends up with nothing simply emits the prompt it emitted before the merge
    existed — its own [Layout] and no [Beat] line. Nothing new is invented for it.
    """
    groups = beats_by_shot(shots or [], beats)
    windows = shot_windows(shots or [])
    items = [b for b in (beats or []) if isinstance(b, dict)]
    kept: List[List[Dict[str, Any]]] = []
    unboarded: List[str] = []
    crowded: List[Dict[str, Any]] = []

    for i, grp in enumerate(groups):
        label = f"Shot{i + 1}"
        if len(grp) <= 1:
            kept.append(list(grp))
            if not grp and items:
                unboarded.append(label)
            continue
        s0, s1 = windows[i]
        span = max(1e-9, s1 - s0)
        best, best_cov = None, 0.0
        for b in grp:
            tm = _beat_time(b)
            cov = (max(0.0, min(tm[1], s1) - max(tm[0], s0)) / span) if tm else 0.0
            if cov > best_cov:
                best, best_cov = b, cov
        speaks = best if best_cov > _BEAT_MAJORITY else None
        kept.append([speaks] if speaks is not None else [])
        crowded.append({
            "shot": label, "panels": len(grp),
            "kept": str((speaks or {}).get("label") or (speaks or {}).get("name") or ""),
            "kept_coverage": round(best_cov, 3) if speaks is not None else 0.0,
            "dropped": len(grp) - (1 if speaks is not None else 0),
        })
        if speaks is None:
            unboarded.append(label)

    # A COUNT THAT DOES NOT MATCH IS THE STRONGEST SIGNAL THERE IS, and it was not being
    # read. The board is generated FROM the shot list, so one panel per stage is what a
    # current board looks like; any other number means the two are describing different
    # cuts. BLACK MIRROR V3: 3 of 11 segments came back with more panels than stages and
    # NOTHING warned, because every stage did receive a panel — just the one written for
    # the moment next door. That is how a prompt ended up ordering "he presses the lamp
    # switch" and "his hand closes around the phone" in the same stage. Absence was
    # detected; misalignment was not.
    misaligned = bool(items) and len(items) != len(shots or [])
    if not items or (not unboarded and not crowded and not misaligned):
        return kept, None

    # Y SE CORRIGE, NO SÓLO SE AVISA. Una anotación equivocada es peor que ninguna: es
    # exactamente lo que puso "la mano se cierra sobre el teléfono" en la etapa cuya acción
    # es "pulsa el interruptor de la lámpara". Cuando el board no describe este corte, sus
    # anotaciones se descartan ENTERAS y el prompt se arma sólo con la lista de planos, que
    # es coherente por sí sola — el mismo trato que esta función ya daba a una etapa sin
    # viñeta, aplicado a la etapa que recibió la del momento de al lado.
    #
    # Sólo en el caso MISALIGNED. Un board con el número correcto de viñetas describe este
    # corte aunque alguna etapa quede sin panel, y ahí no hay nada que descartar.
    if misaligned:
        kept = [[] for _ in kept]

    declared = sum(shot_dur(s) for s in (shots or []))
    times = [t for t in (_beat_time(b) for b in items) if t]
    board_span = (max(t[1] for t in times) - min(t[0] for t in times)) if times else 0.0
    # "0s" and "no readable times" are DIFFERENT diagnoses and the operator acts on them
    # differently — the first says re-board, the second says the panels lost their `time`
    # field on the way here. Printing a measured-looking 0 for the second is the small
    # version of the defect this whole report exists to prevent, so the sentence changes
    # rather than the number. `board_sec` stays 0.0 for callers that only want an arithmetic
    # field; `panels_timed` is what tells them which of the two it was.
    span_says = f"describes {board_span:g}s in {len(items)} panel(s)" if times else (
        f"carries {len(items)} panel(s) with no readable time range")
    dropped = sum(c["dropped"] for c in crowded)
    bits = []
    if crowded:
        bits.append("; ".join(
            f"{c['shot']} collected {c['panels']} panels and "
            + (f"kept the one covering {int(c['kept_coverage'] * 100)}% of it"
               if c["kept_coverage"] else "none of them covers more than half of it, "
                                          "so its board annotations were dropped")
            for c in crowded))
    if unboarded:
        bits.append(f"no panel describes {', '.join(unboarded)}")
    if misaligned:
        bits.append(f"the board holds {len(items)} panel(s) for {len(shots or [])} shot(s), "
                    "so its annotations describe a different cut. THEY WERE DROPPED and this "
                    "prompt was built from the shot list alone — re-board this card to get "
                    "the camera annotations back")
    return kept, {
        "severity": "warning" if (unboarded or misaligned) else "info",
        "misaligned": misaligned,
        "shots": len(shots or []), "panels": len(items),
        "declared_sec": round(declared, 2), "board_sec": round(board_span, 2),
        "panels_timed": len(times),
        "unboarded": unboarded, "crowded": crowded, "dropped_panels": dropped,
        "summary": (f"the board {span_says} against {declared:g}s declared in "
                    f"{len(shots or [])} shot(s) — " + " — ".join(bits)),
    }


def board_shot_mismatch(shots: List[Dict[str, Any]],
                        beats: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    """PURE. None when this board describes these shots; otherwise exactly how it does not.

    Exists so the mismatch is a VALUE and not only a log line: server.py puts it on the
    /api/video/create response and on the agent bus, so the operator sees "this prompt was
    built from a board that describes a different cut" in the UI, at the moment the render
    is about to be paid for. A prompt silently assembled from the wrong board is the exact
    failure this whole merge is one step away from.

    Reads the SAME function the assembler reads, so the report can never describe a
    decision the prompt did not take.
    """
    return _merge_plan(shots, beats)[1]


def _beat_camera_rate(beat: Dict[str, Any], move: str) -> str:
    """The QUANTIFIED camera rate inside a panel's `blue` sentence — and nothing else.

    `blue` as a whole is dropped (see _beat_clauses): it contradicts the shot's own
    cameraMove token on 13 of 57 matched BLOOM panels, and the token is the better-informed
    pass. But `blue` is the only field that carries a camera RATE — "pan left at 0.8° per
    second" (SHOT_009), "gentle 2° downward tilt" (SHOT_042, SHOT_051), 3 of BLOOM's 67
    degree-values — and dropping the field dropped those with it.

    The rate is salvaged only where it CANNOT contradict, by construction:
      1. the shot declares a real move that is not `locked` (a locked camera has no rate,
         so a degree-per-second on one is a contradiction by definition — this alone
         rejects SHOT_042, whose panel says "tracking… 2° downward tilt" on a locked shot);
      2. the panel's camera sentence names that same move and NO OTHER move from
         CAMERA_MOVES (this rejects SHOT_051, whose panel says "2° downward tilt, locked
         position" on a push-in);
      3. only the number and the words that qualify it are lifted, verbatim, up to the
         first clause boundary and at most three words — never the panel's sentence, whose
         move verbs are the half that fights the token.
    Measured on BLOOM: 1 of the 3 rates survives (SHOT_009). The other 2 are exactly the
    contradictions rule 1 and rule 2 exist to refuse, and they are reported as refused
    rather than smuggled in.
    """
    move = (move or "").strip().lower()
    if move not in CAMERA_MOVES or move == "locked":
        return ""
    blue = str(beat.get("blue") or "").strip()
    if not blue:
        return ""
    import re
    low = blue.lower()
    named = [m for m in CAMERA_MOVES
             if re.search(rf"\b{re.escape(m)}(?:s|ed|ing|ning)?\b", low)]
    if named != [move]:
        return ""
    m = re.search(r"\d{1,3}(?:\.\d+)?\s*(?:°|deg(?:rees?)?\b)", blue)
    if not m:
        return ""
    tail = re.split(r"[,.;]", blue[m.end():], 1)[0].split()[:3]
    return " ".join([m.group(0).strip()] + tail).strip()


_OUTPUT_SETTING_TOKENS = re.compile(
    r"\b(?:\d+\s*k\s*resolution|[48]k|2k|1080p|720p|480p|ultra\s*hd|uhd|"
    r"\d+\s*fps|\d+:\d+\s*(?:aspect(?:\s*ratio)?)?|aspect\s*ratio)\b",
    re.I)


def strip_output_settings(style: str) -> str:
    """Remove resolution / frame-rate / aspect-ratio words from a STYLE string.

    Principle 7 of the 2.5 contract: "Do not write aspect ratio, total duration,
    resolution, frame rate, or the audio toggle into the Prompt. For ordinary generation,
    set them on the generation page or through the API." Take One Studio sends all four as real
    API parameters and ALSO wrote them into the prompt, because the shipped style presets
    open with "photorealistic, hyperdetailed, 8k resolution, …". The model was being told
    a resolution it does not take from the prompt, in the sentence that leads it.

    Applied to whatever style string a project carries, so a preset edited by hand or a
    style someone types tomorrow is covered too — nothing here is specific to one project.
    2.0 is untouched: the caller gates this on the 2.5 flag.
    """
    cleaned = _OUTPUT_SETTING_TOKENS.sub("", style or "")
    # The substitution leaves the commas that separated the removed words behind, and a
    # prompt reading "photorealistic, , , studio lighting" is a worse sentence than the
    # one we started with.
    parts = [p.strip(" .") for p in cleaned.split(",")]
    return ", ".join(p for p in parts if p)


def _beat_clauses(beat: Dict[str, Any], camera_move: str = "",
                  end_state: bool = False) -> List[str]:
    """The parts of a board panel that the shot list has NO slot for, in prompt order.

    WHAT IS DELIBERATELY NOT HERE, and why — the merge has to add the numbers without
    stating the same shot twice:
      * `blue` (camera) — the SENTENCE.  The shot already declares a `cameraMove` token,
        and the phase-4 writer is GIVEN that token (storyboard_panels feeds each shot's
        `camera=` into its prompt) — so where the panel disagrees it is the panel that
        ignored its brief. Measured on BLOOM: 13 of 57 matched panels name camera
        vocabulary the shot's token contradicts ("dolly-in" vs "Camera remains locked
        fully static"). The token wins. Its RATE is not dropped with it — see
        _beat_camera_rate, which lifts the number alone and only where the panel and the
        token name the same move.
      * `desc`.  It is the same moment as `action`, re-written; two prose descriptions of
        one movement is exactly the duplication this merge exists to avoid. It costs 4 of
        163 degree-values, against `red` (the motion VECTOR, which the action line has no
        slot for) being kept in full.
      * the size words in `shot_type` — see _beat_fov.
      * `name` / `label` / `time` — editorial ids and a SECOND schedule; the shot list
        already owns the schedule and the model is told to cut on it.
      * `crossing` / `state_change` — declared intent for check_screen_direction() and
        check_object_continuity(); they are QC flags, not render instructions.

    `green` (framing) IS here, and it displaces the shot's `[Layout]` line at the call site
    for the opposite reason to `blue`: the board writer is never shown the layout, so the
    two are independent descriptions of one frame (BLOOM SHOT_001: layout puts the soil
    tubes "right foreground", the board puts them "left third frame"), and the one that was
    DRAWN and approved is the one whose PNG rides in the request as "match its composition,
    framing and camera angle".
    """
    out: List[str] = []
    fov = _beat_fov(beat)
    if fov:
        out.append(f"FOV {fov}")
    # Next to the FOV, because it is the other CAMERA number and the takeone-seedance-prompt
    # grammar this repo follows warns that a camera block read late in a prompt is ignored.
    rate = _beat_camera_rate(beat, camera_move)
    if rate:
        out.append(f"Camera rate: {rate}")
    # `leaves_behind` IS the beat's observable closing state — what phase 4 recorded as
    # still true when the beat ends. On 2.5 it is labelled the way both guides ask for it:
    # the prompt contract wants every stage of a long take to "state its ending condition",
    # and ACTING SKILL §10 wants states rather than transitions ("mid-throw, arm extended"
    # lands; "reaches in, pulls out, winds up" collapses). Same data, the name the model is
    # tuned to read. 2.0 keeps "Left in place" so its prompts do not move.
    #
    # UNA SOLA VEZ CADA COSA. En 2.5 este bucle emitía dos campos que el prompt ya dice en
    # su sitio de la plantilla, y el resultado era una etapa repitiéndose:
    #   · `leaves_behind` salía aquí como "End state: …" Y otra vez como la línea suelta
    #     `End state:` que la plantilla pide, Y como `[Opening state]` de la etapa
    #     siguiente, Y dentro de `[Locks]` — hasta cuatro copias de la misma frase por
    #     etapa (seis copias de una cadena en un guion de tres etapas, medido).
    #   · `screen_side` salía en cada beat repitiendo la lista de blocking entera, que
    #     ahora abre el prompt una vez en `[Subjects and Relationships]` — tantas copias
    #     verbatim como etapas tenga el plano.
    # El principio 4 lo nombra: "Once a slot is covered, do not add an unmentioned
    # material merely to reinforce the same role." 2.0 no tiene esos bloques, así que
    # conserva ambos campos y sale byte-idéntico.
    fields = [("green", "Framing"), ("red", "Motion"), ("orange", "Light"),
              ("purple", "Emphasis")]
    if not end_state:
        fields += [("screen_side", "Screen side"), ("leaves_behind", "Left in place")]
    for key, tag in fields:
        val = str(beat.get(key) or "").strip().rstrip(".")
        if val:
            out.append(f"{tag}: {val}")
    return out


def assemble_segment_prompt(
    shots: List[Dict[str, Any]],
    *,
    beats: Optional[List[Dict[str, Any]]] = None,
    visual_style: str = "",
    scene_name: str = "",
    time_of_day: str = "",
    light: str = "",
    prev_segment_end: str = "",
    voice_of: Optional[Dict[str, str]] = None,
    # Quién HABLA pero no tiene cuerpo: un asset de tipo `voice` — un teléfono, una
    # megafonía, un narrador, un ordenador. Vacío = todos los hablantes están en cuadro,
    # que es el prompt que este ensamblador emitía antes de existir este parámetro.
    voiceless: Optional[Iterable[str]] = None,
    subject_hint: str = "",
    env_hint: str = "",
    neg_base: str = "",
    photographic: bool = True,
    references: Optional[List[Dict[str, str]]] = None,
    geo_layout: str = "",
    at_addressing: bool = False,   # 2.5 addresses refs as `@Image N`; see assemble_reference_roles
    subject_profiles: str = "",    # assemble_subject_profiles() output; "" → prompt unchanged
    # El idioma en que está ESCRITO el diálogo, declarado por el breakdown. "" → la línea
    # de diálogo sale exactamente como antes de existir este parámetro.
    dialogue_language: str = "",
    unused_materials: str = "",    # assemble_unused_materials() output; "" → prompt unchanged
) -> str:
    """Build ONE Seedance prompt for a segment of N shots, in the block grammar that
    ByteDance's own Dramagic uses to drive this model.

    Everything here is measured, not guessed (2026-07-30/31, 26 renders at 480p):

    * **The model obeys declared shots.** Asking for 2 s / 5 s / 3 s produced real cuts at
      2.04 s and 6.21 s; the single-shot control had none. This is the only way to a 1.5 s
      insert, since the API floor is 4 s *per call*.
    * **Dialogue must be written INTO the visual content**, in `{}`. Describing "the robot
      speaks" without the words made Seedance invent its own lines in 7 of 8 renders
      ("I mean no harm", "Stay back, I'm not infected"). With the lines written in: 18/18.
    * **Voice is a written description, not an audio reference.** Attaching the Seed Audio
      clip did NOT carry its identity (our female TTS came back as a male voice), but
      naming the timbre in the prompt held it steady across renders.
    * **No music, 0 of 26** — as long as the ban above is present and dialogue exists.

    `shots` are dicts with: durationSecs, shotSize, cameraMove, layout, action, dialogue
    ([{character, text, emotion}]). `voice_of` maps character name → voice description.
    `references` are the ATTACHED reference images in attachment order — see
    assemble_reference_roles for the Hell Grind rule they answer.

    `geo_layout` is the scene's GEO SPATIAL LAYOUT, written once at board time and pasted
    into every shot of the scene without changes (Hell Grind rule 1 — see
    claude_agents.scene_geo_layout). It is the map of the PLACE; the LOOK of the place
    still comes from `visual_style` and the location reference. "" → the prompt is
    byte-identical to what it was before this parameter existed.

    `beats` are the shot's ANNOTATED BOARD PANELS — the entire output of phase 4. Until
    2026-08-07 this function had no such parameter and server.py passed none, so for every
    multi-shot segment the FOV degrees, the Kelvin white balance, the framing, the
    emphasis and the declared screen sides were assembled by phase 4, shipped over the
    wire, accepted by the request model and then dropped on the floor. Measured before the
    change, re-posting BLOOM's 24 segment-branch payloads with `beats=[]` produced a
    BYTE-IDENTICAL prompt 24 of 24 times (76,869 bytes total, delta 0), and 0 of 57 panel
    names, 0 of 67 degree-values and 0 of 26 Kelvin-values reached any prompt.

    The merge is NOT a concatenation of the board. A segment already declares its shots'
    durations, sizes, moves, layout and action; the panels are the same material at finer
    grain. So each panel is matched to the shot it times against (see beats_by_shot) and
    contributes ONLY what that shot has no slot for (see _beat_clauses) — the numbers
    above, plus the motion vector, the emphasis and the screen sides. Nothing is stated
    twice: where the two overlap, exactly one survives, and which one is decided per axis
    by which pass was better informed (the shot keeps camera and size; the board takes
    framing and displaces `[Layout]`). No beats → every byte below is what it always was.

    AND AT MOST ONE PANEL SPEAKS PER SHOT (see _merge_plan). A `[Beat]` line has no
    timecode, so everything on it is asserted about one uncut take; several panels on one
    shot therefore assert several incompatible states at once. Measured on BLOOM's stale
    SHOT_004 board before that rule existed: one 5s `wide|locked` shot instructed to hold
    four FOV values, four framings, four light states and both screen directions. A shot
    the board no longer describes now emits exactly the prompt it emitted before this
    merge existed, and the disagreement is reported — logged as "BOARD MISMATCH" and
    returned as a value by board_shot_mismatch(), which server.py puts on the response.
    """
    out: List[str] = []
    # WHERE THE STYLE LINE GOES. On 2.0 it opens the prompt, which is where it has always
    # been and where its measurements were taken. On 2.5 it moves to the tail with the
    # other look lines, for two reasons that agree: the contract puts material mapping —
    # the reference roles — at the START, and they were arriving fifth, behind a style
    # sentence and a ban list; and the technical half of a style belongs in a suffix, not
    # in the sentence the model reads first. Nothing about the style's CONTENT changes,
    # only its position and the output settings principle 7 forbids.
    if visual_style.strip() and not at_addressing:
        out.append(f"Visual Style: {visual_style.strip().rstrip('.')}.")

    # [Generation Goal] — PRIMER bloque de la plantilla oficial 2.5 ("Generation with
    # Reference Materials"): "Generate <video type or core event>. The central subject is
    # <subject>, and the primary event is <summary>." Nunca lo emitiamos, asi que el
    # modelo llegaba a la lista de referencias sin que nadie le hubiera dicho QUE se esta
    # rodando. No inventa nada: el sujeto es el mismo subject_hint que ya se emitia mas
    # abajo y el evento es la accion de la primera etapa, que es la que abre la toma.
    if at_addressing:
        _goal_subj = subject_hint.strip().rstrip(".") or "the characters named below"
        _first = ""
        for _sh in (shots or []):
            _a = str(_sh.get("action") or _sh.get("visual_description") or "").strip()
            if _a:
                _first = _a.rstrip(".")
                break
        _goal = (f"[Generation Goal]\nGenerate one continuous live-action film shot. "
                 f"The central subject is {_goal_subj}")
        _goal += f", and the primary event is {_first}." if _first else "."
        out.append(_goal)
    out.append(_SEGMENT_BANS)

    # WHO and WHERE. Dropping these was a silent downgrade against the classic
    # assembler: without the subject line the model re-invents the character from the
    # action text even with reference images attached, which is the identity drift this
    # pipeline spends most of its effort on.
    if subject_hint.strip():
        out.append(f"Subject: {subject_hint.strip().rstrip('.')}.")
    if env_hint.strip():
        out.append(f"Environment: {env_hint.strip().rstrip('.')}.")

    # WHAT EACH ATTACHED PICTURE IS FOR. Placed here — after WHO and WHERE, before the
    # scene block and the shot list — because it is setup: the shot actions below name the
    # same characters and props, and the model has to know which image is which before it
    # reads them. Empty when nothing is attached (i2v mode drops every reference_image, so
    # the prompt is byte-identical to what it was).
    roles = assemble_reference_roles(references, at_addressing)
    if roles:
        # La cabecera es del contrato ("[Reference Material Roles]"), el contenido ya
        # estaba: las lineas "@Image N = ROL" salian sueltas, sin el bloque que la
        # plantilla les pone. Solo en 2.5 — 2.0 direcciona con <Image_N> y su guia no
        # usa bloques con corchetes.
        out.append(f"[Reference Material Roles]\n{roles}" if at_addressing else roles)

    # WHO each character is, immediately after WHICH picture is which — the order the
    # sd25-pe contract lays out. This lands here as well as in server.py's direction branch
    # because THIS is the branch a real film takes: the direction template only runs for a
    # segment of one shot (`use_direction and len(segment_shots) <= 1`), and measured on
    # DryRUN that is 1 of 19 cards. Emitting the profiles only there meant 18 of 19 shots
    # were rendered with no acting profile at all.
    if subject_profiles.strip():
        out.append(subject_profiles.strip())

    # …and what the take does NOT contain. Straight after the subjects, because it is the
    # same question answered in the negative and the model should read both together.
    if unused_materials.strip():
        out.append(unused_materials.strip())

    # [Subjects and Relationships]. Se pre-calcula aqui — antes del guion de eventos —
    # porque ese es su sitio en la plantilla; hasta ahora los lados de pantalla solo
    # aparecian al FINAL, dentro de [Locks], despues de que el modelo ya hubiera leido
    # todas las acciones. La guia lo dice en "Space and Blocking": "Describe inside/
    # outside, front/back, facing direction, distance, and separating structures relative
    # to stable objects... Do not rely only on screen-left or screen-right" — que es
    # exactamente la forma "Nombre:left of frame | window side of the bed" que la fase 4
    # escribe desde el 2026-08-30.
    matched, mismatch = _merge_plan(shots or [], beats)
    _sides: List[str] = []          # every declared screen side, deduped in order
    for _row in matched:
        for _b in _row:
            _s = str(_b.get("screen_side") or "").strip().rstrip(".")
            if _s and _s not in _sides:
                _sides.append(_s)
    if at_addressing and _sides:
        out.append("[Subjects and Relationships]\n"
                   "Each subject holds the position this line gives them, stated against "
                   "the furniture and not only against the frame: " + "; ".join(_sides) + ".")

    if scene_name.strip():
        out.append(f"Scene Settings: {scene_name.strip()}")
    if time_of_day.strip():
        out.append(f"[Time] {time_of_day.strip()}")
    if light.strip():
        out.append(f"[Light] {light.strip().rstrip('.')}.")

    # THE FLOOR PLAN, right after the scene block it belongs to and BEFORE the shot
    # actions that place figures inside it — the actions below name these landmarks, so
    # the map has to be read first. Hell Grind rule 1: identical bytes in every shot of
    # the scene, "no heroes, no action — only the place itself".
    if geo_layout.strip():
        out.append(geo_layout.strip())
        out.append("The layout above is FIXED for this whole scene: every landmark stays "
                   "on the side of frame it names, the camera never crosses the axis line "
                   "it names, and no figure teleports across it between cuts.")

    # Re-establish the scene every time. The model has NO memory of the previous call, so
    # "continue from the last clip" is worthless — the prior state has to be restated as
    # content (guide §1). Measured: without it a shot drifted into a different, brighter
    # location; with it the previous shot's key light survived the cut.
    if prev_segment_end.strip():
        end = prev_segment_end.strip().rstrip(".")
        out.append(f"End of the previous shot: {end}.")
        # EL SOLAPE DE ACCIÓN (guía §3). Reestablecer la escena por texto arregla el
        # SALTO DE HISTORIA, pero no el de MOVIMIENTO: sin repetir el gesto, el corte
        # va de ella tumbada a ella de pie y nunca la vemos levantarse. La guía lo dice
        # explícito — se repite el ESTADO DE LA ACCIÓN, no el plano: cambiando de ángulo
        # o de tamaño, el espectador no lo lee como repetición sino como continuidad.
        out.append(
            # SIN NUMEROS. "0.8-2 seconds" era el ultimo rango temporal que quedaba en el
            # cuerpo del prompt. La guia 2.0 avisa de que "support for precise timing (such
            # as 0-3 seconds) is UNSTABLE" y la 2.5 lo prohibe por el principio 7 y por
            # "Do not invent ranges". El enganche no necesita el numero: lo que hace falta
            # es que la accion siga, no que dure una cifra concreta.
            f"Shot 1 OPENS by replaying the final moment of that action — "
            f"{end.lower()} — but from a DIFFERENT angle or shot size than the previous "
            f"shot used, and then carries it forward. Do not cut into the middle of the "
            f"movement: show it continuing, so the change happens ON SCREEN.")

    # "[Event Script]" es el nombre que la plantilla le da a este bloque; "Shot Actions:"
    # era nuestro. El contenido no cambia — cambia que ahora el modelo lo reconoce.
    out.append("[Event Script]" if at_addressing else "Shot Actions:")
    # Read the list as consecutive STAGES, which is how 2.5 is documented to handle a long
    # take: "Give each stage only one primary state change and state its ending condition."
    # Without this the numbered shots read as a continuous process, and a process is the one
    # form both guides say the model fails — ACTING SKILL §10, and the codebase's own
    # _ACTING_BEAT_RULES comment already conceding that "Take One Studio's beats are written as
    # processes today, which is exactly the failing form".
    if at_addressing:
        out.append("Play these as consecutive stages. Each numbered shot is ONE stage with "
                   "one primary change; where a stage declares an End state, the frame must "
                   "actually reach it before the next stage begins. Show characters already "
                   "IN each state rather than narrating the way into it.")
    # ONE decision, taken once: which panel speaks for which shot, and where the board and
    # the shot list disagree (see _merge_plan). `mismatch` is logged below and returned to
    # the caller by board_shot_mismatch() so the operator can SEE that a prompt was built
    # from a board describing a different cut, instead of the prompt quietly containing it.
    _prev_end = ""                  # closing state of the stage before — the next one's opening
    _last_end = ""                  # the last End state actually EMITTED, to not repeat it
    # Reparto POR ETAPA, en el orden de los planos. `assets` llega resuelto desde el
    # navegador ({id, name, type}) porque es el único lado que tiene el mapa de assets;
    # `assets_used` sigue siendo sólo ids y no sirve para nombrar a nadie.
    _cast_by_stage = [
        [str(a.get("name") or "").strip()
         for a in (sh.get("assets") or [])
         if isinstance(a, dict) and str(a.get("type") or "").strip().lower() == "character"
         and str(a.get("name") or "").strip()]
        for sh in (shots or [])
    ]
    _persist: List[str] = []        # every declared closing state, for the locks block
    for i, sh in enumerate(shots or [], start=1):
        mine = matched[i - 1] if i - 1 < len(matched) else []
        # `duration_sec` (singular) is the breakdown's own key — the one the frontend
        # actually sends. Missing it made every shot fall to the 3s default, which reads
        # as working output while silently flattening the rhythm the whole change exists
        # to create. All three spellings are accepted; none is guessed (see shot_dur).
        dur = shot_dur(sh)
        # SIN SEGUNDOS. Esto llevaba `Shot{i} {dur}s` como "cut schedule". Las dos guias
        # oficiales lo prohiben, y coinciden: la de 2.0 dice "Do not impose strict limits
        # on the duration of each segment; prioritize allowing the model to naturally
        # generate the pacing based on the plot" y avisa de que "support for precise
        # timing (such as 0-3 seconds) is UNSTABLE, and forcibly limiting duration may
        # lead to abnormal generation results"; la 2.5 lo prohibe por el principio 7 y
        # por "Do not invent ranges such as 0-8 seconds". La medicion interna que lo
        # defendia (2026-07-31: pedidos 2s/5s/3s, cortes en 2.04s y 6.21s) es de hecho
        # la deriva que la guia describe. El ORDEN se conserva, que es lo que ambas
        # guias si piden; `dur` se sigue calculando porque el total va en el log y en el
        # parametro de duracion, que es su sitio.
        out.append(f"Stage {i}:" if at_addressing else f"Shot {i}:")
        # ACTIVACIÓN POR ETAPA — la forma que la plantilla usa para esto
        # (§"Subject Profiles and Scene-Based Activation"): `Use: <subjects … activated in
        # this scene>`. Los `[Subject Profile:]` describen a TODO el reparto del segmento y
        # se emiten enteros arriba, así que sin esta línea un plano de tres etapas llega
        # con perfiles completos de gente que no sale en dos de ellas — atención gastada, y
        # la puerta por la que un personaje ausente se cuela en el encuadre.
        #
        # Sólo cuando dice algo: si en todas las etapas está el mismo reparto, la línea es
        # ruido y el principio 4 desaconseja reforzar un hueco ya cubierto.
        if at_addressing and _cast_by_stage and len(set(map(tuple, _cast_by_stage))) > 1:
            here = _cast_by_stage[i - 1] if i - 1 < len(_cast_by_stage) else []
            if here:
                out.append(f"Use: {', '.join(here)}.")
        # OPENING STATE. The 2.5 template's [Event Script] is Opening state / Primary event
        # / Ending state, and we emitted only the ending — so every stage after the first
        # told the model where to ARRIVE and never where it starts, which is the transition
        # form ACTING SKILL §10 says collapses. No new board field was needed: the opening
        # state of a stage IS the closing state of the one before it, which phase 4 already
        # wrote as `leaves_behind`. Derived, not invented, and only where the previous
        # stage actually declared one. Stage 1 is left alone — its opening is the previous
        # SHOT's closing frame, which rides as an image and as the replay line above.
        if at_addressing and i > 1 and _prev_end:
            out.append(f"[Opening state] {_prev_end}.")
        # The board's framing DISPLACES the breakdown's layout rather than joining it (see
        # _beat_clauses): both name where things sit in this exact frame, they were written
        # independently, and BLOOM has a measured contradiction between them. Two maps of
        # one frame is the failure mode the geo-layout block is already careful about.
        if (sh.get("layout") or "").strip() and not any(
                str(b.get("green") or "").strip() for b in mine):
            out.append(f"[Layout] {str(sh['layout']).strip().rstrip('.')}.")

        size = str(sh.get("shotSize") or sh.get("shot_size") or "").strip().lower()
        move = str(sh.get("cameraMove") or sh.get("camera_move") or "").strip().lower()
        # Unknown values are dropped rather than passed through: a made-up tag would read
        # as prose to the model and, worse, make the coverage gates believe a size was
        # declared when none was.
        tag = "|".join(x for x in (size if size in SHOT_SIZES else "",
                                   move if move in CAMERA_MOVES else "") if x)
        body = str(sh.get("action") or "").strip().rstrip(".")

        # Dialogue rides INSIDE the action, with the voice named and the mouth described.
        _voiceless = {str(v).strip() for v in (voiceless or []) if str(v).strip()}
        spoke = 0
        for line in (sh.get("dialogue") or []):
            text = str(line.get("text") or "").strip()
            if not text:
                continue
            who = str(line.get("character") or line.get("characterId") or "").strip()
            voice = (voice_of or {}).get(who, "")
            emo = str(line.get("emotion") or "").strip()
            # Fórmula de la guía 2.5 §1.3: idioma + acento + entrega + hablante + {línea}.
            # El acento y la entrega ya viajaban (`voice` sale del perfil vocal del actor,
            # `emo` de la propia línea); el idioma es el que faltaba, y es el que evita que
            # el modelo doble la frase a su idioma por defecto.
            _lang = f"in {dialogue_language.strip()}" if dialogue_language.strip() else ""
            lead = " ".join(x for x in (who, "says", _lang, voice,
                                        f"({emo})" if emo else "") if x)
            # UNA VOZ SIN CUERPO NO MUEVE LA BOCA. Esta línea se añadía a TODA línea de
            # diálogo, también a la del secuestrador electrónico de BLACK MIRROR — un
            # asset de tipo `voice`, creado precisamente para que no tuviera cara. El
            # prompt le pedía entonces mover los labios en cuadro mientras el bloque de
            # reparto decía que sólo aparece una persona: dos órdenes incompatibles, y la
            # invitación a inventarse un hablante que nadie ha diseñado.
            if who in _voiceless:
                body += (f". {lead}: {{{text}}} This voice comes from OFF SCREEN — through "
                         "a speaker, a phone or a screen. Nobody visible in frame mouths "
                         "these words, and no new person appears to say them")
            else:
                body += f". {lead}: {{{text}}} Their mouth moves with each word"
            spoke += 1
        # THE OTHER HALF OF LIP-SYNC, and it was missing. Each line said whose mouth MOVES
        # and nothing ever said whose mouth is SHUT, so with two or three `says` clauses in
        # one action the model had no instruction to close anyone — which is exactly what
        # the renders showed. The sd25-pe contract asks for it in as many words: "bind the
        # speaker and audio reference within each stage and state that the other characters
        # listen with their mouths naturally closed."
        #
        # Written once for the whole shot rather than per line because Take One Studio puts every
        # line of a take in ONE action block; a per-line version would repeat itself N
        # times and still not say what happens between the lines. Turn-taking is deliberate
        # (user decision 2026-08-12): the contract has no construct for simultaneous speech
        # — `overlap`, `simultaneous`, `talk over` and `interrupt` appear nowhere in its 941
        # lines — so overlapping delivery is built in the cut, not asked of the model.
        if spoke > 1:
            body += (". The characters speak strictly in the order written, one at a time. "
                     "Only the character currently speaking moves their mouth; everyone "
                     "else listens with their mouth naturally closed")
        elif spoke == 1:
            body += (". Everyone else in frame listens with their mouth naturally closed")
        out.append(f"[Action] {tag + ' ' if tag else ''}{body}.")

        # THE BOARD'S NUMBERS, immediately after the action they qualify. Position is not
        # arbitrary: the takeone-seedance-prompt grammar this repo follows warns that a
        # camera/FOV block placed near the END of a prompt is ignored, which is why the
        # classic assembler puts camera in 3rd position — here the equivalent slot is
        # "right under the action of the shot it belongs to".
        #
        # ONE line, and NO timecode on it. The panel's own "5-10.5s" range is deliberately
        # withheld: `Shot{i} {dur}s` is already the cut schedule the model is told to honour
        # (measured 2026-07-31 — asked 2s/5s/3s, cuts landed at 2.04s and 6.21s), and a
        # second set of times inside a shot invites cuts that were never bought. Because
        # the line therefore carries no "then", it can only assert ONE state — which is why
        # _merge_plan hands this loop at most one panel per shot. The n/m numbering that
        # used to appear here is gone with the several-panels case it was papering over.
        for cl in (_beat_clauses(b, move, at_addressing) for b in mine):
            if cl:
                out.append(f"[Beat] {'. '.join(cl)}.")
        _prev_end = ""
        for b in mine:
            _le = str(b.get("leaves_behind") or "").strip().rstrip(".")
            if _le:
                _prev_end = _le
                _persist.append(_le)
        # SÓLO CUANDO CAMBIA. La guía pide que cada etapa tenga "only one primary state
        # change" y declare su condición de cierre. Si una etapa cierra exactamente como
        # cerró la anterior, repetir la frase no declara un cierre: declara que no ha
        # pasado nada, y contradice a la acción de esa misma etapa.
        #
        # Es fácil que ocurra porque el escritor de la fase 4 tiende a copiar el mismo
        # `leaves_behind` en todas las viñetas de un plano. Ejemplo del patrón: tres
        # etapas cerrando las tres con "…pantalla en la pared en pausa" cuando la etapa
        # del medio es justamente alguien HABLANDO en esa pantalla — el prop más
        # importante del plano congelado por una cadena repetida.
        #
        # Lo que se repite ya viaja en `[Locks]`, que es donde "lo que sigue igual" se
        # dice una vez.
        if at_addressing and _prev_end and _prev_end != _last_end:
            out.append(f"End state: {_prev_end}.")
        if _prev_end:
            _last_end = _prev_end

    # The same non-negotiables the classic assembler ends on. They are stated POSITIVELY
    # and in the prompt body because Seedance ignores the `negative_prompt` field
    # (A/B verified with a fixed seed, 2026-06-10) — so a segment that omitted them was
    # not "using a cleaner prompt", it was rendering with the guards switched off.
    if visual_style.strip() and at_addressing:
        _style = strip_output_settings(visual_style.strip().rstrip("."))
        if _style:
            out.append(f"Visual Style: {_style}.")
    # CADA VERSION A SU GUIA. Esta linea no era boilerplate inventado: la guia oficial de
    # Seedance 2.0 la da COMO EJEMPLO literal en su seccion "Image quality" — "HD, rich
    # details, cinematic texture, natural colors, soft lighting" — y llama a ese bloque
    # "necessary configurations for ensuring stable and compliant final output". En 2.0
    # se queda tal cual, porque su guia la pide.
    #
    # En 2.5 se va: el principio 8 del contrato sd25-pe prohibe por su nombre "unrequested
    # quality or stability boilerplate". Las dos guias se contradicen aqui y cada rama
    # sigue la suya, que es la regla 9 de las reglas del proyecto leida literalmente.
    if not at_addressing:
        out.append("HD, rich details, cinematic texture, natural colors" if photographic
                   else "HD, rich details, consistent art style")
    # "Preserve composition and colors" is GONE from the segment assembler, and only that
    # clause: the rest of this block is defended by a fixed-seed A/B and stays.
    #
    # It was inherited from the still-image guards, where preserving the composition of a
    # REFERENCE is the point. In a video prompt it reads as an instruction not to change
    # the frame — and the shot's whole job is to change. Seen on DRAMA QUEEN 3's SHOT_001
    # (2026-08-14): eight frames sampled across 11 seconds are the same photograph twice,
    # an empty kitchen and then two motionless people, with no camera or lighting
    # development at all. It compounded with a stage that declares "No motion occurs" and
    # a director's note that declared no performer present, but of the three this is the
    # one WE add to every segment unasked. The sd25-pe contract's principle 8 names it
    # exactly: "Do not add blanket constraints … stability boilerplate".
    # Mismo reparto. "do not generate a watermark" y "do not generate a logo" son dos de
    # las tres plantillas de palabra-constraint que la guia 2.0 lista textualmente; la
    # profundidad y la inercia son sus "constraint words" contra deformidades. En 2.5 el
    # principio 8 nombra "watermarks, logos" y el boilerplate de estabilidad, asi que la
    # rama 2.5 no los emite. El watermark de video ademas viene ya en false por defecto,
    # de modo que en 2.5 la frase no solo estaba prohibida: era redundante.
    if not at_addressing:
        out.append("Foreground, midground and background layered for depth. Gravity and "
                   "inertia respected. Do not generate a watermark or logo.")
    user_neg = [s.strip() for s in (neg_base or "").split(",") if s.strip()]
    if user_neg:
        # EL BLOQUE QUE LA GUIA USA PARA ESTO. El ejemplo oficial de storyboard de 2.5
        # lleva un "[Strictly exclude]" para el estilo, que es lo que hace legitima una
        # lista de exclusion pese a que la guia prefiera la descripcion positiva. La
        # lista es la misma (la negativa del estilo, que el usuario configura); cambia el
        # envoltorio, para que el modelo la lea como el bloque que conoce y no como una
        # frase suelta al final. 2.0 conserva "Do not include:", que es su forma.
        out.append(f"[Strictly exclude]\n{', '.join(user_neg)}." if at_addressing
                   else f"Do not include: {', '.join(user_neg)}.")

    # LOCKS. Every stage declares what it leaves in place, and nothing ever told the model
    # that those states PERSIST — so each stage read as an independent frame and the take
    # was free to put the room back the way it found it. This is not new boilerplate
    # (principle 8 forbids that): it is one sentence making the stages' own declarations
    # binding on each other, plus the screen sides phase 4 already declared, restated once
    # the way a lock is meant to be. Emitted only when the stages actually declared
    # something — a segment with no board says nothing here.
    if at_addressing and (_persist or _sides):
        locks = ["[Locks]"]
        if _persist:
            locks.append("Whatever a stage leaves in place stays in place for every later "
                         "stage of this take, unless a later stage's action changes it.")
        out.append("\n".join(locks))

    prompt = "\n".join(out)
    total = sum(float(s.get("duration_sec") or s.get("durationSecs")
                      or s.get("duration_secs") or 0) for s in (shots or []))
    logger.info("[PromptAssembler:Segment] %d shot(s), %.1fs declared, %d chars, "
                "%d board panel(s) merged onto %d shot(s)",
                len(shots or []), total, len(prompt),
                sum(len(g) for g in matched), sum(1 for g in matched if g))
    if mismatch:
        # LOUD, and at the level that matches what was lost: `warning` when a shot ended up
        # with no board annotation at all (the board does not describe that shot), `info`
        # when every shot still got one and only an extra panel — the scene's opening wide
        # — stepped aside. Grep handle: "BOARD MISMATCH".
        (logger.warning if mismatch["severity"] == "warning" else logger.info)(
            "[PromptAssembler:Segment] BOARD MISMATCH — %s", mismatch["summary"])
    return prompt


def assemble_video_prompt(
    shot_action: str,
    style_suffix: str = "",
    subject_hint: str = "",
    env_hint: str = "",
    camera: str = "smooth tracking shot",
    lighting_hint: str = "",
    neg_base: str = "",
    dialogue: Optional[List[str]] = None,
    photographic: bool = True,   # False → skip "cinematic texture, natural colors" (fights stylized looks)
    director_notes: str = "",    # per-shot "Direct this shot" note — appended as a must-honor clause (4E)
    references: Optional[List[Dict[str, str]]] = None,  # attached refs, in attachment order
    geo_layout: str = "",        # the scene's GEO SPATIAL LAYOUT (Hell Grind rule 1)
    at_addressing: bool = False,   # 2.5 addresses refs as `@Image N`; see assemble_reference_roles
) -> tuple:
    """
    Central assembler for ALL Seedance prompts.

    Seedance 2.0 formula for image-to-video:
      Subject → Action → Environment → Camera → Style → Constraints
    ~60-100 words.  DO NOT re-describe the first frame image;
    focus entirely on MOTION, camera, and style.

    Returns (positive_prompt, negative_prompt).
    """
    pos_parts: List[str] = []

    # WHAT EACH ATTACHED PICTURE IS FOR, FIRST — Hell Grind rule 2, see
    # assemble_reference_roles. It leads rather than trails for the same reason the camera
    # block sits in 3rd position and not last: the takeone-seedance-prompt grammar warns that a
    # block near the END of the prompt is ignored, and a reference the model has already
    # mis-used by then cannot be un-used. Empty (byte-identical prompt) when nothing is
    # attached, which is every i2v render — the API drops reference_image in that mode.
    roles = assemble_reference_roles(references, at_addressing)
    if roles:
        # rstrip: this assembler joins its parts with ". ", so a block that already ends in
        # a period produced "…do not repeat its composition.. Tomás Arroyo".
        pos_parts.append(roles.rstrip("."))

    # Subject (brief reference, do not re-describe first frame)
    if subject_hint.strip():
        pos_parts.append(subject_hint.strip().rstrip("."))

    # Action — one clear present-tense movement (from breakdown ACTION text)
    if shot_action.strip():
        pos_parts.append(shot_action.strip().rstrip("."))

    # Camera in 3RD position (subject → action → camera): the takeone-seedance-prompt grammar warns
    # that a camera/FOV block placed near the END is ignored, so the framing/FOV must come right
    # after the action, before environment/style. One primary move + pacing.
    pos_parts.append(camera.strip().rstrip(".") if camera.strip() else "smooth tracking shot")

    # Dialogue — documented {} syntax (ModelArk/2222480): Seedance 2.0 speaks
    # the lines with lip-sync. Caller pre-formats each as
    # 'Name says in a <emotion> tone: {line}'.
    if dialogue:
        for line in dialogue:
            if line.strip():
                pos_parts.append(line.strip().rstrip("."))

    # Environment context
    if env_hint.strip():
        pos_parts.append(env_hint.strip().rstrip("."))

    # THE FLOOR PLAN, in the environment slot it belongs to — Hell Grind rule 1, written
    # once per scene at board time and pasted into every shot of the scene unchanged (see
    # claude_agents.scene_geo_layout). It follows the environment hint because it is the
    # MAP of that environment, and precedes lighting/style because those describe how the
    # same place LOOKS. "" → this assembler emits the prompt it always emitted.
    if geo_layout.strip():
        pos_parts.append(geo_layout.strip().rstrip("."))

    # Lighting & color tone — a first-class slot in the official 2.0 formula
    if lighting_hint.strip():
        pos_parts.append(lighting_hint.strip().rstrip("."))

    # Style (locked project style suffix)
    if style_suffix.strip():
        pos_parts.append(style_suffix.strip().rstrip("."))

    # Image quality — official formula slot (ModelArk/2222480). The photoreal
    # wording is conditional: on stylized projects "cinematic texture, natural
    # colors" pulls the render away from the locked art style.
    pos_parts.append("HD, rich details, cinematic texture, natural colors"
                     if photographic else "HD, rich details, consistent art style")

    # Director's note — the user's "Direct this shot" instruction, honored as a hard directive
    # (4E: previously the classic path dropped it silently, so a retake ignored the direction).
    if director_notes.strip():
        pos_parts.append(f"Director's note (must be honored): {director_notes.strip().rstrip('.')}")

    # Constraints (always present) — the documented mechanism is constraint words IN the prompt,
    # not a negative-prompt field (ModelArk/2222480). Enriched with the cinematic-prompt-builder
    # non-negotiables (positive form): motion from the first frame (counters Seedance's static
    # holds), layered FG/MG/BG depth, and respected physics — plus the subtitle/watermark guards.
    pos_parts.append(
        "Motion begins in the first frame — no frozen opening. Foreground, midground and "
        "background layered for depth. Gravity and inertia respected. Preserve composition and "
        "colors. Keep it subtitle-free, avoid generating any text or subtitles. Do not generate "
        "a watermark or logo"
    )

    # The user's OWN exclusions, folded into the positive prompt — the documented
    # mechanism (ModelArk/2222480), and the one the Seedream path already uses.
    #
    # They used to be appended to the returned `negative` string, which create_video_task
    # then dropped on the floor: a live A/B with a fixed seed proved Seedance ignores the
    # negative_prompt body field. So the Stage-5 direction panel let the user type
    # exclusions, recorded them in the take's metadata sidecar, and changed nothing about
    # the render. Folding them in is what makes that control real.
    #
    # Only the USER's items are folded. The six built-ins below (jitter, warping, …) are
    # already covered in positive form above ("Gravity and inertia respected", …); naming
    # them again would only prime the model toward the very artifacts we want gone.
    user_neg = [s.strip() for s in neg_base.split(",") if s.strip()] if neg_base.strip() else []
    if user_neg:
        pos_parts.append(f"Do not include: {', '.join(user_neg)}")

    positive = ". ".join(s for s in pos_parts if s) + "."

    # Returned for the record (prompt-transparency sidecar + QC), NOT sent to Seedance.
    neg_items = ["jitter", "bent limbs", "warping", "identity drift", "morphing faces", "flickering"]
    neg_items.extend(user_neg)
    negative = ", ".join(neg_items)

    logger.info("[PromptAssembler:Video] POSITIVE=%r", positive[:200])
    logger.info("[PromptAssembler:Video] NEGATIVE=%r", negative)
    return positive, negative


class BytePlusGenerativeAPI:
    """
    Unified client for all BytePlus ModelArk generative endpoints.
    """

    def __init__(self):
        self.api_key = os.getenv("BYTEPLUS_API_KEY", "")
        self.base_url = os.getenv(
            "BYTEPLUS_BASE_URL",
            "https://ark.ap-southeast.bytepluses.com/api/v3",
        )
        self.seedream_api_key = os.getenv("SEEDDREAM4_API_KEY", self.api_key)
        self._llm_http_client = None

        try:
            self.llm_client = OpenAI(api_key=self.api_key, base_url=self.base_url)
            logger.info("BytePlus client (DeepSeek-V4-Flash + Seedream-5.0) initialised")
        except TypeError as e:
            if "proxies" in str(e):
                try:
                    self._llm_http_client = httpx.Client(timeout=60.0, follow_redirects=True)
                    self.llm_client = OpenAI(
                        api_key=self.api_key,
                        base_url=self.base_url,
                        http_client=self._llm_http_client,
                    )
                    logger.info("BytePlus client initialised with httpx fallback")
                except Exception as fallback_error:
                    logger.warning("Could not init client after fallback: %s", fallback_error)
                    self.llm_client = None
            else:
                logger.warning("Could not init client: %s", e)
                self.llm_client = None
        except Exception as e:
            logger.warning("Could not init client: %s", e)
            self.llm_client = None

    # ─────────────────────────────────────────────────────────────────────────
    # Image Understanding (Vision QC) — P4
    # Confirmed working model: seed-2-0-pro-260328 (doubao-vision-pro-32k 404s)
    # Multimodal embedding: skylark-embedding-vision-251215
    #   endpoint: /embeddings/multimodal  input: [{"type":"image_url","image_url":{"url":...}}]
    #   dim: 2048
    # ─────────────────────────────────────────────────────────────────────────

    VISION_MODEL = os.getenv("BYTEPLUS_VISION_MODEL", "seed-2-0-pro-260328")
    EMBED_MODEL  = os.getenv("BYTEPLUS_EMBED_MODEL",  "skylark-embedding-vision-251215")
    # THE ONE THAT ALSO HEARS. seed-2-0-lite-260428 and seed-2-0-mini-260428 are the only
    # models on this platform with audio understanding (llm-and-responses-api.md §1), and
    # they take video too — so a rendered clip can be judged on what it SHOWS and what it
    # SAYS in a single call, which nothing in this pipeline could do before: stage 5's
    # gates read prompts and metadata, never the film. Verified against the live API
    # 2026-08-15 on GLADIATOR TEST/SHOT_001, where it reported an identical duplicate of
    # the man and everyone standing frozen — the two defects the user had been reporting
    # by eye. Video audio tracks are extracted automatically (§11).
    MEDIA_MODEL  = os.getenv("BYTEPLUS_MEDIA_MODEL",  "seed-2-0-lite-260428")
    # Generation model IDs — env-overridable so a new release (Seedream 5 Pro,
    # Seedance 2.5, …) is a one-line .env change, no code edit. Before switching,
    # re-verify: (a) Seedream outputs stay Seedance-trusted (the identity anchor
    # depends on the watermark), (b) the Seedance param matrix (seed/camera_fixed/
    # resolutions differ per version — see byteplus-models-genius video ref §3).
    # Default is now Seedream 5.0 Pro EVERYWHERE (user decision 2026-07-12: Pro's
    # generation quality beats the Jan flagship even though Pro caps at ~2K, and
    # generate_image auto-clamps any WxH to Pro's ≤4.62MP / ×16 constraints).
    # Set SEEDREAM_MODEL=seedream-5-0-260128 in .env to fall back to the flagship
    # (e.g. if you need >2K character sheets for maximum per-face resolution).
    SEEDREAM_MODEL = os.getenv("SEEDREAM_MODEL", "dola-seedream-5-0-pro-260628")
    # 2b: model for MULTI-VIEW SETS (environment angles). Pro can't do a consistent
    # multi-image set — `sequential_image_generation` 400s on Pro (verified 2026-07-16;
    # see the Pro limits below). The Jan flagship `seedream-5-0-260128` DOES support it,
    # returning a coherent set of related views in ONE pass — the only way to get the
    # SAME room from 4 angles instead of 4 different rooms. Env-overridable.
    SEEDREAM_VIEWS_MODEL = os.getenv("SEEDREAM_VIEWS_MODEL", "seedream-5-0-260128")
    # Seedream 5.0 Pro — newest flagship, used for reference-conditioned EDITING
    # (subject insertion, wardrobe/attribute transfer, multi-image blending). The
    # default is the account-activated endpoint ID BytePlus' console auto-fills;
    # override per account via env. Pro-specific hard limits (verified against the
    # 2026-06 image API doc), enforced in generate_image():
    #   • single image only — NO sequential_image_generation / stream (sending them errors)
    #   • NO seed / guidance_scale
    #   • ≤ 10 reference images (vs 14 on 5.0-lite/4.5/4.0)
    #   • size capped at ~2K (max 2048x2048x1.1025 = 4,624,220 px); "4K" is invalid
    SEEDREAM_PRO_MODEL = os.getenv("SEEDREAM_PRO_MODEL", "dola-seedream-5-0-pro-260628")
    # Seedream 5.0 LITE — the complement to Pro, offered as an explicit choice in the
    # Studio. Where Pro caps at ~2K, Lite takes the descriptive 2K/3K/4K presets
    # (image-seedream.md §2/§8), so it is the model to pick when the output resolution
    # matters more than Pro's reference fidelity. Also the only Seedream in eu-west-1.
    SEEDREAM_LITE_MODEL = os.getenv("SEEDREAM_LITE_MODEL", "seedream-5-0-lite-260128")
    SEEDANCE_MODEL = os.getenv("SEEDANCE_MODEL", "dreamina-seedance-2-0-260128")
    # The two cheaper/faster members of the 2.0 family, offered as an explicit choice in
    # the Studio. BOTH top out at 720p — only base 2.0 (4k) and 2.5 (1080p) go higher
    # (video-seedance §1/§3), which _MODEL_MAX_RESOLUTION above enforces before the call.
    SEEDANCE_FAST_MODEL = os.getenv("SEEDANCE_FAST_MODEL", "dreamina-seedance-2-0-fast-260128")
    SEEDANCE_MINI_MODEL = os.getenv("SEEDANCE_MINI_MODEL", "dreamina-seedance-2-0-mini-260615")
    # Seedance 2.5 — an explicit OPT-IN tier, never the default. It brings 30 s single-shot
    # output and a 50-material reference budget (30 images / 10 videos / 10 audio), but it
    # renders only 480p/720p, so making it the default would break Final Cut's 4k export.
    # Its extra constraints (adaptive-only ratio on first-frame/first-last, mp4|mov output)
    # are enforced in create_studio_video via _MODEL_CAPS.
    SEEDANCE_25_MODEL = os.getenv("SEEDANCE_25_MODEL", "dreamina-seedance-2-5-260628")
    # ── Render tiers (long-form cost ladder) ─────────────────────────────────
    # A tier is nothing more than a (model, resolution) pair: 'preview' to judge
    # timing and blocking, 'edit' to judge the cut, 'master' at the project's
    # chosen output size for approved shots only. Documented per-5s base-model
    # cost — 480p $0.35 · 720p $0.76 · 1080p $1.87 · 4k $3.89 (video-seedance §11)
    # — so a preview pass over a ~540-shot episode is ~$189 against ~$2,100 to
    # render the same episode at master. That ratio is the whole point.
    #
    # All three tiers default to the BASE model deliberately. Fast/Mini top out
    # at 720p and look like the obvious cheap preview, but BytePlus documents
    # neither their price (§11 is explicitly scoped "Seedance 2.0 base, online")
    # nor whether they accept reference_images — and Take One Studio attaches storyboard
    # refs to nearly every shot, so a preview on a model that ignores them would
    # not predict the master. Point the env vars at Mini/Fast once both facts are
    # measured; nothing else has to change.
    SEEDANCE_PREVIEW_MODEL = os.getenv("SEEDANCE_PREVIEW_MODEL", SEEDANCE_MODEL)
    SEEDANCE_EDIT_MODEL    = os.getenv("SEEDANCE_EDIT_MODEL", SEEDANCE_MODEL)
    SEEDANCE_MASTER_MODEL  = os.getenv("SEEDANCE_MASTER_MODEL", SEEDANCE_MODEL)
    # preview/edit pin their own resolution; 'master' honours the project's setting.
    TIER_RESOLUTIONS = {"preview": "480p", "edit": "720p"}
    DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash-260425")

    # Settings' "Video model" picker → the model constant it selects. The UI sends this
    # key, never a raw id, so a model swap stays a one-line env change.
    _MODEL_CHOICES = {"v25": "SEEDANCE_25_MODEL", "base": "SEEDANCE_MODEL",
                      "fast": "SEEDANCE_FAST_MODEL", "mini": "SEEDANCE_MINI_MODEL"}

    @classmethod
    def resolve_tier(cls, tier: str | None, resolution: str,
                     model_choice: str | None = None) -> tuple[str, str, str]:
        """Resolve a render tier to the (model, resolution) actually submitted.

        Returns (model, resolution, decision) — `decision` is a human-readable
        string the caller logs, so a coerced render is always auditable rather
        than a silent downgrade the user pays for and cannot explain.

        tier=None is the legacy path: whatever resolution the caller asked for,
        on the default model. Existing clients that never send a tier keep their
        exact behaviour.

        `model_choice` is the project's Settings pick ('v25'|'base'|'fast'|'mini').
        It overrides the DEFAULT model but never a tier: preview/edit/master exist to
        pin a specific (model, resolution) pair for cost reasons, and letting a project
        setting silently re-point them would make a 'preview' cost whatever the picker
        happened to say. Unknown or empty → the previous behaviour, exactly.

        The resolution is COERCED DOWN to what the chosen model can render rather than
        raising: the UI warns about the mismatch and lets the user proceed on purpose
        (2.5 tops out at 1080p), so a render must not die at the API for a trade-off the
        user was shown and accepted.
        """
        requested = (resolution or "720p").strip().lower()
        key = (tier or "").strip().lower()
        if key not in ("preview", "edit", "master"):
            attr = cls._MODEL_CHOICES.get((model_choice or "").strip().lower())
            model = getattr(cls, attr) if attr else cls.SEEDANCE_MODEL
            ceiling = _MODEL_MAX_RESOLUTION.get(model)
            if ceiling and _RESOLUTION_ORDER.index(requested) > _RESOLUTION_ORDER.index(ceiling):
                logger.warning("[Seedance] %s cannot render %s — coerced to %s (Settings' warning "
                               "already told the user; upscale afterwards for the rest)",
                               model, requested, ceiling)
                requested = ceiling
            _assert_model_resolution(model, requested)
            return model, requested, f"model={model_choice or 'default'} → {model} @ {requested}"

        model = {
            "preview": cls.SEEDANCE_PREVIEW_MODEL,
            "edit": cls.SEEDANCE_EDIT_MODEL,
            "master": cls.SEEDANCE_MASTER_MODEL,
        }[key]
        # A tier pins the RESOLUTION — that is its cost lever — NOT the model family.
        # Making the tier win over the picker outright made the picker dead on the whole
        # pipeline, because stage 5 always sends one (`tier: opts?.tier ?? 'master'`): a
        # project whose breakdown was planned at 2.5's 30 s ceiling then rendered on 2.0
        # and every long segment answered 422 "renders at most 15s per call".
        # The escape hatch survives: an operator who explicitly set SEEDANCE_PREVIEW_MODEL
        # (etc.) to something OTHER than the default still gets exactly that model, since
        # the override is only applied when the tier is still pointing at SEEDANCE_MODEL.
        attr = cls._MODEL_CHOICES.get((model_choice or "").strip().lower())
        if attr and model == cls.SEEDANCE_MODEL:
            model = getattr(cls, attr)
        # preview/edit deliberately IGNORE the project's output size — that is what
        # makes them cheap. Only 'master' honours it.
        resolved = cls.TIER_RESOLUTIONS.get(key, requested)
        # Coerce down rather than raise, exactly as the no-tier branch does: a master
        # tier on a 4k project with 2.5 selected is a trade the Settings warning already
        # showed the user, not a reason to kill the render at the API.
        ceiling = _MODEL_MAX_RESOLUTION.get(model)
        if ceiling and _RESOLUTION_ORDER.index(resolved) > _RESOLUTION_ORDER.index(ceiling):
            logger.warning("[Seedance] tier=%s wanted %s but %s tops out at %s — coerced",
                           key, resolved, model, ceiling)
            resolved = ceiling
        _assert_model_resolution(model, resolved)
        note = "" if resolved == requested else f" (requested {requested}, pinned by tier)"
        return model, resolved, f"tier={key} → {model} @ {resolved}{note}"

    def _multimodal_embed(self, image_url: str, instructions: str | None = None) -> List[float]:
        """
        Embed an image using the ModelArk multimodal embedding model.
        Endpoint: /embeddings/multimodal
        Returns a dense float vector (default dimensionality is model-defined —
        the docs' sample run shows 3072; the earlier "2048-dim" comment was wrong).

        `instructions` (supported by -251215 and later) materially affects
        representation quality — the vendor explicitly warns against the default.
        Use the documented query/corpus templates (ModelArk/1409291).
        """
        data_uri = _vision_data_uri(image_url, timeout=60)
        # Video input is documented for -250615+ — detect and switch the item type
        is_video = data_uri.startswith("data:video/") or image_url.lower().split("?")[0].endswith((".mp4", ".mov"))
        if is_video:
            item = {"type": "video_url", "video_url": {"url": data_uri}}
        else:
            item = {"type": "image_url", "image_url": {"url": data_uri}}
        payload = {
            "model": self.EMBED_MODEL,
            "input": [item],
        }
        if instructions:
            payload["instructions"] = instructions
        resp = requests.post(
            f"{self.base_url}/embeddings/multimodal",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        # Response shape: {"data": {"embedding": [...]}} or {"data": [{"embedding":[...]}]}
        d = data.get("data", {})
        if isinstance(d, list):
            return d[0]["embedding"]
        return d["embedding"]

    def _cosine_distance(self, a: List[float], b: List[float]) -> float:
        """Cosine distance: 0.0 = identical, 1.0 = orthogonal."""
        import math
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(x * x for x in b))
        if norm_a == 0 or norm_b == 0:
            return 1.0
        cos_sim = dot / (norm_a * norm_b)
        return round(1.0 - max(-1.0, min(1.0, cos_sim)), 4)

    def compute_style_drift(
        self,
        image_url: str,
        style_description: str,
        style_anchor_urls: Optional[List[str]] = None,
    ) -> float:
        """
        P4 spec-compliant: primary signal is multimodal embedding cosine distance.
        - If style_anchor_urls provided: embed each anchor, compute centroid,
          measure cosine distance from asset image to centroid.
        - If no anchors: embed a text description of the style and compare.
        Returns drift score 0.0 (on-style) → 1.0 (off-style).
        """
        # Documented instruction templates (ModelArk/1409291): the query is the
        # candidate image, the corpus is the style-anchor library.
        QUERY_INSTR = (
            "Target_modality: image.\n"
            "Instruction:Find images that share the same artistic style, palette, "
            "lighting and rendering technique as this image, ignoring the subject\n"
            "Query:"
        )
        CORPUS_INSTR = "Instruction:Compress the image into one word.\nQuery:"
        try:
            asset_emb = self._multimodal_embed(image_url, instructions=QUERY_INSTR)

            if style_anchor_urls:
                # Embed each anchor and average → style centroid
                anchor_embs = []
                for url in style_anchor_urls[:4]:
                    try:
                        anchor_embs.append(self._multimodal_embed(url, instructions=CORPUS_INSTR))
                    except Exception as ae:
                        logger.warning("[StyleDrift] Anchor embed failed: %s", ae)
                if anchor_embs:
                    dim = len(anchor_embs[0])
                    centroid = [sum(e[i] for e in anchor_embs) / len(anchor_embs) for i in range(dim)]
                    drift = self._cosine_distance(asset_emb, centroid)
                    logger.info("[StyleDrift] Anchor cosine drift=%.3f", drift)
                    return drift

            # No anchors: embed the style description text, compare to image embedding.
            # NOTE: cross-modal text↔image cosine is an ESTIMATE — uncalibrated as a
            # percentage. Anchor images give the real signal (MODEL_AUDIT E4).
            text_payload = {
                "model": self.EMBED_MODEL,
                "instructions": (
                    "Target_modality: image.\n"
                    "Instruction:Based on the visual style described in this text, find "
                    "images rendered in that style\n"
                    "Query:"
                ),
                "input": [{"type": "text", "text": style_description or "cinematic film production"}],
            }
            resp = requests.post(
                f"{self.base_url}/embeddings/multimodal",
                json=text_payload,
                headers={"Authorization": f"Bearer {self.api_key}"},
                timeout=30,
            )
            if resp.status_code == 200:
                d = resp.json().get("data", {})
                text_emb = d[0]["embedding"] if isinstance(d, list) else d["embedding"]
                drift = self._cosine_distance(asset_emb, text_emb)
                logger.info("[StyleDrift] Text cosine drift=%.3f", drift)
                return drift
            else:
                logger.warning("[StyleDrift] Text embed failed: %s", resp.text[:100])
                return 0.5
        except Exception as e:
            logger.warning("[StyleDrift] Embedding drift failed (non-fatal): %s", e)
            return 0.5

    def compute_identity_drift(self, video_ref: str, character_image_ref: str) -> float:
        """
        P3.17: objective identity-drift score for a rendered shot.
        Embeds the rendered VIDEO (documented video input, frames auto-sampled)
        and the approved character image; cosine distance = drift.
        0.0 = same character throughout, 1.0 = unrelated.
        """
        video_emb = self._multimodal_embed(
            video_ref,
            instructions=("Instruction:Compress the video into one word.\nQuery:"),
        )
        char_emb = self._multimodal_embed(
            character_image_ref,
            instructions=(
                "Target_modality: video.\n"
                "Instruction:Find videos featuring this exact character with the same "
                "face, hair and wardrobe\n"
                "Query:"
            ),
        )
        drift = self._cosine_distance(char_emb, video_emb)
        logger.info("[IdentityDrift] video vs character ref = %.3f", drift)
        return drift

    def identity_drift_images(self, reference_image: str, candidate_image: str) -> float:
        """Image-vs-image identity drift for the consistency harness: embed an
        approved character reference and a candidate still, cosine distance = drift.
        0.0 = same character (face/hair/wardrobe), 1.0 = unrelated. Lets prompt
        variants / keyframes be ranked objectively instead of eyeballed."""
        instr = "Instruction:Represent this character's exact face, hair and wardrobe.\nQuery:"
        ref_emb = self._multimodal_embed(reference_image, instructions=instr)
        cand_emb = self._multimodal_embed(candidate_image, instructions=instr)
        drift = self._cosine_distance(ref_emb, cand_emb)
        logger.info("[Consistency] candidate vs reference = %.3f", drift)
        return drift

    def identity_match_vision(self, reference_image: str, candidate_image: str) -> Dict[str, Any]:
        """Vision-based consistency score for the harness (the multimodal-embedding
        endpoint is not enabled on this account). Shows the vision model the APPROVED
        character reference (image 1) and a candidate still (image 2) and asks how well
        the candidate keeps the SAME identity. Returns
        {consistency, face, wardrobe, differs, notes} — consistency/face/wardrobe 0-100."""
        if not self.llm_client:
            raise RuntimeError("Client not initialised - check BYTEPLUS_API_KEY")
        prompt = (
            "Image 1 is the APPROVED reference for a film character. Image 2 is a candidate "
            "generation. Judge how consistently image 2 preserves the SAME character — face "
            "shape, features, hair, and wardrobe — as image 1. Ignore pose, camera angle, "
            "lighting and background; judge identity only. Respond with JSON (no markdown):\n"
            "{\n"
            '  "consistency": 0-100 integer (100 = unmistakably the same person and outfit),\n'
            '  "face": 0-100 integer, "wardrobe": 0-100 integer,\n'
            '  "differs": "short phrase on the biggest mismatch, or \'none\'",\n'
            '  "notes": "one sentence"\n'
            "}\nOnly output valid JSON."
        )
        ref_uri = _vision_data_uri(reference_image, timeout=30)
        cand_uri = _vision_data_uri(candidate_image, timeout=30)
        client = self.llm_client.with_options(timeout=60.0)
        resp = client.chat.completions.create(
            model=self.VISION_MODEL,
            max_tokens=400,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": ref_uri}},
                    {"type": "image_url", "image_url": {"url": cand_uri}},
                    {"type": "text", "text": prompt},
                ],
            }],
        )
        try: usage.record_llm(getattr(resp, "usage", None), kind="vision")
        except Exception: pass
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        return json.loads(raw.strip())

    def read_top_view_vision(self, base_image: str, top_view_image: str,
                             description: str = "") -> Dict[str, Any]:
        """Vision read of a generated TOP VIEW against the approved base of the location.

        Shows the base (image 1) and the candidate top view (image 2) and asks the two
        questions a hash cannot answer — is image 2 an OVERHEAD, and is it THIS place —
        plus the specific failure that costs the most downstream: an INVENTED INTERIOR,
        a room that is in neither the base nor the description. Returns the raw fields;
        score_top_view (module level, pure) turns them into the verdict, and the block
        above it carries the measurement the wording and thresholds come from.

        Every sentence of this prompt is load-bearing and was measured — in particular
        "a correct top view legitimately looks very different" (without it the model
        fails genuine overheads on same_place) and the roof/deck/bridge carve-out in
        question 2 (without it a straight-down of a porch roof reads as "interior").
        """
        if not self.llm_client:
            raise RuntimeError("Client not initialised - check BYTEPLUS_API_KEY")
        prompt = (
            "Image 1 is the approved reference of a film location. Image 2 is meant to be its "
            "TOP VIEW MAP: an overhead/bird's-eye plan of THAT SAME location, used by the art "
            "department as a layout reference.\n"
            f'Written description of the location: "{description}"\n\n'
            "A correct top view legitimately looks very different from image 1 — different "
            "composition, different objects visible, a footprint you could not have guessed. Do "
            "NOT fail it merely for looking different or for having a differently shaped floor "
            "plan.\n\n"
            "Answer these, independently:\n"
            "0) Describe image 2 in one sentence: what space is it, and where is the camera?\n"
            "1) SCENE TYPE of image 1 (plus the description): is this location an ENCLOSED "
            "INTERIOR (inside a room, walls and ceiling around the camera) or an EXTERIOR / open "
            "space?\n"
            "2) SCENE TYPE of image 2, same question. Answer 'interior' ONLY if the camera is "
            "clearly inside a room, under a ceiling, with walls around the frame. Looking DOWN "
            "from above at a roof, a deck, a porch, a bridge/gantry, a yard or an open-topped "
            "structure is 'exterior' even when built structures fill the frame; a mirror-like "
            "reflection in water is not a second structure.\n"
            "3) PITCH — how far above horizontal is image 2's camera looking DOWN, in degrees? "
            "Use the cues: if you can see a far WALL meeting the floor, a horizon line, or the "
            "FRONTS/sides of furniture and structures, the pitch is BELOW 40. If you mostly see "
            "the TOPS of objects and the floor/ground plane fills the frame, it is ABOVE 60. "
            "90 = straight down.\n"
            "4) SAME PLACE 0-100 — do image 2's materials, structures, set dressing, vegetation, "
            "palette and lighting belong to the location of image 1 / the description? Judge by "
            "what CARRIES OVER, not by composition.\n"
            "5) INVENTED INTERIOR — the specific failure to catch: image 2 shows an enclosed room "
            "with its own walls, ceiling and furniture that is NOT visible in image 1 and NOT "
            "named in the description. NOTE: if image 1 is an EXTERIOR and image 2 is the inside "
            "of a room, that is an invented interior even when it looks like the inside of the "
            "same building — the film has no such room. A differently shaped footprint, or more "
            "of the same space than image 1 showed, is NOT an invented interior.\n\n"
            "Respond with JSON only (no markdown):\n"
            "{\n"
            '  "top_description": "one sentence",\n'
            '  "ref_type": "interior" | "exterior",\n'
            '  "top_type": "interior" | "exterior",\n'
            '  "pitch_deg": 0-90 integer,\n'
            '  "same_place": 0-100 integer,\n'
            '  "invented_interior": true | false,\n'
            '  "invented_what": "short phrase, or \'none\'",\n'
            '  "reason": "one sentence"\n'
            "}\n"
            "Only output valid JSON."
        )
        base_uri = _vision_data_uri(base_image, timeout=30)
        top_uri = _vision_data_uri(top_view_image, timeout=30)
        client = self.llm_client.with_options(timeout=90.0)
        resp = client.chat.completions.create(
            model=self.VISION_MODEL,
            max_tokens=400,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": base_uri}},
                    {"type": "image_url", "image_url": {"url": top_uri}},
                    {"type": "text", "text": prompt},
                ],
            }],
        )
        try: usage.record_llm(getattr(resp, "usage", None), kind="vision")
        except Exception: pass
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        return json.loads(raw.strip())

    # Documented ceilings for inline (base64/URL) media, llm-and-responses-api.md §11:
    # 10 MB per image, 50 MB per audio/video, 64 MB for the whole request body. Past
    # them the Files API is the documented route; these are the inline limits and the
    # code refuses rather than sending a request that will be rejected downstream.
    _MEDIA_MAX_VIDEO_BYTES = 50 * 1024 * 1024   # base64 video, per the platform mirror
    #: AUDIO IS A TIGHTER CAP THAN VIDEO, and it is its own number: 25 MB and 120 minutes
    #: per request (Volcano Engine Chat API, audio understanding). This was set to the
    #: video figure when the method was written, which would have sent a 40 MB take and
    #: taken a 400 with no useful message.
    _MEDIA_MAX_AUDIO_BYTES = 25 * 1024 * 1024
    _MEDIA_BODY_BYTES   = 60 * 1024 * 1024   # under the 64 MB body cap, with headroom
    _VIDEO_EXTS = (".mp4", ".mov", ".webm", ".mkv", ".avi")
    #: The documented PURE-audio formats, and only those. flac/ogg/opus/pcm are NOT in the
    #: list — pcm and ac3 appear only as tracks embedded inside a video container, which
    #: this path never sends on their own. Accepting them here would produce a rejection
    #: the caller cannot act on.
    _AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".aac")

    def analyze_media(
        self,
        paths: List[str],
        question: str,
        max_tokens: int = 1500,
        fps: float = 1.0,
    ) -> str:
        """Ask MEDIA_MODEL a free-form question about images, VIDEO and/or AUDIO.

        The one call in this file that can judge a finished shot: it watches the clip and
        hears its dialogue. Everything else here reads prompts, metadata or stills.

        The content-part shapes are NOT guessed — the vendored reference documents only
        `file_id`, so all three were probed against the live API (2026-08-15) and the
        rejection listed the valid set verbatim: `text`, `image_url`, `video_url`,
        `input_audio`, `file`.
            image → {"type": "image_url",   "image_url": {"url": <data-uri>}}
            video → {"type": "video_url",   "video_url": {"url": <data-uri>}}
            audio → {"type": "input_audio", "input_audio": {"data": <b64>, "format": ext}}
        (`audio_url` is rejected on Chat; the Responses API takes `input_audio.audio_url`
        instead. Chat is used here because it is the shape the rest of this client uses.)

        Images go through `_vision_data_uri` for the 10 MB cap; A/V is sent as-is because
        re-encoding a clip would change the very thing being judged.
        """
        import base64 as _b64
        import mimetypes as _mt

        content: List[Dict[str, Any]] = []
        total = 0
        for p in paths[:8]:
            low = str(p).lower()
            if low.endswith(self._VIDEO_EXTS) or low.endswith(self._AUDIO_EXTS):
                if p.startswith(("http://", "https://")):
                    raw = requests.get(p, timeout=120).content
                else:
                    with open(p, "rb") as fh:
                        raw = fh.read()
                _is_audio = low.endswith(self._AUDIO_EXTS)
                _cap = self._MEDIA_MAX_AUDIO_BYTES if _is_audio else self._MEDIA_MAX_VIDEO_BYTES
                if len(raw) > _cap:
                    raise ValueError(
                        f"{os.path.basename(str(p))} is {len(raw)/1e6:.0f} MB — over the "
                        f"{_cap//(1024*1024)} MB inline limit for "
                        f"{'audio' if _is_audio else 'video'}; upload it via the Files API")
                total += len(raw)
                if total > self._MEDIA_BODY_BYTES:
                    raise ValueError("combined media exceeds the 64 MB request-body cap")
                b64 = _b64.b64encode(raw).decode()
                if low.endswith(self._AUDIO_EXTS):
                    fmt = os.path.splitext(low)[1].lstrip(".")
                    content.append({"type": "input_audio",
                                    "input_audio": {"data": b64, "format": fmt}})
                else:
                    mime = _mt.guess_type(low)[0] or "video/mp4"
                    # `fps` is the frame-sampling density, documented range [0.2, 5],
                    # default 1. It decides how much of the MOTION the model can see, so a
                    # question about whether anyone actually moves is answered on far too
                    # little evidence at 1 fps. Higher costs tokens, which is why it is a
                    # parameter and not a constant.
                    _v: Dict[str, Any] = {"url": f"data:{mime};base64,{b64}"}
                    _f = max(0.2, min(5.0, float(fps or 1.0)))
                    if abs(_f - 1.0) > 1e-9:
                        _v["fps"] = _f
                    content.append({"type": "video_url", "video_url": _v})
            else:
                content.append({"type": "image_url",
                                "image_url": {"url": _vision_data_uri(p, timeout=30)}})
        content.append({"type": "text", "text": question})

        resp = self.llm_client.with_options(timeout=600.0).chat.completions.create(
            model=self.MEDIA_MODEL, max_tokens=max_tokens,
            messages=[{"role": "user", "content": content}],
        )
        try:
            usage.record_llm(getattr(resp, "usage", None), kind="media")
        except Exception:
            pass   # metering must never break a read
        return (resp.choices[0].message.content or "").strip()

    def analyze_image_vision(
        self,
        image_url: str,
        style_context: str = "",
    ) -> Dict[str, Any]:
        """
        P4 secondary signal: human-readable visual observations.
        Uses seed-2-0-pro-260328 (confirmed working on this ModelArk account).
        Returns dominant_palette, lighting, render_style, observations.
        NOTE: style_match_score from this call is NOT used as the drift metric —
        that comes from compute_style_drift() (embedding cosine distance).
        """
        if not self.llm_client:
            raise RuntimeError("Client not initialised - check BYTEPLUS_API_KEY")

        prompt = (
            "Analyze this concept art image for production QC. "
            "Respond with a JSON object (no markdown fences) containing:\n"
            "{\n"
            '  "dominant_palette": "brief color description",\n'
            '  "lighting": "lighting direction and temperature",\n'
            '  "render_style": "photorealistic | anime | cartoon | 3D | comic | painterly | other",\n'
            '  "face_visibility": "clear | partial | none — is a HUMAN character face clearly and frontally visible and large enough to identify? Answer \'none\' for insert shots (hands, objects, text), backs of heads, or faces too small/dark/blurred to recognize",\n'
            '  "observations": "2-3 sentence visual quality assessment"\n'
            "}\n"
            "Only output valid JSON."
        )

        data_uri = _vision_data_uri(image_url, timeout=20)
        client = self.llm_client.with_options(timeout=60.0)
        resp = client.chat.completions.create(
            model=self.VISION_MODEL,
            max_tokens=512,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_uri}},
                    {"type": "text", "text": prompt},
                ],
            }],
        )
        try: usage.record_llm(getattr(resp, "usage", None), kind="vision")
        except Exception: pass
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        return json.loads(raw.strip())

    def describe_character_refs(self, image_urls: List[str]) -> Dict[str, str]:
        """Vision read of 1+ character reference images → structured, generation-ready
        fields. Describes ONLY what is visible (never invents). Seed 2.0 Pro vision.
        Returns {appearance, hairstyle, wardrobe, shoes, props} (strings)."""
        if not self.llm_client:
            raise RuntimeError("Client not initialised - check BYTEPLUS_API_KEY")
        urls = [u for u in (image_urls or []) if u][:4]   # cap vision cost
        if not urls:
            raise ValueError("describe_character_refs needs at least one image")
        prompt = (
            "Look at the reference image(s) of a person/character and describe ONLY what you can "
            "see, as a brief for an AI image generator. Do NOT invent anything that is not visible. "
            "Answer in ENGLISH. "
            "Respond with a JSON object (no markdown fences):\n"
            "{\n"
            '  "appearance": "face, apparent age range, build, skin tone, distinctive visible features",\n'
            '  "hairstyle": "hair length, style and colour",\n'
            '  "wardrobe": "visible garments — type, colour, material, fit",\n'
            '  "shoes": "footwear if visible, else empty string",\n'
            '  "props": "held or worn accessories/objects if visible, else empty string"\n'
            "}\n"
            "Each value is a concise phrase. Only output valid JSON."
        )
        content: List[Dict[str, Any]] = [
            {"type": "image_url", "image_url": {"url": _vision_data_uri(u, timeout=20)}} for u in urls
        ]
        content.append({"type": "text", "text": prompt})
        client = self.llm_client.with_options(timeout=90.0)
        resp = client.chat.completions.create(
            model=self.VISION_MODEL, max_tokens=700,
            messages=[{"role": "user", "content": content}],
        )
        try: usage.record_llm(getattr(resp, "usage", None), kind="vision")
        except Exception: pass
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        data = json.loads(raw.strip())
        return {k: str(data.get(k, "") or "").strip()
                for k in ("appearance", "hairstyle", "wardrobe", "shoes", "props")}

    def analyze_storyboard_continuity(self, board_urls: List[str]) -> Dict[str, Any]:
        """Vision-read ALL of a scene's rendered boards TOGETHER for cross-panel CONTINUITY — the
        storyboard QC's only real visual signal (3-qc). Flags concrete DRIFT (a character's
        face/hair/wardrobe changing between boards, palette/style shifts, screen-direction breaks)
        that a text-only QC (reviewing the descs it generated) can never see. Non-fatal → {}."""
        if not self.llm_client:
            return {}
        urls = [u for u in (board_urls or []) if u][:8]   # cap vision cost / payload
        if not urls:
            return {}
        prompt = (
            "These are the storyboard panels of ONE film scene, in order. Judge CONTINUITY ACROSS "
            "them and report concretely, naming the panels: does every recurring character keep the "
            "SAME face, hair and wardrobe in each panel — flag any face/identity/costume DRIFT; is "
            "the render style and colour palette consistent — flag style drift; do consecutive panels "
            "respect screen direction / the 180-degree rule / eyelines. Answer in ENGLISH as JSON "
            '(no markdown fences): {"render_style": "<one phrase>", "drift": "<\'none\' if truly clean, '
            'else the concrete face/style/direction drift, naming panels>", "observations": "<other '
            'continuity notes>"}. Only output valid JSON.'
        )
        try:
            content: List[Dict[str, Any]] = [
                {"type": "image_url", "image_url": {"url": _vision_data_uri(u, timeout=20)}} for u in urls
            ]
            content.append({"type": "text", "text": prompt})
            client = self.llm_client.with_options(timeout=90.0)
            resp = client.chat.completions.create(
                model=self.VISION_MODEL, max_tokens=700,
                messages=[{"role": "user", "content": content}],
            )
            try: usage.record_llm(getattr(resp, "usage", None), kind="vision")
            except Exception: pass
            raw = resp.choices[0].message.content.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw.rsplit("```", 1)[0]
            return json.loads(raw.strip())
        except Exception as e:
            logger.warning("[StoryboardContinuity] vision failed (non-fatal): %s", e)
            return {}

    def describe_face_vision(self, image_url: str) -> str:
        """Extract a concrete facial-feature description of the person in an
        approved character image (headshot / design sheet). Feeds the cached
        fictional face block so a photoreal keyframe (pure t2i — no image refs)
        reproduces a face CLOSE to the approved character across shots.
        See seedance-identity-filter. Returns "" on any failure (caller falls
        back to the text description)."""
        if not self.llm_client:
            return ""
        prompt = (
            "Describe ONLY the face of the main person in this image, as concrete "
            "physical traits a text-to-image model can reproduce. Cover: face shape, "
            "bone structure, cheekbones, jaw, eyes (shape/set/colour), eyebrows, nose, "
            "lips, skin texture (freckles/scars/wrinkles), notable marks, hair "
            "(colour/length/style), facial hair, and approximate age. One dense line, "
            "comma-separated traits, no preamble. Do NOT name or guess any real or "
            "famous person."
        )
        try:
            data_uri = _vision_data_uri(image_url, timeout=20)
            client = self.llm_client.with_options(timeout=60.0)
            resp = client.chat.completions.create(
                model=self.VISION_MODEL,
                max_tokens=320,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_uri}},
                        {"type": "text", "text": prompt},
                    ],
                }],
            )
            try: usage.record_llm(getattr(resp, "usage", None), kind="vision")
            except Exception: pass
            return (resp.choices[0].message.content or "").strip()
        except Exception as e:
            logger.warning("[FaceVision] describe failed: %s", e)
            return ""

    def motion_prompt_vision(self, image_url: str, hint: str = "") -> str:
        """Look at a still and write the MOTION for it — a Seedance i2v prompt.

        The prompt deliberately describes CHANGE, not content: in i2v Seedance already
        has the frame, so re-describing what is in it wastes the prompt and dilutes the
        direction (the video guide's spatial/temporal split — the still covers the
        spatial layer, the prompt must carry the temporal one). `hint` is the user's own
        wording, honoured when present. Returns "" on any failure (the caller keeps
        whatever the user typed)."""
        if not self.llm_client:
            return ""
        prompt = (
            "This still is the FIRST FRAME of a short video. Write the prompt that "
            "animates it. Describe ONLY what CHANGES over the next few seconds — the "
            "subject's movement (with direction, speed and inertia), the camera move "
            "(push in / pull back / pan / tilt / orbit / static), and how the light or "
            "atmosphere shifts. Do NOT re-describe what is already visible in the frame, "
            "do not name a style, and do not add people or objects that are not there. "
            "Keep it to 2-3 concrete sentences of plain prose, no lists, no preamble."
        )
        if hint.strip():
            prompt += f" The director wants: {hint.strip()} — build the motion around that."
        try:
            data_uri = _vision_data_uri(image_url, timeout=20)
            client = self.llm_client.with_options(timeout=60.0)
            resp = client.chat.completions.create(
                model=self.VISION_MODEL,
                max_tokens=400,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_uri}},
                        {"type": "text", "text": prompt},
                    ],
                }],
            )
            try: usage.record_llm(getattr(resp, "usage", None), kind="vision")
            except Exception: pass
            return (resp.choices[0].message.content or "").strip()
        except Exception as e:
            logger.warning("[MotionVision] describe failed: %s", e)
            return ""

    # ─────────────────────────────────────────────────────────────────────────
    # DeepSeek-V4-Flash
    # ─────────────────────────────────────────────────────────────────────────

    # DEAD CODE (1a, 2026-07-15): call_deepseek + generate_script + generate_breakdown
    # below have ZERO callers. Script + breakdown generation live in ClaudeQCAgents
    # (claude_agents.py) — the endpoints call THOSE. DeepSeek was never wired into
    # the live pipeline (the previously-cited external callers rag_engine.py/app.py
    # no longer exist). Kept, not deleted, only because an out-of-repo notebook/CLI
    # could still import them; safe to remove once that's ruled out. Do NOT reach
    # for these — the writing "brain" is Claude (BREAKDOWN_BACKEND / CLAUDE_AGENT_MODEL).
    def call_deepseek(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 2000,
        request_timeout: float = 180.0,
        max_retries: int = 0,
    ) -> str:
        if not self.llm_client:
            raise RuntimeError("LLM client not initialised - check BYTEPLUS_API_KEY")
        client = self.llm_client.with_options(timeout=request_timeout, max_retries=max_retries)
        resp = client.chat.completions.create(
            model=self.DEEPSEEK_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        try: usage.record_llm(getattr(resp, "usage", None), kind="vision")
        except Exception: pass
        return resp.choices[0].message.content

    def generate_script(self, concept: str) -> str:
        system = (
            "You are a professional screenwriter for short films and TV.\n"
            "Given a concept, produce a formatted script with clearly labelled:\n"
            "  SCENE headings (INT./EXT., location, time),\n"
            "  ACTION lines,\n"
            "  DIALOGUE with character names.\n"
            "Keep it concise - aim for 8-15 scenes that tell a complete story arc.\n"
            "Output ONLY the script text, no extra commentary."
        )
        return self.call_deepseek(system, concept, temperature=0.8, max_tokens=3000,
                                  request_timeout=180.0, max_retries=1)

    def generate_breakdown(self, script: str) -> Dict[str, Any]:
        script = (script or "")[:12000]
        system = (
            "You are a VFX/animation production coordinator.\n"
            "Given a script, output a JSON object (no markdown fences) with:\n"
            "{\n"
            '  "assets": [\n'
            '    {"id": "ASSET_001", "name": "...", "type": "character|prop|environment|fx",\n'
            '     "visual_description": "concise visual description, max 50 words"}\n'
            "  ],\n"
            '  "shots": [\n'
            '    {"id": "SHOT_001", "scene": "...", "action": "...",\n'
            '     "visual_description": "concise visual description, max 50 words",\n'
            '     "assets_used": ["ASSET_001", ...], "duration_sec": 3}\n'
            "  ]\n"
            "}\n"
            "Rules: keep ALL string values under 60 words. One shot per major camera setup. "
            "Return ONLY valid, complete JSON — do not truncate."
        )
        try:
            raw = self.call_deepseek(system, script, temperature=0.2, max_tokens=4000,
                                     request_timeout=180.0, max_retries=0)
        except Exception as e:
            if "timed out" in str(e).lower() or "timeout" in str(e).lower():
                logger.warning("Breakdown timed out, retrying compact: %s", e)
                raw = self.call_deepseek(system, script, temperature=0.2, max_tokens=2500,
                                         request_timeout=120.0, max_retries=0)
            else:
                raise
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        raw = raw.strip()
        decoder = json.JSONDecoder()
        result, _ = decoder.raw_decode(raw)
        return result

    # ─────────────────────────────────────────────────────────────────────────
    # Seedream-5.0  — Image generation with optional reference images
    #
    # Reference image support (extra_body):
    #   ref_images: list of {"url": "<data-URI or http URL>", "weight": 0.0–1.0}
    #   weight controls how strongly the reference influences the output
    #   (0.0 = style hint only, 1.0 = strict likeness)
    #
    # Docs: https://docs.byteplus.com/en/docs/ModelArk/1399008
    # ─────────────────────────────────────────────────────────────────────────

    # Reference wire format. "image" = the documented param (array, up to 14 refs,
    # docs.byteplus.com/en/docs/ModelArk/1824121); "ref_images" = the legacy
    # undocumented extra_body form kept only for A/B comparison.
    SEEDREAM_REF_MODE = os.getenv("SEEDREAM_REF_MODE", "image")
    SEEDREAM_MAX_REFS = 14   # documented ceiling: input refs + generated images ≤ 15
    SEEDREAM_PRO_MAX_REFS = 10   # Pro accepts fewer refs than lite/4.5/4.0

    def generate_image(
        self,
        prompt: str,
        size: str = "2K",
        n: int = 1,
        reference_images: Optional[List[Dict[str, Any]]] = None,
        negative_prompt: Optional[str] = None,
        seed: Optional[int] = None,
        project_path: str = "",   # explicit so usage counts even from a thread pool
        output_format: str = "jpeg",   # "png" = lossless → preserves the trusted watermark
        model: Optional[str] = None,   # override the model (e.g. SEEDREAM_PRO_MODEL for edits)
        ref_mode: Optional[str] = None,  # per-call override of SEEDREAM_REF_MODE (env angles use
                                         # 'ref_images' so the weight is honored — a WEAK anchor)
    ) -> List[str]:
        """
        Generate images with Seedream 5.0.

        Args:
            prompt: Text description.
            size: "2K"/"4K" preset or exact pixels e.g. "2848x1600".
                EMPIRICAL (2026-06-11, InvalidParameter responses): exact sizes
                must be ≥ 3,686,400 px (2560x1440) and "1K" is rejected — there
                is NO draft-size tier below ~3.7MP on seedream-5-0.
            n: Number of images (1–4).
            reference_images: Optional list of reference dicts:
                [{"url": "data:image/... | https://... | /abs/path", "weight": 0.8}, ...]
                ORDER MATTERS (identity refs first). Up to 14 references reach the
                API (documented limit); "weight" is only honoured by the legacy
                ref_images mode — the documented `image` param has no weights.
            seed: optional — accepted by the API; recording it makes a take
                reproducible (same seed + prompt + size).
        """
        if not self.llm_client:
            raise RuntimeError("Client not initialised - check BYTEPLUS_API_KEY")

        img_client = (
            OpenAI(api_key=self.seedream_api_key, base_url=self.base_url)
            if self.seedream_api_key != self.api_key
            else self.llm_client
        )

        model_id = model or self.SEEDREAM_MODEL
        is_pro = "pro" in model_id.lower()
        max_refs = self.SEEDREAM_PRO_MAX_REFS if is_pro else self.SEEDREAM_MAX_REFS
        # Pro is capped at ~2K (max 4,624,220 px). A "4K"/"3K" preset is rejected —
        # clamp so a request built for the 4K pipeline still succeeds on Pro.
        if is_pro and isinstance(size, str) and size.upper() in ("3K", "4K"):
            logger.warning("[Seedream] size %s not supported on Pro (≤2K) — clamped to 2K", size)
            size = "2K"
        # Pro method-1 sizes (WxH, e.g. storyboard grids) must ALSO satisfy: total
        # pixels ≤ 4,624,220 AND each side a multiple of 16. Downscale-to-fit +
        # round each side down to ×16 so any grid geometry is Pro-valid.
        elif is_pro and isinstance(size, str) and "x" in size.lower():
            try:
                _w, _h = (int(v) for v in size.lower().split("x", 1))
            except ValueError:
                _w = _h = 0
            if _w > 0 and _h > 0:
                PRO_MAX_PX = 4_624_220
                if _w * _h > PRO_MAX_PX:
                    import math as _math
                    s = _math.sqrt(PRO_MAX_PX / (_w * _h))
                    _w, _h = int(_w * s), int(_h * s)
                _w = max(16, (_w // 16) * 16)
                _h = max(16, (_h // 16) * 16)
                new_size = f"{_w}x{_h}"
                if new_size != size:
                    logger.info("[Seedream] Pro: size %s → %s (≤2K, ×16)", size, new_size)
                    size = new_size
        # LITE TIENE SUELO, NO SÓLO TECHO. image-seedream.md §2: para seedream-5-0-lite un
        # WxH exacto debe caer en [2560×1440 = 3,686,400 , 4096×4096 = 16,777,216] píxeles
        # con aspecto en [1/16, 16]. El recorte de Pro de arriba sólo baja; un WxH pequeño
        # —p. ej. calculado a partir de una foto de 1200×1600 para respetar su
        # proporción— se rechazaba en Lite con InvalidParameter. Se escala a la ventana
        # conservando la proporción y se redondea a ×16, como en Pro.
        elif isinstance(size, str) and "x" in size.lower():
            try:
                _w, _h = (int(v) for v in size.lower().split("x", 1))
            except ValueError:
                _w = _h = 0
            if _w > 0 and _h > 0:
                import math as _math
                LITE_MIN_PX, LITE_MAX_PX = 3_686_400, 16_777_216
                px = _w * _h
                if px < LITE_MIN_PX or px > LITE_MAX_PX:
                    s_ = _math.sqrt((LITE_MIN_PX if px < LITE_MIN_PX else LITE_MAX_PX) / px)
                    _w, _h = int(_w * s_), int(_h * s_)
                _w = max(16, (_w // 16) * 16)
                _h = max(16, (_h // 16) * 16)
                # El redondeo hacia abajo puede volver a caer bajo el suelo por unos píxeles:
                # se sube de 16 en 16 el lado mayor hasta cruzarlo.
                while _w * _h < LITE_MIN_PX:
                    if _w >= _h: _w += 16
                    else: _h += 16
                new_size = f"{_w}x{_h}"
                if new_size != size:
                    logger.info("[Seedream] Lite: size %s → %s (window %d..%d px, ×16)",
                                size, new_size, LITE_MIN_PX, LITE_MAX_PX)
                    size = new_size

        # Negative prompt: the API's negative_prompt field is a CONTENT NO-OP —
        # fixed-seed A/B (2026-06-11): negative "red, red apple, warm colors"
        # left the apple bright red. Same finding as Seedance. The only working
        # channel is the positive prompt, so exclusions ride there; real style
        # control comes from fronting the render medium (prompt guide §1.2-1.3).
        if negative_prompt:
            prompt = f"{prompt.rstrip('.')}. Render none of the following: {negative_prompt}."
            logger.info("[Seedream] negative folded into prompt (API field is a no-op): %r",
                        negative_prompt[:60])

        extra: Dict[str, Any] = {"watermark": False, "output_format": output_format}
        # `seed` is NOT supported on Seedream 5.0 / 4.5 / 4.0 (Model-Genius image ref §8
        # matrix — only seededit-3-0/3-0-t2i honour it). Sending it was a no-op; kept out
        # of the body so we don't imply reproducibility the model can't deliver.
        if seed is not None:
            logger.debug("[Seedream] seed=%s ignored — Seedream 5.0 does not support seed", seed)
        if reference_images:
            valid = [r for r in reference_images if r.get("url")]
            if len(valid) > max_refs:
                logger.warning(
                    "[Seedream] DROPPING %d reference image(s) — limit for %s is %d. "
                    "Kept the first %d in priority order.",
                    len(valid) - max_refs, model_id, max_refs, max_refs,
                )
                valid = valid[:max_refs]
            resolved = [_url_to_data_uri(r["url"]) for r in valid]
            if resolved:
                _mode = ref_mode or self.SEEDREAM_REF_MODE
                if _mode == "ref_images":
                    extra["ref_images"] = [
                        {"url": uri, "weight": float(r.get("weight", 0.7))}
                        for uri, r in zip(resolved, valid)
                    ]
                else:
                    # Documented form: `image` accepts a string or array of strings
                    extra["image"] = resolved if len(resolved) > 1 else resolved[0]
                logger.info(
                    "[Seedream] Attaching %d reference image(s) via %r param",
                    len(resolved), "ref_images" if _mode == "ref_images" else "image",
                )

        ref_count = len(extra.get("ref_images", [])) or (
            len(extra["image"]) if isinstance(extra.get("image"), list) else (1 if extra.get("image") else 0)
        )
        all_urls: List[str] = []
        for _ in range(min(n, 4)):
            logger.info("[Seedream] Generating image via %s (refs=%d, size=%s)…", model_id, ref_count, size)
            response = img_client.images.generate(
                model=model_id,
                prompt=prompt,
                size=size,
                response_format="url",
                extra_body=extra,
            )
            for img in response.data:
                if img.url:
                    all_urls.append(img.url)
            # METERED PER RESPONSE, not once per call, and from the response rather than
            # from `len(all_urls)`. The count alone cannot be priced: Seedream is billed
            # by MODEL and by PIXEL TIER (measured — this model at size="2K" returns
            # 4.19-4.46 MP, above the 2.61 MP boundary, i.e. 3x the flat 0.03 the meter
            # used to assume), and the input references are a separate line item. All of
            # model / geometry / `input_images` are sitting in `response` and were being
            # thrown away here. usage.record_image_response reads them; see its docstring.
            try: usage.record_image_response(response, model_id, project_path=project_path)
            except Exception: pass  # noqa: BLE001 — metering must never break generation

        logger.info("[Seedream] Received %d image URL(s)", len(all_urls))
        return all_urls

    def edit_image(
        self,
        prompt: str,
        reference_images: List[Dict[str, Any]],
        size: str = "2K",
        output_format: str = "png",
        project_path: str = "",
    ) -> List[str]:
        """
        Seedream 5.0 Pro reference-conditioned EDIT — one edited image from a base
        subject + optional context references + an edit instruction.

        reference_images ORDER MATTERS: the image being edited goes FIRST (the
        prompt refers to it as "Image 1"); context refs (environment, wardrobe,
        another character) follow as Image 2, 3, … Up to 10 refs (Pro ceiling).
        Pro is single-image → returns exactly one URL (empty list on failure).

        Documented capabilities: subject insertion into a new environment with
        matched lighting/contact-shadows/DoF, wardrobe & attribute transfer,
        free-instruction attribute edits, and multi-subject compositing.
        Runs on SEEDREAM_PRO_MODEL.
        """
        if not reference_images or not any(r.get("url") for r in reference_images):
            raise ValueError("edit_image needs at least one reference image (the subject to edit)")
        return self.generate_image(
            prompt=prompt,
            size=size,
            n=1,
            reference_images=reference_images,
            output_format=output_format,
            project_path=project_path,
            model=self.SEEDREAM_PRO_MODEL,
        )

    def generate_variations_sized(
        self,
        description: str,
        count: int,
        size: str,
        reference_images: Optional[List[Dict[str, Any]]] = None,
        negative_prompt: Optional[str] = None,
        on_slot: Optional[Callable[[int, Dict[str, Any]], None]] = None,
        project_path: str = "",
    ) -> List[Dict[str, Any]]:
        """generate_variations at an explicit pixel size (identity boards are 16:9)."""
        return self._generate_variations_impl(description, count, size, reference_images, negative_prompt, on_slot, project_path)

    def generate_variations(
        self,
        description: str,
        count: int = 4,
        reference_images: Optional[List[Dict[str, Any]]] = None,
        negative_prompt: Optional[str] = None,
        on_slot: Optional[Callable[[int, Dict[str, Any]], None]] = None,
        project_path: str = "",
    ) -> List[Dict[str, Any]]:
        return self._generate_variations_impl(description, count, "2K", reference_images, negative_prompt, on_slot, project_path)

    def _generate_variations_impl(
        self,
        description: str,
        count: int,
        size: str,
        reference_images: Optional[List[Dict[str, Any]]] = None,
        negative_prompt: Optional[str] = None,
        on_slot: Optional[Callable[[int, Dict[str, Any]], None]] = None,
        project_path: str = "",
    ) -> List[Dict[str, Any]]:
        """
        Generate `count` variations with PER-SLOT outcomes — a failed slot is
        reported, never silently dropped (the old path could render 1 image and
        present it as the full set).

        Reliability rules (verified failure modes: content-filter false
        positives, transient 5xx/timeouts):
          - concurrency 4 — the standard 4-variation set finishes in ONE wave
          - each failed slot retried up to 4× — content-filter blocks with a FRESH
            seed (a block is deterministic for a given seed; replaying it would block
            again), transient connection/rate/5xx errors with EXPONENTIAL BACKOFF
            (1s/2s/4s) so a BytePlus burst-protection window can pass
          - returns [{url, error, attempts, seed}] in slot order; the seed makes
            an approved take reproducible
          - on_slot(index, result) fires as each slot lands — the async job
            endpoint streams progressive results to the UI through it
        """
        # Up to 8 variations so the user has more to choose from. Concurrency stays
        # at 4 (below) → 8 runs as two waves of 4, respecting the image rate limit.
        n = max(1, min(count, 8))

        def _gen_slot(slot: int) -> Dict[str, Any]:
            last_err = ""
            seed = random.randint(1, 2**31 - 1)
            # 4 attempts. TRANSIENT failures get EXPONENTIAL BACKOFF: the OpenAI SDK raises
            # APIConnectionError → str "Connection error." on a reset/timeout, and BytePlus
            # burst-protection (many concurrent Seedream calls when a whole cast is generated
            # at once) returns 429/5xx — a short back-off lets that window pass instead of
            # hammering the same wall on an immediate retry. Content-filter/param blocks get an
            # immediate FRESH-SEED retry (a block is deterministic per seed → a new seed can
            # clear it; no back-off, since it isn't time-dependent).
            MAX_ATTEMPTS = 4
            for attempt in range(1, MAX_ATTEMPTS + 1):
                try:
                    urls = self.generate_image(prompt=description, size=size, n=1,
                                               reference_images=reference_images,
                                               negative_prompt=negative_prompt,
                                               seed=seed, project_path=project_path)
                    if urls:
                        logger.info("[Seedream] variation %d OK (attempt %d, seed %d)", slot + 1, attempt, seed)
                        return {"url": urls[0], "error": None, "attempts": attempt, "seed": seed}
                    last_err = "Seedream returned no URL"
                except Exception as e:  # noqa: BLE001
                    last_err = str(e)
                    logger.warning("[Seedream] variation %d attempt %d/%d FAILED: %s",
                                   slot + 1, attempt, MAX_ATTEMPTS, last_err[:160])
                if attempt < MAX_ATTEMPTS:
                    low = last_err.lower()
                    transient = any(k in low for k in (
                        "connection error", "timeout", "timed out", "temporarily",
                        "429", "rate limit", "500", "502", "503", "504", "overloaded"))
                    if transient:
                        delay = min(8.0, 2.0 ** (attempt - 1))   # 1s, 2s, 4s
                        logger.info("[Seedream] variation %d transient (%s) — backing off %.0fs",
                                    slot + 1, last_err[:60], delay)
                        time.sleep(delay)
                    seed = random.randint(1, 2**31 - 1)  # fresh seed for the retry
            logger.error("[Seedream] variation %d failed after %d attempts: %s", slot + 1, MAX_ATTEMPTS, last_err[:160])
            return {"url": None, "error": last_err, "attempts": MAX_ATTEMPTS, "seed": None}

        results: List[Dict[str, Any]] = [{}] * n
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {executor.submit(_gen_slot, i): i for i in range(n)}
            for future in as_completed(futures):
                idx = futures[future]
                results[idx] = future.result()
                if on_slot:
                    try:
                        on_slot(idx, results[idx])
                    except Exception:
                        pass  # progress reporting must never kill the render

        ok = sum(1 for r in results if r.get("url"))
        logger.info("[Seedream] variations complete: %d/%d OK", ok, n)
        return results

    def generate_concept_art(
        self,
        description: str,
        count: int = 4,
        reference_images: Optional[List[Dict[str, Any]]] = None,
        negative_prompt: Optional[str] = None,
    ) -> List[str]:
        """Legacy wrapper (app.py): URLs only, raises if every slot failed."""
        results = self.generate_variations(description, count, reference_images, negative_prompt)
        urls = [r["url"] for r in results if r.get("url")]
        if not urls:
            raise RuntimeError(results[0].get("error") or "All variations failed")
        return urls

    # Ordered → the set the model returns maps 1:1 to these keys, by position. top_view LAST
    # so a short set (the model may return fewer than max_images) drops the least-critical
    # view first. The two views that are (a) actually useful for shot coverage and (b)
    # achievable from a single eye-level reference. Wide/eye-level were near-duplicates of
    # the base; a true straight-down top-down fights the reference (it wins → eye-level).
    # Prompts are deliberately forceful about the camera move so the set doesn't collapse
    # to the base.
    #
    # MODULE-LEVEL on purpose: it is the ONLY definition of "which view is image N", and
    # the disk reader (server._env_angles_from_disk) maps stored files back to keys by the
    # same position. Adding, removing or reordering an entry here silently relabels every
    # sheet already on disk — keep the two in step.
    #
    # A THIRD view (90° lateral) was measured and REJECTED. Re-measured from the saved
    # candidate images 2026-08-05 (the earlier note here quoted counts that do NOT
    # reproduce — they are corrected below): 4 real BLOOM locations (Tomás's kitchen,
    # glass conference room, staging hangar, depot yard) × 2 trials, same bases, same
    # model, three-view list vs this two-view list.
    #
    #   dHash-8 Hamming, unrelated-image floor measured on cross-location pairs = 23-30.
    #   THREE views: 5/8 sets contain a pair BELOW that floor (2, 5, 9, 11, 14) — two of
    #     the three images are the same shot. Worse, the overhead is what pays for it:
    #     looking at all 8 sets, only 1/8 came back with a true straight-down top-down and
    #     5/8 had no overhead at all, just a second room-level angle in slot 3.
    #   TWO views: 8/8 gave a distinct reverse plus a genuinely elevated/overhead map.
    #     (2/8 also scored below the floor — 9 and 19 — while being plainly different
    #     shots, which is why the eye, not the hash, is the verdict here.)
    #
    # So the lateral does not earn its slot: it is usually a duplicate AND it costs the
    # top-view map. Two views is the set the model can actually deliver.
    ENVIRONMENT_VIEWS = [
        ("reverse",   "the REVERSE shot — the camera rotated a full 180 degrees to face the "
                      "OPPOSITE direction, looking back from across the room at the wall and "
                      "area that were BEHIND the original camera (a shot/reverse-shot pair)"),
        ("top_view",  "a true BIRD'S-EYE overhead — the camera mounted on the ceiling pointing "
                      "straight DOWN at the floor, an aerial top-down floor-plan of the room "
                      "showing the furniture layout from directly above, floor filling the frame"),
    ]

    # ── Reverse angle out of a VIDEO walk-through ─────────────────────────────────────
    #
    # HELL GRIND rule (quoted from the production brief): "Reverse angles, way two (found
    # late in production): generate a video of the empty location where the camera slowly
    # walks through the space — Seedance draws the other sides consistently with your
    # sheet. Screenshot the angle you need, take it to Seedream or Nano Banana Pro, and
    # prompt it to improve textures and lighting. A full location sheet out of a single
    # image."
    #
    # WHY it applies here: the image path above asks Seedream to "rotate the camera 180
    # degrees". An image model has no 3D notion of the room, so about half the time it
    # satisfies that by FLIPPING the reference — measured in this repo at 15 of 31 fresh
    # draws (48%), and a mirrored sheet made 7 of 12 boards render reversed lettering
    # (p=0.0046). A video model cannot answer with a mirror: it has to move a camera
    # through the space frame by frame, and the frame at the far end of that move is a
    # real other side of the room.
    #
    # MEASURED HERE before this was written (2026-08-06, BLOOM bases, 480p i2v):
    #   * 5 s "walk forward then turn 180" on the Glass Conference Room: last frame
    #     min-Hamming 25 vs 1 for the first frame — a genuinely new camera position, but
    #     by eye only a ~90-120 degree swing. A LATERAL move, not a reverse.
    #   * 10 s with the staged wording below (walk to the far side, THEN rotate a full
    #     180, hold the last two seconds): the conference-room tail frame is a true
    #     shot/reverse-shot partner of the base — the table now recedes toward the wall
    #     that was behind the original camera.
    #   * A 10 s "180-degree ORBIT" variant on the same base came back as a side-on
    #     lateral (min-Hamming 20). The staged "walk, then turn" wording won, so that is
    #     what ships.
    # Runtime therefore is not a free parameter: at 5 s the model spends the whole clip
    # travelling and never turns.
    REVERSE_VIDEO_SECONDS = 10
    # 480p is deliberate. The clip is a MEASURING INSTRUMENT, not footage — nothing but
    # one frame of it survives, and that frame is re-rendered at 2K by the Seedream
    # cleanup below. Documented per-5s base-model cost (video-seedance §11): 480p $0.35,
    # so a 10 s clip is ~$0.70 against ~$3.74 at 1080p for a frame we immediately throw
    # away. Hell Grind's own wording — "screenshot the angle you need, take it to
    # Seedream … to improve textures and lighting" — is the same trade.
    REVERSE_VIDEO_RESOLUTION = "480p"

    def generate_reverse_via_video(
        self,
        description: str,
        base_image_url: str,
        style_suffix: str = "",
        negative_prompt: Optional[str] = None,
        project_path: str = "",
        cleanup: bool = True,
    ) -> Dict[str, Any]:
        """Hell Grind rule 1: derive the REVERSE angle from a short Seedance walk-through
        of the EMPTY location instead of asking an image model to rotate the camera.

        Returns {url, source, check, cleaned, task_id, wall_s, video_url, error}.
        `url` is "" on any failure — the caller falls back to the image path, which keeps
        its own validate+retry ladder. There is deliberately NO retry here: a second clip
        costs another ~$0.70 and ~3 minutes, and the fallback that already exists is
        cheaper than a blind repeat. Raise this to a bounded retry only if the measured
        video-path mirror rate stops being zero.
        """
        out: Dict[str, Any] = {"url": "", "source": "video", "check": {}, "cleaned": False,
                               "task_id": "", "wall_s": 0.0, "video_url": "", "error": ""}
        if not base_image_url:
            out["error"] = "no base image"
            return out

        base_uri = _url_to_data_uri(base_image_url)
        try:
            base_raw = base64.b64decode(base_uri.split(",", 1)[1]) if base_uri.startswith("data:") else None
        except Exception:  # noqa: BLE001
            base_raw = None
        bb, bm = _dhash_bits(base_raw) if base_raw else (None, None)

        # The camera move, staged. "Walk forward, THEN rotate 180, THEN hold" is what
        # produced a real reverse in the bake-off above; a bare "180-degree orbit" gave a
        # lateral. The EMPTY-location clause is Hell Grind's ("a video of the empty
        # location") and is load-bearing for a different reason too: a figure walking into
        # the shot would end up baked into the frame that becomes the location sheet.
        walk = (
            f"The EXACT SAME location shown in the first frame — {description}. "
            "The location is EMPTY — no people, no animals, nobody enters frame. ONE "
            "continuous camera move, no cuts, slow and steady. The camera starts exactly at "
            "this frame, walks slowly FORWARD into the space past the furniture and set "
            "dressing to the far side, and then rotates a FULL 180 DEGREES so that it ends "
            "up LOOKING BACK at the wall and the area that were BEHIND the camera at the "
            "start of the shot — the side of the location this first frame never showed. "
            "The last two seconds are held steady on that opposite view. Keep the same "
            "architecture, furniture, set dressing, materials, colour palette and lighting "
            "throughout. No subtitles, text overlays, BGM or background music."
        )
        if negative_prompt:
            walk = f"{walk.rstrip('.')}. Do not include: {negative_prompt}."

        t0 = time.time()
        # ratio="adaptive" so the clip keeps the BASE's aspect. Measured: DEPOT - YARD's
        # base is 3136x1344 (2.33:1), and a 16:9 render cropped it hard enough that the
        # clip's own FIRST frame already scored Hamming 20 against the base — i.e. the
        # crop alone looks like a different shot to the validator.
        sub = self.create_video_task(
            image_url=base_uri,
            prompt=walk,
            duration=self.REVERSE_VIDEO_SECONDS,
            resolution=self.REVERSE_VIDEO_RESOLUTION,
            ratio="adaptive",
            generate_audio=False,           # nothing here is ever heard
        )
        if not sub.get("task_id"):
            out["error"] = f"submit failed: {str(sub.get('error'))[:200]}"
            out["wall_s"] = round(time.time() - t0, 1)
            logger.warning("[EnvAngles/video] submit failed — falling back to the image "
                           "path: %s", out["error"])
            return out
        out["task_id"] = sub["task_id"]

        res = self.poll_video_task(sub["task_id"], max_wait=900, interval=10)
        out["wall_s"] = round(time.time() - t0, 1)
        if res.get("status") != "completed":
            out["error"] = f"render {res.get('status')}: {str(res.get('error'))[:200]}"
            logger.warning("[EnvAngles/video] %s — falling back to the image path", out["error"])
            return out
        out["video_url"] = res.get("video_url", "")
        try:
            usage.record("videos", videos=1, tokens=res.get("tokens") or 0,
                         resolution=self.REVERSE_VIDEO_RESOLUTION, project_path=project_path)
        except Exception:  # noqa: BLE001
            pass

        # THE FRAME AT THE FAR END OF THE MOVE = the task's own `return_last_frame`, which
        # create_video_task already asks for on every submit. Two reasons not to pull it
        # out of the mp4 with ffmpeg instead: it costs nothing extra, and it arrives as a
        # VERBATIM platform PNG. This sheet is later attached to Seedance renders as an
        # environment reference, and a PIL/ffmpeg re-encode is exactly the "third-party
        # compression" that nullifies the platform-output trust and gets the whole render
        # rejected (InputImageSensitiveContentDetected.PrivacyInformation, 2026-07-17 —
        # see the headshot note in FinalGenView).
        frame_url = res.get("last_frame_url") or ""
        if not frame_url:
            out["error"] = "task returned no last_frame_url"
            logger.warning("[EnvAngles/video] %s — falling back to the image path", out["error"])
            return out

        def _score(u: str) -> Dict[str, Any]:
            raw = None
            try:
                uri = _url_to_data_uri(u)
                if uri.startswith("data:"):
                    raw = base64.b64decode(uri.split(",", 1)[1])
            except Exception:  # noqa: BLE001
                raw = None
            cb, _ = _dhash_bits(raw) if raw else (None, None)
            return score_reverse_against_base(cb, bb, bm), raw

        raw_verdict, frame_raw = _score(frame_url)
        out["url"], out["check"] = frame_url, raw_verdict
        logger.info("[EnvAngles/video] walk-through frame: min-Hamming %s (base %s / mirror "
                    "%s), reuse=%s — task %s, %.0fs",
                    raw_verdict.get("hamming"), raw_verdict.get("hamming_base"),
                    raw_verdict.get("hamming_mirror"), raw_verdict.get("is_reuse"),
                    sub["task_id"], out["wall_s"])
        if raw_verdict.get("is_reuse"):
            # The SAME acceptance check as the image path, applied to both arms — a video
            # frame that somehow comes back as the base is no more shippable than a
            # mirrored Seedream draw.
            out["url"] = ""
            out["error"] = f"walk-through frame is the base again (Hamming {raw_verdict.get('hamming')})"
            return out
        if not cleanup:
            return out

        # ── Hell Grind's second half: "take it to Seedream … and prompt it to improve
        # textures and lighting". Not cosmetic — it does two jobs the 480p frame cannot:
        # it lifts a 480p grab to a 2K sheet, and it makes the saved file a Seedream
        # platform output again, restoring the trust chain the sheet needs downstream.
        try:
            from PIL import Image as _PILImage
            import io as _io
            w, h = _PILImage.open(_io.BytesIO(frame_raw)).size if frame_raw else (16, 9)
            # Aspect-preserving target near Seedream's ceiling. generate_image already
            # clamps a "WxH" to Pro's ≤4,624,220 px and ×16-per-side rules, so this only
            # has to carry the SHAPE — reuse that clamp rather than restating it here.
            scale = (4_500_000 / float(w * h)) ** 0.5
            size = f"{int(w * scale)}x{int(h * scale)}"
        except Exception:  # noqa: BLE001
            size = "2K"

        clean_prompt = (
            f"{description}. Improve the TEXTURE detail, material definition, sharpness and "
            "the quality of the lighting in this photograph. Keep the EXACT SAME camera "
            "position, framing, composition, perspective and lens: every object, wall, "
            "window and piece of set dressing stays exactly where it is and the same size. "
            "Do not move the camera, do not mirror or flip the image, do not add or remove "
            "anything, do not change the colour palette or the time of day."
        )
        try:
            cleaned = self.edit_image(
                prompt=assemble_image_prompt(clean_prompt, style_suffix),
                reference_images=[{"url": frame_url, "weight": 1.0}],
                size=size,
                output_format="png",        # lossless → keeps the trusted watermark
                project_path=project_path,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[EnvAngles/video] texture/lighting cleanup failed (%s) — keeping "
                           "the raw 480p walk-through frame", str(e)[:160])
            return out
        if not cleaned or not cleaned[0]:
            logger.warning("[EnvAngles/video] cleanup returned nothing — keeping the raw frame")
            return out

        clean_verdict, _ = _score(cleaned[0])
        if clean_verdict.get("is_reuse"):
            # A cleanup that came back as the base (or its mirror) has re-invented the
            # shot instead of polishing it. Keeping it would smuggle the exact defect this
            # whole path exists to remove back in through the back door, so the raw frame
            # — which already PASSED — wins.
            logger.error("[EnvAngles/video] cleanup output is the base/mirror (Hamming %s) — "
                         "DISCARDED, keeping the raw walk-through frame (Hamming %s)",
                         clean_verdict.get("hamming"), raw_verdict.get("hamming"))
            out["check"] = {**raw_verdict, "cleanup_rejected": True,
                            "cleanup_hamming": clean_verdict.get("hamming")}
            return out

        out["url"], out["check"], out["cleaned"] = cleaned[0], clean_verdict, True
        logger.info("[EnvAngles/video] cleanup accepted (%s, min-Hamming %s → %s)",
                    size, raw_verdict.get("hamming"), clean_verdict.get("hamming"))
        return out

    def generate_environment_angles(
        self,
        description: str,
        base_image_url: str,
        negative_prompt: Optional[str] = None,
        style_suffix: str = "",
        reverse_via_video: bool = True,
    ) -> Dict[str, Any]:
        """
        P7/2b: Generate multiple camera angles + a top-view of an approved environment as ONE
        CONSISTENT SET (the same physical room, only the camera moves) — not 4 different rooms.

        Why this shape (grounded in the Seedream image ref, verified 2026-07-16): the old path
        made 4 INDEPENDENT calls with a weak ref, and each one re-invented the room. The
        documented way to get a coherent RELATED set is `sequential_image_generation` — ONE
        inference returns a mapped set of related images. That param is NOT supported on Pro
        (400 InvalidParameter), but IS on the flagship SEEDREAM_VIEWS_MODEL. The approved base
        rides as a STRONG `image` reference (full-strength consistency, not the old weight-0.4
        anchor) so the whole set locks to the real room; returned images map to the angle keys
        by ORDER (docs: describe the scenes in order, reference "Image 1", "Image 2"…).
        Returns: {angles: {reverse}, top_view: url, angle_checks: {...}} — see
        ENVIRONMENT_VIEWS for why two views, and the mirror-detector block at the top of
        this module for why the reverse is validated before it is allowed out.

        `reverse_via_video` (default ON) takes the REVERSE from a short Seedance
        walk-through instead of from this image set — Hell Grind rule 1, see
        generate_reverse_via_video. The image reverse below stays as the fallback for
        when the video path fails, with its validate+retry ladder untouched, and every
        sheet records which arm produced it in angle_checks["reverse"]["source"].
        """
        if not base_image_url:
            return {"angles": {}, "top_view": "", "angle_checks": {}}

        VIEWS = self.ENVIRONMENT_VIEWS
        ordered = " ".join(f"Image {i + 1}: {desc}." for i, (_, desc) in enumerate(VIEWS))
        body = (
            f"The EXACT SAME location shown in the reference image — {description}. Generate "
            f"{len(VIEWS)} DIFFERENT camera views of THIS room: keep identical furniture, set "
            "dressing, wall art, windows, materials, colour palette and lighting — ONLY the camera "
            f"position/angle changes, and it must change DRAMATICALLY as described. {ordered}"
        )

        base_uri = _url_to_data_uri(base_image_url)

        def _finish(text: str) -> str:
            p = assemble_image_prompt(text, style_suffix)
            if negative_prompt:
                p = f"{p.rstrip('.')}. Render none of the following: {negative_prompt}."
            return p

        billed = 0
        # The RESPONSES, kept alongside the count so the meter can price them. `billed`
        # on its own is a number of images with no model and no geometry attached — and
        # this arm does NOT run the default Seedream: it runs SEEDREAM_VIEWS_MODEL
        # (seedream-5-0-260128), whose per-image price is not in the supplied BytePlus
        # docs. Metered with the model named, those images are reported as UNPRICED
        # instead of being charged the default model's rate, which is what the old flat
        # per-image figure silently did. Metering still happens once, at the end of the
        # function, exactly where it did before.
        billed_responses: List[Any] = []

        def _views_call(prompt_text: str, max_images: int, resubmits: int = 2) -> List[str]:
            """One sequential_image_generation submit, with the original re-submit loop for
            transient/filtered failures. STRONG base ref via the documented `image` param."""
            nonlocal billed
            extra: Dict[str, Any] = {
                "watermark": False,
                "image": base_uri,
                "sequential_image_generation": "auto",
                "sequential_image_generation_options": {"max_images": max_images},
            }
            for attempt in range(resubmits):
                try:
                    resp = self.llm_client.images.generate(
                        model=self.SEEDREAM_VIEWS_MODEL, prompt=prompt_text, size="2K",
                        response_format="url", extra_body=extra, timeout=280,
                    )
                    got = [d.url for d in resp.data if getattr(d, "url", None)]
                    if got:
                        billed += len(got)
                        billed_responses.append(resp)
                        return got
                except Exception as e:  # noqa: BLE001
                    logger.warning("[EnvAngles] sequential set attempt %d failed: %s",
                                   attempt + 1, str(e)[:160])
            return []

        urls = _views_call(_finish(body), len(VIEWS))

        mapped = {VIEWS[i][0]: urls[i] for i in range(min(len(urls), len(VIEWS)))}
        top_view = mapped.pop("top_view", "")
        angles = {k: v for k, v in mapped.items() if v}
        logger.info("[EnvAngles] sequential set → %d angles + top_view=%s (model=%s, %d imgs)",
                    len(angles), bool(top_view), self.SEEDREAM_VIEWS_MODEL, len(urls))

        # ── HELL GRIND RULE 1: the reverse comes from a VIDEO walk-through ────────────
        # The sequential call above still runs unchanged — it is what produces the
        # top_view, and its reverse stays on hand as the fallback candidate. What changes
        # is which arm is ASKED FIRST for the reverse. See generate_reverse_via_video for
        # the quote, the 48% mirror measurement it answers and the bake-off that fixed the
        # runtime and the wording.
        #
        # The video arm succeeding also SKIPS the image retry ladder below, so the
        # measured 0.48 extra Seedream images per call are not spent either.
        video_reverse: Dict[str, Any] = {}
        if reverse_via_video:
            try:
                video_reverse = self.generate_reverse_via_video(
                    description, base_image_url, style_suffix=style_suffix,
                    negative_prompt=negative_prompt)
            except Exception as e:  # noqa: BLE001
                # A crash in the new arm must never cost a location its sheet: the image
                # path below is exactly the behaviour that shipped before this existed.
                logger.warning("[EnvAngles/video] raised (%s) — falling back to the image path",
                               str(e)[:200])
                video_reverse = {"url": "", "error": str(e)[:200]}

        # ── Reverse validated, then a BOUNDED retry ──────────────────────────────────
        # The sheet is the DOMINANT environment reference downstream (server._env_angle_sheet),
        # so a mirror has to be caught here, at the one place that can still cheaply ask for
        # another one. On disk in BLOOM, 3 of 39 sheets are the base again (2 of them
        # mirrored) — but that snapshot only counts the LAST surviving draw per location.
        #
        # LIVE RATE, measured 2026-08-06 over 31 real generations through this path (23 via
        # POST /api/assets/environment-angles, 8 in-process, across 4 BLOOM locations
        # including one whose sheet on disk is fine): the FIRST candidate was the base or its
        # mirror in 15 of 31 = 48%. So this is not a rare tail — it is a coin-flip per draw,
        # and the pre-validator behaviour was to ship whichever side came up.
        #
        # WHY 2 retries. Of those 15 first-candidate failures, the strengthened prompt below
        # fixed 13 on retry 1 (87%), 1 more on retry 2, and 1 never recovered. A third retry
        # would therefore apply to 1 case in 31 (3%) while every regenerated location pays
        # for the option — each retry is one billed Seedream image (measured cost of the
        # whole mechanism: 0.48 extra images per call). A candidate that survives all three
        # attempts is KEPT (the best of them) and marked degraded rather than dropped:
        # no reverse at all still leaves the board with nothing but the base.
        REVERSE_MAX_RETRIES = 2
        checks: Dict[str, Any] = {}
        rev_url = angles.get("reverse", "")
        if video_reverse.get("url"):
            # The walk-through frame already went through score_reverse_against_base
            # inside generate_reverse_via_video and only reaches here having PASSED, so
            # there is nothing left to retry: it is written straight into the same
            # `angles["reverse"]` slot the image path writes, and every downstream
            # consumer (server's save loop, _env_angles_from_disk, _env_angle_sheet, the
            # panel) sees the identical shape it saw before.
            #
            # `source` is what makes the choice auditable after the fact. server.py
            # persists this whole dict as the file's `check` sidecar, so a sheet on disk
            # can always answer "which arm drew you" — the alternative is the silent
            # fallback this module keeps getting bitten by.
            angles["reverse"] = video_reverse["url"]
            checks["reverse"] = {
                **video_reverse.get("check", {}),
                "attempts": 1, "degraded": False,
                "threshold_hamming": REVERSE_REUSE_MAX_HAMMING,
                "source": "video",
                "video_task_id": video_reverse.get("task_id", ""),
                "video_seconds": self.REVERSE_VIDEO_SECONDS,
                "video_resolution": self.REVERSE_VIDEO_RESOLUTION,
                "video_wall_s": video_reverse.get("wall_s", 0.0),
                "texture_cleanup": bool(video_reverse.get("cleaned")),
            }
            logger.info("[EnvAngles] reverse from the VIDEO walk-through (min-Hamming %s, "
                        "cleanup=%s) — the sequential set's own reverse is discarded",
                        checks["reverse"].get("hamming"), checks["reverse"]["texture_cleanup"])
        elif rev_url:
            base_raw = None
            try:
                base_raw = base64.b64decode(base_uri.split(",", 1)[1]) if base_uri.startswith("data:") else None
            except Exception:  # noqa: BLE001
                base_raw = None
            bb, bm = _dhash_bits(base_raw) if base_raw else (None, None)

            def _score(u: str) -> Dict[str, Any]:
                raw = None
                try:
                    uri = _url_to_data_uri(u)
                    if uri.startswith("data:"):
                        raw = base64.b64decode(uri.split(",", 1)[1])
                except Exception:  # noqa: BLE001
                    raw = None
                cb, _ = _dhash_bits(raw) if raw else (None, None)
                return score_reverse_against_base(cb, bb, bm)

            verdict = _score(rev_url)
            best_url, best_verdict, attempts = rev_url, verdict, 1
            # STRENGTHENED prompt: the plain "180 degrees" wording is what the model
            # satisfied by flipping the reference, so the retry names the failure mode.
            retry_body = (
                f"The EXACT SAME location shown in the reference image — {description}. "
                "ONE image: the REVERSE shot, the camera physically moved to the OPPOSITE "
                "side of the room and turned around to look back at the wall and area that "
                "were BEHIND the original camera. This must be a genuinely different camera "
                "POSITION, not a mirrored or flipped version of the reference; the same room "
                "seen from the opposite side, with the furniture and any lettering in their "
                "true left-right order. Keep identical furniture, set dressing, wall art, "
                "windows, materials, colour palette and lighting."
            )
            while best_verdict.get("is_reuse") and attempts <= REVERSE_MAX_RETRIES:
                logger.warning(
                    "[EnvAngles] reverse REJECTED (%s, Hamming %s vs base/%s vs mirror — "
                    "threshold %d) — regenerating, attempt %d/%d",
                    "mirrored base" if best_verdict.get("mirrored") else "base again",
                    best_verdict.get("hamming_base"), best_verdict.get("hamming_mirror"),
                    REVERSE_REUSE_MAX_HAMMING, attempts + 1, REVERSE_MAX_RETRIES + 1)
                again = _views_call(_finish(retry_body), 1)
                attempts += 1
                if not again:
                    break                      # generation itself failed — keep what we have
                v2 = _score(again[0])
                # "Best" = FURTHEST from the base/mirror. An unmeasurable candidate never
                # displaces a measured one; among measured ones the larger Hamming wins.
                if v2.get("measured") and (not best_verdict.get("measured")
                                           or v2["hamming"] > (best_verdict.get("hamming") or -1)):
                    best_url, best_verdict = again[0], v2
                if not v2.get("is_reuse"):
                    best_url, best_verdict = again[0], v2
                    break

            angles["reverse"] = best_url
            degraded = bool(best_verdict.get("is_reuse"))
            checks["reverse"] = {**best_verdict, "attempts": attempts, "degraded": degraded,
                                 "threshold_hamming": REVERSE_REUSE_MAX_HAMMING,
                                 # WHICH arm drew this sheet, and — when the video arm was
                                 # asked and lost — why it lost. Without the reason a sheet
                                 # that quietly fell back to the 48%-mirror path looks
                                 # exactly like one that was never offered the video path.
                                 "source": "image",
                                 **({"video_error": video_reverse.get("error", "")}
                                    if reverse_via_video else {})}
            if degraded:
                # LOUD, and carried in the returned metadata: a silent fallback here is the
                # exact bug this validator exists to stop.
                logger.error("[EnvAngles] reverse still %s after %d attempts — sheet DEGRADED "
                             "(min-Hamming %s)",
                             "mirrored" if best_verdict.get("mirrored") else "a base copy",
                             attempts, best_verdict.get("hamming"))
            else:
                logger.info("[EnvAngles] reverse accepted on attempt %d (min-Hamming %s)",
                            attempts, best_verdict.get("hamming"))

        # ── Top view validated, then the SAME bounded retry ──────────────────────────
        # Measured over BLOOM's 20 breakdown environments, ground truth by eye: 6 of the
        # 20 top views on disk are not an overhead of their location, and FIVE of those
        # invent an interior — TIDELINE returns a beach shack's inside, ARROYO FARM an
        # attic, Drowned Town and Seawall a living room, Flooded Stairwell a furnished
        # room. This file is fed to boards as environment context (server._env_angle_sheet),
        # so an invented room teaches every board of that location a geography the film
        # does not have. Same reasoning as the reverse above, opposite failure mode — see
        # the score_top_view block for why a hash cannot see this one.
        #
        # 2 retries for the same arithmetic as the reverse, and the failure rate here is
        # far higher (6/20 vs 3/39), so the retry earns its place: the regeneration prompt
        # below spells out what an overhead IS, which the sequential-set prompt only
        # gestures at inside a two-view list.
        TOP_VIEW_MAX_RETRIES = 2
        if top_view:
            def _read(u: str) -> Dict[str, Any]:
                try:
                    return score_top_view(self.read_top_view_vision(base_uri, u, description))
                except Exception as e:  # noqa: BLE001
                    # Vision down / unparseable → measured=False → never rejects. A QC that
                    # cannot see must not start billing retries.
                    logger.warning("[EnvAngles] top-view vision read failed: %s", str(e)[:160])
                    return score_top_view(None)

            def _judge(u: str) -> Dict[str, Any]:
                """One read to accept, TWO to reject. Measured on the 20 BLOOM sheets read
                3x each: every true failure was unanimous 3/3, while the two borderline
                high-angles that flapped (GLASS CONFERENCE ROOM, RESERVOIR STATION) and one
                same_place outlier (STATION GANTRY) each failed only 1 read in 3. Asking
                again costs one cheap vision call and drops those from a 1-in-3 wrongful
                regeneration to 1-in-9; the real failures still reject every time."""
                v = _read(u)
                if not v.get("rejected"):
                    return v
                v2 = _read(u)
                if v2.get("rejected"):
                    return {**v2, "confirmed": True}
                logger.info("[EnvAngles] top view failed the first read, PASSED the second "
                            "(pitch %s, same_place %s) — not regenerating",
                            v2.get("pitch_deg"), v2.get("same_place"))
                return {**v2, "confirmed": False, "first_read_rejected": True}

            # Explicit about what an overhead IS — the retry names every way the model got
            # it wrong: a second room-level shot, and a room that exists nowhere.
            tv_retry_body = (
                f"The EXACT SAME location shown in the reference image — {description}. "
                "ONE image: a TRUE OVERHEAD of this location. The camera is mounted DIRECTLY "
                "ABOVE the space — at ceiling height or higher — pointing STRAIGHT DOWN at the "
                "floor/ground, so the ground plane fills the frame and every object is seen "
                "from ABOVE: the tops of the tables, vehicles, roofs and crates, never their "
                "fronts, with no horizon and no far wall in view. Show the REAL footprint of "
                "the place with the furniture, structures and dressing in the positions they "
                "occupy in the reference image. Do NOT invent any room, corridor, interior or "
                "building that is not in the reference — if the reference is an exterior, this "
                "is an overhead of that same exterior, never the inside of a house. Keep "
                "identical materials, set dressing, colour palette and lighting."
            )

            tv_verdict = _judge(top_view)
            tv_best_url, tv_best, tv_attempts = top_view, tv_verdict, 1
            while tv_best.get("rejected") and tv_attempts <= TOP_VIEW_MAX_RETRIES:
                logger.warning(
                    "[EnvAngles] top view REJECTED (%s; pitch %s° < %d or same_place %s < %d) "
                    "— regenerating, attempt %d/%d",
                    tv_best.get("invented_what") or tv_best.get("reason", "")[:60],
                    tv_best.get("pitch_deg"), TOP_VIEW_MIN_PITCH_DEG,
                    tv_best.get("same_place"), TOP_VIEW_MIN_SAME_PLACE,
                    tv_attempts + 1, TOP_VIEW_MAX_RETRIES + 1)
                again = _views_call(_finish(tv_retry_body), 1)
                tv_attempts += 1
                if not again:
                    break                      # generation itself failed — keep what we have
                v2 = _judge(again[0])
                # "Best" = highest score_top_view score. An unmeasurable candidate never
                # displaces a measured one (same rule as the reverse).
                if v2.get("measured") and (not tv_best.get("measured")
                                           or (v2.get("score") or -1) > (tv_best.get("score") or -1)):
                    tv_best_url, tv_best = again[0], v2
                if not v2.get("rejected"):
                    tv_best_url, tv_best = again[0], v2
                    break

            top_view = tv_best_url
            tv_degraded = bool(tv_best.get("rejected"))
            checks["top_view"] = {**tv_best, "attempts": tv_attempts, "degraded": tv_degraded,
                                  "threshold_pitch_deg": TOP_VIEW_MIN_PITCH_DEG,
                                  "threshold_same_place": TOP_VIEW_MIN_SAME_PLACE}
            if tv_degraded:
                # Shipped, because a sheet with no map at all is worse for coverage — but
                # never silently: an invented room reaching the boards unlabelled is the
                # whole defect. Same contract as the reverse above.
                logger.error("[EnvAngles] top view still not an overhead of this place after "
                             "%d attempts — sheet DEGRADED (%s; pitch %s, same_place %s)",
                             tv_attempts, tv_best.get("invented_what") or tv_best.get("reason", ""),
                             tv_best.get("pitch_deg"), tv_best.get("same_place"))
            else:
                logger.info("[EnvAngles] top view accepted on attempt %d (pitch %s, same_place %s)",
                            tv_attempts, tv_best.get("pitch_deg"), tv_best.get("same_place"))

        try:
            metered = sum(usage.record_image_response(r, self.SEEDREAM_VIEWS_MODEL,
                                                      project_path="")
                          for r in billed_responses)
            # `billed` counts images that came back with a URL; `metered` counts what the
            # API says it billed (`usage.generated_images` — the docs are explicit that
            # failures inside a batch are not charged). They agreed on every call
            # measured, so a gap means one of the two readings is wrong and the meter
            # should not quietly pick a winner.
            if metered != billed:
                logger.warning("[EnvAngles] metered %d image(s) but %d URL(s) came back — "
                               "usage.generated_images and the response body disagree",
                               metered, billed)
        except Exception:  # noqa: BLE001
            pass
        return {"angles": angles, "top_view": top_view, "angle_checks": checks}

    def generate_shot_concept_art(
        self,
        shot_description: str,
        approved_assets: List[Dict[str, str]],
        count: int = 4,
        reference_images: Optional[List[Dict[str, Any]]] = None,
    ) -> List[str]:
        asset_context = "\n".join(
            f"- {a['name']}: {a['visual_description']}" for a in approved_assets
        )
        enriched_prompt = (
            f"{shot_description}\n\n"
            f"IMPORTANT - The following characters/props MUST appear exactly as described:\n"
            f"{asset_context}\n\n"
            f"Maintain strict visual consistency with the approved asset designs."
        )
        return self.generate_concept_art(enriched_prompt, count=count,
                                         reference_images=reference_images)

    def _composite_character_sheet(self, view_urls: List[str], labels: List[str]) -> str:
        """
        Download the view images and composite them into a labeled 2×2 model sheet.
        Returns a base64 JPEG data URI that can be used as an <img> src directly.
        """
        try:
            from PIL import Image, ImageDraw, ImageFont
        except ImportError:
            logger.warning("[Composite] Pillow not installed — skipping composite")
            return ""

        import io

        PANEL_W, PANEL_H = 512, 768
        LABEL_H = 30
        COLS, ROWS = 2, 2
        COMPOSITE_W = COLS * PANEL_W
        COMPOSITE_H = ROWS * (PANEL_H + LABEL_H)
        BG_COLOR = (12, 18, 32)
        LABEL_BG = (6, 10, 20)
        LABEL_FG = (0, 212, 255)   # cyan accent

        composite = Image.new('RGB', (COMPOSITE_W, COMPOSITE_H), BG_COLOR)
        draw = ImageDraw.Draw(composite)

        # Try to load a proportional font; fall back to default
        try:
            font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 16)
        except Exception:
            try:
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16)
            except Exception:
                font = ImageFont.load_default()

        for idx, (url, label) in enumerate(zip(view_urls[:4], labels[:4])):
            col = idx % COLS
            row = idx // COLS
            x = col * PANEL_W
            y = row * (PANEL_H + LABEL_H)

            if url:
                try:
                    resp = requests.get(url, timeout=30)
                    resp.raise_for_status()
                    img = Image.open(io.BytesIO(resp.content)).convert('RGB')
                    img = img.resize((PANEL_W, PANEL_H), Image.LANCZOS)
                    composite.paste(img, (x, y))
                except Exception as e:
                    logger.warning("[Composite] Panel %d load failed: %s", idx, e)

            # Label bar below each panel
            label_y = y + PANEL_H
            draw.rectangle([(x, label_y), (x + PANEL_W, label_y + LABEL_H)], fill=LABEL_BG)
            draw.text((x + PANEL_W // 2, label_y + LABEL_H // 2), label.upper(),
                      fill=LABEL_FG, anchor='mm', font=font)

        buf = io.BytesIO()
        composite.save(buf, format='JPEG', quality=85, optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode()
        logger.info("[Composite] Character sheet composite: %d KB", len(buf.getvalue()) // 1024)
        return f'data:image/jpeg;base64,{b64}'

    def generate_character_sheet(
        self,
        description: str,
        reference_images: Optional[List[Dict[str, Any]]] = None,
        negative_prompt: Optional[str] = None,
    ) -> List[str]:
        """
        Generate a multi-view character model sheet.
        Strategy (P3):
          1. Generate canonical front view first.
          2. Use front view as reference for the other 3 views (concurrent) — locks identity.
          3. Composite all 4 views into a labeled sheet image (5th element in return list).
        Returns: [front_url, side_url, back_url, 3q_url, composite_data_uri]
        """
        VIEW_DEFS = [
            ("front",    "full body front view, facing camera, character design sheet, "
                         "clean white background, professional concept art, T-pose"),
            ("side",     "full body side profile view, character design sheet, "
                         "clean white background, professional concept art"),
            ("back",     "full body back view, rear-facing, character design sheet, "
                         "clean white background, professional concept art"),
            ("3q_detail","three-quarter view + close-up facial detail inset, "
                         "character design sheet, clean white background, professional concept art"),
        ]
        VIEW_LABELS = ["FRONT", "SIDE PROFILE", "BACK VIEW", "3/4 + DETAIL"]

        def _build_prompt(view_desc: str) -> str:
            return f"{description} — {view_desc}"

        # Step 1: generate the canonical front view first (sequential)
        logger.info("[CharSheet] Generating canonical front view…")
        front_url = ""
        try:
            urls = self.generate_image(
                prompt=_build_prompt(VIEW_DEFS[0][1]),
                n=1,
                reference_images=reference_images,
                negative_prompt=negative_prompt,
            )
            front_url = urls[0] if urls else ""
        except Exception as e:
            logger.error("[CharSheet] Front view failed: %s", e)

        # Step 2: use the front view as reference for identity consistency
        front_ref = []
        if front_url:
            front_ref = [{"url": front_url, "weight": 0.85}]
        combined_refs = (reference_images or []) + front_ref

        # Step 3: generate remaining views concurrently using front as reference
        results: List[str] = [front_url, "", "", ""]

        def _gen_view(idx: int) -> tuple[int, str]:
            _, view_desc = VIEW_DEFS[idx]
            try:
                urls = self.generate_image(
                    prompt=_build_prompt(view_desc),
                    n=1,
                    reference_images=combined_refs,
                    negative_prompt=negative_prompt,
                )
                return idx, urls[0] if urls else ""
            except Exception as e:
                logger.error("[CharSheet] View %d failed: %s", idx, e)
                return idx, ""

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {executor.submit(_gen_view, i): i for i in range(1, 4)}
            for future in as_completed(futures):
                idx, url = future.result()
                results[idx] = url

        generated = sum(1 for u in results if u)
        logger.info("[CharSheet] %d/4 views generated, compositing…", generated)

        # Step 4: composite into a labeled sheet (5th element)
        composite_uri = self._composite_character_sheet(results, VIEW_LABELS)
        if composite_uri:
            results.append(composite_uri)

        return results

    # ─────────────────────────────────────────────────────────────────────────
    # Seedance-2.0  — Video generation with reference images/videos/audio
    #
    # Content array roles:
    #   "first_frame"    — first frame image (strong constraint, max 1)
    #   "last_frame"     — last frame image (strong constraint, max 1)
    #   "reference_image"— style/consistency reference (up to 9 total incl. first/last)
    #   "reference_video"— motion/style reference video (up to 3)
    #
    # Audio:
    #   generate_audio: true  → Seedance generates audio automatically
    #   audio_url: "<URL>"    → Use provided audio as the video's soundtrack
    #
    # Docs: https://docs.byteplus.com/en/docs/ModelArk/1520757
    # ─────────────────────────────────────────────────────────────────────────

    def create_video_task(
        self,
        image_url: str,
        prompt: str,
        duration: float,                  # REQUIRED — see the guard at the top of the body
        # Reference media
        reference_images: Optional[List[Dict[str, Any]]] = None,
        reference_videos: Optional[List[str]] = None,
        audio_url: Optional[str] = None,
        negative_prompt: Optional[str] = None,
        generate_audio: bool = True,
        # Output spec (documented params — docs.byteplus.com/en/docs/ModelArk/2298881)
        ratio: str = "adaptive",          # 21:9|16:9|4:3|1:1|3:4|9:16|adaptive
        resolution: str = "720p",         # 480p|720p|1080p|4k (4k = base 2.0 only)
        seed: Optional[int] = None,       # NO-OP on Seedance 2.0 (see below) — kept for fwd-compat/metadata
        first_frame_pass_url: bool = False,  # pass a TRUSTED CDN first_frame BY URL (no data-URI)
        tier: Optional[str] = None,       # 'preview'|'edit'|'master'; None = legacy (resolution as given)
        model_choice: Optional[str] = None,  # Settings' pick: 'v25'|'base'|'fast'|'mini'
        # Called with no arguments IMMEDIATELY before the POST that costs money, and
        # never on any path that returns/raises before it. server.py uses it to write a
        # render_registry submit-intent marker, so a process that dies inside the POST
        # still leaves proof that a charge may exist. It must be placed here rather than
        # around this call: everything above (tier resolution, up to 10 data-URI
        # downloads, prompt assembly) is free, and marking intent before it would report
        # a charge for submits that never reached BytePlus at all.
        on_submit: Optional[Any] = None,
            # KEYWORD-ONLY, and last. Placed among the positionals it captured
        # `negative_prompt` by position while the caller also passed it by name —
        # TypeError: multiple values, i.e. a 500 on EVERY render. py_compile cannot
        # see an argument collision at a call site; only calling it does.
        *,
        speaker_audio_urls: Optional[List[str]] = None,
) -> Dict[str, Any]:
        """
        Submit a video generation task to Seedance 2.0.

        Args:
            image_url: Primary first-frame image (URL or data URI).
            prompt: Motion/scene description.
            duration: Video duration in seconds. Required, > 0 and finite — this is the
                last stop before a paid POST and it has no honest default (see below).
            reference_images: List of dicts with 'url' and 'role' keys.
                role: 'first_frame' | 'last_frame' | 'reference_image'
                Up to 9 total (including the primary first frame).
                Example: [{"url": "https://...", "role": "reference_image"}]
            reference_videos: List of video URLs to use as motion reference.
                Up to 3 videos.
            audio_url: URL of audio file to use as the video soundtrack.
                When provided, overrides generate_audio=True.
        """
        # The LAST stop before a paid POST, so it invents nothing. `duration: int = 5` in the
        # signature and `float(duration or 5)` in the body meant a caller that omitted the
        # length, or handed over a 0 from a request that never carried one, bought 5s of
        # Seedance footage and nothing said so. Every caller has a MEASURED length by the time
        # it gets here (server.py: the segment's duration_secs, the extend's extra_seconds, the
        # edit's probed source), so there is no case left that a default would serve. Raised
        # before the api-key check and before any download — nothing has been spent yet.
        if not isinstance(duration, (int, float)) or not _math.isfinite(duration) or duration <= 0:
            raise ValueError(
                f"create_video_task needs a measured duration in seconds, got {duration!r} — "
                "a video render is paid for by the second and this call will not guess one")

        api_key = self.seedream_api_key or self.api_key
        if not api_key:
            return {"task_id": None, "status": "error", "error": "No API key configured"}

        # Resolve the tier BEFORE anything expensive. A mismatch (cheap model asked
        # for 4k) raises here, not as a vendor 400 the user waits out. The decision
        # is logged either way so a coerced resolution is never a silent downgrade.
        model, resolution, tier_decision = self.resolve_tier(tier, resolution, model_choice)
        # Reference and duration ceilings follow the RESOLVED model, not a constant:
        # 2.0 allows 9 images and 15 s, 2.5 allows 30 images and 30 s. Reading them
        # from the model is what lets a 30 s single take actually reach the API.
        caps = model_caps(model)
        logger.info("[Seedance] %s", tier_decision)

        url = f"{self.base_url}/contents/generations/tasks"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

        # ── Build content array ───────────────────────────────────────────────
        # IMPORTANT: Seedance API prohibits mixing first_frame/last_frame with
        # reference_image in the same request.  When a first_frame is provided
        # (image-to-video from an approved keyframe), the keyframe already
        # encodes the character identity and scene — so reference_image items
        # are dropped.  When no first_frame is given (text-to-video), up to 4
        # reference_image items are accepted.
        has_first_frame = bool(image_url)
        # 2.5 LOCKS the aspect ratio to the first-frame image, and any other value fails
        # ASYNCHRONOUSLY — the task is created, accepted, and only then dies with an
        # opaque InvalidParameter "Bad Request", so the operator pays the round trip to
        # find out. Measured live on DryRUN: every shot WITHOUT dialogue (i.e. still on
        # the first_frame path) failed this way at 16:9 — SHOT_046/048/050 — while the
        # shots with dialogue, which now ride reference mode, all rendered. The Studio
        # builder already coerced this; the pipeline builder did not, and it is the one
        # every shot of every film goes through.
        if has_first_frame and ratio != "adaptive" and model == self.SEEDANCE_25_MODEL:
            logger.info("[Seedance] first_frame locks the ratio on %s — forcing "
                        "'adaptive' (was %r)", model, ratio)
            ratio = "adaptive"

        content: List[Dict[str, Any]] = []

        # 1. Text prompt (always first)
        content.append({"type": "text", "text": prompt})

        # 2. Primary first-frame image (image-to-video)
        if image_url:
            # A TRUSTED BytePlus CDN asset (e.g. an Extend return_last_frame PNG) must be handed
            # to Seedance BY URL, verbatim. Downloading + base64'ing it (the default below) is
            # "third-party compression" that NULLIFIES the biometric trust (video-seedance §7) →
            # InputImageSensitiveContentDetected.PrivacyInformation. Only for http(s) urls.
            pass_url = first_frame_pass_url and image_url.startswith(("http://", "https://"))
            ff_url = image_url if pass_url else _url_to_data_uri(image_url)
            content.append({
                "type": "image_url",
                "image_url": {"url": ff_url},
                "role": "first_frame",
            })
            logger.info("[Seedance] first_frame set (%s)", "url-passthrough" if pass_url else "data-uri")

        # 3. Reference images — ONLY when there is NO first_frame
        #    (mixing first_frame + reference_image → 400 InvalidParameter)
        if not has_first_frame and reference_images:
            img_count = 0
            for ref in reference_images:
                if img_count >= caps["images"]:
                    logger.warning("[Seedance] Skipping ref — %s accepts %d reference images",
                                   model, caps["images"])
                    break
                ref_url = ref.get("url", "")
                ref_role = ref.get("role", "reference_image")
                if not ref_url or ref_role == "first_frame":
                    continue
                data_uri = _url_to_data_uri(ref_url)
                # _url_to_data_uri silently falls back to the RAW url when it can't download
                # (expired ~24h CDN signature / moved local path). Sending that un-fetchable url
                # 400s the WHOLE render on BytePlus ("content[N].image_url … resource download
                # failed"). By here the server-side disk-hint resolver (create_video) should have
                # swapped in the PERMANENT disk copy, so this is a genuine dead end: DON'T silently
                # drop it (a missing character/environment ref renders a WRONG take) and DON'T send
                # the raw url — fail with an actionable message (observed 2026-07-23, SHOT_003).
                if not data_uri.startswith("data:"):
                    raise RuntimeError(
                        "A reference image for this shot could not be loaded (its link expired and "
                        "no cached disk copy was found). Re-approve the affected asset in AG to "
                        f"refresh its permanent copy, then retry. (ref: {ref_url[:80]})"
                    )
                content.append({
                    "type": "image_url",
                    "image_url": {"url": data_uri},
                    "role": ref_role,
                })
                img_count += 1
                logger.info("[Seedance] Added %s reference (t2v mode)", ref_role)
        elif has_first_frame and reference_images:
            ref_count = sum(1 for r in reference_images if r.get("url") and r.get("role") != "first_frame")
            logger.info(
                "[Seedance] Skipping %d reference_image item(s) — cannot mix with first_frame (i2v mode). "
                "Identity is locked in the keyframe.", ref_count
            )

        # 4. Reference videos — PROVEN live (2026-06-10, task …9497t submit error):
        #    "first/last frame content cannot be mixed with reference media content".
        #    The i2v exclusion covers ALL reference media items, not just images.
        if reference_videos:
            if has_first_frame:
                logger.warning(
                    "[Seedance] Dropping %d reference video(s) — i2v mode rejects ALL "
                    "reference media content items (verified live)", len(reference_videos)
                )
            else:
                for vid_url in reference_videos[:3]:
                    if not vid_url:
                        continue
                    content.append({
                        "type": "video_url",
                        "video_url": {"url": vid_url},
                        "role": "reference_video",
                    })
                    logger.info("[Seedance] Added reference video")

        # 5. Audio. A/B verdict (2026-06-10): the content-item form is rejected in
        #    i2v mode (same reference-media exclusion); the top-level audio_url
        #    field works. Content item is only attempted in reference/t2v mode.
        audio_as_content = False
        if audio_url and not has_first_frame and not generate_audio:
            # THE RETRY WINS. `generate_audio=False` has exactly one caller: the audio
            # content-filter retry (server.py VideoTaskRequest.generate_audio → the second
            # submitAndPoll in FinalGenView), which asks for a MUTE take after Seedance
            # rejected the first one on audio. Attaching the dialogue clip here anyway used
            # to force generate_audio back to true a few lines down, so for a shot with no
            # keyframe the retry submitted the SAME audio-bearing request that had just been
            # rejected — the retry could not succeed, the clip never came back mute, and the
            # TTS rescue that re-speaks the lines (FinalGenView, after saveShotVideo) had
            # nothing to run on. t2v shots were the only ones excluded from that rescue.
            #
            # Dropping the reference costs nothing on this path: with generate_audio false
            # the documented behaviour is that the reference is NOT woven in, so it would be
            # uploaded, paid for, judged by the same content filter, and ignored. The
            # dialogue is not lost — it comes back through the TTS rescue, mixed onto the
            # saved clip with real ducking.
            audio_url = None
            logger.info("[Seedance] generate_audio=False (audio-filter retry) — dialogue "
                        "reference DROPPED so the take renders mute; the dialogue is put "
                        "back by the TTS rescue after the save")
        elif audio_url and not has_first_frame:
            # Disk path / URL → data-URI so Seedance can read it (mp3 → audio/mpeg).
            # Reference/t2v mode REQUIRES role=reference_audio on the audio content item
            # (API-validated: "reference media mode requires audio role to be reference_audio").
            #
            # PER-SPEAKER FIRST, mixed as the fallback. The audio is a reference the model
            # reads a PERFORMANCE from — tempo, pauses, where the voice breaks — so one
            # mixed track describes the whole cast with a single blended delivery, which is
            # where timbres start being invented past three speakers. When the caller
            # supplied one clip per character, those go instead, capped by the model's own
            # audio limit (3 on 2.0, 10 on 2.5). The mixed clip stays the fallback so a
            # single-speaker take, or a project that predates this, is unchanged.
            _auds = [u for u in (speaker_audio_urls or []) if u] or [audio_url]
            _cap = _MODEL_CAPS.get(model, _SEEDANCE_20_CAPS)["audios"]
            if len(_auds) > _cap:
                logger.warning("[Seedance] %d speaker clip(s) but %s accepts %d — dropping %d",
                               len(_auds), model, _cap, len(_auds) - _cap)
            # THE OTHER AUDIO LIMIT, AND IT IS A DURATION. The cap above counts CLIPS; the
            # API also refuses any single reference longer than ~30 s ("audio duration
            # (seconds) … must be less than or equal to 30.2 for model dreamina-seedance-2-5
            # in r2v"). Nothing checked it, and the failure is silent and total: BLACK
            # MIRROR SHOT_023, 2026-08-15 — a 35.5 s dialogue clip took the whole render
            # down with a bare "Bad Request", after a fallback that could not work either.
            # A segment with several long lines reaches 30 s easily, so this is not an edge
            # case. Dropping the over-long clip loses the performance reference for that
            # take; sending it loses the take.
            _kept: list[str] = []
            for _a in _auds:
                _secs = _audio_seconds(_a)
                # TOO SHORT is as fatal as too long, and far more common: the API refuses
                # anything under 1.8s and a one-word line renders to about a second. Padded
                # rather than dropped — see _pad_audio_to_min.
                if (_secs is not None and _secs < _AUDIO_REF_MIN_SECS
                        and not _a.startswith(("http://", "https://", "data:"))):
                    _padded = _pad_audio_to_min(_a, _AUDIO_REF_MIN_SECS)
                    if _padded != _a:
                        logger.info("[Seedance] dialogue reference %.2fs < %.1fs floor — padded "
                                    "with silence so the clip is accepted", _secs, _AUDIO_REF_MIN_SECS)
                        _a, _secs = _padded, _audio_seconds(_padded)
                if _secs is not None and _secs < _AUDIO_REF_MIN_SECS:
                    logger.error("[Seedance] dialogue reference %.2fs is under the %.1fs floor and "
                                 "could not be padded — NOT attached, because sending it refuses the "
                                 "WHOLE request with a bare Bad Request.", _secs, _AUDIO_REF_MIN_SECS)
                    continue
                if _secs is not None and _secs > _AUDIO_REF_MAX_SECS:
                    logger.error("[Seedance] dialogue reference %.1fs > %.1fs limit — NOT attached. "
                                 "The take renders without a performance reference and will speak in "
                                 "a voice of its own. Split the segment or shorten the lines.",
                                 _secs, _AUDIO_REF_MAX_SECS)
                    continue
                _kept.append(_a)
            _auds = _kept
            for _a in _auds[:_cap]:
                content.append({
                    "type": "audio_url",
                    "role": "reference_audio",
                    # _audio_data_uri, NOT _url_to_data_uri: an mp3 labelled with its own
                    # IANA type (audio/mpeg) is refused as "Invalid base64 audio_url".
                    "audio_url": {"url": _audio_data_uri(_a)},
                })
            audio_as_content = True
            logger.info("[Seedance] %d audio reference(s) attached (reference_audio, t2v mode)",
                        min(len(_auds), _cap))

        # ── Build body ────────────────────────────────────────────────────────
        body: Dict[str, Any] = {
            "model": model,
            "content": content,
            "ratio": ratio,
            "resolution": resolution,
            # The API takes whole seconds. A segment's length is the SUM of its shots and
            # may be fractional (2.5 + 3 + 1.5 = 7.0, but 2.5 + 3.2 = 5.7), so the rounding
            # happens HERE, once, at the boundary — never upstream, where it would corrupt
            # the per-shot timings that the prompt spells out and the EDL trims to.
            # ceil, not round: Python rounds .5 to EVEN, so a 12.5s segment asked for
            # 12 while its prompt declared 12.5s of content, and 4.5/6.5/8.5 all lost
            # half a second of the last shot. Rounding up costs a fraction of a second
            # of hold; rounding down truncates a beat that was written and paid for.
            # `float(duration or 5)` stood here — the second half of the same fabrication the
            # guard at the top of this function now refuses. duration is measured or we
            # never reach this line.
            "duration": max(caps["min_duration"],
                            min(caps["max_duration"], _math.ceil(round(float(duration), 3)))),
            "watermark": False,
        }
        # Seedance 2.0 does NOT support `seed` or `camera_fixed` (Model-Genius video
        # ref §3 — the new body-field method is strict-validated; both are ❌ on 2.0).
        # They were previously sent and merely tolerated/ignored; dropped to stay in
        # spec. Consequence: exact seed-replay is not achievable on 2.0 — an HD/retake
        # re-render reuses the prompt (and first_frame) only, not a bit-identical seed.
        if seed is not None:
            logger.debug("[Seedance] seed=%s ignored — Seedance 2.0 does not support seed", seed)

        # Negative prompt: NOT sent. A/B with a fixed seed (2026-06-10, tasks
        # cgt-…rmwld vs cgt-…lvm5n) produced identical output with and without
        # the undocumented `negative_prompt` body field — the API ignores it.
        # Constraints ride IN the positive prompt per the official guide.
        if negative_prompt:
            logger.debug("[Seedance] negative list (prompt-side constraints cover this): %r",
                         negative_prompt[:80])

        # P3.15: always ask for the last frame — it's free metadata and feeds
        # the per-scene continuity chain (last frame → next shot's first frame).
        body["return_last_frame"] = True

        # Audio semantics differ by mode (video-seedance ref §4):
        #   Reference mode, audio as CONTENT ITEM (the dialogue clip): the doc requires
        #   generate_audio: true — "Audio (0–3) + generate_audio: true → synced vocals".
        #   With false the reference is not woven in, so the dubbed dialogue was lost.
        #   i2v mode, top-level audio_url (legacy soundtrack override, A/B-verified
        #   2026-06-10): the track REPLACES generation → generate_audio stays False.
        # The `true` below is still load-bearing for the NORMAL path — it is what makes the
        # dubbed dialogue audible at all — but it can no longer overrule an explicit
        # generate_audio=False, because the block above clears audio_url in that case and
        # this falls through to the caller's own value.
        if audio_url:
            if audio_as_content:
                body["generate_audio"] = True
            else:
                body["audio_url"] = audio_url
                body["generate_audio"] = False
                logger.info("[Seedance] Audio via top-level field (i2v mode)")
        else:
            body["generate_audio"] = generate_audio

        # ── Log full request body for verification (omit raw image data) ─────────
        log_content = []
        for item in content:
            entry = {"type": item.get("type"), "role": item.get("role")}
            if "image_url" in item:
                raw = item["image_url"]["url"]
                entry["url_preview"] = raw[:60] + "…" if len(raw) > 60 else raw
            elif "video_url" in item:
                entry["url_preview"] = item["video_url"]["url"][:60]
            elif "text" in item:
                entry["text_preview"] = item["text"][:120]
            log_content.append(entry)

        logger.info(
            "[Seedance] SUBMIT: model=%s resolution=%s duration=%ds items=%d neg=%r",
            body["model"], body["resolution"], body["duration"], len(content),
            body.get("negative_prompt", ""),
        )
        for i, c in enumerate(log_content):
            logger.info("[Seedance] content[%d]: %s", i, c)
        # ─────────────────────────────────────────────────────────────────────

        logger.info("[Seedance] Submitting task — %d content items", len(content))
        if on_submit is not None:
            try:
                on_submit()
            except Exception as e:
                # Recording the intent must never be what stops a render the operator
                # asked for — a missing marker only costs certainty later.
                logger.warning("[Seedance] submit-intent hook failed (continuing): %s", e)
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=_submit_timeout(content))
            resp.raise_for_status()
            data = resp.json()
            task_id = data.get("id", "")
            logger.info("[Seedance] Task submitted: %s", task_id)
            # Echo what was ACTUALLY submitted, not what was asked for — the registry
            # and the usage meter must record the resolution that gets billed, which
            # for a tiered render is not necessarily the project's output size.
            return {"task_id": task_id, "status": "submitted",
                    "model": model, "resolution": resolution, "tier": tier or "",
                    # A 2xx we cannot find an id in is not a verdict: the request DID
                    # arrive, so a task may exist that we simply cannot name. Post-flight
                    # for exactly that reason, so the caller keeps its submit-intent
                    # marker instead of filing this under "nothing happened".
                    "submit_phase": "" if task_id else PHASE_POSTFLIGHT}
        except requests.exceptions.HTTPError as e:
            err_body = ""
            try:
                err_body = e.response.json()
            except Exception:
                err_body = e.response.text[:500] if e.response else str(e)
            # Did BytePlus DECIDE, or did we simply never hear a verdict? The caller
            # needs this to know whether a charge may exist (server.py resolves or
            # keeps its submit-intent marker on it). A 4xx is a decision: the request
            # was understood and refused, so no task was created and nothing is
            # billable. A 5xx is NOT — a gateway error can sit in front of a task the
            # backend already accepted — so it is reported as undecided, like a
            # timeout. Erring the other way would print "nothing was billed" over a
            # render that is running.
            _status = e.response.status_code if e.response is not None else 0
            decided = 400 <= _status < 500
            # An HTTP status means a response ARRIVED, so the request certainly left this
            # machine. Post-flight regardless of the code (see _submit_failure_phase): on
            # a 4xx `decided` already says nothing was created, and on a 5xx this is what
            # stops the caller from clearing a marker over a task that may exist.
            phase = PHASE_POSTFLIGHT
            # A/B fallback: if the documented audio content-item shape is rejected,
            # retry once with the legacy top-level audio_url field.
            if audio_as_content and e.response is not None and e.response.status_code == 400:
                # ERROR, not warning, and it says what it COSTS. This branch hid the
                # audio/mpeg-vs-audio/mp3 bug for weeks: it reads as a graceful
                # degradation and is nothing of the sort. The legacy field takes
                # `audio_url` VERBATIM — for a local path, something BytePlus cannot
                # fetch — while `generate_audio` stays true from the block above. So the
                # render is paid for, comes back with invented dialogue, and every
                # `@Audio N` in the prompt addresses a reference that never arrived.
                logger.error("[Seedance] AUDIO REFERENCE REJECTED (%s) — falling back to the "
                             "legacy audio_url field. The model will NOT receive the clip; if "
                             "the prompt addresses @Audio N it now points at nothing, and the "
                             "take will generate its own dialogue.", err_body)
                body["content"] = [c for c in content if c.get("type") != "audio_url"]
                body["audio_url"] = audio_url
                try:
                    resp2 = requests.post(url, headers=headers, json=body, timeout=_submit_timeout(body.get("content")))
                    resp2.raise_for_status()
                    task_id = resp2.json().get("id", "")
                    logger.info("[Seedance] Task submitted via legacy audio field: %s", task_id)
                    # Additive flag so a caller can surface the degradation instead of
                    # presenting an audio-less take as a normal result.
                    return {"task_id": task_id, "status": "submitted", "audio_mode": "legacy",
                            "audio_ref_dropped": True,
                            "model": model, "resolution": resolution, "tier": tier or "",
                            "submit_phase": "" if task_id else PHASE_POSTFLIGHT}
                except Exception as e2:
                    # The RETRY is the last thing that touched the network, so it owns
                    # the verdict AND the phase. A retry that timed out leaves us not
                    # knowing whether THAT request created a task, whatever the first
                    # response said; a retry that never got a connection created nothing,
                    # and the 4xx before it created nothing either — so the whole submit
                    # is pre-flight and no charge can exist.
                    if not isinstance(e2, requests.exceptions.HTTPError):
                        decided = False
                        phase = _submit_failure_phase(e2)
                    elif e2.response is not None:
                        decided = 400 <= e2.response.status_code < 500
                    logger.error("[Seedance] Legacy audio retry also failed: %s", e2)
            logger.error("[Seedance] Submit HTTP error: %s - %s", e, err_body)
            return {"task_id": None, "status": "error", "decided": decided,
                    "submit_phase": phase, "error": f"{e} | {err_body}"}
        except Exception as e:
            # No verdict at all. WHERE it died is what decides whether money can be at
            # stake: a DNS/TLS/connect failure never handed BytePlus the request, so
            # nothing is billable, while a read timeout or a connection dropped after the
            # write may have started a render we can no longer name. decided=False in both
            # cases (nobody answered), but the phase is what tells server.py whether to
            # clear its submit-intent marker or keep it — see _submit_failure_phase.
            phase = _submit_failure_phase(e)
            logger.error("[Seedance] Submit failed (%s): %s", phase, e)
            return {"task_id": None, "status": "error", "decided": False,
                    "submit_phase": phase, "error": str(e)}

    def create_studio_video(
        self,
        *,
        prompt: str,
        mode: str = "t2v",                       # 't2v' | 'i2v' | 'first_last' | 'multimodal'
        images: Optional[List[str]] = None,      # urls / data-URIs
        videos: Optional[List[str]] = None,      # multimodal only (0–3)
        audios: Optional[List[str]] = None,      # multimodal only (0–3)
        ratio: str = "adaptive",                 # 21:9|16:9|4:3|1:1|3:4|9:16|adaptive
        resolution: str = "720p",                # 480p|720p|1080p|4k (4k = base 2.0 only, 10-bit H.265)
        duration: int = 5,                       # 4–15 on 2.0, 4–30 on 2.5, or -1 (auto)
        generate_audio: bool = True,
        model: Optional[str] = None,             # None → SEEDANCE_MODEL (base 2.0)
        output_format: str = "",                 # 'mp4' | 'mov' — Seedance 2.5 only
    ) -> Dict[str, Any]:
        """Studio-only Seedance 2.0 task builder. Supports the three mutually
        exclusive modes from the docs (first-frame / first+last / multimodal
        references) + 4k. Independent of the pipeline's create_video_task — adds
        nothing to and changes nothing about the pipeline path."""
        api_key = self.seedream_api_key or self.api_key
        if not api_key:
            return {"task_id": None, "status": "error", "error": "No API key configured"}
        # Studio has always offered a 480p–4k picker with no capability check; if
        # SEEDANCE_MODEL is ever pointed at Fast/Mini, a 4k pick here would fail as
        # an opaque vendor 400. Same guard as the pipeline path (no tier — Studio is
        # a sandbox where the user picks the resolution outright).
        resolution = (resolution or "720p").strip().lower()
        model_id = model or self.SEEDANCE_MODEL
        _assert_model_resolution(model_id, resolution)
        caps = model_caps(model_id)
        imgs = [u for u in (images or []) if u]
        vids = [u for u in (videos or []) if u]
        auds = [u for u in (audios or []) if u]

        # Duration ranges differ per model (2.0: 4-15 s, 2.5: 4-30 s). Clamp instead of
        # forwarding an out-of-range value, which comes back as an opaque vendor 400.
        # -1 is "let the model choose" and is valid on both, so it passes through.
        if duration != -1:
            clamped = max(caps["min_duration"], min(caps["max_duration"], int(duration)))
            if clamped != duration:
                logger.warning("[Seedance studio] duration %ss out of range for %s — clamped to %ss",
                               duration, model_id, clamped)
            duration = clamped

        # first_frame / first+last / multimodal are MUTUALLY EXCLUSIVE task types. On 2.5
        # the first two additionally LOCK the aspect ratio to the input image, and passing
        # any other ratio fails ASYNCHRONOUSLY — i.e. the task is created, then dies, so
        # the user pays the round trip to find out. Coerce it here rather than let that happen.
        if mode in ("i2v", "first_last") and ratio != "adaptive" and model_id == self.SEEDANCE_25_MODEL:
            logger.info("[Seedance studio] %s locks the ratio to the first frame on %s — "
                        "forcing 'adaptive' (was %r)", mode, model_id, ratio)
            ratio = "adaptive"

        content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
        if mode == "i2v" and imgs:
            content.append({"type": "image_url", "image_url": {"url": _url_to_data_uri(imgs[0])}, "role": "first_frame"})
        elif mode == "first_last" and len(imgs) >= 2:
            content.append({"type": "image_url", "image_url": {"url": _url_to_data_uri(imgs[0])}, "role": "first_frame"})
            content.append({"type": "image_url", "image_url": {"url": _url_to_data_uri(imgs[1])}, "role": "last_frame"})
        elif mode == "multimodal":
            # Caps are per-model: 9/3/3 on 2.0, 30/10/10 on 2.5. Truncating is silent to
            # the caller otherwise, and a dropped reference is exactly the kind of thing
            # that shows up as "why does the character look wrong" three steps later.
            for kind, items, cap in (("image", imgs, caps["images"]),
                                     ("video", vids, caps["videos"]),
                                     ("audio", auds, caps["audios"])):
                if len(items) > cap:
                    logger.warning("[Seedance studio] %d %s reference(s) submitted but %s accepts %d — dropping %d",
                                   len(items), kind, model_id, cap, len(items) - cap)
            for u in imgs[:caps["images"]]:
                content.append({"type": "image_url", "image_url": {"url": _url_to_data_uri(u)}, "role": "reference_image"})
            for v in vids[:caps["videos"]]:
                content.append({"type": "video_url", "video_url": {"url": v}, "role": "reference_video"})
            for a in auds[:caps["audios"]]:
                content.append({"type": "audio_url", "audio_url": {"url": a}, "role": "reference_audio"})
            # 2.5 accepts audio-only reference input; 2.0 requires at least one image or
            # video and rejects the audio-only payload at the vendor.
            if not imgs and not vids and auds and not caps["audio_only"]:
                return {"task_id": None, "status": "error",
                        "error": (f"{model_id} needs at least one image or video reference — "
                                  "audio-only input is Seedance 2.5 only.")}
        # 't2v' → text only

        body: Dict[str, Any] = {
            "model": model_id,
            "content": content,
            "ratio": ratio,
            "resolution": resolution,
            "duration": duration,
            "watermark": False,
            # camera_fixed omitted — unsupported on Seedance 2.0 (Model-Genius video ref §3)
            # and on 2.5, which also drops `seed` and `frames`.
            "return_last_frame": True,
            "generate_audio": bool(generate_audio),
        }
        # mp4 (default) | mov — 2.5 ONLY. mov carries higher colour precision and is what
        # the docs recommend for edit/extend; sending the field to a 2.0 model is an
        # unsupported-parameter 400, so it is gated on the capability, not on the value.
        if output_format and caps["output_format"]:
            body["output_format"] = output_format
        url = f"{self.base_url}/contents/generations/tasks"
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
        logger.info("[Seedance studio] SUBMIT mode=%s res=%s dur=%s items=%d", mode, resolution, duration, len(content))
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=_submit_timeout(content))
            resp.raise_for_status()
            return {"task_id": resp.json().get("id", ""), "status": "submitted"}
        except requests.exceptions.HTTPError as e:
            try:
                err = e.response.json()
            except Exception:
                err = e.response.text[:500] if e.response is not None else str(e)
            logger.error("[Seedance studio] submit error: %s | %s", e, err)
            return {"task_id": None, "status": "error", "error": f"{e} | {err}"}
        except Exception as e:
            # A read timeout here is POSTFLIGHT (_submit_failure_phase): the request was
            # fully written, so BytePlus may be holding the task RIGHT NOW and billing it.
            # Saying so is the whole point — the raw urllib3 line ("Read timed out") reads
            # like nothing happened, and the natural response to it is to press again and
            # pay twice.
            phase = _submit_failure_phase(e)
            logger.error("[Seedance studio] submit failed (%s): %s", phase, e)
            if phase == PHASE_POSTFLIGHT:
                return {"task_id": None, "status": "error", "submit_phase": phase,
                        "error": ("BytePlus did not answer the submit in time. The task may have "
                                  "been accepted and be rendering — check the BytePlus console "
                                  "before submitting again, or it will render (and bill) twice. "
                                  f"({e})")}
            return {"task_id": None, "status": "error", "submit_phase": phase, "error": str(e)}

    def cancel_video_task(self, task_id: str) -> Dict[str, Any]:
        """Cancel a queued task / delete a task record (documented DELETE endpoint)."""
        api_key = self.seedream_api_key or self.api_key
        url = f"{self.base_url}/contents/generations/tasks/{task_id}"
        try:
            resp = requests.delete(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=15)
            resp.raise_for_status()
            logger.info("[Seedance] Task cancelled/deleted: %s", task_id)
            return {"task_id": task_id, "status": "cancelled"}
        except requests.exceptions.HTTPError as e:
            # Documented: only QUEUED tasks can be cancelled. A running task
            # returns 409 Conflict (verified live) — report that clearly.
            if e.response is not None and e.response.status_code == 409:
                logger.info("[Seedance] %s already running — cannot cancel (409)", task_id)
                return {"task_id": task_id, "status": "running_cannot_cancel"}
            logger.warning("[Seedance] Cancel failed for %s: %s", task_id, e)
            return {"task_id": task_id, "status": "error", "error": str(e)}
        except Exception as e:
            logger.warning("[Seedance] Cancel failed for %s: %s", task_id, e)
            return {"task_id": task_id, "status": "error", "error": str(e)}

    def list_video_tasks(self, status: Optional[str] = None, page_size: int = 20) -> Dict[str, Any]:
        """List recent video tasks (documented list endpoint) — used to reconcile
        tasks orphaned by a closed browser."""
        api_key = self.seedream_api_key or self.api_key
        url = f"{self.base_url}/contents/generations/tasks?page_size={page_size}"
        if status:
            url += f"&filter.status={status}"
        resp = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=15)
        resp.raise_for_status()
        return resp.json()

    def poll_video_task(
        self, task_id: str, max_wait: int = 120, interval: int = 5
    ) -> Dict[str, Any]:
        """Poll for video task completion."""
        api_key = self.seedream_api_key or self.api_key
        if not api_key:
            return {"status": "error", "error": "No API key configured"}

        url = f"{self.base_url}/contents/generations/tasks/{task_id}"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

        elapsed = 0
        while elapsed < max_wait:
            try:
                resp = requests.get(url, headers=headers, timeout=15)
                resp.raise_for_status()
                data = resp.json()
                status = data.get("status", "unknown")

                if status == "succeeded":
                    video_url = ""
                    last_frame_url = ""
                    content_obj = data.get("content")
                    if isinstance(content_obj, dict):
                        video_url = content_obj.get("video_url", "")
                        last_frame_url = content_obj.get("last_frame_url", "")
                    # Metadata passthrough. NOTE: Seedance 2.0 does not support
                    # seed (see create_video_task), so data.get("seed") is
                    # normally absent/None — a re-render is a fresh take, NOT an
                    # exact replay. resolution/ratio confirm what was rendered.
                    return {
                        "status": "completed",
                        "video_url": video_url,
                        "last_frame_url": last_frame_url,
                        "seed": data.get("seed"),
                        "resolution": data.get("resolution", ""),
                        "ratio": data.get("ratio", ""),
                        # Billable token count for usage metering (doc §5)
                        "tokens": (data.get("usage") or {}).get("completion_tokens", 0),
                    }
                if status == "failed":
                    # THE WHOLE error object, not just `message`. A task that dies
                    # asynchronously reports a message as terse as "Bad Request Request id:
                    # …" while `code` and `param` carry what actually went wrong — the same
                    # pair that, on the SUBMIT path, told us an audio clip was under the
                    # 1.8s floor. Discarding them is why BLACKMIRROR 4 SHOT_017 and BLACK
                    # MIRROR V3 SHOT_029/SHOT_031 have been unexplained for weeks: the
                    # explanation arrived every time and was thrown away one field short.
                    _e = data.get("error") or {}
                    err = _e.get("message", "Unknown error")
                    _code, _param = _e.get("code", ""), _e.get("param", "")
                    if _code or _param:
                        err = f"{_code or 'error'}{f' [{_param}]' if _param else ''}: {err}"
                    # EL FILTRO DE CONTENIDO SOBRE LA SALIDA, dicho de forma accionable. La
                    # ruta de IMAGEN ya lo hace (server._all_variations_failed: "suele ser
                    # un falso positivo en primeros planos o en léxico visceral; suaviza y
                    # repite"); la de VÍDEO devolvía el blob crudo. Medido en BLACKMIRROR 4
                    # SHOT_004 — un hombre despertando en la cama junto a su mujer —, que es
                    # exactamente el falso positivo que el operador necesita reconocer para
                    # no buscar el fallo en otra parte. No se reintenta solo: un reintento
                    # aquí es otro render pagado, y esa decisión es de quien paga.
                    if "sensitivecontent" in str(_e).lower().replace(" ", ""):
                        err = (f"{err} — Seedance's content filter blocked the OUTPUT video. "
                               "It is usually a false positive on skin, beds, wounds or "
                               "visceral wording. Soften the action line in the prompt panel "
                               "and render this shot again; the references are fine.")
                    logger.error("[Seedance] task %s failed — %s", task_id, json.dumps(_e)[:600])
                    return {"status": "failed", "error": err, "error_detail": _e}
                if status == "expired":
                    return {"status": "failed", "error": "Task expired"}
                logger.info("[Seedance] Status: %s, waiting…", status)
            except Exception as e:
                logger.warning("[Seedance] poll error: %s", e)
            time.sleep(interval)
            elapsed += interval
        return {"status": "timeout", "task_id": task_id}
