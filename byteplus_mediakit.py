"""
BytePlus AI MediaKit — Video Enhancement, behind the Studio "Upscale" action.

AI MediaKit is a VOD-family product with its OWN host and its OWN key. It is not
ModelArk (the `ark.*` host, BYTEPLUS_API_KEY), not the Voice host, and the Ark CLI has
no action for it — its key is created in the AI MediaKit console (Settings → Create
API key) and read here from BYTEPLUS_MEDIAKIT_API_KEY.

Reference: docs.byteplus.com › BytePlus VOD › AI MediaKit (read 2026-09-09):
- Submit:  POST {base}/api/v1/tools/enhance-video  → {success, task_id, request_id, error}
- Poll:    GET  {base}/api/v1/tasks/{task_id}       → status running | completed | failed;
           result.video_url lives 24 h, and polling renews it when under 2 h remain.
- Auth:    `Authorization: Bearer <key>`
- Input:   video_url must be a PUBLIC http(s) url (mp4/mov/mkv/…, ≤10 GB, up to 2K in).
           Studio clips live on disk, so the caller hosts one on R2 first — the same
           hand-off Seedance reference videos already use (server.studio_video).
- Output:  `resolution` ∈ 240p…1080p | 2k | 4k | 8k. It is mutually exclusive with
           `resolution_limit` (short side, 128–4320), so this module never sends both.
- Tiers:   tool_version standard (default) | professional. `scene` is honoured by
           standard only; `enhance_style` hd | natural by both.
- Limits:  10 QPS per account, shared by every asynchronous tool.
- Price:   output minutes × coefficient × $0.2066. The coefficient table below is the
           published one (Standard vs Professional × resolution × fps band); a 10 s
           24-fps clip to 4K is $0.28 on standard and $2.75 on professional.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import requests

logger = logging.getLogger(__name__)

MEDIAKIT_BASE_URL = os.getenv(
    "BYTEPLUS_MEDIAKIT_BASE_URL", "https://mediakit.ap-southeast-1.bytepluses.com",
).rstrip("/")
ENHANCE_URL = f"{MEDIAKIT_BASE_URL}/api/v1/tools/enhance-video"
TASK_URL = f"{MEDIAKIT_BASE_URL}/api/v1/tasks/{{task_id}}"

# The enhance-video contract, verbatim. Anything outside these is a 400 from the vendor,
# so it is refused HERE, before a source clip is hosted and a task is paid for.
RESOLUTIONS = ("240p", "360p", "480p", "540p", "720p", "1080p", "2k", "4k", "8k")
TIERS = ("standard", "professional")
SCENES = ("common", "ugc", "short_series", "aigc", "old_film")
STYLES = ("hd", "natural")

# Pricing page, "Video quality enhancement pricing (standard and pro)". Rows are the
# output-resolution class ("720p or less" covers 240p–720p); columns are the fps band
# of the OUTPUT: ≤30, ≤60, ≤120. There is no 6K row, and enhance-video has no 6k value.
BASE_USD_PER_MIN = 0.2066
_FPS_BANDS = (30, 60, 120)
_COEFFICIENTS: dict[str, dict[str, tuple[int, int, int]]] = {
    "standard": {
        "720p": (1, 2, 4), "1080p": (2, 4, 8), "2k": (4, 8, 16),
        "4k": (8, 16, 32), "8k": (32, 64, 128),
    },
    "professional": {
        "720p": (10, 20, 40), "1080p": (20, 40, 80), "2k": (40, 80, 160),
        "4k": (80, 160, 320), "8k": (320, 640, 1280),
    },
}


def is_configured() -> bool:
    return bool(os.getenv("BYTEPLUS_MEDIAKIT_API_KEY", "").strip())


def _api_key() -> str:
    key = os.getenv("BYTEPLUS_MEDIAKIT_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "BYTEPLUS_MEDIAKIT_API_KEY not set — create one in the AI MediaKit console "
            "(Settings → Create API key), add it to .env and restart the backend"
        )
    return key


def _headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"}


def validate(resolution: str, tool_version: str, scene: str, enhance_style: str) -> None:
    """Raise ValueError naming the bad field — the caller turns it into a 400."""
    if resolution not in RESOLUTIONS:
        raise ValueError(f"resolution must be one of {', '.join(RESOLUTIONS)} (got {resolution!r})")
    if tool_version not in TIERS:
        raise ValueError(f"tier must be one of {', '.join(TIERS)} (got {tool_version!r})")
    if scene not in SCENES:
        raise ValueError(f"scene must be one of {', '.join(SCENES)} (got {scene!r})")
    if enhance_style not in STYLES:
        raise ValueError(f"style must be one of {', '.join(STYLES)} (got {enhance_style!r})")


def _resolution_class(resolution: str) -> str:
    return "720p" if resolution in ("240p", "360p", "480p", "540p", "720p") else resolution


def coefficient(resolution: str, tool_version: str, fps: float = 24.0) -> int:
    band = next((i for i, cap in enumerate(_FPS_BANDS) if fps <= cap), len(_FPS_BANDS) - 1)
    return _COEFFICIENTS[tool_version][_resolution_class(resolution)][band]


def estimate_cost_usd(duration_secs: float, resolution: str, tool_version: str, fps: float = 24.0) -> float:
    """Output minutes × coefficient × base. Billing is per millisecond, so a clip's own
    length is the exact figure — not a ceiling to the next minute."""
    minutes = max(0.0, float(duration_secs or 0.0)) / 60.0
    return round(minutes * coefficient(resolution, tool_version, fps) * BASE_USD_PER_MIN, 4)


def _explain(resp: requests.Response) -> str:
    """The vendor's own message when it sent one; the raw body otherwise."""
    try:
        err = (resp.json() or {}).get("error") or {}
        if isinstance(err, dict) and err.get("message"):
            param = f" (param: {err['param']})" if err.get("param") else ""
            return f"{err.get('code', 'Error')}: {err['message']}{param}"
    except Exception:
        pass
    return resp.text[:300]


def _check(resp: requests.Response, what: str) -> dict[str, Any]:
    if resp.status_code in (401, 403):
        raise RuntimeError(f"AI MediaKit auth failed (HTTP {resp.status_code}) — check BYTEPLUS_MEDIAKIT_API_KEY")
    if resp.status_code == 429:
        raise RuntimeError("AI MediaKit rate limit (10 QPS per account) — retry in a moment")
    if resp.status_code >= 400:
        raise RuntimeError(f"AI MediaKit {what} failed (HTTP {resp.status_code}): {_explain(resp)}")
    try:
        body = resp.json()
    except Exception as e:
        raise RuntimeError(f"AI MediaKit {what} returned non-JSON: {e}")
    if not isinstance(body, dict):
        raise RuntimeError(f"AI MediaKit {what} returned an unexpected body")
    if body.get("success") is False:
        raise RuntimeError(f"AI MediaKit {what} refused: {_explain(resp)}")
    return body


def submit_enhance(
    video_url: str,
    *,
    resolution: str = "4k",
    tool_version: str = "standard",
    scene: str = "aigc",
    enhance_style: str = "hd",
    fps: float | None = None,
    client_token: str | None = None,
    timeout: int = 60,
) -> dict[str, Any]:
    """Submit one enhancement task; returns {"task_id", "request_id"}.

    `scene` is only sent on standard, because the vendor ignores it on professional and
    the payload should say what actually happens. `fps` is omitted unless asked for — the
    default keeps the source frame rate, which is what a Seedance clip wants (and a higher
    band multiplies the price)."""
    validate(resolution, tool_version, scene, enhance_style)
    if not (video_url.startswith("http://") or video_url.startswith("https://")):
        raise ValueError("video_url must be a public http(s) url")
    body: dict[str, Any] = {
        "video_url": video_url,
        "tool_version": tool_version,
        "enhance_style": enhance_style,
        "resolution": resolution,
    }
    if tool_version == "standard":
        body["scene"] = scene
    if fps:
        body["fps"] = fps
    if client_token:
        body["client_token"] = client_token[:64]
    logger.info("[MediaKit] enhance-video %s %s %s %s", tool_version, resolution, enhance_style,
                body.get("scene", "-"))
    resp = requests.post(ENHANCE_URL, headers=_headers(), json=body, timeout=timeout)
    data = _check(resp, "submit")
    task_id = str(data.get("task_id") or "")
    if not task_id:
        raise RuntimeError(f"AI MediaKit submit returned no task_id: {resp.text[:200]}")
    return {"task_id": task_id, "request_id": str(data.get("request_id") or "")}


def get_task(task_id: str, timeout: int = 30) -> dict[str, Any]:
    """One status check. Flattened to what the Studio poll loop reads:
    {status, video_url, resolution, duration, fps, tool_version, error}."""
    resp = requests.get(TASK_URL.format(task_id=task_id), headers=_headers(), timeout=timeout)
    data = _check(resp, "poll")
    status = str(data.get("status") or "running")
    out: dict[str, Any] = {"status": status, "task_id": task_id}
    result = data.get("result") or {}
    if status == "completed" and isinstance(result, dict):
        out.update({
            "video_url": result.get("video_url") or "",
            "resolution": result.get("resolution") or "",
            "duration": result.get("duration"),
            "fps": result.get("fps"),
            "tool_version": result.get("tool_version") or "",
        })
        if not out["video_url"]:
            out["status"] = "failed"
            out["error"] = "AI MediaKit completed without a video_url"
    elif status == "failed":
        err = data.get("error") or {}
        out["error"] = (err.get("message") if isinstance(err, dict) else str(err)) or "AI MediaKit task failed"
    return out
