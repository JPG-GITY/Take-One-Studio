"""Per-project usage metering → <project>/Usage/usage.json.

Real tokens come from the API responses (Anthropic `usage`, ModelArk video
`completion_tokens`); images are counted (image gen returns no token usage). A
contextvar carries the current project so generation code deep in the call stack
can attribute usage without threading project_path through every signature.
Estimated USD cost is derived from the documented price tables — clearly an
estimate, not a billing figure.
"""

from __future__ import annotations

import json
import threading
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# One implementation of "publish a file atomically" for the whole app — unique tmp
# per write, fsync before replace. See the atomic-writes section in storage.py.
from storage import atomic_write_json

_project: ContextVar[str] = ContextVar("takeone_usage_project", default="")
_lock = threading.Lock()

# ── Estimate-only pricing (USD) ───────────────────────────────────────────────
# Claude Sonnet per-1M tokens; ModelArk video per-1M completion tokens.
_LLM_IN_PER_M = 3.0
_LLM_OUT_PER_M = 15.0
# Video rates per MODEL FAMILY and resolution, USD per million completion tokens with
# no input video, from the live ModelArk pricing page (docs.byteplus.com/en/docs/
# ModelArk/1544106, read 2026-09-04). List prices: 2.5's 1080p carries a 28 % promotion
# until 2026-10-17 that is deliberately NOT applied — an estimate that runs high is a
# smaller lie than one that runs low. Families are keyed by the short tier names the
# rest of the app uses; _video_family() folds a full model id onto them.
_VIDEO_PER_M_BY_MODEL = {
    "v25":  {"480p": 10.7, "720p": 10.7, "1080p": 11.7},
    "base": {"480p": 7.0,  "720p": 7.0,  "1080p": 7.7, "4k": 4.0},
    "fast": {"480p": 5.6,  "720p": 5.6},
    "mini": {"480p": 3.5,  "720p": 3.5},
}
# Legacy per-resolution rates (a midpoint of the 2.0 with/without-video tiers). Only
# renders metered before the ledger learned the model — no `byModel` entry — are still
# priced off this row.
_VIDEO_PER_M = {"480p": 5.5, "720p": 5.5, "1080p": 6.2, "4k": 3.2, "": 6.2}


def _video_family(model: str) -> str:
    """'v25' | 'base' | 'fast' | 'mini' | '' — from either a tier key or a model id."""
    m = (model or "").strip().lower()
    if m in _VIDEO_PER_M_BY_MODEL:
        return m
    if "2-5" in m or "2.5" in m:
        return "v25"
    if "fast" in m:
        return "fast"
    if "mini" in m:
        return "mini"
    if "2-0" in m or "2.0" in m:
        return "base"
    return ""

# ── Images: priced by MODEL and PIXEL TIER, never by a flat guess ─────────────
#
# This was `_IMAGE_EACH = 0.03`, "a rough Seedream per-image figure", applied to
# every image any model ever produced. It was wrong in the expensive direction and
# it was wrong for a reason that is measurable, so it is now measured.
#
# MEASURED 2026-08-07 against ark.ap-southeast (2 live `images.generate` calls on
# dola-seedream-5-0-pro-260628, the pipeline's default SEEDREAM_MODEL):
#   size="2K", no refs  → data[0].size "2048x2048"  = 4,194,304 px (4.19 MP)
#                         usage = {generated_images: 1, input_images: 0,
#                                  output_tokens: 16384}
#   size="2K", 2 refs   → data[0].size "2816x1584"  = 4,460,544 px (4.46 MP)
#                         usage = {generated_images: 1, input_images: 2,
#                                  output_tokens: 17424}
# `output_tokens * 256` reproduced the pixel count EXACTLY in both (16384*256 =
# 2048², 17424*256 = 2816*1584), which is the documented `output_tokens ≈
# sum(w*h)/256` relation — so the response carries the true size two independent
# ways and neither has to be inferred from the requested preset.
#
# Both land ABOVE the 2.61 MP tier boundary, where the documented Pro rate is
# $0.09 — 3x the 0.03 that was being reported. BLOOM's 765 recorded images were
# therefore priced at $22.95 against a true figure of up to $68.85.
#
# WHAT IS NOT HERE, DELIBERATELY. Only the ONE rate that was supplied to this
# change is in the table: Pro above 2.61 MP. There is no entry for Pro at or below
# 2.61 MP, and none for seedream-5-0-260128 (SEEDREAM_VIEWS_MODEL, which every
# environment angle sheet runs on) or seedream-5-0-lite-260128 — the bundled
# BytePlus reference says in as many words that Seedream image per-token prices
# "were **not** in the supplied docs" (byteplus-genius/references/enterprise-ops.md
# §"These per-item prices ARE grounded"). An image whose (model, tier) is absent
# here is counted as UNPRICED and reported as such, all the way to the panel. A
# guessed rate is how the 0.03 got here in the first place.
_IMAGE_TIER_PX = 2_610_000
_IMAGE_TIER_HI = ">2.61MP"
_IMAGE_TIER_LO = "<=2.61MP"
_IMAGE_TIER_UNKNOWN = "unknown-size"
#: model id → {pixel tier → USD per generated image}. Missing key = undocumented.
_IMAGE_USD = {
    "dola-seedream-5-0-pro-260628": {_IMAGE_TIER_HI: 0.09},
}
#: Input-reference images: $0.003 each AFTER THE FIRST, per request. A platform
#: line item rather than a per-model one, so it is not in _IMAGE_USD. The billable
#: count is worked out per response by record_image_response() (the API reports
#: `usage.input_images`, measured above), because "after the first" cannot be
#: recovered from a running total once several requests have been added together.
_IMAGE_REF_EACH = 0.003
#: Bucket label for images metered before this breakdown existed — BLOOM's 765 have
#: no model and no size on record, so they cannot be priced by ANY rate without
#: inventing which model made them.
_IMAGE_LEGACY = "(unattributed — recorded before per-model metering)"


def image_tier(pixels: int) -> str:
    """PURE. Which documented price tier a generated image of `pixels` falls in."""
    if not pixels or pixels <= 0:
        return _IMAGE_TIER_UNKNOWN
    return _IMAGE_TIER_HI if pixels > _IMAGE_TIER_PX else _IMAGE_TIER_LO


def set_project(path: str) -> None:
    """Attribute subsequent record() calls (without an explicit path) to this
    project. The contextvar propagates into asyncio.to_thread workers."""
    _project.set(path or "")


def _resolve(project_path: str = "") -> str:
    return project_path or _project.get("")


def _file(project_path: str) -> Path:
    return Path(project_path).expanduser() / "Usage" / "usage.json"


def _empty() -> dict[str, Any]:
    return {
        "llm":    {"calls": 0, "tokens_in": 0, "tokens_out": 0},
        "vision": {"calls": 0, "tokens_in": 0, "tokens_out": 0},
        # `count` keeps its old meaning (every generated image ever metered here) so a
        # file written before the breakdown existed still reads back its total. `byModel`
        # is what makes the total PRICEABLE; `refsBilled` is the input references past the
        # first of each request, already reduced at record time (see _IMAGE_REF_EACH).
        "images": {"count": 0, "refsBilled": 0, "byModel": {}},
        "videos": {"count": 0, "tokens": 0, "byResolution": {}},
        # AI MediaKit masters (Stage 6 "Upscale master"). Priced at record time from the
        # vendor's published coefficient table (byteplus_mediakit.estimate_cost_usd), so
        # `usd` is the figure that was quoted and paid, not a rate looked up later.
        "upscale": {"count": 0, "seconds": 0.0, "usd": 0.0, "byResolution": {}},
    }


#: The nested per-key breakdowns. They are REPLACED wholesale on load rather than
#: merged key-by-key like the scalars — `v.update(...)` below only copies the keys
#: `_empty()` declares, so a dict of arbitrary model ids / resolutions would come
#: back empty. Videos already needed this; images now do too, and getting it wrong
#: silently resets the breakdown on every write.
_NESTED = {"videos": "byResolution", "images": "byModel", "upscale": "byResolution"}


def _load(fp: Path) -> dict[str, Any]:
    base = _empty()
    if fp.is_file():
        try:
            d = json.loads(fp.read_text())
            for k, v in base.items():
                if isinstance(d.get(k), dict):
                    v.update({kk: d[k].get(kk, vv) for kk, vv in v.items()})
                    nested = _NESTED.get(k)
                    if nested and isinstance(d[k].get(nested), dict):
                        v[nested] = d[k][nested]
        except (json.JSONDecodeError, OSError):
            pass
    return base


def record(kind: str, *, project_path: str = "", calls: int = 0, images: int = 0,
           videos: int = 0, tokens_in: int = 0, tokens_out: int = 0, tokens: int = 0,
           resolution: str | None = None,
           model: str = "", pixels: int = 0, refs_billed: int = 0,
           seconds: float = 0.0, usd: float = 0.0) -> None:
    """`model` / `pixels` / `refs_billed` are the images branch only, and all three
    default to the old behaviour: an `images` record with no model still bumps `count`
    and nothing else, which is exactly what it did before — and lands in the unpriced
    bucket rather than being priced at a rate nobody measured. Prefer
    record_image_response(), which fills all three from the API's own numbers."""
    proj = _resolve(project_path)
    if not proj:
        return
    fp = _file(proj)
    with _lock:
        try:
            fp.parent.mkdir(parents=True, exist_ok=True)
            data = _load(fp)
            if kind in ("llm", "vision"):
                data[kind]["calls"] += calls or 1
                data[kind]["tokens_in"] += int(tokens_in or 0)
                data[kind]["tokens_out"] += int(tokens_out or 0)
            elif kind == "images":
                n = images or 1
                data["images"]["count"] += n
                data["images"]["refsBilled"] += int(refs_billed or 0)
                # Only images that name a model can be priced. Without one there is
                # nothing to look up and no honest default, so they stay in `count`
                # alone and get reported as unpriced by get().
                if model:
                    bm = data["images"]["byModel"].setdefault(
                        model, {"count": 0, "refsBilled": 0, "byTier": {}})
                    bm["count"] += n
                    bm["refsBilled"] += int(refs_billed or 0)
                    t = image_tier(int(pixels or 0))
                    bm["byTier"][t] = bm["byTier"].get(t, 0) + n
            elif kind == "videos":
                n = videos or 1
                data["videos"]["count"] += n
                data["videos"]["tokens"] += int(tokens or 0)
                r = resolution or ""
                br = data["videos"]["byResolution"].setdefault(r, {"count": 0, "tokens": 0})
                br["count"] += n
                br["tokens"] += int(tokens or 0)
                # Nested INSIDE the resolution bucket so the file keeps its old shape
                # (the panel's "by resolution" table still adds up) while the priced
                # share of it is attributed to a model. Unknown model → no entry, and
                # get() prices that remainder at the legacy resolution rate.
                fam = _video_family(model)
                if fam:
                    bm = br.setdefault("byModel", {}).setdefault(fam, {"count": 0, "tokens": 0})
                    bm["count"] += n
                    bm["tokens"] += int(tokens or 0)
            elif kind == "upscale":
                # One master per record. `model` carries the tier (standard|professional)
                # and the bucket key says both, because the two are priced 10× apart.
                data["upscale"]["count"] += 1
                data["upscale"]["seconds"] += float(seconds or 0.0)
                data["upscale"]["usd"] += float(usd or 0.0)
                key = f"{resolution or ''} {model or ''}".strip()
                bu = data["upscale"]["byResolution"].setdefault(key, {"count": 0, "seconds": 0.0, "usd": 0.0})
                bu["count"] += 1
                bu["seconds"] += float(seconds or 0.0)
                bu["usd"] += float(usd or 0.0)
            data["updatedAt"] = datetime.now(timezone.utc).isoformat()
            # Was a FIXED "<name>.json.tmp" with no fsync — the same shape that was
            # measured destroying pipeline_state.json (see storage.py's atomic-writes
            # section). _lock only covers this process, and a second Take One Studio meters
            # into the same project folder.
            atomic_write_json(fp, data)
        except (OSError, ValueError):
            pass  # metering must never break generation


def record_llm(usage_obj: Any, *, kind: str = "llm", project_path: str = "") -> None:
    """Record from an Anthropic (input/output_tokens) or OpenAI-style
    (prompt/completion_tokens) usage object."""
    if usage_obj is None:
        return
    ti = getattr(usage_obj, "input_tokens", None)
    to = getattr(usage_obj, "output_tokens", None)
    if ti is None:
        ti = getattr(usage_obj, "prompt_tokens", 0)
    if to is None:
        to = getattr(usage_obj, "completion_tokens", 0)
    record(kind, project_path=project_path, calls=1,
           tokens_in=int(ti or 0), tokens_out=int(to or 0))


def _resp_pixels(item: Any, usage_obj: Any, generated: int) -> int:
    """Pixels of ONE returned image, from the response and never from the request.

    Two independent readings, measured to agree exactly (see the pricing block):
      1. `data[i].size` — "2048x2048". The authority, because it is per image.
      2. `usage.output_tokens * 256 / generated_images` — the documented
         `output_tokens ≈ sum(w*h)/256`, used only when (1) is absent.
    The REQUESTED size is deliberately not a third fallback: it is a preset ("2K")
    that the service clamps and re-shapes (a 2K request with 2 refs came back
    2816x1584, not 2048x2048), so a tier read off the request would be a guess
    dressed as a measurement. No reading → tier "unknown-size" → unpriced.
    """
    raw = str(getattr(item, "size", "") or "")
    if "x" in raw.lower():
        try:
            w, h = (int(v) for v in raw.lower().split("x", 1))
            if w > 0 and h > 0:
                return w * h
        except (TypeError, ValueError):
            pass
    ot = int(getattr(usage_obj, "output_tokens", 0) or 0)
    return (ot * 256) // generated if ot > 0 and generated > 0 else 0


def record_image_response(resp: Any, model: str = "", *, project_path: str = "") -> int:
    """Meter ONE `images.generate` response from the numbers the API itself reports.
    Returns the number of generated images metered.

    ONE parser for every image call site, because the alternative measured badly: the
    two call sites used to hand `record()` a bare count they had derived themselves
    (`len(all_urls)`, a `billed` accumulator), which is how a model id and a pixel size
    that were sitting in the response object never reached the price table.

    Fields read (all confirmed present on ark.ap-southeast, 2026-08-07):
      `usage.generated_images` — what is actually billed. The docs are explicit that
          failures are not billed, so this is preferred over len(resp.data).
      `usage.input_images`     — the reference images the request carried. Charged
          "each after the first", so `max(0, input_images - 1)` is the billable count,
          reduced HERE while the request boundary still exists.
      `data[i].size`           — the true output geometry (see _resp_pixels).
      `resp.model`             — the resolved model id, which can differ from the one
          asked for (Automated Replacement silently routes deprecated ids to a
          successor at a DIFFERENT price — enterprise-ops.md §"Automated Replacement").
          So the response's own answer wins over the caller's `model` argument.
    """
    if resp is None:
        return 0
    u = getattr(resp, "usage", None)
    items = list(getattr(resp, "data", None) or [])
    generated = int(getattr(u, "generated_images", 0) or 0) or len(items)
    if generated <= 0:
        return 0
    mdl = str(getattr(resp, "model", "") or model or "")
    refs = int(getattr(u, "input_images", 0) or 0)
    # Grouped by the MEASURED pixel count, not by tier: a batch can come back with mixed
    # geometries, and record() is the one place allowed to turn pixels into a tier (via
    # image_tier), so passing it a tier — or a pixel count reverse-engineered from one —
    # would be a second, drifting definition of the boundary.
    #
    # The reference charge rides on the FIRST group only. It is billed per REQUEST
    # ("each after the first"), so spreading it over the groups would multiply one
    # request's references by the batch size.
    by_px: dict[int, int] = {}
    for i in range(generated):
        px = _resp_pixels(items[i] if i < len(items) else None, u, generated)
        by_px[px] = by_px.get(px, 0) + 1
    first = True
    for px, n in by_px.items():
        record("images", project_path=project_path, images=n, model=mdl, pixels=px,
               refs_billed=max(0, refs - 1) if first else 0)
        first = False
    return generated


def get(project_path: str) -> dict[str, Any]:
    data = _load(_file(project_path))
    llm, vis, vid, img = data["llm"], data["vision"], data["videos"], data["images"]

    # IMAGES — priced per (model, pixel tier), and whatever has no documented rate is
    # COUNTED rather than guessed. `unpriced` is not a rounding detail: on BLOOM it is
    # all 765 images, and a panel that quietly showed $22.95 for them was reporting a
    # number derived from a rate that was never true for the model in use.
    img_usd = 0.0
    unpriced = 0
    unpriced_models: list[str] = []
    attributed = 0
    for mdl, b in (img.get("byModel") or {}).items():
        table = _IMAGE_USD.get(mdl) or {}
        for tier, n in (b.get("byTier") or {}).items():
            attributed += int(n or 0)
            rate = table.get(tier)
            if rate is None:
                unpriced += int(n or 0)
                label = f"{mdl} @ {tier}"
                if label not in unpriced_models:
                    unpriced_models.append(label)
            else:
                img_usd += int(n or 0) * rate
    legacy = int(img.get("count", 0)) - attributed
    if legacy > 0:
        unpriced += legacy
        unpriced_models.append(_IMAGE_LEGACY)
    refs_usd = int(img.get("refsBilled", 0)) * _IMAGE_REF_EACH

    llm_usd = ((llm["tokens_in"] + vis["tokens_in"]) / 1e6 * _LLM_IN_PER_M
               + (llm["tokens_out"] + vis["tokens_out"]) / 1e6 * _LLM_OUT_PER_M)
    # VIDEOS — tokens attributed to a model family are priced at that family's rate
    # for the resolution; whatever was metered before the ledger knew the model falls
    # back to the legacy per-resolution midpoint, exactly as before.
    vid_usd = 0.0
    for r, b in vid["byResolution"].items():
        attributed_tokens = 0
        for fam, mb in (b.get("byModel") or {}).items():
            rate = (_VIDEO_PER_M_BY_MODEL.get(fam) or {}).get(r)
            if rate is None:
                rate = _VIDEO_PER_M.get(r, 6.2)
            attributed_tokens += int(mb.get("tokens", 0))
            vid_usd += int(mb.get("tokens", 0)) / 1e6 * rate
        rest = int(b.get("tokens", 0)) - attributed_tokens
        if rest > 0:
            vid_usd += rest / 1e6 * _VIDEO_PER_M.get(r, 6.2)

    ups_usd = float((data.get("upscale") or {}).get("usd") or 0.0)
    data["estimatedCostUsd"] = round(llm_usd + img_usd + refs_usd + vid_usd + ups_usd, 2)
    # The panel needs the unpriced count to say so out loud — a headline figure that
    # silently excludes 765 images is the same defect as one that silently invents a
    # rate for them.
    data["costBreakdown"] = {
        "llmUsd": round(llm_usd, 2),
        "imagesUsd": round(img_usd, 2),
        "imageRefsUsd": round(refs_usd, 2),
        "videosUsd": round(vid_usd, 2),
        "upscaleUsd": round(ups_usd, 2),
        "unpricedImages": unpriced,
        "unpricedModels": unpriced_models,
    }
    return data
