"""
Take One Studio FastAPI backend — bridges the React frontend to:
  - BytePlus generative API (Seedream 5.0 / Seedance 2.0 / DeepSeek)
  - Claude QC Agents (Anthropic SDK)
  - Real-time agent status via SSE
"""

import anyio
import asyncio
import functools
import json
import logging
import math as _math
import os
import shutil
import subprocess
import tempfile
import time as _time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator


def _find_ffmpeg() -> str:
    """
    Resolve the ffmpeg binary path in priority order:
      1. FFMPEG_BIN environment variable
      2. /opt/homebrew/bin/ffmpeg  (ARM Homebrew on macOS)
      3. /usr/local/bin/ffmpeg     (Intel Homebrew / manual install)
      4. ffmpeg via PATH (shutil.which)
      5. Bare 'ffmpeg' — will produce a clear CalledProcessError at runtime.
    """
    env = os.getenv("FFMPEG_BIN", "").strip()
    if env and os.path.isfile(env):
        return env
    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if os.path.isfile(candidate):
            try:
                import subprocess
                r = subprocess.run([candidate, "-version"], capture_output=True, timeout=5)
                if r.returncode == 0:
                    return candidate
            except Exception:
                pass
    found = shutil.which("ffmpeg")
    if found:
        return found
    return "ffmpeg"   # surface a clear "not found" error at call time


FFMPEG_BIN = _find_ffmpeg()
FFPROBE_BIN = (FFMPEG_BIN[:-6] + "ffprobe") if FFMPEG_BIN.endswith("ffmpeg") else "ffprobe"


def _has_audio(path: str) -> bool:
    """True if the file has at least one audio stream (ffprobe). Used so the
    export can keep real audio and add silence only to clips that lack it."""
    try:
        r = subprocess.run(
            [FFPROBE_BIN, "-i", path, "-show_streams", "-select_streams", "a", "-loglevel", "error"],
            capture_output=True, timeout=20,
        )
        return b"codec_type=audio" in r.stdout
    except Exception:
        return False


# There was a second duration probe here, _media_duration. It is GONE, not fixed: it
# had zero callers and did the same job as _probe_audio_seconds (which _source_seconds
# caches, and which every length in the export now flows through). Two probes with two
# names and two failure conventions is how the invented 5.0 kept coming back — whoever
# needed a length reached for whichever one they found first, and the one at the top of
# the file used to answer 5.0 when the probe failed. One probe, one convention: None
# means "not measured". See the _SOURCE_SECS_CACHE block for the measurements.

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

# A TLS-inspecting corporate proxy re-signs HTTPS with a CA that certifi does not
# carry, so every BytePlus call dies at the handshake on a backend that was NOT
# launched through start.sh (which exports the merged bundle itself). Installed
# here — before the imports below build any SDK client — so `npm run backend`, a
# bare uvicorn, or a debugger all get the same trust. See ssl_trust.py.
from ssl_trust import ensure_ca_bundle
# Kept so lifespan can REPORT the active bundle: this runs before uvicorn configures
# logging, so ssl_trust's own log line goes nowhere and an operator would have no way
# to tell whether trust was installed — which is the whole failure mode being fixed.
_CA_BUNDLE = ensure_ca_bundle()

from byteplus_generative import (BytePlusGenerativeAPI, _url_to_data_uri, _vision_data_uri,
                                 model_caps,
                                 assemble_subject_profiles, assemble_unused_materials,
                                 assemble_audio_roles, assemble_scene_audio_role,
                                 strip_output_settings,
                                 assemble_cast_consistency,
                                 PHASE_PREFLIGHT, PHASE_POSTFLIGHT)
from claude_agents import (ClaudeQCAgents, _is_photographic, _has_obstacle, check_story_spine,
                           # Sheet geometry lives with the prompt that draws it: the
                           # headshot crop box is per-layout (_derive_headshot).
                           _SHEET_LAYOUTS, SHEET_LAYOUT_DEFAULT,
                           # The axis a shot leaves behind, threaded into the next shot of
                           # the same scene so the 180° geometry survives the cut.
                           carry_screen_side,
                           # …and the SET STATE it leaves behind (what is where, who wears
                           # what), threaded the same way so props and wardrobe survive it too.
                           carry_leaves_behind,
                           carry_anchored,
                           anchor_conflicts,
                           ACTION_WORDS_PER_SEC, estimate_dialogue_seconds, split_script_speech,
                           dialogue_coverage,
                           # The drama layer of the spine, read here so the breakdown can be
                           # told what each stretch of film is worth and audited against it.
                           spine_shares, estimate_shots_seconds, _as_bool,
                           _seq_share, _seq_tension, _seq_mode, _seq_event,
                           # A malformed shot batch is the CALLER's mistake (422), not the
                           # LLM's (502) — see /api/shots/enhance below.
                           ShotPayloadError)
import storage as proj_storage
# Imports cleanly with or without rtmlib/onnxruntime/opencv installed — every heavy import
# it needs happens inside the call, so /api/motion/skeleton answers 503 with the pip
# command instead of taking the server down at boot for a feature nobody asked for.
import motion_drive
import render_registry
import render_queue
import usage

load_dotenv()
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

# ── Singleton clients ─────────────────────────────────────────────────────────

_byteplus: BytePlusGenerativeAPI | None = None
_claude: ClaudeQCAgents | None = None

# ── Global generation throttles (3-bug2) ──────────────────────────────────────
# Storyboard boards are throttled PROCESS-WIDE, not per-request. "Board all scenes"
# / autopilot now fire every scene's /api/storyboard/generate at once, so a
# per-request Semaphore would let N scenes × STORYBOARD_CONCURRENCY boards hit
# Seedream simultaneously and trip BytePlus burst-protection (500 IPM). One
# module-global semaphore keeps TOTAL boards in flight ≤ STORYBOARD_CONCURRENCY
# (16) exactly as before — identical BytePlus load, just overlapped across scenes.
# Lazily created so it binds to the running uvicorn loop (like get_byteplus).
_board_sem: asyncio.Semaphore | None = None
_beat_sem: asyncio.Semaphore | None = None


def _get_board_sem() -> asyncio.Semaphore:
    global _board_sem
    if _board_sem is None:
        _board_sem = asyncio.Semaphore(max(1, int(os.getenv("STORYBOARD_CONCURRENCY", "16"))))
    return _board_sem


def _get_beat_sem() -> asyncio.Semaphore:
    # Claude beat-writing runs per-shot; across parallel scenes that fan-out
    # multiplies (N scenes × shots) and risks Anthropic 429. Cap it process-wide
    # near today's per-scene peak; STORYBOARD_BEAT_CONCURRENCY overrides.
    global _beat_sem
    if _beat_sem is None:
        _beat_sem = asyncio.Semaphore(max(1, int(os.getenv("STORYBOARD_BEAT_CONCURRENCY", "8"))))
    return _beat_sem


# Seedance submit admission. Until now the ONLY throttle on video submits was the
# frontend's chunk size (10, or 3 at 4k) — a client-side convention that a second
# browser tab, an Autopilot run, or a direct API call bypasses completely, which is
# how a burst gets rejected by BytePlus mid-episode.
#
# Two buckets because the published caps are split that way, not per resolution
# (enterprise-ops §rate limits: enterprise-verified 10 concurrent non-4k, 1 at 4k;
# individual 3). Defaults sit at the ENTERPRISE non-4k figure and 4k's hard 1, and
# both are env-overridable — an individual-tier account should set 3.
#
# These are documented as theoretical maxima, not guarantees, so this is a ceiling
# that prevents self-inflicted bursts; it is not a promise BytePlus will accept them.
_video_sem: dict[str, asyncio.Semaphore] = {}


def _get_video_sem(resolution: str) -> asyncio.Semaphore:
    bucket = "4k" if str(resolution).lower() == "4k" else "sd"
    if bucket not in _video_sem:
        default = "1" if bucket == "4k" else "10"
        env = "SEEDANCE_CONCURRENCY_4K" if bucket == "4k" else "SEEDANCE_CONCURRENCY"
        _video_sem[bucket] = asyncio.Semaphore(max(1, int(os.getenv(env, default))))
    return _video_sem[bucket]


def get_byteplus() -> BytePlusGenerativeAPI:
    global _byteplus
    if _byteplus is None:
        _byteplus = BytePlusGenerativeAPI()
    # Surface missing/broken config as an actionable 503, not an opaque 500 mid-call.
    if not _byteplus.api_key:
        raise HTTPException(status_code=503,
                            detail="BYTEPLUS_API_KEY not set — add it to .env and restart the backend")
    if _byteplus.llm_client is None:
        raise HTTPException(status_code=503,
                            detail="BytePlus client failed to initialise — check BYTEPLUS_API_KEY and restart")
    return _byteplus


def get_claude() -> ClaudeQCAgents:
    global _claude
    if _claude is None:
        _claude = ClaudeQCAgents()
    if _claude.client is None:
        raise HTTPException(status_code=503, detail=_claude.config_error or "ANTHROPIC_API_KEY not configured")
    return _claude


def get_agents() -> ClaudeQCAgents:
    """The agent bundle for endpoints whose work is SEED-FIRST.

    get_claude() above refuses without an Anthropic key, which is right for the nine
    QC personas that still call Claude directly — and wrong for everything that has
    since moved to _text_llm (bible, script, breakdown, the three sheet prompts, the
    storyboard beat writer, the storyboard QC). Those run on Seed with Claude only as
    a fallback, so demanding the fallback's key to reach them is a locked door in front
    of a working engine: measured on this project's own account with no Anthropic
    credit, POST /api/storyboard/qc answered 503 before the Seed path was ever tried,
    and the storyboard gate never ran on a single scene of a 41-board film.

    Raises only when NEITHER backend is configured, because then there is genuinely
    nothing to run the call on.
    """
    global _claude
    if _claude is None:
        _claude = ClaudeQCAgents()
    if _claude.client is None and getattr(_claude, "_qc_client", None) is None:
        raise HTTPException(
            status_code=503,
            detail=(_claude.config_error
                    or "No text backend configured — set BYTEPLUS_API_KEY (Seed) or ANTHROPIC_API_KEY"),
        )
    return _claude


def _byteplus_quiet() -> "BytePlusGenerativeAPI | None":
    """Background-task accessor for the render reconciler: returns the client or
    None — never raises HTTPException (that only makes sense inside a request)."""
    global _byteplus
    if _byteplus is None:
        _byteplus = BytePlusGenerativeAPI()
    if not _byteplus.api_key or _byteplus.llm_client is None:
        return None
    return _byteplus


# ── SSE agent event bus ───────────────────────────────────────────────────────

class AgentEventBus:
    def __init__(self):
        self._subscribers: list[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self._subscribers.discard(q) if hasattr(self._subscribers, 'discard') else None
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    async def publish(self, agent_id: str, status: str, detail: str, progress: int | None = None):
        if status == "error" and detail:
            _log_error("agent", agent_id, detail)
        payload = {"agent_id": agent_id, "status": status, "detail": detail}
        if progress is not None:
            payload["progress"] = progress
        data = json.dumps(payload)
        dead = []
        for q in self._subscribers:
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._subscribers.remove(q)


bus = AgentEventBus()

# ── Persistent error log (ring buffer) ────────────────────────────────────────
# Toasts vanish and the agent panel only shows CURRENT state; this keeps the last
# 200 errors (HTTP 4xx/5xx raised by endpoints + agent-bus error events) queryable
# at /api/errors so failures are inspectable after the fact. In-memory by design —
# clears on backend restart, like the jobs it describes.
from collections import deque as _deque
import datetime as _dt

ERROR_LOG: "_deque[dict]" = _deque(maxlen=200)


def _log_error(kind: str, source: str, detail: str) -> None:
    ERROR_LOG.append({
        "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "kind": kind, "source": source, "detail": str(detail)[:600],
    })
# (the /api/errors endpoint + HTTP-exception capture register below, after `app`)


# ── App ───────────────────────────────────────────────────────────────────────

# ── B2: render reconciler ─────────────────────────────────────────────────────
# Finishes + saves any render that was in flight when the tab closed or the
# backend restarted, so a (paid) render is never orphaned. Runs in the background
# off the persistent render registry — independent of any browser session.

RECONCILE_INTERVAL = int(os.getenv("TAKEONE_RECONCILE_INTERVAL", "90"))
# Cuánto tiempo se persigue una tarea que nunca termina. Ver _reconcile_one: una tarea
# que el proveedor ya no reconoce (404) se lee como "timeout" y se reintentaría para
# siempre. 2 h por defecto — un render de Seedance tarda minutos, así que ninguno legítimo
# llega a rozarlo. 0 desactiva el abandono.
RECONCILE_MAX_AGE = int(os.getenv("TAKEONE_RECONCILE_MAX_AGE", "7200"))


def _meter_video_usage(task_id: str, result: dict) -> None:
    """Record ONE finished render against the project's usage ledger.

    Idempotent via the registry's `usage_recorded` flag, so it is safe to call from
    every path that can observe a completion. It has to be callable from all of them:
    metering used to live only in the /api/video/poll handler, which meant a render
    the BACKGROUND RECONCILER finished — i.e. exactly the ones where the user closed
    the tab — was downloaded, saved and paid for, but never appeared in the spend.
    Silent under-reporting is worse than no reporting: the number looks authoritative.

    BLOCKING: it reads and writes the registry, so every caller in a coroutine must
    dispatch it with asyncio.to_thread (see file_lock.LOCK_TIMEOUT_SECS).
    """
    if not task_id:
        return
    try:
        entry = render_registry.get(task_id) or {}
        if entry.get("usage_recorded"):
            return
        usage.record("videos", project_path=entry.get("project_path") or "",
                     videos=1, tokens=int(result.get("tokens") or 0),
                     resolution=result.get("resolution") or entry.get("resolution") or "",
                     model=entry.get("model") or "")
        render_registry.update(task_id, usage_recorded=True)
    except Exception as e:
        # Never let accounting break a render that already succeeded.
        logger.warning("[usage] could not meter %s: %s", task_id, e)


async def _reconcile_one(api: BytePlusGenerativeAPI, task: dict) -> None:
    tid = task.get("task_id")
    if not tid:
        return
    res = await asyncio.to_thread(api.poll_video_task, tid, 1, 1)   # single quick status check
    status = res.get("status")
    if status == "completed" and res.get("video_url"):
        try:
            import requests as _req
            r = await asyncio.to_thread(_req.get, res["video_url"], timeout=120)
            r.raise_for_status()
            saved = await asyncio.to_thread(
                proj_storage.save_shot_video,
                task.get("project_name", ""), task.get("shot_id", ""), r.content,
                task.get("project_path", ""),
                # task_id and references, or this reconciler writes a SECOND take of a
                # render the browser already saved: both see the same completed task, and
                # a sidecar with no task id is one save_shot_video cannot recognise as a
                # duplicate. Measured on BLACK MIRROR V3 SHOT_008 and SHOT_014 — two files
                # identical to the byte, seconds apart, each burning a slot in a ring that
                # holds twenty real takes, and the reconciled one recording an empty
                # reference list where the browser's had six. The registry row carries
                # both fields already; passing them makes this save the equal of the
                # browser's instead of a poorer copy of it.
                {"seed": res.get("seed") or task.get("seed"),
                 "resolution": res.get("resolution") or task.get("resolution"),
                 "prompt": task.get("prompt", ""), "reconciled": True,
                 "task_id": tid, "references": task.get("references") or []},
            )
            # Every registry call from a coroutine goes through to_thread: the registry
            # lock is a cross-process flock that WAITS with time.sleep on the calling
            # thread (file_lock.hold), so called straight from here it froze the whole
            # server for as long as any peer process held it — measured at 2.81 s of
            # dead event loop for a 3 s hold, bounded only by LOCK_TIMEOUT_SECS=15.
            await asyncio.to_thread(
                render_registry.mark_completed,
                tid, video_local_path=saved.get("path", ""), video_url=res["video_url"],
                seed=res.get("seed"), resolution=res.get("resolution"),
                last_frame_url=res.get("last_frame_url", ""),
            )
            # Meter it here too — this is the path where the browser never saw the
            # completion, so nothing else will ever count this (paid) render.
            await asyncio.to_thread(_meter_video_usage, tid, res)
            logger.info("[Reconcile] saved orphaned render %s → %s", tid, saved.get("path"))
        except Exception as e:
            logger.warning("[Reconcile] download/save failed for %s: %s", tid, e)
    elif status == "failed":
        await asyncio.to_thread(render_registry.mark_failed, tid, res.get("error", "failed"))
    # still running/queued/timeout → leave active; retried next sweep …
    #
    # …but not forever. A task the provider answers 404 for does not exist there any more:
    # it was cancelled, or it expired, or it never landed. `poll_video_task` catches the
    # 404, logs it and returns "timeout" — indistinguishable from a slow render — so the
    # reconciler kept it active and re-polled it every 90 seconds. Found on this machine
    # 2026-08-14 with a single dead id being polled for HOURS: the log filled with
    #     [Reconcile] checking 1 in-flight render task(s)
    #     [Seedance] poll error: 404 Client Error: Not Found …/api/v3/contents/
    # which is not just noise — it buries the errors you are actually looking for, and I
    # spent real time reading past it while hunting a different bug.
    #
    # Age, not error text, is the safe signal: a Seedance render finishes in minutes, and
    # the ledger stamps `created_at` when the task is registered. Anything still unfinished
    # after RECONCILE_MAX_AGE is abandoned rather than chased. Generous by default (2 h) so
    # a genuinely queued job is never killed, and env-tunable like every other interval.
    elif RECONCILE_MAX_AGE > 0:
        try:
            born = _dt.datetime.fromisoformat(str(task.get("created_at") or ""))
            age = (_dt.datetime.now(_dt.timezone.utc) - born).total_seconds()
        except Exception:                                          # noqa: BLE001
            return                                                  # no usable stamp → keep chasing
        if age > RECONCILE_MAX_AGE:
            await asyncio.to_thread(
                render_registry.mark_failed, tid,
                f"abandoned after {age / 3600:.1f}h unfinished — the provider no longer "
                f"reports this task (last status: {status})")
            logger.warning("[Reconcile] %s abandoned after %.1fh, last status %s",
                           tid, age / 3600, status)


async def _reconcile_render_tasks() -> None:
    # Fold back any task_id that had to fall back to the append-only ledger because the
    # registry lock was wedged when it was accepted (render_registry.record_durable).
    # Until it is a real ROW nothing polls it, so the paid render would never be
    # downloaded — the ledger would have saved the id and still lost the video.
    try:
        adopted = await asyncio.to_thread(render_registry.drain_orphans)
        if adopted:
            logger.warning(
                "[Reconcile] adopted %d task(s) from %s that could not be written to the "
                "registry when they were submitted — they are polled from now on",
                adopted, render_registry.ORPHAN_PATH)
    except Exception as e:
        logger.warning("[Reconcile] orphan ledger drain failed: %s", e)
    api = _byteplus_quiet()
    if not api:
        return
    tasks = await asyncio.to_thread(render_registry.active)
    if not tasks:
        return
    logger.info("[Reconcile] checking %d in-flight render task(s)", len(tasks))
    for t in tasks:
        try:
            await _reconcile_one(api, t)
        except Exception as e:
            logger.warning("[Reconcile] error on %s: %s", t.get("task_id"), e)
    await asyncio.to_thread(render_registry.prune)


async def _reconcile_loop() -> None:
    try:
        await asyncio.sleep(8)   # let the server settle, then sweep periodically
        while True:
            await _reconcile_render_tasks()
            await asyncio.sleep(RECONCILE_INTERVAL)
    except asyncio.CancelledError:
        pass


# ── B3: render queue worker ───────────────────────────────────────────────────
# The reconciler above rescues renders that were ALREADY SUBMITTED. Submission
# itself still lived in the browser's batch loop (FinalGenView.tsx): close the tab
# at shot 12 of 40 and shots 13-40 were never sent. This worker drains the
# persistent queue (render_queue.py) server-side, submitting through the very same
# function POST /api/video/create runs, so each job then lands in the registry and
# the reconciler finishes it exactly as before.

QUEUE_INTERVAL = int(os.getenv("TAKEONE_QUEUE_INTERVAL", "5"))
# At most two in-flight submissions. The point is to never starve an interactive
# render: the Seedance semaphore allows 10 concurrent non-4k submits, so leaving 8
# free means a user hitting "render this shot" while a 40-shot episode drains is
# not queued behind the batch.
QUEUE_MAX_INFLIGHT = int(os.getenv("TAKEONE_QUEUE_CONCURRENCY", "2"))

# How many times a queue write is retried before the outcome is treated as unwritable.
# LockTimeout means a peer process is wedged holding the queue lock, and a peer that is
# wedged now is often not wedged 250 ms later. Worth waiting for, because the write this
# protects carries a task_id BytePlus has already accepted.
QUEUE_MARK_RETRIES = 3
QUEUE_MARK_RETRY_SECS = 0.25


async def _queue_mark(entry_id: str, status: str, claim_token: str = "",
                      **fields: Any) -> bool | None:
    """render_queue.mark(), off the event loop, retried, and NEVER raising.

    Off the loop because mark() takes the queue's threading.Lock and then waits out the
    cross-process flock with a blocking time.sleep (file_lock.hold). Called straight from
    a coroutine it stalled the entire server for as long as any peer held the lock —
    measured 2.81 s of dead event loop against a 3 s hold, and LOCK_TIMEOUT_SECS allows
    15. Note this ALSO applies to a mark() that is not contended at all: it waits on
    render_queue._lock, which another thread holds across its own file-lock wait.

    Never raising because the caller is _queue_submit_one, which is documented "Never
    raises" and whose most important call carries an ALREADY-ACCEPTED task_id. A
    LockTimeout escaping there killed the coroutine and discarded that id (reproduced:
    the entry stayed 'submitted' with an empty task_id and nothing anywhere named the
    paid task). Returns mark()'s own bool, or None when the write never happened at
    all — the two mean opposite things and the caller must be able to tell them apart.
    """
    for attempt in range(QUEUE_MARK_RETRIES):
        try:
            return await asyncio.to_thread(
                render_queue.mark, entry_id, status, claim_token, **fields)
        except Exception as e:
            if attempt + 1 >= QUEUE_MARK_RETRIES:
                logger.error("[RenderQueue] %s: could not write status=%s after %d "
                             "attempts (%s); fields=%s", entry_id, status,
                             QUEUE_MARK_RETRIES, e, fields)
                return None
            await asyncio.sleep(QUEUE_MARK_RETRY_SECS)
    return None


async def _queue_submit_one(entry: dict) -> None:
    """Submit ONE claimed queue entry. Never raises — a bad job marks itself failed
    and the loop moves on, because one malformed payload must not stop the other 39
    shots of an episode from rendering.

    Everything here runs INSIDE the queue's claim window, so the finally is not
    optional: claim_next() put this entry in render_queue's held set precisely so a
    recovery sweep cannot re-queue it (and pay for the shot twice) while this coroutine
    is still working, and only release() takes it back out. Every mark() carries the
    claim's token so a claim that was superseded anyway cannot overwrite the entry.

    Every queue call goes through _queue_mark()/to_thread. Both halves of that matter:
    the lock waits on the calling thread (it froze the whole server), and it can RAISE,
    which broke the "never raises" promise above on the one line that was holding a paid
    task_id."""
    eid = entry.get("entry_id", "")
    tok = entry.get("claim_token", "")
    try:
        try:
            req = VideoTaskRequest(**(entry.get("job") or {}))
        except Exception as e:
            await _queue_mark(eid, "failed", tok, error=f"invalid job payload: {e}"[:500])
            logger.warning("[RenderQueue] %s: unusable payload: %s", eid, e)
            return
        try:
            result = await _create_video_impl(req)
        except HTTPException as e:
            detail = e.detail if isinstance(e.detail, str) else json.dumps(e.detail)
            await _queue_mark(eid, "failed", tok, error=detail[:500])
            logger.warning("[RenderQueue] %s (%s) failed: %s", eid, req.shot_id, detail)
            return
        except Exception as e:
            await _queue_mark(eid, "failed", tok, error=str(e)[:500])
            logger.warning("[RenderQueue] %s (%s) failed: %s", eid, req.shot_id, e)
            return
        tid = result.get("task_id") or ""
        if tid:
            # Already recorded in the registry by _create_video_impl — from here the
            # reconciler owns the download/save. The queue only tracks the outcome.
            wrote = await _queue_mark(eid, "submitted", tok, task_id=tid)
            if wrote:
                logger.info("[RenderQueue] submitted %s (%s) → task %s", eid, req.shot_id, tid)
            elif wrote is None:
                # The queue file could not be written AT ALL — a peer wedged on the lock
                # past LOCK_TIMEOUT_SECS, three times over. The shot is submitted and IS
                # billed, so the id must not die with this coroutine. Re-assert it in the
                # REGISTRY: a different file behind a different lock, and record_durable()
                # falls back to an append-only ledger when even that is unwritable. That
                # is also what makes the entry recoverable — it stays stranded, and
                # recovery ADOPTS this task rather than paying for the shot again
                # (_recovery_evidence matches project+shot inside the claim window).
                rec = render_registry.Durable("nowhere", "", "dispatch failed")
                try:
                    rec = await asyncio.to_thread(
                        render_registry.record_durable, tid,
                        status="running", project_name=req.project_name,
                        project_path=req.project_path, shot_id=req.shot_id,
                        resolution=result.get("resolution") or req.resolution,
                        model=result.get("model") or "",
                        queue_entry_id=eid)
                except Exception as e:
                    # record_durable() does not raise; only the dispatch can. Still
                    # guarded, because THIS coroutine promises not to raise and the log
                    # line below is the last thing naming a task that is being billed.
                    logger.error("[RenderQueue] %s: could not re-assert task %s in the "
                                 "registry either (%s)", eid, tid, e)
                if rec.nowhere:
                    # Neither the queue NOR the registry NOR the ledger holds this id.
                    # Nothing will ever poll it, so recovery cannot adopt it either —
                    # this is the one case the operator has to act on by hand, and the
                    # log line below used to claim the opposite ("is recorded in the
                    # render registry") at exactly this moment.
                    await bus.publish(
                        "seedance", "error",
                        f"{req.shot_id}: render {tid} was accepted and IS BILLING but "
                        f"could NOT be recorded anywhere ({rec.error}) — neither the "
                        f"queue, the registry nor the orphan ledger. Nothing will finish "
                        f"or save it. Reconcile task {tid} by hand.")
                    logger.error(
                        "[RenderQueue] %s (%s): task %s WAS submitted and IS BILLED and "
                        "is recorded NOWHERE — queue unwritable, registry unwritable "
                        "(%s), orphan ledger unwritable. No sweep can find it; reconcile "
                        "by hand.", eid, req.shot_id, tid, rec.error)
                else:
                    logger.error(
                        "[RenderQueue] %s (%s): task %s WAS submitted and IS BILLED but the "
                        "queue file could not be written. The task is recorded in %s, the "
                        "entry stays stranded, and recovery will ADOPT it instead of "
                        "re-submitting. Do NOT re-queue this shot.",
                        eid, req.shot_id, tid, rec.path or "the render registry")
            else:
                # Rejected: this claim was superseded, so the shot was submitted TWICE
                # and BytePlus is billing both. The queue keeps the live claim's task and
                # files ours under `superseded`; say so loudly, because a duplicate 4k
                # render is real money and nothing else in the stack will flag it.
                logger.error(
                    "[RenderQueue] %s (%s): claim superseded while submitting — task %s "
                    "was submitted anyway and IS BILLED, but another claim owns the entry. "
                    "Both task_ids are in the render registry; this one is recorded under "
                    "the entry's `superseded` list.", eid, req.shot_id, tid)
        else:
            # No task_id came back. THREE very different things arrive here and this used
            # to file all of them as "no task_id returned (dry_run jobs cannot be queued)":
            #   * an actual dry run — the only case that copy describes;
            #   * a submit BytePlus refused (4xx), or one that never left this machine
            #     (DNS/TLS/connect) — nothing was created either way;
            #   * a submit that DID leave and got no verdict. That one may be RENDERING
            #     AND BILLING right now. It is the exact case render_registry's
            #     submit-intent marker exists for, and until now NOTHING on this path read
            #     it: the marker's only reader (_recovery_evidence, via
            #     render_registry.submit_intents) is driven by _recoverable(), i.e.
            #     entries stranded at 'submitted' with an empty task_id — and this entry
            #     is about to become 'failed', which is not stranded. Measured: status
            #     'failed', charge_risk '', charges_at_risk 0, stranded_candidates []
            #     and the marker sitting in render_registry.json read by nothing, while
            #     the operator was told a possibly-billing 4k submit had failed because
            #     "dry_run jobs cannot be queued". This branch is that missing reader.
            err = str(result.get("error") or "")
            mid = str(result.get("submit_intent") or "")
            phase = str(result.get("submit_phase") or "")
            if result.get("dry_run"):
                await _queue_mark(eid, "failed", tok,
                                  error="no task_id returned (dry_run jobs cannot be queued)")
            elif phase == PHASE_POSTFLIGHT and not result.get("decided"):
                # The resolution the money would be spent AT, not the one asked for — a
                # preview tier renders 480p in a 4k project, and the operator is about to
                # decide whether to go looking for a charge.
                billed_res = BytePlusGenerativeAPI.TIER_RESOLUTIONS.get(
                    req.tier or "", req.resolution)
                note = (
                    f"A {billed_res} submit for {req.shot_id} REACHED BytePlus and never "
                    f"came back with a task id ({err[:200] or 'no error text'}), so a render "
                    f"for this shot may be running and BILLABLE right now. This server never "
                    f"saw an id, so nothing can adopt or poll it. Before re-queueing, list "
                    f"the account's recent tasks (GET /api/video/tasks, or the ModelArk "
                    f"console task list) and look for one created around "
                    f"{entry.get('claimed_at') or 'the time this shot was claimed'}; if one "
                    f"is this shot, let it finish and save its video instead of paying for "
                    f"the shot twice.")
                wrote = await _queue_mark(
                    eid, "failed", tok, charge_risk="likely", charge_note=note,
                    # `error` is capped at 500 and is what the UI shows inline; the
                    # actionable half lives in charge_note, which is not capped.
                    error=(f"submitted, but BytePlus never returned a task id "
                           f"({err[:200]}) — this shot MAY be rendering and billing right "
                           f"now. Check the recent task list before re-queueing.")[:500])
                logger.error("[RenderQueue] %s (%s): submit got no verdict — POSSIBLE "
                             "CHARGE, entry flagged charge_risk=likely. %s", eid,
                             req.shot_id, err[:200])
                if mid and wrote:
                    # The warning now lives on the entry, which is durable, so the marker
                    # is CONSUMED — render_registry.resolve_submit_intent's documented
                    # contract: whoever reports a marker owns it, or every recovery sweep
                    # re-raises the same warning for a shot that already carries it.
                    # Only on a real write: a superseded claim (False) or an unwritable
                    # queue (None) means the warning did NOT land, and the marker is then
                    # the only evidence left.
                    await _resolve_intent_quietly(mid)
                elif mid:
                    logger.error("[RenderQueue] %s: could not write the charge warning to "
                                 "the queue — submit-intent marker %s is KEPT so recovery "
                                 "can still report it", eid, mid)
            elif phase == PHASE_PREFLIGHT:
                # Deliberately does NOT touch charge_risk. It says nothing about a charge
                # because THIS attempt cannot have caused one — but an earlier attempt on
                # the same entry may have, and that risk rides the entry (it survives a
                # re-queue on purpose, see render_queue.recover_stalled); overwriting it
                # here would retract a warning that is still true.
                await _queue_mark(eid, "failed", tok,
                                  error=(f"could not reach BytePlus — the request never left "
                                         f"this machine ({err[:250]}). This attempt submitted "
                                         f"nothing and cost nothing; re-queue the shot once the "
                                         f"connection works.")[:500])
            else:
                # A refusal with an HTTP status (nothing created), or a failure before the
                # POST. Neither can be billed, but say what happened rather than assert a
                # negative this branch cannot always prove.
                await _queue_mark(eid, "failed", tok,
                                  error=(f"no task id returned: "
                                         f"{err[:400] or 'no error text'}")[:500])
    finally:
        # Off the loop like every other queue call: release() takes render_queue._lock,
        # which another thread holds across its own file-lock wait, so a plain call here
        # could stall the loop for LOCK_TIMEOUT_SECS even though release() itself touches
        # no file. Swallowing the failure is part of "never raises" — and an entry left
        # in _held is immune to recovery for the life of the process, which is the
        # permanent leak recovery exists to close, so it is reported.
        try:
            await asyncio.to_thread(render_queue.release, eid)
        except Exception as e:
            logger.error("[RenderQueue] %s: release failed (%s) — this entry stays HELD "
                         "and cannot be recovered until the server restarts", eid, e)


def _queue_sync_terminal() -> None:
    """Promote submitted entries to their final state by reading the RENDER REGISTRY,
    not BytePlus — the reconciler is already polling those tasks, and a second poller
    would double the upstream request rate for nothing.

    BLOCKING, and deliberately left sync: it is four lock-taking calls in a loop, so the
    caller runs the WHOLE function in a worker thread (asyncio.to_thread) rather than
    bouncing off the loop four times per entry."""
    for e in render_queue.in_flight():
        reg = render_registry.get(e.get("task_id", "")) or {}
        st = reg.get("status")
        if st == "completed":
            render_queue.mark(e["entry_id"], "done")
        elif st == "failed":
            render_queue.mark(e["entry_id"], "failed",
                              error=str(reg.get("error") or "render failed")[:500])


# How far OUTSIDE the claim window a registry task may sit and still be believed to be
# that claim's render. A task created before the claim existed cannot be its; the lead is
# only slack for clock skew between the two stamps (both are written by this process, so
# it is small on purpose — a wide window is how an adoption picks up the user's own
# interactive re-render of the same shot).
ADOPT_WINDOW_LEAD_SECS = 120


def _parse_ts(value: Any) -> "_dt.datetime | None":
    """ISO-8601 (registry/queue stamps) or unix seconds (BytePlus task listing) → an
    aware UTC datetime; None when it is neither. Everything that decides whether a task
    falls INSIDE a claim window goes through here, and an unparseable stamp must always
    read as "not inside" — a wrong adoption saves another shot's video over this one."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            return _dt.datetime.fromtimestamp(float(value), _dt.timezone.utc)
        parsed = _dt.datetime.fromisoformat(str(value))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=_dt.timezone.utc)
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _recent_task_ids() -> list[tuple[str, "_dt.datetime | None"]]:
    """The account's recent Seedance tasks — P3.14's list endpoint, the same one
    /api/video/tasks exposes for "reconcile shots orphaned by a closed browser".

    Used ONLY to name candidate ids in a warning. The listing carries no project and no
    shot, so a task id from it can never be bound to an entry; the operator is the one
    who opens it and decides. Its response shape is not in the bundled BytePlus reference
    either, so this parses defensively and a response it cannot read yields nothing at
    all — which costs a hint, never a wrong answer."""
    api = _byteplus_quiet()
    if not api:
        return []
    try:
        raw = api.list_video_tasks(None, 50) or {}
    except Exception as e:
        logger.warning("[RenderQueue] recent-task listing unavailable: %s", e)
        return []
    items = raw.get("items") or raw.get("data") or raw.get("tasks") or []
    out: list[tuple[str, _dt.datetime | None]] = []
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict):
                continue
            tid = str(it.get("id") or it.get("task_id") or "")
            if tid:
                out.append((tid, _parse_ts(it.get("created_at") or it.get("created_time"))))
    return out


def _recovery_evidence(cands: list[dict], bound: set[str]) -> tuple[dict, dict]:
    """For every entry recovery is about to act on, answer the only question that costs
    money: is there ALREADY a task for this shot?

    Runs in a worker thread (see _queue_recover_stalled) because it reads the registry and
    may call BytePlus, and the queue lock must not be held across either.

    Adoption is deliberately conservative — binding the WRONG task to a shot is worse than
    paying twice, because the reconciler would then save that task's video as this shot:
      * the registry keys every render by project_path/project_name + shot_id (see
        render_registry.record() in _create_video_impl), so the match is exact;
      * `kind` must be absent — /api/shot/edit and /api/shot/extend record under the same
        shot_id but are different renders;
      * the task must have been created INSIDE this claim's window, which requires a
        parseable claimed_at; without one nothing is adopted;
      * a task another queue entry already owns is never taken (`bound`), or two entries
        would track one render;
      * a failed task is not adopted — that would park the shot at 'submitted' forever.

    When nothing can be adopted the evidence becomes HONEST COPY instead. An unresolved
    submit-intent marker (render_registry.INTENT_STATUS) for this project+shot inside the
    window is positive evidence that a POST went out and never got a verdict → risk
    "likely", and the recent-task listing is consulted once to name the ids to check.

    Returns (evidence, spent): evidence keyed by entry_id for recover_stalled(), and the
    marker ids each entry's answer was built from, so the caller can consume them."""
    evidence: dict[str, dict[str, Any]] = {}
    spent: dict[str, list[str]] = {}
    taken = set(bound)
    listing: list[tuple[str, _dt.datetime | None]] | None = None
    for c in cands:
        eid = str(c.get("entry_id") or "")
        shot = str(c.get("shot_id") or "")
        ppath = str(c.get("project_path") or "")
        pname = str(c.get("project_name") or "")
        claimed = _parse_ts(c.get("claimed_at"))
        if not eid or not shot or not claimed:
            continue
        lo = claimed - _dt.timedelta(seconds=ADOPT_WINDOW_LEAD_SECS)
        hi = claimed + _dt.timedelta(seconds=render_queue.STALE_CLAIM_SECS + ADOPT_WINDOW_LEAD_SECS)

        def _same_project(row: dict) -> bool:
            # for_project()/submit_intents() fall back to the NAME when the path misses,
            # so two projects sharing a name can both come back. Re-check strictly.
            if ppath:
                return str(row.get("project_path") or "") == ppath
            return bool(pname) and str(row.get("project_name") or "") == pname

        matches: list[dict] = []
        try:
            for t in render_registry.for_project(ppath, pname):
                if not _same_project(t) or str(t.get("shot_id") or "") != shot:
                    continue
                if t.get("kind"):
                    continue
                tid = str(t.get("task_id") or "")
                created = _parse_ts(t.get("created_at"))
                if not tid or tid in taken or str(t.get("status") or "") == "failed":
                    continue
                if created is None or not (lo <= created <= hi):
                    continue
                matches.append(t)
        except Exception as e:
            logger.warning("[RenderQueue] registry lookup failed for %s: %s", eid, e)

        markers: list[dict] = []
        try:
            for m in render_registry.submit_intents(ppath, pname):
                if not _same_project(m) or str(m.get("shot_id") or "") != shot:
                    continue
                mt = _parse_ts(m.get("created_at"))
                if mt is not None and lo <= mt <= hi:
                    markers.append(m)
        except Exception as e:
            logger.warning("[RenderQueue] submit-intent lookup failed for %s: %s", eid, e)
        marker_ids = [str(m.get("marker_id") or "") for m in markers if m.get("marker_id")]

        if matches:
            matches.sort(key=lambda t: _parse_ts(t.get("created_at")) or lo)
            tid = str(matches[-1].get("task_id") or "")
            taken.add(tid)
            evidence[eid] = {
                "adopt_task_id": tid,
                "risk": "adopted",
                "note": (f"Not re-submitted: task {tid} was already accepted for {shot} at "
                         f"{matches[-1].get('created_at')} and has been adopted, so this "
                         "shot is billed once. It finishes through the normal reconciler."),
            }
            spent[eid] = marker_ids     # the ambiguity is resolved — the task IS the answer
            continue

        note = render_queue.CHARGE_NOTE_UNKNOWN.format(claimed_at=c.get("claimed_at"))
        risk = "unknown"
        if markers:
            risk = "likely"
            note = (f"A submit for {shot} WAS handed to BytePlus at "
                    f"{markers[0].get('created_at')} and never came back with a task id, so "
                    "a render may be running and BILLABLE right now. No task for this shot "
                    "is in this server's registry, so it cannot be adopted automatically. ")
            if listing is None:
                listing = _recent_task_ids()
            near = [tid for tid, ts in listing
                    if ts is not None and lo <= ts <= hi and tid not in taken]
            note += (
                ("Tasks created in that window that this server has no record of: "
                 + ", ".join(near[:5]) + ". Open them (GET /api/video/poll/<task_id>) and, "
                 "if one is this shot, let it finish instead of re-queueing.")
                if near else
                "Check the ModelArk console task list for that window before re-queueing.")
        evidence[eid] = {"adopt_task_id": "", "risk": risk, "note": note}
        spent[eid] = marker_ids
    return evidence, spent


async def _queue_recover_stalled() -> None:
    """Un-strand entries a previous process abandoned mid-submit. claim_next() flips an
    entry to 'submitted' BEFORE the API call, so a process killed in that window (with
    --reload in start.sh, that is every file save) left it at 'submitted' with no
    task_id — a state nothing else could leave, which kept status_for().running true and
    the UI polling forever. Runs at startup AND on every sweep: at startup because the
    entries stranded by the restart that just happened are the common case, on each
    sweep because a crash can also happen while the server is up.

    Safe to run on every sweep only because recover_stalled() skips entries this process
    is still holding (render_queue._held, released in _queue_submit_one's finally). Age
    alone never proved the claimer was dead — a live submit can outlive the grace — and
    acting on it re-submitted, and re-paid for, shots that were already in flight.

    Three phases, and the split is not cosmetic. The queue must be asked what it would
    act on, the evidence gathered OFF the queue lock and off the event loop (it reads the
    registry and may call BytePlus), and only then may the queue act. Doing the lookup
    inside recover_stalled() would hold the whole-file lock across a network round trip
    while every status poll and claim waited behind it.

    Both queue calls are dispatched to a thread for the same reason the evidence lookup
    always was: they WAIT on the cross-process lock with time.sleep, so on the loop they
    stalled every request for as long as a peer held it."""
    cands, bound = await asyncio.to_thread(render_queue.stranded_candidates)
    evidence: dict[str, dict[str, Any]] = {}
    spent: dict[str, list[str]] = {}
    if cands:
        try:
            evidence, spent = await asyncio.to_thread(_recovery_evidence, cands, bound)
        except Exception as e:
            # Recovery still has to happen — a failed lookup must not leave the queue
            # stranded — but without evidence it can only re-queue, and it will say the
            # charge is unknown rather than pretend it is not.
            logger.warning("[RenderQueue] adoption lookup failed (recovering blind): %s", e)
    healed = await asyncio.to_thread(render_queue.recover_stalled, evidence)
    if healed["adopted"]:
        logger.warning(
            "[RenderQueue] %d stranded entry(ies) ADOPTED an existing task instead of "
            "being re-submitted — that is a double charge avoided: %s", healed["adopted"],
            ", ".join(f"{eid}→{(evidence.get(eid) or {}).get('adopt_task_id')}"
                      for eid in healed["entry_ids"]
                      if (evidence.get(eid) or {}).get("adopt_task_id")))
    if healed["requeued"] or healed["failed"]:
        logger.warning("[RenderQueue] stalled claims recovered: %d re-queued, %d failed "
                       "(charge status is recorded per entry — see charge_note)",
                       healed["requeued"], healed["failed"])
    # Consume the markers this sweep reported on. They have been written onto the entry
    # (charge_risk/charge_note) and survive there; leaving them would re-raise the same
    # warning every 5 s for the life of the file.
    for eid in healed["entry_ids"]:
        for mid in spent.get(eid, []):
            try:
                await asyncio.to_thread(render_registry.resolve_submit_intent, mid)
            except Exception as e:
                logger.warning("[RenderQueue] could not consume marker %s: %s", mid, e)


# Pids of other live processes on the queue file, as of the last sweep. Kept so the
# warning below fires on CHANGES rather than every 5 seconds forever.
_queue_peers: list[int] = []


def _queue_check_peers() -> None:
    """Heartbeat this process on the queue lockfile and shout if it is not alone.

    The WEB_CONCURRENCY check in lifespan() cannot see a peer — it reads an env var,
    which is blind to `uvicorn --workers N` (the children are forked, nobody sets it)
    and to a second server the operator started on another port. The file lock made a
    real check possible: every drainer already opens the lockfile, so
    render_queue.announce_worker() stamps this pid in it under the lock and hands back
    the pids that are still alive and still heartbeating.

    Two drainers is not a style problem. render_queue._held is in memory, so the other
    process cannot tell an entry THIS one is still submitting from one a dead process
    abandoned; after STALE_CLAIM_SECS it re-queues it and BytePlus bills the shot
    twice. Warn, loudly, with the pid — this is the one thing the operator can act on.

    BLOCKING (announce_worker takes the queue lock), so every caller in a coroutine
    dispatches it with asyncio.to_thread — and this one is the likeliest of all to find
    the lock contended, since it only ever fires when there IS a peer."""
    global _queue_peers
    peers = render_queue.announce_worker()
    if peers == _queue_peers:
        return
    if peers:
        logger.error(
            "[RenderQueue] ANOTHER Take One Studio process is using %s (pid(s) %s). The queue "
            "file itself is safe — it is locked across processes — but the held-claim "
            "set that stops a live submit from being re-queued is per-process, so two "
            "drainers CAN submit (and pay for) the same shot twice. Stop one of them.",
            render_queue.QUEUE_PATH, ", ".join(str(p) for p in peers),
        )
    elif _queue_peers:
        logger.info("[RenderQueue] peer process(es) gone; this process is the only drainer")
    _queue_peers = peers


async def _startup_peer_check() -> None:
    """The startup peer warning, off the boot critical path (see lifespan).

    Never raises: it is diagnostic, and a check that cannot run must neither delay
    serving nor stop the reconciler and the queue worker from starting."""
    try:
        await asyncio.to_thread(_queue_check_peers)
    except Exception as e:
        logger.warning("[Startup] could not check for peer Take One Studio processes: %s", e)


async def _render_queue_loop() -> None:
    inflight: set[asyncio.Task] = set()
    try:
        await asyncio.sleep(6)   # let the server settle, same as the reconciler
        try:
            await _queue_recover_stalled()
        except Exception as e:
            # Same reasoning as the per-sweep guard below: a throw here would end the
            # coroutine before the loop ever starts, stranding the whole queue.
            logger.warning("[RenderQueue] startup recovery failed: %s", e)
        while True:
            try:
                # Every one of these takes the cross-process lock and WAITS on it with
                # time.sleep, so on the loop thread a single wedged peer stalled the whole
                # server for up to file_lock.LOCK_TIMEOUT_SECS — measured 2.81 s of dead
                # event loop (and 2.81 s of dead GET /api/health) for a 3 s peer hold.
                await asyncio.to_thread(_queue_check_peers)
                await _queue_recover_stalled()
                await asyncio.to_thread(_queue_sync_terminal)
                while len(inflight) < QUEUE_MAX_INFLIGHT:
                    entry = await asyncio.to_thread(render_queue.claim_next)
                    if not entry:
                        break
                    try:
                        t = asyncio.create_task(_queue_submit_one(entry))
                    except BaseException:
                        # claim_next() already put the entry in the queue's held set and
                        # ONLY _queue_submit_one's finally gives it back. If the task
                        # never starts, nothing ever would: the entry would sit at
                        # 'submitted' immune to recover_stalled() for the life of the
                        # process — precisely the permanent leak recovery exists to close.
                        # Off the loop like every other queue call (release() waits on
                        # render_queue._lock, which a peer thread holds across its own
                        # file-lock wait), and swallowed so the real failure still wins.
                        try:
                            await asyncio.to_thread(
                                render_queue.release, entry.get("entry_id", ""))
                        except Exception:
                            pass
                        raise
                    inflight.add(t)
                    t.add_done_callback(inflight.discard)
                await asyncio.to_thread(render_queue.prune)
            except Exception as e:
                # A sweep that throws must not kill the worker for the rest of the
                # process's life — that would silently strand every queued shot.
                logger.warning("[RenderQueue] sweep error: %s", e)
            await asyncio.sleep(QUEUE_INTERVAL)
    except asyncio.CancelledError:
        for t in inflight:
            t.cancel()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Take One Studio API server starting")
    logger.info("ffmpeg binary: %s (exists=%s)", FFMPEG_BIN, os.path.isfile(FFMPEG_BIN))
    logger.info("TLS CA bundle: %s", _CA_BUNDLE or "certifi default (no macOS anchors merged)")
    if not os.path.isfile(FFMPEG_BIN):
        logger.warning(
            "ffmpeg not found at '%s'. P9/P10 render will fail. "
            "Install with: arch -arm64 /bin/bash -c '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)' "
            "then: brew install ffmpeg",
            FFMPEG_BIN
        )
    # The registry and the queue files ARE multi-process safe now: both wrap their
    # whole read-modify-write in fcntl.flock on a sidecar (file_lock.py), so a second
    # process can no longer claim an entry this one already took, nor erase this one's
    # write with its own stale snapshot.
    #
    # What is still single-process is the DRAINING: render_queue._held lives in memory,
    # and recover_stalled() uses it as the proof that an old claim is not abandoned. A
    # second worker cannot see it, so after STALE_CLAIM_SECS it would re-queue a shot
    # this process is still submitting — and BytePlus bills both. Plus the reconciler
    # would poll every in-flight task N times.
    #
    # So this check stays, but it does NOT prove anything: WEB_CONCURRENCY is an env
    # var. uvicorn --workers forks children without setting it, and a second server on
    # another port never touches it. It catches one deployment mistake, nothing more —
    # _queue_check_peers() below is the part that actually looks.
    _workers = int(os.getenv("WEB_CONCURRENCY", "1") or "1")
    if _workers > 1:
        logger.error(
            "[Startup] WEB_CONCURRENCY=%d. The render queue's held-claim set is "
            "process-local (render_queue._held), so concurrent workers can re-queue and "
            "double-submit the same paid render even though the files are locked. Run "
            "one worker.", _workers,
        )
        raise RuntimeError(
            f"Refusing to start with {_workers} workers — the render queue's held-claim "
            "set is per-process (see render_queue._held). Use a single worker."
        )
    # The check that can actually see a peer, via the queue lockfile. Non-fatal on
    # purpose: a second Take One Studio is usually the operator's own dev server, and killing
    # this one for it would be worse than the warning. Never fatal for a lock error
    # either — failing to CHECK must not stop the server from starting.
    #
    # In the BACKGROUND, not awaited here. announce_worker() takes the queue lock and
    # WAITS on it (file_lock.LOCK_TIMEOUT_SECS), and startup is the one moment where
    # nothing is serving yet, so the wait is added to every request: measured with a peer
    # process holding the queue lock across boot, the first GET /api/health was answered
    # at 12.08 s against 1.83 s on a clean boot. The alternative — a non-blocking attempt
    # that gives up at once — is worse than useless here, because the lock is contended
    # precisely BECAUSE there is a peer, i.e. it would decline to check in exactly the
    # case it exists to report. So: keep the whole check, move it off the critical path.
    peer_check = asyncio.create_task(_startup_peer_check())
    reconciler = asyncio.create_task(_reconcile_loop())
    logger.info("[Reconcile] render reconciler started (interval=%ds)", RECONCILE_INTERVAL)
    # B3: same single-drainer reasoning as above — the queue FILE is locked across
    # processes, the held-claim set that keeps recovery off a live submit is not.
    queue_worker = asyncio.create_task(_render_queue_loop())
    # AI MediaKit tasks outlive the browser that started them — give every one still
    # running its watcher back (upscale_jobs.py), so a reload or a restart loses nothing.
    upscale_resume = asyncio.create_task(_resume_upscale_jobs())
    logger.info("[RenderQueue] submit worker started (interval=%ds, max_inflight=%d)",
                QUEUE_INTERVAL, QUEUE_MAX_INFLIGHT)
    yield
    peer_check.cancel()
    reconciler.cancel()
    queue_worker.cancel()
    upscale_resume.cancel()
    for _t in list(_UPSCALE_WATCHERS.values()):
        _t.cancel()
    logger.info("Take One Studio API server shutting down")


app = FastAPI(title="Take One Studio API", version="1.0.0", lifespan=lifespan)

# ── Error-log capture (ring buffer defined next to the bus above) ─────────────
from starlette.exceptions import HTTPException as _StarletteHTTPException
from fastapi.exception_handlers import http_exception_handler as _default_http_handler


@app.exception_handler(_StarletteHTTPException)
async def _capture_http_errors(request, exc):
    # Skip route-miss noise for non-API paths; log every raised API error verbatim.
    if request.url.path.startswith("/api"):
        _log_error("http", f"{request.method} {request.url.path} → {exc.status_code}",
                   exc.detail if isinstance(exc.detail, str) else json.dumps(exc.detail))
    return await _default_http_handler(request, exc)


@app.get("/api/errors")
def get_error_log():
    """Last 200 backend errors, newest first (see ERROR_LOG)."""
    return {"errors": list(reversed(ERROR_LOG))}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Per-project usage metering: pull project_path from the POST body (cheap regex,
# no full parse) and set the contextvar so generation code deep in the stack
# attributes tokens/images to the right project. Starlette caches request.body()
# so the endpoint's own parsing still works.
import re as _re
from starlette.requests import Request as _Req
_PROJ_RE = _re.compile(rb'"project_path"\s*:\s*"([^"]*)"')

# Umbral a partir del cual una petición se registra como LENTA, con ruta y duración. El log
# de acceso de uvicorn no lleva tiempos, así que un guardado que tardó dos minutos en
# responder aparecía como un "200 OK" indistinguible de uno de 20 ms — y la única pista
# de que algo iba mal era el aviso del navegador, ya después de rendirse. Con esto, la
# próxima vez el log dice QUÉ petición fue y CUÁNTO tardó.
_SLOW_REQUEST_SECS = float(os.getenv("TAKEONE_SLOW_REQUEST_SECS", "5"))


@app.middleware("http")
async def _usage_project_ctx(request: _Req, call_next):
    proj = ""
    if request.method == "POST":
        try:
            m = _PROJ_RE.search(await request.body())
            if m:
                proj = m.group(1).decode("utf-8", "ignore")
        except Exception:
            proj = ""
    usage.set_project(proj)
    started = _time.monotonic()
    response = await call_next(request)
    elapsed = _time.monotonic() - started
    if elapsed >= _SLOW_REQUEST_SECS:
        logger.warning("[Slow] %s %s took %.1fs (status %s)",
                       request.method, request.url.path, elapsed, response.status_code)
    return response


# ── SSE endpoint ─────────────────────────────────────────────────────────────

@app.get("/api/agents/stream")
async def agents_stream():
    async def event_generator() -> AsyncGenerator[dict, None]:
        q = bus.subscribe()
        try:
            while True:
                try:
                    data = await asyncio.wait_for(q.get(), timeout=30.0)
                    yield {"data": data}
                except asyncio.TimeoutError:
                    yield {"data": json.dumps({"ping": True})}
        except asyncio.CancelledError:
            pass
        finally:
            bus.unsubscribe(q)

    return EventSourceResponse(event_generator())


# ── Pydantic models ───────────────────────────────────────────────────────────

class ScriptRequest(BaseModel):
    concept: str
    project_name: str = ""
    project_path: str = ""
    target_duration_secs: int = 60   # desired final cut length in seconds

class BreakdownRequest(BaseModel):
    script: str
    concept: str = ""          # original user concept — script QC judges against it
    project_name: str = ""
    project_path: str = ""
    target_duration_secs: int = 60
    # Settings' video-model pick, so the planner groups shots into segments the CHOSEN
    # model can actually render in ONE take (15 s on 2.0, 30 s on 2.5). Empty keeps the
    # 2.0 ceiling, i.e. exactly today's plans.
    model_choice: str = ""

class AssetQCRequest(BaseModel):
    asset: dict
    image_url: str | None = None
    style_label: str = "cinematic"
    style_suffix: str = ""
    use_vision: bool = True        # P4: enable vision + drift detection
    # The project's style ANCHOR images (store: style.anchorImageRefs). With them the
    # drift number is an image↔image cosine, which is the only calibrated form of it;
    # without them compute_style_drift falls back to a text↔image cosine that its own
    # docstring calls "uncalibrated as a percentage". Empty = the old behaviour.
    style_anchor_urls: list[str] = []

class BreakdownQCRequest(BaseModel):
    breakdown: dict
    script: str
    # The requested runtime, so the QC can compare Σ durations against it. Optional:
    # a caller that omits it just does not get the Runtime check.
    target_duration_secs: int = 0
    # Skip the subjective LLM pass. Autopilot uses this: everything that blocks an
    # unattended run is arithmetic, so the paid round-trip cannot change the outcome.
    deterministic_only: bool = False
    # Where the bible lives. Without these the story gates cannot be looked up and the
    # response falls back to exactly the checks it carried before — no behaviour change
    # for a caller that does not send them.
    project_name: str = ""
    project_path: str = ""
    # WHICH MODEL THIS FILM IS PLANNED FOR ('' | 'v25' | 'base' | 'fast' | 'mini') — the
    # same field /api/breakdown/generate takes, and it has to be the same value: the
    # generator is handed that model's per-call ceiling (30s on 2.5) and the QC was
    # judging the result against the 2.0 constant, so from 2026-08-07 every 2.5 breakdown
    # failed two BLOCKING checks for takes the renderer accepts and has been rendering.
    # Empty keeps the 2.0 numbers, so an old caller scores exactly what it scored before.
    model_choice: str = ""

class FinalSceneQCRequest(BaseModel):
    shot_id: str
    video_url: str
    shot_description: str
    # P3.17: approved character image (headshot preferred) — enables an objective
    # embedding-based identity-drift score for the rendered clip
    character_ref_url: str = ""

class FinalCutQCRequest(BaseModel):
    sequence: list[str]
    shot_data: list[dict]
    # The rendered file. Without it the Final Director judged "does this look like one
    # film" from a list of ids and durations — it could only guess, and said so in its own
    # summary ("no visual frames were provided for inspection"). Sampling frames from the
    # cut is the whole difference between a review and a formality.
    render_path: str = ""
    target_secs: int = 0
    loudness: dict | None = None
    # Optional project identity, so the Final Director can be shown the ACT STRUCTURE the
    # cut is supposed to deliver. Optional because the only caller does not send it and a
    # required field would 422 it; when it is absent the project is resolved from
    # render_path instead (see _project_root_of_render), which is the same server-side
    # resolution the dialogue path uses so a stale frontend field cannot silently drop it.
    project_name: str = ""
    project_path: str = ""

class ReferenceImage(BaseModel):
    url: str                          # data URI or https URL
    role: str = "reference_image"     # first_frame | last_frame | reference_image
    weight: float = 0.7               # Seedream only: 0.0–1.0 style influence
    path: str = ""                    # optional disk-FOLDER hint (e.g. "Assets/Characters/Loom"):
                                      # the permanent versioned copy, resolved server-side so a
                                      # ref survives an expired ~24h CDN url (never send that url)
    kind: str = ""                    # what this reference IS ("continuity", …), when the caller
                                      # knows and no disk path can say it. _ref_roster used to
                                      # recover that from the wording of the addressing line, so
                                      # rephrasing that sentence silently un-classified the ref and
                                      # the model got the picture with no role text at all — which
                                      # is exactly what happened to the closing-frame reference
                                      # (BLACK MIRROR V3, SHOT_008/SHOT_014). Say it, do not spell it.


class SubjectProfile(BaseModel):
    """One character's ACTING MASTER PROFILE, bound to the picture that shows them.

    The profile is written once at breakdown time (ACTING SKILL §6) and, until now, never
    left stage 2: the render received only the per-beat `performance`. `addr` is the 1-based
    index of this character's reference image in the attachment list, so the prompt can lead
    with the tag the skill's §8.6 requires; 0 means no picture is attached for them.
    """
    name: str
    acting: str = ""
    addr: int = 0


class StyleConfig(BaseModel):
    """Project style config forwarded from the frontend store."""
    label: str = "cinematic"
    prompt_suffix: str = ""
    negative_prompt: str = ""
    anchor_image_refs: list[str] = []


class VideoTaskRequest(BaseModel):
    shot_id: str
    image_url: str
    prompt: str                        # Raw base description (backend rebuilds using formula)
    # Shot metadata for formula-structured Seedance prompt (0.4)
    shot_action: str = ""              # ACTION text from breakdown — what moves
    shot_scene: str = ""               # Scene/location context
    subject_hint: str = ""             # Brief subject reference (e.g. "Jack, a young man")
    camera_angle: str = ""             # e.g. "medium close-up", "tracking shot"
    env_hint: str = ""                 # Environment context hint
    lighting_hint: str = ""            # One motivated lighting line from the breakdown
    # Float, not int: a SEGMENT's length is the sum of its shots, and those are allowed
    # to be fractional (a 1.5 s insert, a 0.8 s reaction — legal because they live inside
    # the segment and never become their own call). Pydantic rejects 12.5 against `int`
    # with a 422 before the request ever reaches Seedance.
    #
    # REQUIRED — no default. `= 5` stood here, so a body that never carried a length bought
    # 5 s of Seedance footage matching nothing on the timeline, and the queue PERSISTED the
    # invented 5 and replayed it (measured against a stub: field omitted → a paid submit
    # with duration=5, on both the endpoint and the queue). Every live caller sends a
    # measured value — the segment's summed shots via toVideoCreateBody — so there is
    # nothing legitimate left to default for. Same contract as /api/shot/edit.
    duration_secs: float               # sum of the segment's shots; must be within [4,15]
    # ── Segment mode ────────────────────────────────────────────────────────────
    # The shots INSIDE this call, in order. When present the prompt is built in the
    # block grammar Seedance is tuned for (Visual Style / bans / Scene Settings / N ×
    # Shot Action), and the model cuts between them itself. Absent → the classic
    # one-shot-per-call assembly, unchanged, so every existing project still renders.
    segment_shots: list[dict] = []
    scene_name: str = ""               # `Scene Settings:` — the location
    time_of_day: str = ""              # `[Time]`
    # The visual state the PREVIOUS segment ended on, restated as content. The model has
    # no memory across calls, so "continue from the last clip" is worthless — measured:
    # without this a shot drifted into a different, brighter location; with it the prior
    # key light survived the cut.
    prev_segment_end: str = ""
    # Style (0.1)
    style: StyleConfig = StyleConfig()
    # Reference media
    reference_images: list[ReferenceImage] = []   # up to 9 (incl. first_frame)
    # ACTING MASTER PROFILES for the characters in this take, in the SAME order their
    # reference images are attached, so `addr` addresses the right picture. Empty on a
    # breakdown written before the acting pass → the prompt is unchanged.
    subjects: list[SubjectProfile] = []
    # Names of assets APPROVED IN THIS SCENE that this take does not attach. Prohibited by
    # name in the prompt so the model cannot walk them in. See assemble_unused_materials.
    unused_assets: list[str] = []
    reference_videos: list[str] = []              # up to 3 video URLs
    # What each of those clips DRIVES, index-aligned with reference_videos: "body", "face",
    # or "" for the whole-clip motion role this field did not exist for. A parallel list
    # rather than a shape change because the render queue replays STORED bodies verbatim,
    # and every one of them carries reference_videos as plain strings; a short or absent
    # list simply leaves those clips on the role they have today.
    reference_video_kinds: list[str] = []
    # Idioma del diálogo, declarado por el breakdown. Vacío = el prompt no lo menciona.
    dialogue_language: str = ""
    audio_url: str | None = None                  # soundtrack override
    generate_audio: bool = True                   # False = retry path for audio content-filter false positives
    # Output spec (documented Seedance params)
    ratio: str = "16:9"                           # project aspect ratio
    resolution: str = "720p"                      # 480p|720p|1080p|4k — the project's output size
    # Render tier. 'preview' (480p) and 'edit' (720p) pin their own resolution and
    # IGNORE the field above — that is what makes them cheap; 'master' honours it.
    # Empty = legacy behaviour (render exactly `resolution`), so an older client
    # that never sends this keeps its current wire contract byte for byte.
    tier: str = ""                                # ''|'preview'|'edit'|'master'
    # Settings' "Video model" pick. '' keeps the previous behaviour exactly (base 2.0),
    # so an older client that never sends it renders identically to before.
    model_choice: str = ""                        # ''|'v25'|'base'|'fast'|'mini'
    # "Match the previous cut" opens on the PREVIOUS shot's closing frame, and that
    # seam is only invisible if the frame is byte-exact. Such a shot must never be
    # rerouted through reference mode (which only APPROXIMATES the first frame),
    # whatever the model or the dialogue say.
    exact_first_frame: bool = False
    seed: int | None = None                       # NO-OP on Seedance 2.0 (ignored); fwd-compat/metadata only
    # P3.13: dialogue lines — rendered with the documented {} syntax so the
    # characters actually speak (lip-synced by Seedance 2.0)
    dialogue: list[dict] = []                     # [{character, text, emotion?}]
    # The breakdown's per-shot dialogue_scene — ONE Seed Audio prompt for the whole shot,
    # so the characters can speak OVER each other instead of taking turns. Empty ('' — the
    # only thing an older client sends) keeps the per-line concat, byte for byte.
    dialogue_scene: str = ""
    # Production Video Direction template (Claude-assembled). 'storyboard' mode
    # writes sections 1-6 (source lock → final beat); 'keyframe' mode writes
    # sections 3-6 (the keyframe is the source). Falls back to the classic
    # formula assembler when disabled or beats are missing.
    use_direction: bool = False
    direction_mode: str = "keyframe"              # 'storyboard' | 'keyframe'
    beats: list[dict] = []                        # annotated beats from the shot's board
    char_name: str = ""
    char_signature: str = ""                      # one-line visual signature
    ref_addressing: list[str] = []                # e.g. ["@Image 1 = the storyboard", ...]
    # Item 7b: Claude sees the ACTUAL reference pixels before writing the prompt
    use_vision_prompt: bool = True
    director_notes: str = ""                      # per-shot notes — must be honored
    # Prompt transparency (item 7c): dry_run assembles the full direction prompt
    # (incl. the Claude vision step) and returns WITHOUT creating a video task;
    # prompt_override is what the user approved/edited — sent verbatim, skipping
    # the Claude rewrite entirely so what-you-saw-is-what-runs.
    dry_run: bool = False
    prompt_override: str = ""
    negative_override: str | None = None
    # B2: project identity so the backend can save the render autonomously if the
    # tab closes (the render registry records task → project/shot at create time).
    project_name: str = ""
    project_path: str = ""


class KeyframeCharacter(BaseModel):
    name: str
    description: str = ""
    headshot_url: str = ""    # approved headshot — vision-grounds the cached face block


class ShotKeyframeRequest(BaseModel):
    """Generate a Seedream still of a shot composition before animating (0.5)."""
    shot_id: str
    shot_description: str             # visual_description of the shot
    shot_action: str = ""
    subject_hint: str = ""
    env_hint: str = ""
    lighting_hint: str = ""              # motivated lighting line — stills need it too
    approved_asset_urls: list[str] = []  # identity/environment reference images
    # P2.10: human-readable descriptor per ref (parallel to approved_asset_urls),
    # e.g. ["Detective Vael's face", "Detective Vael full body", "the precinct hall"].
    # The prompt addresses refs explicitly — "the detective from image 1…" — per
    # the documented multi-image blending form (ModelArk/1824121).
    ref_descriptors: list[str] = []
    # F1 (seedance-identity-filter): for PHOTOGRAPHIC styles the frontend drops the
    # character face refs (they break Seedream's watermark → Seedance rejects the
    # i2v as a "real person") and sends the characters here instead. The backend
    # injects a cached distinctive-fictional facial-feature block per character so
    # the keyframe is a pure-t2i face that passes Seedance, consistent across shots.
    characters: list[KeyframeCharacter] = []
    style: StyleConfig = StyleConfig()
    aspect_ratio: str = "16:9"           # 16:9 | 9:16 | 1:1 → exact-pixel Seedream size
    # Persist the keyframe to disk so first_frame never depends on an expiring CDN URL
    project_name: str = ""
    project_path: str = ""
    # Prompt transparency: dry_run returns the assembled prompt + planned refs
    # WITHOUT generating; overrides are sent verbatim instead of the assembly.
    dry_run: bool = False
    prompt_override: str = ""
    negative_override: str | None = None
    # Best-of-N: generate `best_of` candidates, score each against reference_url (the
    # character's approved image) with the consistency harness, keep the most on-model.
    best_of: int = 1
    reference_url: str = ""
    # The shot's storyboard board. For PHOTOGRAPHIC styles it is NEVER attached as an
    # image ref (that breaks the trust chain) — instead Claude vision reads its FIRST
    # panel and the composition rides the prompt as text, so the keyframe reproduces
    # the panel while staying pure t2i (trusted).
    board_url: str = ""
    board_rows: int = 0
    board_cols: int = 0


# Recommended 2K pixel dims per aspect ratio (Seedream docs, ModelArk/1824121).
# Matching the keyframe pixels to the video ratio prevents Seedance center-crops.
KEYFRAME_SIZE_BY_AR = {
    "16:9": "2848x1600",
    "9:16": "1600x2848",
    "1:1": "2048x2048",
}


class AssetGenerateRequest(BaseModel):
    asset_id: str
    asset_name: str = ""                          # identity-board ID block needs the name
    description: str
    asset_type: str = "prop"
    count: int = 4
    project_name: str = ""
    project_path: str = ""                         # localFolderRoot — for usage metering
    reference_images: list[ReferenceImage] = []   # up to 4 for Seedream
    negative_prompt: str | None = None            # P1: style negative prompt
    # Style config (0.1)
    style: StyleConfig = StyleConfig()
    raw_description: str = ""                     # Original unmodified description for doctor
    # User-reviewed final Seedream prompt. When set, it is sent VERBATIM:
    # characters skip the Claude board-prompt build, others skip assembly.
    final_prompt: str = ""
    # Director notes behind a regeneration. For characters, their presence means the
    # identity may be CHANGING (e.g. ethnicity) → the cached face block + face anchor
    # are invalidated so downstream (storyboard/keyframes/shots) re-derives from the
    # NEW approved look instead of resurrecting the old face.
    regen_notes: str = ""


class PromptReviseRequest(BaseModel):
    """Rewrite an existing prompt applying director notes everywhere they matter
    (the append-a-note approach loses to the prompt's own detailed FACE LOCK)."""
    prompt: str
    notes: str


@app.post("/api/prompt/revise")
async def revise_prompt(req: PromptReviseRequest):
    if not (req.prompt.strip() and req.notes.strip()):
        raise HTTPException(status_code=400, detail="Need both a prompt and notes")
    claude = get_claude()
    try:
        revised = await asyncio.to_thread(claude.revise_prompt, req.prompt, req.notes)
        return {"revised": revised}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Prompt revision failed: {e}")


class DoctorPromptRequest(BaseModel):
    """Run the Claude prompt doctor on a raw description (0.2)."""
    raw_description: str
    asset_type: str = "general"
    style_label: str = "cinematic"
    style_suffix: str = ""


# ── Stage 1: Script ───────────────────────────────────────────────────────────

@app.post("/api/script/generate")
async def generate_script(req: ScriptRequest, bg: BackgroundTasks):
    # 1b: ONE-SHOT contract — a single Claude call returns the full script; there is
    # no session/turn state. The optional "Develop idea" phase (1c, /api/script/expand)
    # sits BESIDE this, folding its output into the concept before calling here — so
    # this fast path stays byte-for-byte identical whether or not Develop was used.
    claude = get_agents()
    # THE APPROVED SPINE, if there is one. generate_script has taken a `spine=` argument
    # since the per-sequence writer landed, and nothing ever passed it — so the writer
    # that exists to hold a film to its structure could not fire from the product, and
    # every script was still the one call whose entire structural instruction is
    # "setup → single complication → resolution. No padding."
    #
    # APPROVED, not merely present, and that is the whole guard for backward
    # compatibility. Every bible on disk today was DERIVED from a finished script and
    # none carries spine_approved, so re-generating an existing project's script still
    # takes the single-call path it takes today — writing it from a post-mortem of the
    # script it is replacing would be a silent rewrite nobody asked for. A spine only
    # steers the pen after the user has looked at it and voted.
    spine: dict = {}
    if req.project_name or req.project_path:
        stored = await asyncio.to_thread(
            _read_bible_quietly, req.project_name, req.project_path)
        if stored.get("spine_approved") and stored.get("sequences"):
            spine = stored
    await bus.publish("story", "active",
                      f"Writing the script to the approved spine "
                      f"({len(spine['sequences'])} sequences)…" if spine else
                      "Generating script with Claude…", 10)
    try:
        script = await asyncio.to_thread(claude.generate_script, req.concept,
                                         req.target_duration_secs, spine or None)
        logger.info("[Script] %s → %d word(s) (project=%s)",
                    f"written from an approved spine of {len(spine['sequences'])} sequence(s)"
                    if spine else "single-call (no approved spine)",
                    len(script.split()), req.project_name or req.project_path or "—")
        await bus.publish("story", "completed", "Script generated", 100)
        # 1.2: save to disk if project is initialised
        if req.project_name or req.project_path:
            try:
                await asyncio.to_thread(
                    proj_storage.save_script,
                    req.project_name, script, req.concept, req.project_path,
                )
            except Exception as se:
                logger.warning("[P5] save_script failed (non-fatal): %s", se)
        return {"content": script, "concept": req.concept}
    except Exception as e:
        await bus.publish("story", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


class ScriptExpandRequest(BaseModel):
    """Item 1c — interactive "Develop idea": expand a concept + draft selection
    questions. Claude-routed (ClaudeQCAgents._llm), NOT the Seed QC path."""
    concept: str
    target_duration_secs: int = 60   # scales premise/question ambition


@app.post("/api/script/expand")
async def expand_concept(req: ScriptExpandRequest):
    # Item 1c: routes through Claude (_llm), NOT the seed QC path — the develop step
    # is a writing/brain task. Optional side-path; the one-shot Generate is unchanged.
    claude = get_claude()
    if not req.concept.strip():
        raise HTTPException(status_code=400, detail="concept required")
    await bus.publish("story", "active", "Developing your idea with Claude…", 10)
    try:
        out = await asyncio.to_thread(claude.expand_concept, req.concept, req.target_duration_secs)
        await bus.publish("story", "completed", "Idea developed", 100)
        return out   # {expanded_concept, questions:[{id,question,options[]}]}
    except Exception as e:
        await bus.publish("story", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


class ScriptSaveRequest(BaseModel):
    """Persist a loaded or hand-edited script to Script/ on disk (items 1+2)."""
    script: str
    concept: str = ""
    project_name: str = ""
    project_path: str = ""


@app.post("/api/script/save")
async def save_script_endpoint(req: ScriptSaveRequest):
    try:
        result = await asyncio.to_thread(
            proj_storage.save_script, req.project_name, req.script, req.concept, req.project_path,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class ScriptRuntimeRequest(BaseModel):
    """A script to measure. Pure maths — no LLM, no disk, no project."""
    script: str = ""


@app.post("/api/script/runtime")
async def script_runtime(req: ScriptRuntimeRequest):
    """How long a script will run, on the pipeline's SHARED duration maths.

    The frontend estimates runtime as words/130 in three places (script ingestion,
    autopilot, project reconstruction). That is the Courier page-rate rule, which assumes
    action spread over sparse lines; these scripts are dense prose, and measured against
    the breakdowns of every real project on disk it overstates the film by roughly 2×
    (ROBOTECH: 569 s claimed against 294 s of real shots). This endpoint returns what
    phase 1 and phase 2 actually reconcile against, so every stage quotes one number.

    Dialogue is charged at speaking rate (it is performed), action at
    ACTION_WORDS_PER_SEC (it is watched); `words` is the plain word count of the whole
    script, which is larger than dialogue+action words because scene headings and
    transitions are structure and cost no screen time.

    No LLM call and no I/O, so it is safe to call on every keystroke of a paste."""
    try:
        spoken, action_words = await asyncio.to_thread(split_script_speech, req.script or "")
        dialogue_secs = estimate_dialogue_seconds(spoken)
        action_secs = action_words / ACTION_WORDS_PER_SEC
        return {
            "seconds": round(dialogue_secs + action_secs, 2),
            "dialogue_seconds": round(dialogue_secs, 2),
            "action_seconds": round(action_secs, 2),
            "words": len((req.script or "").split()),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/script/qc")
async def qc_script(req: BreakdownRequest):
    claude = get_claude()
    await bus.publish("qc", "active", "Script QC running…", 20)
    try:
        # Judge against the REAL user concept; fall back to the script head only
        # when the frontend didn't supply one (legacy callers)
        result = await asyncio.to_thread(
            claude.qc_script, req.script, req.concept or req.script[:200]
        )
        await bus.publish("qc", "completed", "Script QC complete")
        return result
    except Exception as e:
        await bus.publish("qc", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ── Stage 2: Breakdown ────────────────────────────────────────────────────────

def _spine_planned_seconds(seqs: list[dict], target_secs: int) -> dict:
    """{sequence id: (planned seconds, declared share)} for the sequences that DECLARE a
    seconds_share — the only ones whose runtime the plan actually states.

    A sequence without a share is ABSENT here, never a share of zero and never the
    normalised guess spine_shares() would hand out. spine_shares exists to place a
    sequence in the film; this exists to hold the breakdown to a promise, and a promise
    the plan never made cannot be broken. (The same split the "Runtime share" gate keeps:
    it reads the raw declared numbers so it can fail.)

    `target_secs` of 0 yields 0.0 seconds and the share alone, so a caller that does not
    know the target still says something true.
    """
    out: dict = {}
    for s in seqs:
        share = _seq_share(s)
        if share is None:
            continue
        out[str(s.get("id") or "SEQ")] = (share * max(0, target_secs), share)
    return out


def _bible_as_context(bible: dict, concept: str = "", sequence_ids: list | None = None,
                      target_duration_secs: int = 0) -> str:
    """Render the bible as the premise block every breakdown batch receives.

    Kept short on purpose: it is prepended to EVERY batch prompt, and a batch's own
    scene text is what it is mainly meant to be reading. The characters are the part
    that earns its space — a batch that knows Eli wants to be forgiven and needs to
    admit what he did writes a different `performance` than one reading only
    'Eli sets the mug down'.

    `sequence_ids` SCOPES the spine to the sequences that own this batch's scenes. It is
    not a nicety: _breakdown_batch gives this block 2000 characters, FARO's six-sequence
    spine already renders at 2362, and a propose_spine spine runs to fifteen — so the
    unscoped block loses the film's last act to that truncation, for every batch,
    including the ones writing that act. Scoped, a batch sees the two or three sequences
    its scenes belong to and sees them whole. None (the default) renders every sequence,
    which is what this has always done and what a caller with no runtime map still gets.

    `target_duration_secs` turns seconds_share into SECONDS, which is the number the
    breakdown has never had: today a batch is told "target 184 seconds" for a slice of
    script and nothing tells it that SEQ_7 is worth 18% of the film. It is also the
    promise _footage_share_check later holds it to.
    """
    head: list[str] = []
    if bible.get("logline"):
        head.append(f"LOGLINE: {bible['logline']}")
    if bible.get("tone"):
        head.append(f"TONE: {bible['tone']}")

    people: list[str] = []
    for c in bible.get("characters") or []:
        bits = [str(c.get("name"))]
        for key in ("wants", "needs", "arc"):
            if c.get(key):
                bits.append(f"{key}: {c[key]}")
        people.append("- " + " · ".join(bits))

    # The story spine. This is what a batch needs in order to know what its scenes are
    # FOR: which question they put in the audience's head, what resists the protagonist,
    # and whether they leave better or worse off. Without it a batch can only describe
    # what happens — which is how a runtime full of correct, continuous shots ends up
    # reading as "a bunch of takes one after another".
    seqs = [s for s in (bible.get("sequences") or []) if isinstance(s, dict)]
    planned = _spine_planned_seconds(seqs, target_duration_secs)
    focus = None if sequence_ids is None else {str(x) for x in sequence_ids}
    spine: list[str] = []
    for s in seqs:
        sid = str(s.get("id") or "SEQ")
        if focus is not None and sid not in focus:
            continue
        bits = [sid]
        # The drama layer, and the order matters: a bible written before these fields
        # existed adds NOTHING here, so its line is byte-for-byte what it renders today.
        if sid in planned:
            secs, share = planned[sid]
            bits.append(f"worth {secs:.0f}s ({share:.0%} of the film)" if secs
                        else f"{share:.0%} of the film")
        t = _seq_tension(s)
        if t is not None:
            bits.append(f"tension {t}/10")
        if _seq_mode(s):
            bits.append(_seq_mode(s))
        if s.get("covers"):
            bits.append(str(s["covers"])[:80])
        if s.get("question_opened"):
            bits.append(f"asks: {s['question_opened']}")
        if _has_obstacle(s):
            who = str(s.get("obstacle_owner") or "").strip()
            bits.append(f"resisted by: {s['obstacle']}" + (f" — {who}" if who else ""))
        if s.get("value_in") and s.get("value_out"):
            d = str(s.get("direction") or "").strip().lower()
            # '→' for unchanged. Rendering it as '↓' told every batch the story descends
            # where the bible said nothing moves — and contradicted check_story_spine,
            # which counts 'unchanged' as no movement at all.
            arrow = "↑" if d == "up" else "↓" if d == "down" else "→"
            bits.append(f"{s['value_in']} {arrow} {s['value_out']}")
        ev = _seq_event(s)
        if ev.get("loses"):
            bits.append(f"PAID HERE: {ev.get('who') or 'the protagonist'} loses {ev['loses']}"
                        + (" — permanently" if _as_bool(ev.get("irreversible")) else ""))
        spine.append("- " + " · ".join(bits))

    if not head and not people and not spine:
        return concept
    out = "\n".join(head)
    if people:
        out += ("\n\nCHARACTERS (write their behaviour from this, not from the action "
                "line alone):\n" + "\n".join(people))
    if spine:
        # The tag is what makes a sequence reachable from a shot. Without it the spine is
        # advice a batch may or may not have followed and nobody can measure which — the
        # shot record has carried scene_id since segments landed and never once said which
        # STRETCH of film it belongs to, so "this sequence is worth 18% of the runtime"
        # was unsayable and unauditable. The instruction sits in the HEADER, above the
        # list, because _breakdown_batch truncates this block at 2000 characters and an
        # instruction that can be cut off is not an instruction.
        tag = ('\nEvery shot object you output MUST also carry "sequence_id": exactly one '
               "of the ids listed here, the sequence that shot belongs to.\n")
        header = ("\n\nTHIS STRETCH OF THE FILM — the scenes in this batch belong to the "
                  "sequence(s) below; write them to serve that sequence's question, its "
                  "obstacle and its cost, not just the action line."
                  if focus is not None else
                  "\n\nSTORY SPINE — what each stretch of the film is FOR. Every shot you "
                  "write belongs to one of these; make it serve that sequence's question "
                  "and its obstacle, not just the action line:")
        out += header + tag + "\n".join(spine)
    return out


def _batch_story_context(bible: dict, concept: str, target_secs: int):
    """The per-batch renderer generate_breakdown asks for one batch at a time.

    Returns (secs_before, batch_secs) -> the context block scoped to the sequences whose
    PLANNED stretch of runtime overlaps that batch. The mapping is the only honest one
    available at this point: the batcher slices the script by length and the spine slices
    the film by share, so a batch that covers seconds 300-600 of a 20-minute plan is
    written by whichever sequences the plan puts there.

    Positions come from spine_shares (normalised), NOT from the raw seconds_share this
    module's _spine_planned_seconds reads: a spine whose shares sum to 0.9 still has an
    ORDER, and refusing to place its batches would leave the whole spine out of the
    prompt over an arithmetic slip the "Runtime share" gate already reports.
    """
    seqs = [s for s in (bible.get("sequences") or []) if isinstance(s, dict)]
    bounds: list[tuple[float, float]] = []
    acc = 0.0
    for w in spine_shares(seqs):
        bounds.append((acc, acc + w))
        acc += w

    def render(secs_before: float, batch_secs: float) -> str:
        if not seqs or target_secs <= 0:
            return _bible_as_context(bible, concept)
        lo = secs_before / target_secs
        hi = (secs_before + batch_secs) / target_secs
        ids = [str(s.get("id") or "SEQ") for s, (a, b) in zip(seqs, bounds)
               if b > lo and a < hi]
        # A batch past the end of the plan (the script ran long) still belongs to the
        # film: give it the last sequence rather than a batch prompt with no spine at all.
        return _bible_as_context(bible, concept,
                                 ids or [str(seqs[-1].get("id") or "SEQ")], target_secs)

    return render


def _attach_sequence_ids(breakdown: dict, bible: dict) -> dict:
    """Stamp every shot — and the segment that renders it — with the SEQUENCE it belongs
    to. Returns {"tagged", "shots", "scenes", "filled", "dropped"} for the log.

    The model proposes (it is asked for `sequence_id` in the batch prompt); this decides
    what is legal, exactly the way _group_into_segments treats the model's `segment`
    label. Three rules, in order:

      1. A tag that is not an id in THIS bible is dropped. A batch that invents SEQ_9 for
         a nine-sequence film would otherwise create a phantom stretch that the footage
         accounting then reports against a plan that never mentioned it.
      2. A SCENE belongs to ONE sequence. Batches run concurrently and a scene can span a
         batch boundary, so the tags inside one scene can disagree; the majority wins and
         is written to every shot of that scene. In the 13 produced screenplays a scene
         never straddles two sequences, so this loses nothing real.
      3. A scene NO shot tagged stays untagged. There is a tempting fourth rule — fill it
         from the plan's cumulative runtime — and it is exactly the `or 5.0` mistake:
         placing shots by the plan and then measuring them against the plan is a check
         that cannot fail. Untagged seconds are reported as untagged.

    Legacy breakdowns are untouched: with no `sequences` in the bible there is nothing to
    validate against and the function returns immediately, so a project regenerated today
    carries the same shot keys it carried yesterday.
    """
    seqs = [s for s in (bible.get("sequences") or []) if isinstance(s, dict)]
    valid = {str(s.get("id") or "").strip().lower(): str(s.get("id") or "").strip()
             for s in seqs if str(s.get("id") or "").strip()}
    shots = [sh for sh in (breakdown.get("shots") or []) if isinstance(sh, dict)]
    stat = {"tagged": 0, "shots": len(shots), "scenes": 0, "filled": 0, "dropped": 0}
    if not valid or not shots:
        return stat

    by_scene: dict[str, list[dict]] = {}
    for sh in shots:
        raw = str(sh.get("sequence_id") or sh.get("sequenceId") or "").strip()
        sh.pop("sequenceId", None)              # one spelling on disk, snake_case like the rest
        sid = valid.get(raw.lower(), "")
        if raw and not sid:
            stat["dropped"] += 1
        if sid:
            sh["sequence_id"] = sid
            stat["tagged"] += 1
        else:
            sh.pop("sequence_id", None)
        by_scene.setdefault(str(sh.get("scene_id") or sh.get("scene") or ""), []).append(sh)

    stat["scenes"] = len(by_scene)
    for group in by_scene.values():
        votes: dict[str, int] = {}
        for sh in group:
            if sh.get("sequence_id"):
                votes[sh["sequence_id"]] = votes.get(sh["sequence_id"], 0) + 1
        if not votes:
            continue
        winner = max(votes.items(), key=lambda kv: kv[1])[0]
        for sh in group:
            if sh.get("sequence_id") != winner:
                sh["sequence_id"] = winner
                stat["filled"] += 1

    # The SEGMENT is the unit that is actually rendered and the only scene-level object
    # this payload has (the frontend builds its Scene list from the shots). It already
    # carries scene_id; giving it sequence_id is what lets the footage accounting weigh
    # the PADDED seconds that get paid for rather than the raw shot lengths.
    for seg in (breakdown.get("segments") or []):
        if not isinstance(seg, dict):
            continue
        tags = [sh.get("sequence_id") for sh in (seg.get("shots") or [])
                if isinstance(sh, dict) and sh.get("sequence_id")]
        if tags:
            seg["sequence_id"] = tags[0]
        else:
            seg.pop("sequence_id", None)
    return stat


def _footage_share_check(breakdown: dict, bible: dict, target_secs: int) -> list[dict]:
    """Did the breakdown spend the runtime the spine planned? [] when it cannot be asked.

    The plan says SEQ_7 is 18% of the film. Until sequence_id reached the shot there was
    no way to find out that phase 2 gave it 4% — the "Runtime" gate compares the WHOLE
    breakdown against the WHOLE target, so a third act crushed into 40 seconds and a
    first act bloated to twice its share cancel out perfectly and the film passes.

    Deterministic, no LLM. Measured with estimate_shots_seconds, the same Σ the Runtime
    gate and phase 1's reconciliation use, over the SEGMENTS when there are any (they are
    what gets submitted, padding included) and over the shots otherwise.

    Returns [] — not a failure — when the spine declares no seconds_share, when the
    target is unknown, or when no shot carries a sequence_id. Same contract as the drama
    gates in check_story_spine: a check that cannot see its input reports nothing, so
    every breakdown already on disk keeps exactly the verdict it has today.
    """
    seqs = [s for s in (bible.get("sequences") or []) if isinstance(s, dict)]
    planned = _spine_planned_seconds(seqs, target_secs)
    if not planned or target_secs <= 0:
        return []

    units = [u for u in (breakdown.get("segments") or []) if isinstance(u, dict)] or \
            [u for u in (breakdown.get("shots") or []) if isinstance(u, dict)]
    by_seq: dict[str, list[dict]] = {}
    untagged: list[dict] = []
    for u in units:
        sid = str(u.get("sequence_id") or u.get("sequenceId") or "").strip()
        (by_seq.setdefault(sid, []) if sid else untagged).append(u)
    if not by_seq:
        return []

    # Walked in SPINE order, not in `planned` order, so a sequence that carries footage
    # without declaring a share is still reported. It cannot be judged — there is no
    # promise to compare it against — but leaving it out of the sum would quietly hide
    # the seconds it spent, which is the one thing this check exists to make visible.
    rows: list[str] = []
    over: list[str] = []
    for s in seqs:
        sid = str(s.get("id") or "SEQ")
        if sid not in planned and sid not in by_seq:
            continue
        got = estimate_shots_seconds(by_seq.get(sid) or [])
        if sid not in planned:
            rows.append(f"{sid} {got:.0f}s against no planned share")
            continue
        # want is always > 0 here: _seq_share drops a share of 0 or less, and target_secs
        # is guarded above — so the division below cannot be the one that blows up.
        want, share = planned[sid]
        if abs(got - want) / want > 0.30:
            over.append(sid)
        rows.append(f"{sid} {got:.0f}s against {want:.0f}s planned "
                    f"({share:.0%} of the film, {(got - want) / want * 100:+.0f}%)")
    loose = estimate_shots_seconds(untagged)
    notes = "; ".join(rows[:8]) + (f" (+{len(rows) - 8} more)" if len(rows) > 8 else "") + "."
    if loose:
        notes += f" {loose:.0f}s of footage belongs to no sequence."
    if over:
        notes += (f" {len(over)} of {len(planned)} sequence(s) are more than 30% off the "
                  f"plan ({', '.join(over[:5])}) — the film the breakdown describes is not "
                  "the one that was approved.")
    return [{"label": "Footage share", "passed": not over, "blocking": False,
             "notes": notes}]


# ── The bible, cut down for the phases that make the pixels ──────────────────
# _bible_as_context above had exactly ONE caller (generate_breakdown), and read_bible
# had four, all of them in phases 1-2. Phases 3 (asset sheets), 4 (storyboard beats),
# 5 (render prompts) and 6 (delivery review) never saw the story layer at all — which
# is the root cause this app's own analysis named "no conceptual thread": the shots are
# individually correct and collectively about nothing.
#
# The whole bible does NOT go into every prompt. A render prompt is sent once per
# segment (hundreds per episode) and the model's attention is finite: a page of story
# metadata in a Seedance prompt costs the description of what is actually in frame.
# So each extractor below returns a FEW LINES, scoped to the scene/character at hand,
# and — this is the contract every caller depends on — returns "" for a project with no
# bible, so an unbibled project's prompt is byte-for-byte what it is today.


def _scene_tokens(heading: str) -> set:
    """Significant words of a scene heading, for matching one against another.

    The two sides are written by different passes and never agree literally: the bible
    says "EXT. LIGHTHOUSE — ROCKY SHORE — NIGHT" while the breakdown's shots carry
    "EXT. LIGHTHOUSE SHORE NIGHT" (measured on FARO). Punctuation and em-dashes are
    noise; the words are the signal.
    """
    import re as _re
    return {w for w in _re.split(r"[^A-Za-z0-9]+", (heading or "").upper()) if len(w) > 1}


def _bible_sequence_for(bible: dict, scene_hint: str) -> dict | None:
    """The sequence whose `covers` best matches this scene heading, or None.

    Scored by overlap rather than substring, for the spelling reasons above. The bar is
    deliberately high (half the scene's words, at least two of them): a WRONG sequence
    would push a shot's performance toward the wrong dramatic beat, which is worse than
    the status quo of no story context at all. Ties go to the earliest sequence — a
    location that recurs across the film genuinely is ambiguous from the heading alone.
    """
    want = _scene_tokens(scene_hint)
    if not want:
        return None
    best, best_score = None, 0.0
    for s in bible.get("sequences") or []:
        if not isinstance(s, dict):
            continue
        have = _scene_tokens(str(s.get("covers") or ""))
        hit = want & have
        score = len(hit) / len(want)
        if len(hit) >= 2 and score >= 0.5 and score > best_score:
            best, best_score = s, score
    return best


def _bible_render_note(bible: dict, scene_hint: str) -> str:
    """PHASE 5 — the story layer for the prompt that makes the pixels.

    Tone plus THIS sequence's dramatic intent, as direction a camera can act on. The
    question the sequence opens is deliberately left out: it is the least renderable
    thing in the bible (a video model cannot photograph a question), while the obstacle
    is required by derive_film_bible to be "something a CAMERA CAN SEE" and the value
    shift is the emotional trajectory of the take. Both belong in a shot prompt.

    Rides out through the director's-note channel (see _create_video_impl), which is the
    one input that already reaches all four prompt-assembly branches and is already
    specified to the model as "must be honored".
    """
    # DIRECCIÓN, NO UN FORMULARIO RELLENADO. Esto salía como
    #   "Story: Overall tone of the film: …; what resists the character here, and must be
    #    visible: …"
    # es decir, tres capas de etiquetas NUESTRAS —el nombre del bloque, el de la sección y
    # el de cada campo— alrededor del texto que de verdad dirige. El principio 6 del
    # contrato pide "submit-ready content only": el prompt no lleva notas de análisis ni
    # nombres de campo internos. El contenido es dirección legítima y se queda; lo que se
    # va es el esquema, de modo que cada trozo salga como una frase que se puede obedecer.
    tone = str(bible.get("tone") or "").strip()
    seq = _bible_sequence_for(bible, scene_hint)
    bits: list[str] = []
    if tone:
        bits.append(f"The tone of the film is {tone.rstrip('.').lower()}")
    if seq:
        if _has_obstacle(seq):
            bits.append(f"{str(seq['obstacle']).rstrip('.')} — that resistance must be "
                        f"visible on screen")
        if seq.get("value_in") and seq.get("value_out"):
            d = str(seq.get("direction") or "").strip().lower()
            if d in ("up", "down"):
                bits.append(f"across this stretch the character goes from "
                            f"'{seq['value_in']}' to '{seq['value_out']}' — play the "
                            f"performance and the light {'lifting' if d == 'up' else 'closing down'}")
            else:
                bits.append(f"nothing moves for the character here — they stay "
                            f"'{seq['value_in']}'; play the stillness, do not manufacture drama")
    if not bits:
        return ""
    return ". ".join(b[0].upper() + b[1:] for b in bits) + "."


def _bible_beat_note(bible: dict, scene_hint: str) -> str:
    """PHASE 4 — what this scene is FOR, so its beats stop being uniform.

    Richer than the render note because the reader is Claude writing beats, not an image
    model: the question the sequence opens is exactly what tells a beat writer where the
    tension should sit inside the scene, and it is the reason four beats of a scene can
    have four different weights instead of four equal ones.
    """
    tone = str(bible.get("tone") or "").strip()
    seq = _bible_sequence_for(bible, scene_hint)
    if not seq and not tone:
        return ""
    lines: list[str] = []
    if tone:
        lines.append(f"TONE: {tone}")
    if seq:
        bits = []
        if seq.get("question_opened"):
            bits.append(f"it asks: {seq['question_opened']}")
        if _has_obstacle(seq):
            bits.append(f"resisted by: {seq['obstacle']}")
        if seq.get("value_in") and seq.get("value_out"):
            bits.append(f"the character enters it '{seq['value_in']}' and leaves it "
                        f"'{seq['value_out']}'")
        if bits:
            lines.append(f"WHAT THIS STRETCH OF THE FILM IS FOR ({seq.get('id') or 'SEQ'}): "
                         + " · ".join(bits)
                         + ". Weight the beats accordingly — the beat where that "
                           "resistance bites is not the same size as the ones around it.")
    return "\n" + "\n".join(lines) if lines else ""


def _bible_character_note(bible: dict, name: str) -> str:
    """PHASE 3 — who this sheet is a picture of.

    A character sheet built from the visual description alone is a costume fitting for
    someone with no story: correct hair, no reason to stand the way they stand. What the
    bible has that the description does not is want / need / arc.

    `wardrobe` is read but NEVER invented: derive_film_bible does not write it today
    (deliberately — this codebase does not add fields nothing consumes), so it only
    appears on a bible a user has hand-edited through PUT /api/bible, whose merge keeps
    any key the client sends. When it is absent the note is simply shorter.
    """
    key = (name or "").split(" · ")[0].strip().lower()
    if not key:
        return ""
    for c in bible.get("characters") or []:
        if not isinstance(c, dict):
            continue
        cn = str(c.get("name") or "").strip().lower()
        if not cn or (cn != key and cn not in key and key not in cn):
            continue
        bits = [f"{k}: {c[k]}" for k in ("wants", "needs", "arc", "wardrobe") if c.get(k)]
        if not bits:
            return ""
        return ("\nSTORY (this is who the figure IS — let it show in posture, gaze, how "
                "worn the wardrobe looks and what they carry. Do NOT write any of these "
                "words into the prompt; they are not visible things):\n- " + "\n- ".join(bits))
    return ""


def _bible_delivery_note(bible: dict) -> str:
    """PHASE 6 — the act structure the finished cut is supposed to deliver.

    The Final Director already measures runtime against target; what it could never see
    is whether the assembled film still has the shape the story was built on. The spine
    is the only thing that can turn "does this look like one film" into a question with
    a right answer.
    """
    seqs = [s for s in (bible.get("sequences") or []) if isinstance(s, dict)]
    if not seqs:
        return ""
    lines = []
    for s in seqs:
        bits = [str(s.get("id") or "SEQ")]
        if s.get("question_opened"):
            bits.append(f"asks: {s['question_opened']}")
        if s.get("value_in") and s.get("value_out"):
            bits.append(f"{s['value_in']} → {s['value_out']}")
        lines.append("- " + " · ".join(bits))
    head = f"TONE: {bible['tone']}\n" if bible.get("tone") else ""
    return ("\n\n" + head + "ACT STRUCTURE this cut is supposed to deliver, in order:\n"
            + "\n".join(lines)
            + "\nSay plainly whether the cut still reads in these stages, or whether it "
              "has flattened into one undifferentiated stretch.")


def _read_script_quietly(project_name: str, project_path: str) -> str:
    """The project's script off disk, or "" — for gates that need it and must not fail
    without it. Storage writes Script/script.txt beside script.json (see save_script), and
    the spine's cast checks read it so a panel that only ever loads a bible can still tell
    the operator the spine is about a different film."""
    try:
        root = proj_storage._resolve_root(project_name, project_path)
        f = root / "Script" / "script.txt"
        return f.read_text(encoding="utf-8") if f.is_file() else ""
    except Exception as e:
        logger.debug("[Spine] script unreadable for the cast gate (non-fatal): %s", e)
        return ""


def _read_bible_quietly(project_name: str, project_path: str) -> dict:
    """The project's bible, or {} — never raising, never blocking a render.

    Same contract generate_breakdown has always used for it: a missing or unreadable
    bible costs richness, it must never take down the phase that asked for it.
    """
    if not (project_name or project_path):
        return {}
    try:
        return proj_storage.read_bible(project_name, project_path)
    except Exception as e:                      # noqa: BLE001 — richness, not correctness
        logger.warning("[Bible] unreadable, continuing without story context: %s", e)
        return {}


def _read_scene_geos_quietly(project_name: str, project_path: str) -> dict:
    """The project's per-scene GEO SPATIAL LAYOUT map, or {} — never raising.

    Same contract as _read_bible_quietly, for the same reason: the geo block is richness
    layered on top of a pipeline that worked without it, and an unreadable file must cost
    the block and nothing else.
    """
    if not (project_name or project_path):
        return {}
    try:
        return proj_storage.read_scene_geos(project_name, project_path)
    except Exception as e:                      # noqa: BLE001 — richness, not correctness
        logger.warning("[Geo] layouts unreadable, continuing without the floor plan: %s", e)
        return {}


def _geo_block_for(geos: dict, shot_id: str, scene_hint: str) -> str:
    """This shot's scene floor plan, matched by SHOT ID first and heading second.

    Phase 5 never receives a scene id — the frontend sends `scene_name`/`shot_scene`, both
    of which are the HEADING (FinalGenView.sceneHeadingOf). The shot id it does send is
    exact and unambiguous, and save_scene_geo records the ids each scene was boarded with,
    so that is the primary key; the heading is the fallback for a shot boarded before this
    existed. Heading matching is EXACT (normalised) rather than the bible's fuzzy overlap:
    a wrong floor plan would put the camera on the wrong side of the wrong room, which is
    worse than no floor plan — the failure this whole block exists to prevent.
    """
    if not geos:
        return ""
    for rec in geos.values():
        if isinstance(rec, dict) and shot_id and shot_id in (rec.get("shot_ids") or []):
            return str(rec.get("geo") or "").strip()
    want = " ".join((scene_hint or "").lower().split())
    if want:
        for rec in geos.values():
            if isinstance(rec, dict) and " ".join(str(rec.get("heading") or "").lower().split()) == want:
                return str(rec.get("geo") or "").strip()
    return ""


def _scene_open_context(project_name: str, project_path: str, scene_id: str) -> tuple[str, str]:
    """(id of the shot that OPENS this scene, tail of the line spoken just before it).

    Both come from the breakdown on disk, which is the only place phase 4 can learn either:
    the storyboard request carries a SUBSET of a scene's shots (the "Regen this one shot"
    button sends exactly one), so req.shots[0] is not the scene's first shot, and the beat
    writer has never received dialogue at all.

    The BOARD unit is the segment, and a segment inherits the id of its first shot, so the
    scene's first segment id IS the scene's first shot id — which is why matching on the
    shots list works even though the caller sends segments.

    The tail is taken from the shot IMMEDIATELY before the scene and nowhere further back:
    "If the shot is an answer to the previous one" (HELL GRIND rule 2). A scene that opens
    on silence, or after a shot with no line, correctly gets "" and its opening wide simply
    holds the arrangement.

    ("", "") on any failure — the caller reads that as "no opening wide", i.e. exactly the
    behaviour that existed before this function.
    """
    if not (project_name or project_path) or not scene_id:
        return ("", "")
    try:
        from pathlib import Path as _Path
        root = _Path(project_path) if project_path else _Path(proj_storage.project_root(project_name))
        fp = root / "Breakdown" / "breakdown.json"
        if not fp.is_file():
            return ("", "")
        shots = (json.loads(fp.read_text()) or {}).get("shots") or []
    except Exception as e:                      # noqa: BLE001 — richness, not correctness
        logger.warning("[Geo] breakdown unreadable for the scene opening: %s", e)
        return ("", "")
    idx = next((i for i, s in enumerate(shots)
                if str(s.get("scene_id") or s.get("sceneId") or "") == scene_id), -1)
    if idx < 0:
        return ("", "")
    first_id = str(shots[idx].get("id") or "")
    tail = ""
    if idx > 0:
        lines = [d for d in (shots[idx - 1].get("dialogue") or [])
                 if str(d.get("text") or "").strip()]
        if lines:
            tail = str(lines[-1].get("text") or "").strip()
    return (first_id, tail)


def _project_root_of_render(render_path: str) -> str:
    """The project folder an exported file belongs to, from its path alone, or "".

    Stage 6's QC endpoint is the one phase with no project handle in its request — its
    caller has never sent one — but it always sends the rendered file, and that file
    lives at <project>/Exports/render_*.mp4. Walking up to the folder that holds
    Script/bible.json recovers the project without changing the wire contract (and
    without guessing: the marker file has to actually be there).
    """
    if not render_path:
        return ""
    from pathlib import Path as _Path       # local, like the other Path users in this file
    try:
        p = _Path(render_path).resolve()
        for parent in list(p.parents)[:4]:
            if (parent / "Script" / "bible.json").is_file():
                return str(parent)
    except Exception:                           # noqa: BLE001 — a bad path is just "no bible"
        pass
    return ""


class BibleSaveRequest(BaseModel):
    """B4: a hand-edited film bible on its way back to disk.

    `approved` is tri-state on purpose. None means "the client only edited text", so
    saving a typo fix can neither approve a spine the user never voted on nor revoke
    an approval they already gave — only an explicit true/false moves that flag.
    """
    project_name: str = ""
    project_path: str = ""
    bible: dict = {}
    approved: bool | None = None


@app.get("/api/bible")
async def get_bible(project_name: str = "", project_path: str = ""):
    """B4: the film bible + its story gates, so the UI can finally SHOW the spine.

    Until now the spine Take One Studio proposes was written to Script/bible.json and read
    only by the server (breakdown context + QC gates) — the user had no way to see
    or change the thing the whole film is built on.

    A project with no bible is NOT a 404: the story tab opens long before anything is
    derived, and a 404 there reads as a broken backend when the honest answer is
    "nothing yet". Empty bible, no checks, not approved.
    """
    try:
        bible = await asyncio.to_thread(proj_storage.read_bible, project_name, project_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    # Prefer the checks stored at derive time so the editor shows exactly what QC
    # showed; recompute only for bibles saved before story_checks was persisted.
    # Recomputed, not read from disk, when the stored verdict predates the cast
    # gates: a bible saved before they existed carries story_checks without them.
    _scr = _read_script_quietly(project_name, project_path)
    checks = check_story_spine(bible, _scr) if bible.get("sequences") else []
    return {"bible": bible, "checks": checks, "approved": bool(bible.get("spine_approved"))}


@app.put("/api/bible")
async def put_bible(req: BibleSaveRequest):
    """B4: save an edited spine, re-score it, and optionally approve it."""
    try:
        stored = await asyncio.to_thread(
            proj_storage.read_bible, req.project_name, req.project_path)
        # MERGE, never replace. The bible carries keys no spine editor loads (logline,
        # tone, characters, savedAt, whatever the next agent adds); a PUT that wrote the
        # incoming dict wholesale would delete them the first time someone fixed one
        # sequence's obstacle. The client only ever owns the keys it actually sent.
        merged = {**stored, **(req.bible or {})}
        # Re-score AFTER the merge: the checks must describe what lands on disk, not what
        # the client happened to send. Stored under 'story_checks' — the same key
        # derive_film_bible writes and /api/breakdown/qc reads — so the gates shown in the
        # editor and the gates that block QC can never disagree.
        #
        # ONLY score a bible that HAS a spine, exactly like GET /api/bible does. Scoring
        # a spine-less one was permanent damage: check_story_spine({}) returns the single
        # BLOCKING "Story spine — no sequences" failure, and /api/breakdown/qc PREFERS the
        # stored copy (`bible.get("story_checks") or ...`) over recomputing — so one PUT
        # before the spine exists (the "Aprobar espina" button had no guard, and a project
        # with no bible reaches this endpoint like any other) wrote that verdict to disk
        # and every later QC run appended it and forced result["passed"] = False, forever.
        # A spine-less bible is not a FAILED spine, it is an ABSENT one; the honest verdict
        # for it is "nothing to score", which is what GET has always returned.
        checks = check_story_spine(
            merged, _read_script_quietly(req.project_name, req.project_path)
        ) if merged.get("sequences") else []
        if checks:
            merged["story_checks"] = checks
        else:
            # And drop any poisoned copy an earlier unguarded PUT already persisted: it
            # arrives here inside `stored` and rides the merge, so leaving it alone would
            # preserve the blocking failure through the very save meant to be harmless.
            merged.pop("story_checks", None)
        if req.approved is not None:
            merged["spine_approved"] = bool(req.approved)
        # save_bible stamps its own savedAt and returns the path, not the payload — so the
        # response is built from `merged`, minus that timestamp we never see here.
        await asyncio.to_thread(
            proj_storage.save_bible, req.project_name, merged, req.project_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    logger.info("[Bible] saved %d sequence(s), %d failing check(s), approved=%s (project=%s)",
                len(merged.get("sequences") or []),
                sum(1 for c in checks if not c.get("passed")),
                bool(merged.get("spine_approved")), req.project_name or req.project_path)
    return {"bible": merged, "checks": checks, "approved": bool(merged.get("spine_approved"))}


class BibleDeriveRequest(BaseModel):
    """Derive the spine from a script, on demand — phase 1's entry point to it.

    Until now derive_film_bible had exactly one caller, generate_breakdown, which made
    the story spine a side effect of writing several hundred shots: there was no way to
    ask for the spine, look at it and approve it BEFORE the shot list existed, which is
    the order the work is actually done in.
    """
    project_name: str = ""
    project_path: str = ""
    script: str = ""
    target_duration_secs: int = 60


@app.post("/api/bible/derive")
async def derive_bible(req: BibleDeriveRequest):
    """Derive a film bible from the script and persist it. Same shape as GET /api/bible.

    Merged over the stored bible in the same direction PUT uses ({**stored, **fresh}), so
    keys the deriver does not write — anything an editor or a later agent added — survive
    a re-derivation instead of being wiped by it.

    RE-DERIVING AN APPROVED BIBLE IS REFUSED (409), not merged. A fresh derivation
    rewrites `sequences` wholesale, so for a user who has already edited the spine and
    voted on it, "merge" means "silently replace the thing they approved with a new
    proposal the approval never applied to" — and the bible is where every later phase
    reads its intent from, so that loss propagates into the whole film. Un-approving is
    one click and is a decision only the user can make; guessing on their behalf is not.
    """
    if not req.script.strip():
        raise HTTPException(status_code=400, detail="script required to derive a bible")
    claude = get_claude()
    await bus.publish("story", "active", "Reading the story spine…", 10)
    try:
        stored = await asyncio.to_thread(
            proj_storage.read_bible, req.project_name, req.project_path)
        if stored.get("spine_approved"):
            raise HTTPException(
                status_code=409,
                detail=("This project's story spine is already APPROVED. Re-deriving would "
                        "replace the sequences you approved with a new proposal. Un-approve "
                        "the spine first if you want Take One Studio to write a new one."),
            )
        fresh = await asyncio.to_thread(
            claude.derive_film_bible, req.script, req.target_duration_secs)
        # derive_film_bible returns {} rather than raising when the model's answer will not
        # parse. Saving that would erase a bible the project already had, so an empty
        # derivation is reported as the failure it is and nothing is written — the same
        # "only replace on something usable" rule generate_breakdown applies.
        if not (fresh.get("characters") or fresh.get("sequences")):
            raise HTTPException(
                status_code=502,
                detail=("The story spine could not be derived from this script (the model's "
                        "answer was unusable). Nothing was changed; try again."),
            )
        merged = {**stored, **fresh}
        # Identical guard to PUT /api/bible: score ONLY a bible that HAS a spine. An absent
        # spine is not a failed spine, and check_story_spine({}) returns the single BLOCKING
        # "no sequences" verdict, which /api/breakdown/qc prefers over recomputing — so
        # persisting it once poisons every later QC run for the project.
        checks = check_story_spine(merged, req.script) if merged.get("sequences") else []
        if checks:
            merged["story_checks"] = checks
        else:
            merged.pop("story_checks", None)
        await asyncio.to_thread(
            proj_storage.save_bible, req.project_name, merged, req.project_path)
    except HTTPException:
        # Already a deliberate verdict (400/409/502) — re-raise untouched rather than
        # letting the handler below restate it as a 500 the client should retry.
        await bus.publish("story", "error", "Story spine not derived")
        raise
    except Exception as e:
        await bus.publish("story", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))
    await bus.publish("story", "completed", "Story spine ready", 100)
    logger.info("[Bible] derived %d character(s), %d sequence(s), %d failing check(s) (project=%s)",
                len(merged.get("characters") or []), len(merged.get("sequences") or []),
                sum(1 for c in checks if not c.get("passed")),
                req.project_name or req.project_path)
    return {"bible": merged, "checks": checks, "approved": bool(merged.get("spine_approved"))}


class BibleProposeRequest(BaseModel):
    """Propose a spine from the CONCEPT — before a word of script exists.

    Deliberately does NOT accept a script. /api/bible/derive is the script-reading
    endpoint and this is its inverse; taking an optional script here would make one
    endpoint that sometimes proposes and sometimes reports, and no caller could tell
    from the response which one it got.
    """
    project_name: str = ""
    project_path: str = ""
    concept: str = ""
    target_duration_secs: int = 60
    tone_hint: str = ""


@app.post("/api/bible/propose")
async def propose_bible(req: BibleProposeRequest):
    """Take One Studio proposes the story, the user approves it, and THEN it is written.

    NO CALLER since 2026-08-12. Kept, unreachable, on purpose — see the decision below.

    What it cost: designing from the concept means the model never reads the script, so
    on THE DIVORCE DRAMA QUEEN 2 it invented the cast. The script is about JOEL and MARA;
    the spine this wrote is about CLARA, with DANIEL owning four obstacles and no entry in
    `characters` at all — and it read 10/12 gates PASSING, because until that day nothing
    compared the spine's people against the script's. (The two cast gates in
    check_story_spine now do; a derivation cannot invent a cast in the first place.)

    Why it is not deleted: the failure is in WHEN it runs, not in what it does. A spine
    designed before the script is the only version of this idea that can make something
    resist the protagonist rather than report that nothing did — the paragraph below is
    still true. It belongs upstream of "Develop idea", where the script is then written to
    fit it; there is no such place in the pipeline today. The frontend client
    (pipelineApi.proposeBible) is kept for the same reason and carries the same note.

    NOTE the live path this does NOT cover: generate_script still writes sequence by
    sequence whenever a spine is APPROVED (server.py:1476) — it never asked where the
    spine came from, so a derived-and-approved one steers the pen exactly the same way.
    That branch is reachable and is not dead code.

    /api/bible/derive reads a finished screenplay and reports its structure, which makes
    every story judgement in this app a post-mortem: it can say that nothing resisted the
    protagonist, and it can never make something resist him. FARO is the proof — the best
    spine this system produces has five of six obstacles that ARE the protagonist's own
    passivity, and SEQ_1 declares obstacle NONE with value_in 'Alone, ordered, numb' →
    value_out 'Still alone, unbroken routine'. The document was accurate; the film was
    the problem.

    This is the input side. The spine lands on disk BEFORE the script, the user approves
    it through PUT /api/bible, and /api/script/generate then writes to it sequence by
    sequence instead of being scored after the fact.

    Same shape as GET /api/bible, the same merge as PUT (never wipe a key the client did
    not send), the same 409 on an already-approved spine as /api/bible/derive — replacing
    the sequences the user voted on with a new proposal is a decision only they can make.
    """
    if not req.concept.strip():
        raise HTTPException(status_code=400, detail="concept required to propose a spine")
    claude = get_claude()
    await bus.publish("story", "active", "Designing the story spine…", 10)
    try:
        stored = await asyncio.to_thread(
            proj_storage.read_bible, req.project_name, req.project_path)
        if stored.get("spine_approved"):
            raise HTTPException(
                status_code=409,
                detail=("This project's story spine is already APPROVED. Proposing a new one "
                        "would replace the sequences you approved. Un-approve the spine first "
                        "if you want Take One Studio to design another."),
            )
        fresh = await asyncio.to_thread(
            claude.propose_spine, req.concept, req.target_duration_secs, req.tone_hint)
        # propose_spine returns {} rather than raising when the answer will not parse.
        # Saving that would erase a bible the project already had — the same "only replace
        # on something usable" rule /api/bible/derive applies. A proposal with no SEQUENCES
        # is unusable here even if it came back with characters: a spine is the point.
        if not fresh.get("sequences"):
            raise HTTPException(
                status_code=502,
                detail=("Take One Studio could not design a spine for this concept (the model's answer "
                        "was unusable). Nothing was changed; try again."),
            )
        merged = {**stored, **fresh}
        # Identical guard to PUT and derive: score ONLY a bible that HAS a spine. Unreachable
        # in practice on this path (the 502 above already requires sequences) and kept
        # anyway, because the three endpoints that write bible.json must not disagree about
        # what a spine-less bible scores — that disagreement is how the blocking
        # "Story spine — no sequences" verdict reached disk and poisoned every later QC run.
        checks = check_story_spine(
            merged, _read_script_quietly(req.project_name, req.project_path)
        ) if merged.get("sequences") else []
        if checks:
            merged["story_checks"] = checks
        else:
            merged.pop("story_checks", None)
        await asyncio.to_thread(
            proj_storage.save_bible, req.project_name, merged, req.project_path)
    except HTTPException:
        await bus.publish("story", "error", "Story spine not proposed")
        raise
    except Exception as e:
        await bus.publish("story", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))
    await bus.publish("story", "completed", "Story spine proposed", 100)
    logger.info("[Bible] proposed %d sequence(s) · tension %s · %d failing check(s) (project=%s)",
                len(merged.get("sequences") or []),
                ",".join(str(_seq_tension(s) or "-") for s in (merged.get("sequences") or [])),
                sum(1 for c in checks if not c.get("passed")),
                req.project_name or req.project_path)
    return {"bible": merged, "checks": checks, "approved": bool(merged.get("spine_approved"))}


@app.post("/api/breakdown/generate")
async def generate_breakdown(req: BreakdownRequest):
    # Spec: Claude generates the breakdown — not DeepSeek
    claude = get_agents()
    await bus.publish("breakdown", "active", "Breaking down the script (scene batches)…", 10)
    try:
        # Story context for the concurrent batches. The concept was already being sent
        # here (script QC judges against it) and then dropped; forwarding it is free.
        # On top of that, derive the film bible ONCE per project and reuse it — it is
        # what lets the breakdown write a `performance` grounded in what a character
        # wants rather than in the action line alone. Derived from the script so the
        # Autopilot path (which never calls "Develop idea") gets one too. Best-effort:
        # a missing bible costs richness, never the breakdown.
        story_context = req.concept
        bible: dict = {}
        if req.project_name or req.project_path:
            try:
                bible = await asyncio.to_thread(
                    proj_storage.read_bible, req.project_name, req.project_path)
                # Re-derive when the cached bible predates the story spine. Keying the
                # cache on `characters` alone froze every project that already had one
                # into a spine-less bible forever — the sequences would never be written
                # and check_story_spine would never run for them.
                if not bible.get("characters") or "sequences" not in bible:
                    await bus.publish("breakdown", "active", "Reading the story spine…", 20)
                    fresh = await asyncio.to_thread(
                        claude.derive_film_bible, req.script, req.target_duration_secs)
                    # Only replace on something usable — a failed derivation must not
                    # destroy a bible that already had characters.
                    if fresh.get("characters") or fresh.get("sequences"):
                        bible = fresh
                        await asyncio.to_thread(proj_storage.save_bible, req.project_name,
                                                bible, req.project_path)
                if bible.get("characters") or bible.get("sequences"):
                    story_context = _bible_as_context(bible, req.concept)
                # WITH a spine, each batch gets the sequences that own ITS stretch of the
                # film instead of the whole document — see _batch_story_context. A bible
                # with characters and no sequences keeps the single string above, which is
                # byte-for-byte the prompt it produces today.
                if bible.get("sequences") and req.target_duration_secs > 0:
                    story_context = _batch_story_context(bible, req.concept,
                                                         req.target_duration_secs)
            except Exception as e:
                logger.warning("[Bible] skipped (non-fatal): %s", e)

        # spine_len sizes the batches: a batch that is handed most of the spine at once
        # collapses it (see the note in generate_breakdown). 0 for a project with no
        # spine, which keeps the old fixed 300s batching byte for byte.
        # Plan against the CHOSEN model's ceiling. Picking 2.5 only pays off if the
        # breakdown actually groups shots into the 30 s takes it can render — a plan
        # capped at 15 s would leave the capability unused.
        _seg_max = model_caps(
            BytePlusGenerativeAPI.resolve_tier(None, "720p", req.model_choice or None)[0]
        )["max_duration"]
        bd = await asyncio.to_thread(claude.generate_breakdown, req.script,
                                     req.target_duration_secs,
                                     segment_max_secs=_seg_max,
                                     story_context=story_context,
                                     spine_len=len(bible.get("sequences") or []))
        # The shots come back carrying whatever the batches wrote into `sequence_id`;
        # this is where it becomes trustworthy — unknown ids dropped, a scene settled on
        # ONE sequence, the segments stamped. Without it the footage accounting would be
        # auditing the model's spelling. No-op for a project with no spine.
        if bible.get("sequences"):
            tags = _attach_sequence_ids(bd, bible)
            logger.info("[Breakdown] sequence tags: %d/%d shot(s) across %d scene(s) "
                        "(%d filled from their scene, %d unknown id(s) dropped)",
                        tags["tagged"], tags["shots"], tags["scenes"],
                        tags["filled"], tags["dropped"])
        # DID THE DIALOGUE SURVIVE? The writer summarises: an 18-line script came back as
        # 8 lines on THE DIVORCE DRAMA QUEEN, losing the middle of every exchange, and
        # nothing noticed because the breakdown was complete in SHAPE — every shot had a
        # dialogue list, nobody had counted them against the source. Ground truth is the
        # deterministic script parser, so this costs no tokens and cannot hallucinate.
        # Reported, never repaired: the missing lines are a creative decision, and
        # silently re-inserting them would be a worse failure than naming them.
        try:
            _cov = dialogue_coverage(req.script or "", bd.get("shots") or [])
            bd["dialogueCoverage"] = _cov
            if not _cov["covered"]:
                _n = len(_cov["missing"])
                logger.warning("[Breakdown] DIALOGUE INCOMPLETE — script has %d spoken "
                               "line(s), the breakdown carries %d; %d missing: %s",
                               _cov["script_lines"], _cov["breakdown_lines"], _n,
                               " | ".join(_cov["missing"][:6]) + (" …" if _n > 6 else ""))
                await bus.publish(
                    "breakdown", "error",
                    f"Dialogue incomplete: {_cov['breakdown_lines']} of "
                    f"{_cov['script_lines']} spoken lines reached the breakdown — "
                    f"{_n} missing, starting with \"{_cov['missing'][0]}\"")
        except Exception as ce:      # a coverage report must never fail a breakdown
            logger.warning("[Breakdown] coverage check failed (non-fatal): %s", ce)

        await bus.publish("breakdown", "completed", "Breakdown complete", 100)
        # 1.2: save to disk if project is initialised
        if req.project_name or req.project_path:
            try:
                await asyncio.to_thread(
                    proj_storage.save_breakdown,
                    req.project_name, bd, req.script[:500], req.project_path,
                )
            except Exception as se:
                logger.warning("[P5] save_breakdown failed (non-fatal): %s", se)
        return bd
    except Exception as e:
        await bus.publish("breakdown", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


class CharacterEnrichRequest(BaseModel):
    name: str
    description: str = ""
    context: str = ""          # optional script excerpt for grounding


@app.post("/api/character/enrich")
async def enrich_character(req: CharacterEnrichRequest):
    """Director pass — fill a character's personality, backstory and wardrobe from
    the name + visual description (Seed 2.0 Pro; no Anthropic spend)."""
    claude = get_claude()
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="character name required")
    try:
        detail = await asyncio.to_thread(claude.enrich_character, req.name, req.description, req.context)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Character enrich failed: {e}")
    return detail  # {personality, backstory, wardrobe}


class DescribeRefsRequest(BaseModel):
    image_urls: list[str] = []      # character reference images (url | /abs/path | data-URI)


@app.post("/api/character/describe-refs")
async def describe_character_refs(req: DescribeRefsRequest):
    """Vision read of a character's reference image(s) → structured fields
    {appearance, hairstyle, wardrobe, shoes, props} (Seed 2.0 Pro vision)."""
    urls = [u for u in (req.image_urls or []) if (u or "").strip()]
    if not urls:
        raise HTTPException(status_code=400, detail="at least one image required")
    api = get_byteplus()
    try:
        out = await asyncio.to_thread(api.describe_character_refs, urls)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Describe refs failed: {e}")
    return out


class TextEnhanceRequest(BaseModel):
    field: str                 # 'personality' | 'backstory' | 'action' | 'dialogue' | …
    current: str = ""
    context: str = ""


@app.post("/api/text/enhance")
async def enhance_text(req: TextEnhanceRequest):
    """Rewrite/enhance (or write, when empty) ONE field with the LLM (Seed 2.0 Pro)."""
    claude = get_claude()
    if not req.field.strip():
        raise HTTPException(status_code=400, detail="field required")
    # A Seedance direction is not prose: it is rewritten under the official guide of the
    # model it goes to, and refused when it breaks it (the project's rules 9 and 10). The
    # context carries the model ('v25' | 'base' | 'fast' | 'mini') as JSON.
    if req.field.strip() == "seedance_direction":
        try:
            ctx = json.loads(req.context or "{}") if (req.context or "").strip().startswith("{") else {}
        except ValueError:
            ctx = {}
        try:
            text, warnings = await asyncio.to_thread(
                claude.enhance_seedance_direction, req.current, str(ctx.get("model") or "v25"))
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Enhance failed: {e}")
        return {"text": text, "warnings": warnings}
    try:
        text = await asyncio.to_thread(claude.enhance_text, req.field, req.current, req.context)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Enhance failed: {e}")
    return {"text": text, "warnings": []}


class ShotsEnhanceRequest(BaseModel):
    # [{id, action, visual_description, dialogue, characters}] — one BATCH. `characters` is
    # the shot's own cast (names of its character assets, resolved by the caller against the
    # asset table — only the caller knows an asset's type). An EMPTY list means nobody is in
    # frame and the shot comes back with performance == ""; an ABSENT key means the caller
    # said nothing and the shot is directed exactly as it was before the key existed.
    # Deliberately a free dict: the shot payload is pass-through and must not be schema-pinned.
    shots: list[dict] = []
    # The cast's ACTING MASTER PROFILES ([{name, acting}]), so the acting direction this
    # call writes is a re-expression of who the character already is rather than a fresh
    # invention per batch. Defaulted: a caller that omits it behaves exactly as before.
    characters: list[dict] = []


@app.post("/api/shots/enhance")
async def enhance_shots(req: ShotsEnhanceRequest):
    """Batch-enhance action + visual for a group of shots in ONE Seed 2.0 Pro call.
    Returns {shotId: {action, visual}}. The frontend calls it per batch (concurrent)."""
    claude = get_claude()
    try:
        result = await asyncio.to_thread(claude.enhance_shots, req.shots, req.characters)
    # A BAD BODY IS NOT A BAD GATEWAY. `shots` is list[dict] by design (the shot payload is
    # pass-through), so pydantic checks the entries are dicts and stops there — everything
    # inside was landing on this generic handler, which reported a caller mistake as an
    # upstream failure AND pasted a raw Python message into the API's answer: measured
    # 2026-08-07, `dialogue: "a string"` returned 502 {"detail":"Shot enhance failed: 'str'
    # object has no attribute 'get'"}. _validate_shot_payload now names the shot and the
    # key instead, and this arm gives it the 4xx that says whose mistake it is. Ordered
    # first because ShotPayloadError is a ValueError and the arm below would swallow it.
    except ShotPayloadError as e:
        raise HTTPException(status_code=422, detail=f"Malformed shot payload — {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Shot enhance failed: {e}")
    return {"shots": result}


@app.post("/api/breakdown/qc")
async def qc_breakdown(req: BreakdownQCRequest):
    claude = get_claude()
    await bus.publish("qc", "active", "Breakdown QC running…")
    try:
        # Judge against the ceiling the film is PLANNED for — the same line, the same
        # table and the same tier resolution generate_breakdown plans with, so the two can
        # never disagree about what one call may hold.
        _qc_max_call = model_caps(
            BytePlusGenerativeAPI.resolve_tier(None, "720p", req.model_choice or None)[0]
        )["max_duration"]
        result = await asyncio.to_thread(claude.qc_breakdown, req.breakdown, req.script,
                                         req.target_duration_secs, req.deterministic_only,
                                         _qc_max_call)
        # The STORY gates ride out on this response, which is the only QC channel the
        # product actually reads (Autopilot and ApprovalControls both consume it). They
        # were being computed and written into bible.json where nothing looked at them —
        # four checks, two of them blocking, gating nothing at all.
        if req.project_name or req.project_path:
            try:
                bible = await asyncio.to_thread(
                    proj_storage.read_bible, req.project_name, req.project_path)
                story = bible.get("story_checks") or (
                    check_story_spine(bible) if bible.get("sequences") else [])
                if story:
                    result["checks"] = list(result.get("checks") or []) + story
                    if any(c.get("blocking") and not c.get("passed") for c in story):
                        result["passed"] = False
                    logger.info("[QC:Breakdown] +%d story check(s), %d failing",
                                len(story), sum(1 for c in story if not c.get("passed")))
                # FOOTAGE ACCOUNTING — did phase 2 spend the runtime the spine planned?
                # Computed here rather than in qc_breakdown because this is the only place
                # that holds BOTH the breakdown and the bible; the story gates above are
                # here for the same reason. Non-blocking, like the "Runtime" gate it
                # refines: it is arithmetic about a brand-new field, and a blocking verdict
                # on it would stop every unattended autopilot run at stage 2 the first time
                # a model tagged its shots badly.
                footage = _footage_share_check(req.breakdown, bible, req.target_duration_secs)
                if footage:
                    result["checks"] = list(result.get("checks") or []) + footage
                    logger.info("[QC:Breakdown] footage share: %s — %s",
                                "ok" if footage[0]["passed"] else "OFF PLAN",
                                footage[0]["notes"])
            except Exception as e:
                logger.warning("[QC:Breakdown] story checks skipped (non-fatal): %s", e)
        await bus.publish("qc", "completed", "Breakdown QC complete")
        return result
    except Exception as e:
        await bus.publish("qc", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ── Stage 3: Asset generation ─────────────────────────────────────────────────
#
# HELL GRIND, quoted from the production brief: "Keep the sheet boring on purpose. Neutral
# grey background. Flat light. Real skin with visible pores, no retouch. The cinema look
# does not live in the character sheet — it lives in the locations and in the video
# prompts. Bake film grain and cinematic lenses into the sheet, and the character will
# carry that look into every scene and stop reacting to new light."
#
# WHAT WAS MEASURED HERE. BLOOM's locked suffix is "cinematic film photography, anamorphic
# lens, film grain, dramatic lighting, shallow depth of field, golden hour, RAW photo,
# ultra detailed, 35mm film". It was concatenated into the CHARACTER SHEET, and 4/4 sheets
# of Tomás Arroyo came back with it faithfully applied: a warm golden key from screen-left
# with a rim, a warm background falloff, and grain — the "[CAMERA] Arri Alexa 35, 85mm
# prime, … ISO 320, fine natural 35mm film grain" the writer was told to produce. The
# sheet is the DOMINANT reference for every downstream board and shot of that character,
# so whatever look is baked into it is carried into scenes that were lit differently.
# One level worse, already seen in this project: a suffix that read "Cold bioluminescent
# blue-green light on black flood water" put glowing water on the floor of a location
# whose own description was "quiet empty domestic space", and every board of that kitchen
# inherited the flood. Rewording the suffix fixed that instance; this fixes the structure.
#
# THE DECISION, per asset type — the flag below is the whole of it, in one place:
#   • CHARACTER  → NEUTRAL. The rule is literally about this document, and it is the one
#     asset whose job is to be re-lit in every scene of the film.
#   • PROP       → NEUTRAL. Same document class, same job: a prop sheet is already a
#     multi-view on a neutral sweep, it is the downstream Seedance reference, and it has
#     to survive being carried from a golden-hour exterior into a fluorescent corridor.
#     The brief names locations as where the look lives; a prop is not a location.
#   • WARDROBE   → NEUTRAL. Same argument — garments on a ghost mannequin, worn later by a
#     character under scene light. Fabric colour read under a golden key is a lie.
#   • ENVIRONMENT / LOCATION → KEEPS THE STYLE, deliberately. The brief is explicit that
#     "the cinema look […] lives in the locations". A location plate IS the look: strip the
#     grade off it and the film has nowhere left to establish one. Residual risk stated
#     plainly: this is the exact path that flooded the kitchen, and it stays open — a
#     suffix describing scene CONTENT (water, fire, a crowd) rather than a look will still
#     be painted into a location. That is a suffix-authoring problem, not a per-asset one,
#     and it is out of this change's scope.
#   • VFX / FX   → KEEPS THE STYLE. An effect element's content is its look; there is
#     nothing left of it once the look is removed.
#
# WHAT DID **NOT** REPRODUCE — say it plainly, because the brief's own justification for
# the rule is the part that failed here. The brief claims a styled sheet makes the
# character "stop reacting to new light". Boarded BLOOM's SHOT_034 (INT. FLOODED PUMP
# ROOM - NIGHT, "faint blue glow seeping under door, cool murky light" — deliberately the
# opposite of the sheet's warm golden key), 8 boards per arm, the ONLY variable being
# which sheet rode as the identity reference:
#     skin b*  styled +11.82 ± 1.66  ·  neutral +10.41 ± 2.82   p=0.33 (exact MWU, 8v8)
#     carry    styled  -4.97 ± 1.66  ·  neutral  -4.37 ± 2.82   p=0.38
# where `carry` = the face's b* in the board minus its b* on its OWN sheet, i.e. how far
# it moved toward the scene's blue. Both arms move ~5 b* points. The styled face reacts
# to the new light just as much, and if anything slightly more. An earlier 8v4 pass did
# show a "clean" separation on skin_b−scene_b (p=0.008); it fell to p=0.05 at 8v8 and is
# confounded anyway — the two sheets dressed him in different suits (navy vs charcoal),
# and the suit is a large share of "non-skin". Treat that first result as refuted.
# So the justification for this change is NOT the downstream claim: it is the sheet
# itself, where the effect is unambiguous (4v4, no overlap) — background chroma
# 2.74 ± 0.33 → 0.34 ± 0.16, backdrop grain 2.67 ± 0.76 → 0.62 ± 0.23, while cheek
# texture is unharmed (3.87 ± 0.36 → 4.01 ± 0.29). A neutral sheet is an honest
# document of what the wardrobe and the skin actually look like; that is worth having
# on its own, and it is the whole of what was measured to work.
#
#: Master switch. False restores the pre-2026-08-06 behaviour exactly (the project suffix
#: goes into every sheet again) — flip it, restart, and nothing else changes.
NEUTRAL_ASSET_SHEETS = True
#: The asset types whose sheet is a technical document, not a frame of the film.
NEUTRAL_SHEET_ASSET_TYPES = frozenset({"character", "prop", "wardrobe"})

#: The MEDIUM (how it is drawn) survives; the CINEMATOGRAPHY (grade, grain, lens, light,
#: hour) is what gets dropped. An anime project must still get an anime character, so this
#: maps each shipped style id (frontend/lib/styles.ts) to the medium-only phrase that
#: replaces its suffix on a sheet. A style not listed here (custom) falls back to the
#: FIRST clause of its own suffix, which is where every shipped preset puts its medium.
NEUTRAL_SHEET_MEDIUM: dict[str, str] = {
    "cinematic": "photographic, a real studio photograph",
    "photoreal": "photographic, a real studio photograph",
    "anime":     "anime cel-shaded illustration, clean line art",
    "pixar3d":   "stylized 3D animated character, subsurface scattering",
    "cartoon2d": "flat 2D cartoon illustration, bold clean outlines",
    "comic":     "inked comic-book illustration, bold ink outlines, halftone shading",
}
#: The treatment itself, in ONE string so the reviewer sees exactly what replaced the
#: project style. Mirrors claude_agents._NEUTRAL_SHEET_BLOCK, which states the same thing
#: to the prompt WRITER; this is the [MEDIUM] line the writer is handed.
NEUTRAL_SHEET_TREATMENT = (
    "flat even studio lighting, neutral mid-grey seamless background, neutral white "
    "balance, no colour grade, no film grain, no lens effects, evenly sharp, real "
    "un-retouched texture"
)


def _sheet_style(asset_type: str, style_label: str, style_suffix: str) -> tuple[str, str, bool]:
    """(label, suffix, neutral) to hand a sheet prompt writer for `asset_type`.

    Returns the caller's own style untouched for every type that KEEPS the look
    (environment / vfx / fx, and everything when NEUTRAL_ASSET_SHEETS is off), so those
    paths are byte-identical to before this function existed.

    The photographic-vs-illustrated verdict must NOT flip, IN EITHER DIRECTION:
    _is_photographic runs again inside the prompt writers and decides whether the sheet
    gets the [CAMERA]+[SKIN] photo mandate or a [RENDER] line. It is computed here from
    the ORIGINAL style and preserved in the replacement. Both directions were live bugs
    in this function's first draft:
      • photoreal → drawings: a custom suffix like "moody neon, photorealistic" loses its
        only marker to the first-clause fallback.
      • drawings → photoreal: the Studio Character Creator (CharacterCreator.tsx) posts
        style_label="cinematic" with an EMPTY suffix, on which _is_photographic is False
        today; the mapped medium for "cinematic" is photographic, so the mapping alone
        would have switched on a photo mandate that sheet never had.
    """
    at = (asset_type or "").strip().lower()
    if not NEUTRAL_ASSET_SHEETS or at not in NEUTRAL_SHEET_ASSET_TYPES:
        return style_label, style_suffix, False
    photo = _is_photographic(style_label, style_suffix)
    # The caller's own medium wording: the first clause of the suffix, else the label —
    # exactly the text `style_suffix or style_label` handed the writer before this change.
    own = (style_suffix or "").split(",")[0].strip() or (style_label or "").strip()
    medium = NEUTRAL_SHEET_MEDIUM.get((style_label or "").strip().lower()) or own
    if photo and not _is_photographic("", medium):
        medium = f"photographic, {medium}" if medium else "photographic, a real studio photograph"
    elif not photo and _is_photographic("", medium):
        medium = own if not _is_photographic("", own) else "illustrated concept art"
    return style_label, f"{medium}, {NEUTRAL_SHEET_TREATMENT}".lstrip(", "), True


@app.post("/api/assets/doctor-prompt")
async def doctor_prompt_endpoint(req: DoctorPromptRequest):
    """0.2: Claude prompt doctor — rewrites raw description → style-aware generation prompt."""
    claude = get_claude()
    await bus.publish("qc", "active", "Prompt Doctor running…", 5)
    # The doctor is the OTHER way the project style reaches a sheet: its rewrite becomes
    # the DESCRIPTION the sheet writer is given, and its rule 4 orders the style keywords
    # in verbatim. Neutralising only the sheet writer would have left this back door open.
    doc_label, doc_suffix, _ = _sheet_style(req.asset_type, req.style_label, req.style_suffix)
    try:
        doctored = await asyncio.to_thread(
            claude.doctor_prompt,
            req.raw_description,
            req.asset_type,
            doc_label,
            doc_suffix,
        )
        await bus.publish("qc", "completed", "Prompt Doctor done", 100)
        # Also return the FINAL assembled Seedream prompt (doctored + style
        # suffix) so the UI can show exactly what will be sent — and let the
        # user edit it before generating.
        from byteplus_generative import assemble_image_prompt
        assembled = assemble_image_prompt(doctored, doc_suffix)
        return {"doctored_prompt": doctored, "raw": req.raw_description, "assembled_prompt": assembled}
    except Exception as e:
        await bus.publish("qc", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


class BoardPromptRequest(BaseModel):
    """Build (but don't run) the identity-board / prop-sheet Seedream prompt — the
    UI shows it for review/editing before generation."""
    asset_name: str
    description: str
    style_label: str = "cinematic"
    style_suffix: str = ""
    kind: str = "character"          # 'character' → identity board · 'prop' → prop sheet · 'wardrobe' → costume sheet
    # Studio Character Creator sheet options. The default must stay EQUAL to
    # identity_board_prompt's own default: Stage 3 previews the prompt here and then
    # generates through _generate_asset_core, which passes no layout at all — if the two
    # defaults drift, the user approves one sheet and Seedream is sent another.
    layout: str = SHEET_LAYOUT_DEFAULT  # 'headless' = 3/4 portrait + headless front + back
                                     # · '4+2' = 4 full-body + 2 close-ups · '2+2' = 2 + 2
    grey_bg: bool = True             # grey seamless studio backdrop
    pose_labels: bool = True         # False → no rendered text anywhere on the sheet


@app.post("/api/assets/board-prompt")
async def board_prompt_endpoint(req: BoardPromptRequest):
    claude = get_claude()
    await bus.publish("qc", "active", f"Board prompt: {req.asset_name}…", 5)
    try:
        builder = {
            "prop": claude.prop_sheet_prompt,
            "wardrobe": claude.wardrobe_sheet_prompt,
        }.get(req.kind, claude.identity_board_prompt)
        # Sheet options are character-only: the prop/wardrobe builders take the base
        # signature, so passing them through would TypeError on an item sheet.
        # NOTE: test by KIND, never `builder is claude.identity_board_prompt` — attribute
        # access builds a NEW bound method each time, so that identity check is always
        # False and the options were silently dropped.
        extra = {
            "layout": req.layout, "grey_bg": req.grey_bg, "pose_labels": req.pose_labels,
        } if req.kind not in ("prop", "wardrobe") else {}
        # HELL GRIND (see _sheet_style): the project's cinematic suffix is replaced by the
        # neutral studio treatment for all three sheet kinds. `neutral_sheet` is accepted
        # by all three builders, so it rides in `extra` for every kind — this endpoint is
        # what the review panel shows, so the user SEES the neutral prompt before spending.
        # Normalised the SAME way the builder dispatch above normalises: anything that is
        # not prop/wardrobe falls through to the character builder, so an unrecognised
        # kind must get the character sheet's treatment and not silently keep the style.
        kind = req.kind if req.kind in ("prop", "wardrobe") else "character"
        s_label, s_suffix, neutral = _sheet_style(kind, req.style_label, req.style_suffix)
        extra["neutral_sheet"] = neutral
        prompt = await asyncio.to_thread(
            functools.partial(builder, **extra),
            req.asset_name, req.description, s_label, s_suffix,
        )
        await bus.publish("qc", "completed", "Board prompt ready", 100)
        return {"board_prompt": prompt}
    except Exception as e:
        await bus.publish("qc", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


def _variation_failure_error(slots: list[dict], what: str) -> HTTPException:
    """Every variation failed — classify the cause so the UI gives actionable
    guidance instead of a raw upstream error blob."""
    errs = [s.get("error") or "" for s in slots]
    first = next((e for e in errs if e), f"All {what} failed")
    if any("SensitiveContent" in e or "sensitive" in e.lower() for e in errs):
        return HTTPException(status_code=422, detail=(
            f"Seedream's content filter blocked all {len(slots)} {what} "
            "(OutputImageSensitiveContentDetected). This is usually a false positive on "
            "close-up faces or visceral wording (melting, under-skin, wounds, burning). "
            "Open the prompt panel, soften that wording, and generate again."
        ))
    return HTTPException(status_code=502, detail=first)


async def _generate_asset_core(req: AssetGenerateRequest, on_slot=None) -> dict:
    """The whole asset-generation pipeline (prompt assembly → variations).
    Shared by the sync endpoint and the async job runner; on_slot(index, result)
    fires from the render pool as each variation lands."""
    from byteplus_generative import assemble_image_prompt
    api = get_byteplus()

    # Identity-changing regen: director notes on a character regen may redefine the
    # face (ethnicity, age, hair…). Drop the cached face block + face anchor so the
    # sheet's FACE LOCK and every downstream stage rebuild from the NEW look — the
    # stale caches were how the old face kept resurfacing after a regen.
    if req.regen_notes.strip() and req.asset_type == "character" and req.asset_name:
        try:
            # to_thread: both take storage's cross-process flock, which WAITS on the
            # calling thread (see file_lock.LOCK_TIMEOUT_SECS) — on the loop that is the
            # whole server frozen for as long as a peer holds the project's lock.
            cleared = await asyncio.to_thread(
                proj_storage.clear_face_block,
                req.project_name, req.asset_name, req.project_path)
            anchor_cleared = await asyncio.to_thread(
                proj_storage.clear_face_anchor,
                req.project_name, req.asset_name, req.project_path)
        except Exception as e:
            # Both used to swallow a failed write and report "nothing was cached", which
            # is indistinguishable from success. The stale caches then survive and the
            # regen comes back wearing the OLD face — the exact failure this invalidation
            # exists to prevent. Refuse the regen: nothing has been generated or paid for
            # yet, and both callers of this function surface an HTTPException on the bus.
            raise HTTPException(
                status_code=500,
                detail=(f"Could not invalidate {req.asset_name}'s identity cache ({e}) — "
                        f"regenerating now would bring the old face back"),
            )
        _face_block_locks.pop(f"{req.project_path or req.project_name}:{req.asset_name}", None)
        if cleared or anchor_cleared:
            logger.info("[AssetGen] %s: identity caches invalidated on notes-regen (block=%s anchor=%s)",
                        req.asset_name, bool(cleared), anchor_cleared)

    # 0.1: assemble the final prompt using the central assembler —
    # unless the user already reviewed/edited one in the UI.
    assembled = req.final_prompt or assemble_image_prompt(
        raw_description=req.description,
        style_suffix=req.style.prompt_suffix,
    )

    # Convert Pydantic models → dicts; merge style anchor refs
    refs = [r.model_dump() for r in req.reference_images]
    style_anchor_refs = [
        {"url": url, "role": "reference_image", "weight": 0.6}
        for url in req.style.anchor_image_refs[:3]
        if url
    ]
    # UN ESTADO DEL PERSONAJE SE DIBUJA SOBRE SU PROPIA CARA, no desde cero.
    # `_apply_wardrobe_variants` nombra los estados "<Personaje> · <estado>", y cada uno
    # se generaba como un asset independiente a partir de texto — tres generaciones sin
    # relación entre sí. En FARO eso puso a Mara con rasgos europeos en las rocas y
    # asiáticos dentro del faro: no es deriva, es otra actriz. Anclar el estado a la
    # imagen ya aprobada del personaje base es lo que hace que solo cambie lo que le ha
    # pasado al cuerpo.
    if req.asset_type == "character" and " · " in (req.asset_name or ""):
        base = req.asset_name.split(" · ")[0].strip()
        try:
            v = proj_storage.list_asset_versions(req.project_name,
                                                 f"Characters/{base}", req.project_path)
            vers = v.get("versions") or []
            # `approved` / `current` son NÚMEROS de versión (1-based), no rutas.
            pick = v.get("approved") or v.get("current")
            anchor = ""
            if isinstance(pick, int) and 1 <= pick <= len(vers):
                anchor = vers[pick - 1]
            elif isinstance(pick, str) and os.path.isfile(pick):
                anchor = pick
            elif vers:
                anchor = vers[-1]
            if anchor and os.path.isfile(str(anchor)):
                # Delante de todo: es la referencia que manda sobre el estilo.
                refs = [{"url": str(anchor), "role": "reference_image"}] + refs
                logger.info("[AssetGen] %s anclado al rostro aprobado de %s",
                            req.asset_name, base)
            else:
                logger.warning("[AssetGen] %s sin ancla: %s no tiene imagen aprobada — "
                               "el estado saldrá con OTRA cara", req.asset_name, base)
        except Exception as e:
            logger.warning("[AssetGen] no pude anclar %s a %s (%s)", req.asset_name, base, e)

    all_refs = refs + style_anchor_refs

    neg = req.negative_prompt or req.style.negative_prompt or None

    slots: list[dict] | None = None
    is_sheet = req.asset_type in ("character", "prop", "wardrobe")
    if is_sheet:
        # Production template: ONE 16:9 multi-view sheet (identity board for
        # characters, object design sheet for props, costume lookbook for
        # wardrobe) — all on the same neutral-gray sweep. For human approval +
        # documentation only — the downstream ref is DERIVED at approval
        # (derive-refs / derive-prop-ref), never the multi-view sheet itself.
        # HELL GRIND (see _sheet_style, above the doctor endpoint): all three sheet kinds
        # are built WITHOUT the project's cinematic suffix — the look belongs in the
        # locations and the video prompts, not in the document every later shot takes the
        # face from. The style is untouched for environment / vfx / fx, which never reach
        # this branch. Note `_is_photographic` below still reads the ORIGINAL style: the
        # face-block gate decides identity, not light, and must not move.
        s_label, s_suffix, neutral = _sheet_style(
            req.asset_type, req.style.label, req.style.prompt_suffix)
        if req.final_prompt:
            board_prompt = req.final_prompt
        elif req.asset_type == "prop":
            claude = get_claude()
            board_prompt = await asyncio.to_thread(
                claude.prop_sheet_prompt,
                req.asset_name or req.asset_id, req.raw_description or req.description,
                s_label, s_suffix, neutral_sheet=neutral,
            )
        elif req.asset_type == "wardrobe":
            claude = get_claude()
            board_prompt = await asyncio.to_thread(
                claude.wardrobe_sheet_prompt,
                req.asset_name or req.asset_id, req.raw_description or req.description,
                s_label, s_suffix, neutral_sheet=neutral,
            )
        else:
            # CHARACTER — IDENTITY UNIFICATION: lock the face FIRST. Generate (cache) the
            # fictional-distinctive face block, then build the sheet AROUND it. Stage 5 reuses
            # the SAME cached block for the shot face anchor, so the face the user approves on
            # the sheet is the face in every shot. See seedance-identity-filter.
            claude = get_claude()
            face_block = ""
            if _is_photographic(req.style.label, req.style.prompt_suffix):
                try:
                    ch = KeyframeCharacter(name=req.asset_name or req.asset_id,
                                           description=req.raw_description or req.description)
                    face_block = await _get_face_block(claude, api, ch, req.project_name, req.project_path)
                except Exception as e:
                    logger.warning("[AssetGen] face block gen failed (sheet from description only): %s", e)
            # PHASE 3 · who this sheet is a picture OF. A sheet built from the visual
            # description alone is a costume fitting for someone with no story: the hair
            # is right and there is no reason for the posture. want/need/arc come from
            # the bible; no bible (or a name it does not carry) → "" → the writer sees
            # exactly the CHARACTER NAME + DESCRIPTION it sees today.
            _char_note = _bible_character_note(
                await asyncio.to_thread(_read_bible_quietly, req.project_name, req.project_path),
                req.asset_name or req.asset_id,
            )
            if _char_note:
                logger.info("[Bible] %s: story context in sheet prompt (%d chars)",
                            req.asset_name or req.asset_id, len(_char_note))
            board_prompt = await asyncio.to_thread(
                claude.identity_board_prompt,
                req.asset_name or req.asset_id, req.raw_description or req.description,
                s_label, s_suffix, face_block,
                story=_char_note, neutral_sheet=neutral,
            )
        what = {"prop": "prop sheets", "wardrobe": "wardrobe sheets"}.get(req.asset_type, "character sheets")
        # Character sheet = LARGE square. The reason has CHANGED with the layout: it used
        # to be "so each of the 4 full-body figures keeps enough pixels on its face (at
        # 2048² the small faces deform)", but the default sheet is now "headless" and has
        # no small faces left to protect (HELL GRIND rule 1 — see _SHEET_LAYOUTS). The
        # square stays because the LEFT-COLUMN 3/4 portrait is the only face the pipeline
        # ever crops (_derive_headshot) and it is the one that must not be soft. 4096² =
        # 16.8MP, inside Seedream's 36MP cap. Prop sheet stays 16:9.
        sheet_size = "4096x4096" if req.asset_type == "character" else "2848x1600"
        # Item 5: FOUR variations of COMPLETE sheets — the user picks one, which is
        # both the approved artwork and the downstream Seedance reference.
        # IMPORTANT: a multi-view sheet is rendered from the PROMPT alone. We do NOT
        # add the project style anchor here — once a scene/establishing image rides
        # as a reference, it collapses the multi-pose grid into a single composed
        # figure (hence "first character fine, the rest single-image"). Only the
        # user's own attached refs (e.g. a face) ride along; palette/lighting match
        # is applied at shot time, not on the neutral-gray sheet.
        board_slots = await asyncio.to_thread(
            api.generate_variations_sized, board_prompt, req.count or 4,
            sheet_size, refs or None, neg, on_slot, req.project_path,
        )
        urls = [s["url"] for s in board_slots if s.get("url")]
        slots = board_slots
        if not urls:
            raise _variation_failure_error(board_slots, what)
    else:
        # Per-slot outcomes: failed variations are reported to the UI with
        # their real error, never silently dropped.
        slots = await asyncio.to_thread(
            api.generate_variations, assembled, req.count, all_refs or None, neg, on_slot, req.project_path,
        )
        urls = [s["url"] for s in slots if s.get("url")]
        if not urls:
            raise _variation_failure_error(slots, "variations")
    used_prompt = board_prompt if is_sheet else assembled
    return {"urls": urls, "asset_id": req.asset_id, "slots": slots, "used_prompt": used_prompt}


@app.post("/api/assets/generate")
async def generate_assets(req: AssetGenerateRequest):
    ref_count = len(req.reference_images)
    await bus.publish("seedream", "active",
                      f"Generating {req.asset_id}{'  (+' + str(ref_count) + ' refs)' if ref_count else ''}…", 10)
    try:
        result = await _generate_asset_core(req)
        await bus.publish("seedream", "active", f"{req.asset_id} rendered", 80)
        return result
    except HTTPException as he:
        await bus.publish("seedream", "error", str(he.detail))
        raise
    except Exception as e:
        await bus.publish("seedream", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ── Seedream 5.0 Pro — reference-conditioned asset EDITING ────────────────────
# Edit an already-approved asset (e.g. drop a character into an approved
# environment, change wardrobe, tweak a feature, combine subjects) using Pro's
# multi-image blending. Non-destructive: the result is saved as a NEW asset
# version so the approved original is never overwritten.

# Image 1 is ALWAYS the subject being edited; context refs are Image 2, 3, …
# (image prompt guide §9 — name them so the model's mapping is unambiguous).
EDIT_TOOLS = {"place_in_env", "wardrobe", "edit_feature", "combine", "edit", "markup", "depicts"}


def _edit_prompt(tool: str, instruction: str, n_context_refs: int = 0,
                 style_suffix: str = "", neutral_sheet: bool = False) -> str:
    """Assemble a Seedream-5.0-Pro edit instruction from a tool + free-text note.
    `style_suffix` = the LOCKED project style: edits used to hardcode
    "Photorealistic", which pushed stylized projects' assets toward photoreal.
    Empty style (legacy callers) keeps the original photoreal wording."""
    instr = (instruction or "").strip()
    tool = (tool or "edit").strip().lower()
    # Render-medium tail: the project's declared style, or the legacy photoreal default.
    styled = (style_suffix or "").strip().rstrip(".")
    tail = (f"Render in the project's locked visual style: {styled}." if styled
            else "Photorealistic, cinematic.")
    if tool == "markup":
        base = ("Apply the edit indicated by the annotations drawn directly on Image 1. "
                "Boxes / rectangles mark regions to change; circles highlight areas; arrows show where to "
                "move or place something; crosshair targets mark exact points. Make the described change at "
                "those marks, blending seamlessly with the image's existing style, and then REMOVE every "
                "annotation mark (boxes, circles, arrows, targets, freehand lines) from the final image so "
                "none remain visible. Keep the subject's identity and everything else unchanged.")
    elif tool == "place_in_env" and n_context_refs >= 1:
        base = ("Place the subject from Image 1 into the environment shown in Image 2. "
                "Preserve the subject's face, identity, hairstyle, body and wardrobe exactly as in Image 1. "
                "Match the environment's lighting direction, colour temperature and perspective, and add "
                f"correct contact shadows and matched depth of field so the subject sits naturally in the scene. "
                f"{tail}")
    elif tool == "wardrobe":
        base = ("Change the wardrobe of the character in Image 1. "
                "Keep the character's face, identity, body, pose and background unchanged. "
                f"Consistent lighting and believable fabric. {tail}")
    elif tool == "combine" and n_context_refs >= 1:
        base = ("Combine the subjects from the provided reference images into a single cohesive "
                "scene. Preserve each subject's face, identity and proportions; match lighting and perspective "
                f"across them. {tail}")
    # DEPICTS — the object is the output, the people are its CONTENT. `combine` puts the
    # subjects together in a scene; this puts them INSIDE something: a photograph on a
    # fridge, a face on a briefing-room screen, a portrait on a wall. Without it, an asset
    # like DRAMA QUEEN 3's "2011 Polaroid photo — young Joel and Mara grinning" renders
    # from its own words alone and the couple in the picture are strangers. The reference
    # images are supplied for their FACES only; the instruction owns everything else, so
    # the wording has to defeat the model's default reading of image 1 as the subject.
    elif tool == "depicts":
        base = ("The reference images are IDENTITY REFERENCES: they exist only to fix the faces "
                "of the people who appear inside the object described below. Do NOT output a "
                "portrait, a character sheet, or a scene of those people. Output the OBJECT "
                "itself, framed as the object — every person visible on or within it must be "
                "one of the referenced people, with their face, hair, skin tone and build "
                "preserved exactly. Reproduce the object's own medium and physical condition "
                "(print grain, screen pixels and scanlines, paper texture, creases, glare, "
                "reflections, ageing) over the depicted faces, and ignore the reference "
                "images' backgrounds, wardrobe, poses, framing and lighting unless the "
                f"description below asks for them. {tail}")
    else:  # edit_feature / edit / underspecified place_in_env|combine → free instruction
        base = ("Edit Image 1 as instructed below. Change ONLY what is described; keep the subject's identity, "
                f"composition, framing and everything else unchanged. {tail}")
    # A SHEET IS NOT A SCENE, said where the description cannot outvote it. The neutral
    # backdrop reaches this function only inside `style_suffix`, and a description that
    # says "wall mounted" or "on the nightstand" beats it every time — measured on BLACK
    # MIRROR (2026-08-15): with the neutral suffix applied, "Large wall mounted display"
    # still came back installed in a fully furnished oak boardroom. Old breakdowns are
    # full of descriptions written that way and they must keep working, so the sheet
    # instruction is stated as a rule ABOUT the output rather than left to the adjectives.
    if neutral_sheet:
        base += (" The output is a REFERENCE SHEET, not a frame of a film: show ONLY the "
                 "subject itself, isolated on the plain backdrop described below. No room, "
                 "no wall, no furniture, no floor, no scenery and no other objects around "
                 "it — if the description says it is mounted, fitted or resting on "
                 "something, render the subject alone anyway.")
    return f"{base} {instr}".strip() if instr else base


class AssetEditRequest(BaseModel):
    base_image: str                              # subject to edit — url | /abs/path | data-URI
    tool: str = "edit"                           # place_in_env|wardrobe|edit_feature|combine|edit
    instruction: str = ""                        # free-text edit note
    reference_images: list[str] = []             # context refs (env / wardrobe / other char)
    size: str = "2K"                             # Pro tops out at 2K
    output_format: str = "png"                   # png = lossless
    # LOCKED project style — replaces the legacy hardcoded "Photorealistic" tail.
    style_suffix: str = ""
    # WHAT KIND OF SHEET this edit produces ('character' | 'prop' | 'wardrobe' | …).
    # An edit that IS an asset sheet has to obey the same neutral-sheet rule every other
    # sheet obeys (`_sheet_style`): flat studio light, mid-grey seamless background, no
    # grade. It did not, because this endpoint only ever saw the project's locked style —
    # so the two paths that render a sheet through here, the wardrobe variant and the
    # dependent asset, produced framed-scene images while every other sheet was neutral.
    # Measured 2026-08-15: BLACK MIRROR's briefing-room screen came back mounted on a
    # rough stone wall carrying "photorealistic, hyperdetailed, 8k, DSLR". Empty keeps
    # the old behaviour, so an ordinary edit (markup, place_in_env) is untouched.
    asset_type: str = ""
    # Non-destructive versioning (optional): persist as a new version of this asset
    save_version: bool = False
    asset_rel_path: str = ""                     # e.g. "Assets/Characters/Alastor"
    project_name: str = ""
    project_path: str = ""


@app.post("/api/assets/edit")
async def edit_asset(req: AssetEditRequest):
    """Seedream 5.0 Pro image edit. Returns the edited image URL (+ a persisted
    localPath when save_version is set). Never overwrites the approved original."""
    if not (req.base_image or "").strip():
        raise HTTPException(status_code=400, detail="base_image is required (the subject to edit)")
    if req.tool and req.tool.lower() not in EDIT_TOOLS:
        raise HTTPException(status_code=400, detail=f"unknown tool {req.tool!r}")
    api = get_byteplus()
    ctx = [r for r in req.reference_images if (r or "").strip()]
    # A sheet is a technical document, not a frame of the film — the same rule the
    # doctor and the sheet writer already follow, applied to the two sheet-producing
    # edit paths that were bypassing it.
    _, _edit_suffix, _neutral = _sheet_style(req.asset_type, "", req.style_suffix)
    if _neutral:
        logger.info("[Edit] %s sheet → neutral treatment instead of the locked style", req.asset_type)
    prompt = _edit_prompt(req.tool, req.instruction, len(ctx), _edit_suffix, _neutral)
    # Image 1 = subject first, then context refs in order.
    refs = [{"url": req.base_image}] + [{"url": r} for r in ctx]
    await bus.publish("seedream", "active", f"Editing ({req.tool})…", 10)
    try:
        urls = await asyncio.to_thread(
            api.edit_image,
            prompt=prompt,
            reference_images=refs,
            size=req.size or "2K",
            output_format=req.output_format or "png",
            project_path=req.project_path,
        )
    except Exception as e:
        await bus.publish("seedream", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))
    if not urls:
        await bus.publish("seedream", "error", "Pro returned no image")
        raise HTTPException(status_code=502, detail="Seedream Pro returned no image")

    result: dict = {"url": urls[0], "prompt": prompt, "localPath": ""}
    # Persist the edit so the 24h CDN link can't strand it; version it if asked.
    if req.save_version and req.asset_rel_path and req.project_name:
        try:
            import requests as _req, base64 as _b64
            resp = await asyncio.to_thread(_req.get, urls[0], timeout=120)
            resp.raise_for_status()
            saved = await asyncio.to_thread(
                proj_storage.save_asset_version,
                req.project_name, req.asset_rel_path,
                _b64.b64encode(resp.content).decode(),
                req.project_path,
                {"kind": "edit", "tool": req.tool, "instruction": req.instruction, "prompt": prompt},
            )
            result["localPath"] = saved["path"]
            result["version"] = saved["version"]
        except Exception as e:
            logger.warning("[Edit] version save failed (edit still returned): %s", e)
    await bus.publish("seedream", "active", "Edit rendered", 80)
    return result


class EditEnhanceRequest(BaseModel):
    instruction: str
    has_markup: bool = False
    has_refs: bool = False


@app.post("/api/assets/edit-enhance")
async def edit_enhance(req: EditEnhanceRequest):
    """Refine an edit instruction for the Pro editor (Seed 2.0 Pro — not Claude budget)."""
    if not (req.instruction or "").strip():
        raise HTTPException(status_code=400, detail="empty instruction")
    claude = get_claude()
    try:
        out = await asyncio.to_thread(
            claude.enhance_edit_instruction, req.instruction, req.has_markup, req.has_refs,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"instruction": out}


# ── Studio (Free Gen) — isolated, pipeline-independent generation ─────────────
# The Studio is a standalone Lumina-style playground. These routes are ADDITIVE
# and deliberately separate from the pipeline's /api/assets and /api/video
# endpoints, so nothing the Studio does can affect Script/Breakdown/SG/Final Cut.
# No project context, no disk save, no agent-bus publish — just generate + return.

class StudioImageRequest(BaseModel):
    prompt: str
    count: int = 1                                 # 1–4
    size: str = "2K"                               # "2K"|"4K" or exact "WxH" (≥3.7MP on seedream-5-0)
    reference_images: list[ReferenceImage] = []    # data URIs or https — image-to-image
    seed: int | None = None
    project_path: str = ""                         # active project root → usage metering
    # 'pro' (default, best reference fidelity, caps at ~2K) | 'lite' (takes the 2K/3K/4K
    # presets — image-seedream.md §2). Anything else falls back to the configured default;
    # the frontend never sends a raw model id, so a model swap stays a one-line env change.
    model: str = ""
    # FORMATO DE SALIDA, elegido por el usuario — sólo Studio. `png` (sin pérdida) o
    # `jpeg`; la UI dice "JPG" y el wire dice "jpeg", que es el valor documentado.
    # Fuentes: image-seedream.md §4 lo lista para seedream-5-0-lite; el tutorial oficial de
    # Seedream 5.0 pro ("Customize image output specifications") también lo lista, así que
    # ambos motores de Studio lo aceptan. Hasta ahora este endpoint no lo mandaba y
    # generate_image emitía su default "jpeg" — mientras /api/studio/save guardaba TODO
    # como .png. Es decir: bytes JPEG en ficheros .png. El guardado ahora huele los bytes.
    output_format: str = "png"


@app.post("/api/studio/image")
async def studio_image(req: StudioImageRequest):
    """Text-to-image / image-to-image with Seedream 5.0 — Studio only."""
    api = get_byteplus()
    refs = [{"url": r.url, "weight": r.weight} for r in req.reference_images if r.url] or None
    n = max(1, min(req.count or 1, 4))
    # Map the UI's choice to a configured model id — never trust a raw id from the client.
    # generate_image() already clamps a 3K/4K request down for Pro, so an unsupported
    # size/model pairing degrades instead of erroring.
    model_id = {"lite": api.SEEDREAM_LITE_MODEL, "pro": api.SEEDREAM_PRO_MODEL}.get(
        (req.model or "").strip().lower())
    # Variations render CONCURRENTLY. generate_image() loops n SEQUENTIALLY, so four Pro
    # variations at 2K ran back-to-back and could outlast the request — the caller timed
    # out and the whole batch was lost even though the images were still being produced
    # (2026-07-29). Fanning out n single-image calls turns that into roughly the time of
    # ONE image; Seedream is rated 500 IPM, so four in flight is nothing. Deliberately
    # done HERE and not inside generate_image, which the pipeline shares.
    async def _one() -> list[str]:
        return await asyncio.to_thread(
            api.generate_image,
            prompt=req.prompt,
            size=req.size or "2K",
            n=1,
            reference_images=refs,
            seed=req.seed,
            project_path=req.project_path,
            model=model_id,
            output_format="jpeg" if (req.output_format or "").strip().lower() in ("jpg", "jpeg") else "png",
        )

    slots = await asyncio.gather(*(_one() for _ in range(n)), return_exceptions=True)
    urls = [u for s in slots if not isinstance(s, BaseException) for u in (s or [])]
    failed = [s for s in slots if isinstance(s, BaseException)]
    if not urls:
        # Every slot failed — surface the first real reason, not a generic 502.
        detail = str(failed[0]) if failed else "Seedream returned no image"
        raise HTTPException(status_code=502, detail=detail)
    if failed:
        # Partial success is reported, never silently presented as a full set.
        logger.warning("[Studio] %d/%d variation(s) failed: %s", len(failed), n, failed[0])
    # Report the model that ACTUALLY ran (SEEDREAM_MODEL, Pro by default). The Studio UI
    # used to carry a hardcoded "Seedream 5.0 Lite" label that silently went stale when
    # the default moved to Pro — returning it keeps the badge honest for free.
    return {"urls": urls, "model": model_id or api.SEEDREAM_MODEL,
            "requested": n, "failed": len(failed)}


class StudioMotionPromptRequest(BaseModel):
    """Studio 'Animate': read a still and propose the MOTION to animate it with."""
    image: str                   # disk path | https url | data URI
    hint: str = ""               # optional direction from the user, honoured verbatim


@app.post("/api/studio/motion-prompt")
async def studio_motion_prompt(req: StudioMotionPromptRequest):
    """Vision-read a Studio image → a Seedance i2v motion prompt (Studio only)."""
    if not (req.image or "").strip():
        raise HTTPException(status_code=400, detail="image is required")
    api = get_byteplus()
    text = await asyncio.to_thread(api.motion_prompt_vision, req.image, req.hint)
    if not text:
        raise HTTPException(status_code=502, detail="Could not read that image — describe the motion yourself.")
    return {"prompt": text}


class StudioEnhanceRequest(BaseModel):
    prompt: str
    mode: str = "image"          # 'image' (full prompt) | 'refine' (edit instruction)


@app.post("/api/studio/enhance-prompt")
async def studio_enhance_prompt(req: StudioEnhanceRequest):
    """Claude rewrites the user's idea into a Seedream-5.0-tuned prompt/instruction."""
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Empty prompt")
    claude = get_claude()
    try:
        enhanced = await asyncio.to_thread(claude.enhance_prompt_seedream, req.prompt, req.mode)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return {"prompt": enhanced}


class StudioVideoRequest(BaseModel):
    prompt: str
    mode: str = "t2v"                 # t2v | i2v | first_last | multimodal
    images: list[str] = []            # urls / data-URIs
    videos: list[str] = []            # multimodal refs — 0–3 on 2.0, 0–10 on 2.5
    audios: list[str] = []            # multimodal refs — 0–3 on 2.0, 0–10 on 2.5
    ratio: str = "16:9"               # 21:9|16:9|4:3|1:1|3:4|9:16|adaptive
    resolution: str = "720p"          # 480p|720p|1080p|4k (2.5 tops out at 1080p; 4k is base 2.0)
    duration: int = 5                 # 4–15 on 2.0, 4–30 on 2.5, or -1 (auto)
    generate_audio: bool = True
    # 'base' (default, the only one with 1080p/4k) | 'fast' | 'mini' | 'v25'. The client
    # sends the tier, never a raw model id, so swapping a model stays a one-line env
    # change. 'v25' is opt-in: 30 s clips and a 50-material reference budget, 1080p max.
    model: str = "base"
    output_format: str = ""           # 'mp4' | 'mov' — accepted by Seedance 2.5 only


# task_id → temp R2 object keys (reference videos), deleted once the task finishes
STUDIO_VIDEO_TMP: dict[str, list[str]] = {}


@app.post("/api/studio/video")
async def studio_video(req: StudioVideoRequest):
    """Submit a Seedance 2.0 video task — Studio only (isolated from the pipeline).
    Reference videos must be public URLs (Seedance rejects base64), so data-URI
    videos are uploaded to R2 first and removed when the task completes."""
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Empty prompt")
    api = get_byteplus()

    import r2_storage, base64 as _b64
    videos = list(req.videos)
    r2_keys: list[str] = []
    if req.mode == "multimodal" and any(v.startswith("data:") for v in videos):
        if not r2_storage.is_configured():
            raise HTTPException(status_code=503, detail="Reference videos need a public URL — configure R2_* in .env (Seedance won't accept an uploaded video as base64).")
        out: list[str] = []
        for v in videos:
            if not v.startswith("data:"):
                out.append(v)
                continue
            try:
                header, b64 = v.split(",", 1)
                raw = _b64.b64decode(b64)
                mime = header.split(";", 1)[0].split(":", 1)[1] if ":" in header else "video/mp4"
                ext = "mov" if ("mov" in mime or "quicktime" in mime) else ("webm" if "webm" in mime else "mp4")
                key, url = await asyncio.to_thread(r2_storage.upload_temp, raw, ext, mime)
                r2_keys.append(key)
                out.append(url)
            except Exception as e:
                if r2_keys:
                    await asyncio.to_thread(r2_storage.delete, r2_keys)
                raise HTTPException(status_code=502, detail=f"R2 upload failed: {e}")
        videos = out

    model_id = {"fast": api.SEEDANCE_FAST_MODEL, "mini": api.SEEDANCE_MINI_MODEL,
                "v25": api.SEEDANCE_25_MODEL}.get((req.model or "").strip().lower())
    try:
        res = await asyncio.to_thread(
            api.create_studio_video,
            prompt=req.prompt, mode=req.mode, images=req.images, videos=videos,
            audios=req.audios, ratio=req.ratio, resolution=req.resolution,
            duration=req.duration, generate_audio=req.generate_audio,
            model=model_id, output_format=req.output_format,
        )
    except ValueError as e:
        # The capability guard fired (e.g. 4k on Mini) — a 400 with the real reason
        # beats letting the vendor reject it after the user waited out a render.
        if r2_keys:
            await asyncio.to_thread(r2_storage.delete, r2_keys)
        raise HTTPException(status_code=400, detail=str(e))
    if not res.get("task_id"):
        if r2_keys:
            await asyncio.to_thread(r2_storage.delete, r2_keys)
        raise HTTPException(status_code=502, detail=res.get("error") or "Seedance submit failed")
    if r2_keys:
        STUDIO_VIDEO_TMP[res["task_id"]] = r2_keys
    return {"task_id": res["task_id"]}


@app.get("/api/studio/video/{task_id}")
async def studio_video_poll(task_id: str):
    """One status check for a Studio video task (queued/running/completed/failed)."""
    api = get_byteplus()
    result = await asyncio.to_thread(api.poll_video_task, task_id, 1, 1)
    if result.get("status") in ("completed", "failed") and task_id in STUDIO_VIDEO_TMP:
        import r2_storage
        await asyncio.to_thread(r2_storage.delete, STUDIO_VIDEO_TMP.pop(task_id, []))
    return result


# ── AI MediaKit upscales — Studio clips and Stage 6 masters (byteplus_mediakit.py) ────
class StudioUpscaleRequest(BaseModel):
    video: str                        # our /api/asset/serve url, an absolute disk path, or a public https url
    resolution: str = "4k"            # the UI offers 2k | 4k | 8k; any enhance-video value is accepted
    tier: str = "standard"            # standard | professional (10× the price — large-model restoration)
    scene: str = "aigc"               # standard only: common | ugc | short_series | aigc | old_film
    style: str = "hd"                 # hd | natural (natural = softer, less oil-paint on AI faces)
    duration_secs: float = 0.0        # the client's measurement; a local file is re-probed here
    # Where the finished clip is saved (the project's Studio/Videos, or the standalone
    # Studio folder). The SERVER finishes the task now, even with the tab gone, so it has
    # to know this at submit — the browser used to do the saving and no longer has to.
    project_name: str = ""
    project_path: str = ""


class StudioUpscaleQuoteRequest(BaseModel):
    resolution: str = "4k"
    tier: str = "standard"
    duration_secs: float = 0.0
    fps: float = 24.0                 # Seedance renders at 24 — the ≤30 fps price band
    # A served url or disk path: when given, the server measures the clip itself —
    # its length for the price, and its size against the vendor's 2K input ceiling.
    path: str = ""


def _local_media_path(ref: str) -> "str | None":
    """The disk path behind a Studio media reference, or None when it is a foreign url.

    Accepts our own /api/asset/serve url (whatever origin the client built it on) and an
    absolute path, and gates the result exactly like /api/asset/serve does — otherwise
    this endpoint would ship any file on the machine to a public bucket."""
    from urllib.parse import urlparse, parse_qs
    p = (ref or "").strip()
    if p.startswith("http://") or p.startswith("https://"):
        u = urlparse(p)
        if not u.path.endswith("/api/asset/serve"):
            return None
        p = (parse_qs(u.query).get("path") or [""])[0]      # parse_qs already percent-decodes
    if not p.startswith("/"):
        return None
    ap = os.path.abspath(p)
    if not _inside_project_tree(ap):
        raise HTTPException(status_code=403, detail="Path outside project storage")
    if not os.path.isfile(ap):
        raise HTTPException(status_code=404, detail="Source clip not found on disk")
    return ap


@app.post("/api/studio/upscale/quote")
async def studio_upscale_quote(req: StudioUpscaleQuoteRequest):
    """The price of one upscale BEFORE it is submitted, from the published coefficient
    table — so the picker can show it while the director is still choosing."""
    import byteplus_mediakit as mk
    try:
        mk.validate(req.resolution, req.tier, "aigc", "hd")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    secs, dims, input_note = req.duration_secs, None, ""
    local = _local_media_path(req.path) if req.path else None
    if local:
        secs = (await asyncio.to_thread(_probe_audio_seconds, local)) or secs
        dims = await asyncio.to_thread(_probe_dimensions, local)
        input_note = _mediakit_input_note(dims)
    return {
        "usd": mk.estimate_cost_usd(secs, req.resolution, req.tier, req.fps),
        "coefficient": mk.coefficient(req.resolution, req.tier, req.fps),
        "base_usd_per_min": mk.BASE_USD_PER_MIN,
        "seconds": secs,
        "width": dims[0] if dims else None,
        "height": dims[1] if dims else None,
        # Non-empty when the vendor would refuse this source (input is capped at 2K).
        "input_note": input_note,
    }


def _probe_dimensions(path: str) -> "tuple[int, int] | None":
    """(width, height) of the first video stream via ffprobe, or None when unreadable."""
    try:
        r = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
             "-of", "csv=p=0", path], capture_output=True, text=True, timeout=15)
        w, h = (int(x) for x in r.stdout.strip().split(",")[:2])
        return (w, h) if w > 0 and h > 0 else None
    except Exception:
        return None


# The vendor's input ceiling is "up to 2K" (enhance-video reference), i.e. 2560×1440.
# A native-4K Seedance export is therefore not upscalable — and does not need to be.
MEDIAKIT_MAX_INPUT = (2560, 1440)


def _mediakit_input_note(dims: "tuple[int, int] | None") -> str:
    if not dims:
        return ""
    long_side, short_side = max(dims), min(dims)
    if long_side <= MEDIAKIT_MAX_INPUT[0] and short_side <= MEDIAKIT_MAX_INPUT[1]:
        return ""
    return (f"AI MediaKit takes inputs up to 2K (2560×1440) — this file is {dims[0]}×{dims[1]}. "
            "Export at 1080p to upscale it.")


class EditUpscaleRequest(BaseModel):
    project_name: str
    project_path: str = ""            # custom storage root (localFolderRoot)
    render_path: str                  # the export on disk (Exports/render_*.mp4) — never a CDN url
    resolution: str = "4k"            # 2k | 4k | 8k
    tier: str = "standard"            # standard | professional
    style: str = "natural"            # natural is the vendor's own advice for AI-generated people
    scene: str = "aigc"


# ── The watcher: the server owns the wait ─────────────────────────────────────────
# A task the browser stopped polling — tab closed, reload, the client's 30-minute
# deadline, a backend restart — was still processed and BILLED, and its output (kept
# 24 h by the vendor) was never fetched. So every task is written to upscale_jobs.py at
# submit, a watcher polls the vendor until it ends and writes the file where it belongs,
# and at startup every job still running gets its watcher back. The client polls US,
# which answers from the ledger: cheap, and the same answer after a reload.
_UPSCALE_WATCHERS: dict[str, "asyncio.Task"] = {}
UPSCALE_POLL_SECS = 15                    # the vendor's QPS budget is 10/s account-wide; this is nowhere near
UPSCALE_GIVE_UP_SECS = 6 * 3600           # Professional 8K on a long film is slow, but not this slow


def _upscale_master_path(src: Path, resolution: str, tier: str) -> Path:
    """Exports/<render>_up<res>_<tier>.mp4 next to the export — never over an earlier master."""
    stem = f"{src.stem}_up{resolution}_{tier}"
    out = src.parent / f"{stem}{src.suffix or '.mp4'}"
    n = 2
    while out.exists():
        out = src.parent / f"{stem}_{n}{src.suffix or '.mp4'}"
        n += 1
    return out


async def _host_for_mediakit(local: str) -> tuple[list[str], str]:
    """Put a local clip on R2 for the task; returns (temp keys, public url)."""
    import r2_storage
    if not r2_storage.is_configured():
        raise HTTPException(status_code=503, detail=(
            "AI MediaKit needs a public url for the source clip — configure R2_* in .env"))
    src = Path(local)
    ext = src.suffix.lstrip(".").lower() or "mp4"
    mime = "video/quicktime" if ext == "mov" else ("video/webm" if ext == "webm" else "video/mp4")
    try:
        raw = await asyncio.to_thread(src.read_bytes)
        key, url = await asyncio.to_thread(r2_storage.upload_temp, raw, ext, mime)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"R2 upload failed: {e}")
    return [key], url


async def _submit_upscale(job: dict, source_url: str) -> dict:
    """Submit to the vendor, persist the job under its task_id, start its watcher."""
    import byteplus_mediakit as mk, r2_storage, upscale_jobs
    try:
        res = await asyncio.to_thread(
            mk.submit_enhance, source_url, resolution=job["resolution"], tool_version=job["tier"],
            scene=job["scene"], enhance_style=job["style"],
        )
    except Exception as e:
        if job.get("r2_keys"):
            await asyncio.to_thread(r2_storage.delete, job["r2_keys"])
        raise HTTPException(status_code=400 if isinstance(e, ValueError) else 502, detail=str(e))
    job = {**job, "task_id": res["task_id"], "status": "running"}
    await asyncio.to_thread(upscale_jobs.put, job)
    _watch_upscale(res["task_id"])
    return job


def _watch_upscale(task_id: str) -> None:
    if task_id in _UPSCALE_WATCHERS and not _UPSCALE_WATCHERS[task_id].done():
        return
    t = asyncio.create_task(_upscale_watch(task_id))
    _UPSCALE_WATCHERS[task_id] = t
    t.add_done_callback(lambda _t: _UPSCALE_WATCHERS.pop(task_id, None))


def _finish_studio(job: dict, result_url: str) -> dict:
    """Download the vendor's clip into the project's Studio/Videos. Worker thread."""
    import requests as _req
    with _req.get(result_url, stream=True, timeout=(30, 300)) as r:
        r.raise_for_status()
        buf = bytearray()
        for chunk in r.iter_content(1 << 20):
            buf.extend(chunk)
    name = job.get("project_name") or "_studio"
    saved = proj_storage.save_studio_item(name, "video", bytes(buf), "mp4", job.get("project_path") or "")
    return {"local_path": saved["path"], "filename": saved.get("filename", ""), "bytes": len(buf)}


def _finish_master(job: dict, result_url: str) -> dict:
    """Download the vendor's file and write the master with the EXPORT's own audio.

    The vendor keeps the audio track but resamples it (measured: 32 kHz in, 44.1 kHz
    out). The export's mix is the mastered, loudness-normalised programme, so it is
    remuxed back bit-for-bit over the upscaled picture; only when the export has no
    audio at all does the vendor's file stand as-is. No `-shortest`: the vendor's
    picture came back 1.5 frames shorter than a 12.063 s export (12.000 s), and
    trimming the audio to it dropped the tail of the mix — the audio stays whole and
    the last frame simply holds. Runs in a worker thread."""
    import requests as _req
    src, out = job["source"], Path(job["output"])
    tmp = out.with_name(out.stem + ".vendor.tmp.mp4")
    with _req.get(result_url, stream=True, timeout=600) as r:
        r.raise_for_status()
        with open(tmp, "wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
    try:
        if _has_audio(src):
            cmd = [FFMPEG_BIN, "-y", "-v", "error", "-i", str(tmp), "-i", src,
                   "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", str(out)]
            proc = subprocess.run(cmd, capture_output=True, timeout=600)
            if proc.returncode != 0:
                raise RuntimeError(f"audio remux failed: {proc.stderr.decode()[-300:]}")
        else:
            os.replace(tmp, out)
    finally:
        if tmp.exists():
            try:
                os.remove(tmp)
            except OSError:
                pass
    # Sidecar: what this master is, from what, at what price — auditable like every
    # other versioned write in the project.
    try:
        meta = {k: job[k] for k in ("source", "resolution", "tier", "style", "scene", "seconds", "usd")}
        meta.update({"task_id": job.get("task_id", ""), "vendor": "byteplus-ai-mediakit",
                     "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat()})
        with open(str(out) + ".meta.json", "w") as fh:
            json.dump(meta, fh, indent=2)
    except Exception as e:
        logger.warning("[Upscale] sidecar write failed (non-fatal): %s", e)
    return {"output_path": str(out), "filename": out.name, "bytes": out.stat().st_size}


async def _upscale_watch(task_id: str) -> None:
    """Poll one vendor task to its end, then finish it (file, ledger, cleanup)."""
    import byteplus_mediakit as mk, r2_storage, upscale_jobs
    first = await asyncio.to_thread(upscale_jobs.get, task_id)
    label = "master" if (first or {}).get("kind") == "master" else "clip"
    while True:
        job = await asyncio.to_thread(upscale_jobs.get, task_id)
        if not job or job.get("status") != "running":
            return
        elapsed = _time.time() - float(job.get("created_at") or _time.time())
        try:
            res = await asyncio.to_thread(mk.get_task, task_id)
        except Exception as e:
            # A blip — the vendor or the network. Try again; only the give-up clock ends it.
            logger.warning("[Upscale] poll %s failed (retrying): %s", task_id, e)
            res = {"status": "running"}
        if res.get("status") == "running":
            if elapsed > UPSCALE_GIVE_UP_SECS:
                final = {"status": "failed", "error": f"gave up after {int(elapsed // 3600)} h still running"}
                break
            await asyncio.sleep(UPSCALE_POLL_SECS)
            continue
        if res.get("status") == "completed":
            await bus.publish("seedance", "active", f"Writing the upscaled {label}…", 90)
            try:
                finish = _finish_master if job.get("kind") == "master" else _finish_studio
                written = await asyncio.to_thread(finish, job, res["video_url"])
            except Exception as e:
                final = {"status": "failed", "error": f"{label} write failed: {e}"}
            else:
                if job.get("kind") == "master":
                    # Metered where the master exists — a failed task is not billed either.
                    try:
                        usage.record("upscale", project_path=job.get("project_path") or "",
                                     resolution=job["resolution"], model=job["tier"],
                                     seconds=float(job.get("seconds") or 0), usd=float(job.get("usd") or 0))
                    except Exception:
                        pass
                final = {"status": "completed", "result": {
                    **written, "resolution": res.get("resolution") or job["resolution"],
                    "fps": res.get("fps"), "tool_version": res.get("tool_version") or job["tier"]}}
        else:
            final = {"status": "failed", "error": res.get("error") or "AI MediaKit task failed"}
        break
    try:
        await asyncio.to_thread(r2_storage.delete, job.get("r2_keys") or [])
    except Exception as e:
        logger.warning("[Upscale] temp source cleanup failed (non-fatal): %s", e)
    await asyncio.to_thread(upscale_jobs.update, task_id, **final, r2_keys=[])
    took = _time.time() - float(job.get("created_at") or _time.time())
    if final["status"] == "completed":
        await bus.publish("seedance", "completed", f"Upscaled {label} ready: {final['result'].get('filename', '')}", 100)
        logger.info("[Upscale] %s %s done in %.0fs → %s", label, task_id, took,
                    final["result"].get("local_path") or final["result"].get("output_path"))
    else:
        await bus.publish("seedance", "error", f"Upscale failed: {final['error']}")
        logger.warning("[Upscale] %s %s failed after %.0fs: %s", label, task_id, took, final["error"])


async def _resume_upscale_jobs() -> None:
    """At startup: every job still running gets its watcher back; old finished ones go."""
    import upscale_jobs
    try:
        jobs = await asyncio.to_thread(upscale_jobs.running)
        dropped = await asyncio.to_thread(upscale_jobs.prune)
    except Exception as e:
        logger.warning("[Upscale] resume skipped: %s", e)
        return
    for j in jobs:
        _watch_upscale(j["task_id"])
    if jobs or dropped:
        logger.info("[Upscale] resumed %d running job(s), pruned %d finished", len(jobs), dropped)


def _upscale_job_view(job: dict) -> dict:
    """What the two poll endpoints answer: the job, flattened for the client."""
    out = {"status": job.get("status"), "task_id": job.get("task_id"), "kind": job.get("kind"),
           "seconds": job.get("seconds"), "usd": job.get("usd"), "resolution": job.get("resolution"),
           "tier": job.get("tier"), "elapsed": round(_time.time() - float(job.get("created_at") or _time.time()))}
    if job.get("status") == "completed":
        out.update(job.get("result") or {})
    elif job.get("status") == "failed":
        out["error"] = job.get("error") or "AI MediaKit task failed"
    return out


@app.post("/api/studio/upscale")
async def studio_upscale(req: StudioUpscaleRequest):
    """Submit an AI MediaKit enhancement for a Studio clip — Studio only.

    The vendor downloads the source from a PUBLIC url, and Studio clips live on this
    machine, so a local clip is hosted on R2 first and removed when the task finishes —
    the same hand-off Seedance reference videos use in studio_video above. A foreign
    https url (a still-live Seedance CDN link) is passed through untouched. The wait is
    the server's (see _upscale_watch); the client just asks how it is going."""
    import byteplus_mediakit as mk
    if not mk.is_configured():
        raise HTTPException(status_code=503, detail=(
            "BYTEPLUS_MEDIAKIT_API_KEY not set — create one in the AI MediaKit console "
            "(Settings → Create API key), add it to .env and restart the backend"))
    try:
        mk.validate(req.resolution, req.tier, req.scene, req.style)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    local = _local_media_path(req.video)
    secs = float(req.duration_secs or 0.0)
    r2_keys: list[str] = []
    if local:
        secs = (await asyncio.to_thread(_probe_audio_seconds, local)) or secs
        r2_keys, source_url = await _host_for_mediakit(local)
    elif req.video.startswith("http://") or req.video.startswith("https://"):
        source_url = req.video
    else:
        raise HTTPException(status_code=400, detail="video must be a served url, a disk path or a public https url")
    job = await _submit_upscale({
        "kind": "studio", "source": local or req.video, "r2_keys": r2_keys,
        "project_name": req.project_name, "project_path": req.project_path,
        "resolution": req.resolution, "tier": req.tier, "style": req.style, "scene": req.scene,
        "seconds": secs, "usd": mk.estimate_cost_usd(secs, req.resolution, req.tier),
    }, source_url)
    return {"task_id": job["task_id"], "seconds": secs, "estimated_cost_usd": job["usd"]}


@app.get("/api/studio/upscale/{task_id}")
async def studio_upscale_poll(task_id: str):
    """How a Studio upscale is going — answered from the ledger, so it costs nothing and
    says the same thing after a reload. `local_path` arrives when the clip is on disk."""
    import upscale_jobs
    job = await asyncio.to_thread(upscale_jobs.get, task_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown upscale task")
    return _upscale_job_view(job)


@app.post("/api/edit/upscale")
async def edit_upscale(req: EditUpscaleRequest):
    """Send a finished export to AI MediaKit for a 2K/4K/8K master.

    Runs on the EXPORT, not on the shots: one task, only the programme's minutes are
    paid, and the ffmpeg pipeline keeps working at 1080p. The master is written next
    to the export — the export itself is never replaced. The vendor downloads from a
    public url, so the export is hosted on R2 for the task; the server waits for the
    result (see _upscale_watch) and writes the master whether or not the tab is open."""
    import byteplus_mediakit as mk
    if not mk.is_configured():
        raise HTTPException(status_code=503, detail=(
            "BYTEPLUS_MEDIAKIT_API_KEY not set — create one in the AI MediaKit console "
            "(Settings → Create API key), add it to .env and restart the backend"))
    try:
        mk.validate(req.resolution, req.tier, req.scene, req.style)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    local = _local_media_path(req.render_path)
    if not local:
        raise HTTPException(status_code=400, detail="render_path must be an export on disk")
    note = _mediakit_input_note(await asyncio.to_thread(_probe_dimensions, local))
    if note:
        raise HTTPException(status_code=400, detail=note)
    secs = (await asyncio.to_thread(_probe_audio_seconds, local)) or 0.0
    out_path = _upscale_master_path(Path(local), req.resolution, req.tier)
    await bus.publish("seedance", "active", f"Hosting the export for AI MediaKit ({req.resolution.upper()} {req.tier})…", 5)
    r2_keys, source_url = await _host_for_mediakit(local)
    job = await _submit_upscale({
        "kind": "master", "source": local, "output": str(out_path), "r2_keys": r2_keys,
        "project_name": req.project_name, "project_path": req.project_path,
        "resolution": req.resolution, "tier": req.tier, "style": req.style, "scene": req.scene,
        "seconds": secs, "usd": mk.estimate_cost_usd(secs, req.resolution, req.tier),
    }, source_url)
    await bus.publish("seedance", "active", f"AI MediaKit is upscaling the master to {req.resolution.upper()}…", 15)
    return {"task_id": job["task_id"], "seconds": secs, "estimated_cost_usd": job["usd"],
            "output_path": str(out_path), "filename": out_path.name}


@app.get("/api/edit/upscale/{task_id}")
async def edit_upscale_poll(task_id: str):
    """How a master upscale is going — from the ledger. `output_path` arrives when the
    master is written, with the export's audio, its sidecar and its ledger entry."""
    import upscale_jobs
    job = await asyncio.to_thread(upscale_jobs.get, task_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown upscale task")
    return _upscale_job_view(job)


class StudioTTSRequest(BaseModel):
    text: str
    speaker: str = "en_female_stokie_uranus_bigtts"
    format: str = "mp3"               # mp3 | ogg_opus | pcm
    sample_rate: int = 24000
    speech_rate: int = 0              # [-50, 100]
    loudness_rate: int = 0           # [-50, 100]
    emotion: str = ""
    project_name: str = ""
    project_path: str = ""


@app.post("/api/studio/tts")
async def studio_tts(req: StudioTTSRequest):
    """Seed TTS 2.0 — synthesize speech, save to the project's Studio/Audio, return
    the served path. Isolated from the pipeline; uses SEED_TTS_API_KEY."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Empty text")
    import byteplus_tts
    try:
        audio = await byteplus_tts.synthesize(
            req.text, req.speaker, fmt=req.format, sample_rate=req.sample_rate,
            speech_rate=req.speech_rate, loudness_rate=req.loudness_rate,
            emotion=req.emotion or None,
        )
    except RuntimeError as e:
        detail = str(e)
        raise HTTPException(status_code=503 if "SEED_TTS_API_KEY" in detail else 502, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TTS failed: {e}")
    ext = "ogg" if "ogg" in req.format else ("wav" if req.format == "pcm" else "mp3")
    saved = await asyncio.to_thread(
        proj_storage.save_studio_item, req.project_name, "audio", audio, ext, req.project_path,
    )
    return {"local_path": saved["path"], "filename": saved.get("filename", ""), "bytes": len(audio)}


# ── Studio: Seed Audio 1.0 (separate engine from Seed TTS 2.0 above) ─────────
# Seed Audio is a DIFFERENT product on a DIFFERENT host (voice.ap-southeast-1,
# X-Api-Key) — see audio-generation.md. It adds voice CLONING from a reference clip
# and voice DESIGN from a portrait, which Seed TTS 2.0 can't do. Both engines stay
# available: this endpoint is additive and /api/studio/tts is untouched.
_SEED_AUDIO_MAX_TEXT = 2048        # audio-generation.md §4: text_prompt hard limit


def _materialize_audio_ref(src: str, kind: str) -> tuple[str, str, str]:
    """Bridge a Studio reference to what seed_audio.synthesize accepts (a local PATH
    or a remote URL) — the browser sends `data:` URIs for uploads. Returns
    (path, url, tmp_to_clean); exactly one of path/url is non-empty. Format + size
    validation deliberately stays in seed_audio (_ref_from_path / _image_ref_from_path)
    so a bad file fails with the documented limit message, in ONE place."""
    import base64 as _b64, tempfile as _tf
    src = (src or "").strip()
    if not src:
        return "", "", ""
    if src.startswith(("http://", "https://")):
        return "", src, ""
    if not src.startswith("data:"):
        return src, "", ""                                  # already a local path
    header, _, b64 = src.partition(",")
    mime = header[5:].split(";", 1)[0]
    ext = {
        "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
        "audio/ogg": ".ogg", "audio/opus": ".ogg", "audio/pcm": ".pcm",
        "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    }.get(mime, ".mp3" if kind == "audio" else ".png")
    tf = _tf.NamedTemporaryFile(suffix=ext, delete=False)
    try:
        tf.write(_b64.b64decode(b64))
    finally:
        tf.close()
    return tf.name, "", tf.name


class StudioAudioRequest(BaseModel):
    text: str
    # Voice source — pick ONE. A reference wins over `speaker`; an IMAGE reference can
    # NEVER be combined with an audio reference (audio-generation.md §5).
    speaker: str = ""                 # Doubao / voice-clone id; "" → default text-only voice
    reference_audio: str = ""         # data URI | https | local path → clone that voice (@Audio1)
    reference_image: str = ""         # data URI | https | local path → design a voice from a portrait
    format: str = "mp3"               # wav | mp3 | pcm | ogg_opus
    sample_rate: int = 24000          # 8000|16000|24000|32000|44100|48000
    speech_rate: int = 0              # [-50, 100]
    pitch_rate: int = 0               # [-12, 12]
    loudness_rate: int = 0            # [-50, 100]
    emotion: str = ""
    project_name: str = ""
    project_path: str = ""
    # ── Full Seed Audio surface (Studio only; the pipeline's synthesize() path is
    #    untouched and ignores every field below).
    # 'voice' = one line in one voice (the original behaviour, wrapped in the cloning
    # template). 'scene' = the prompt IS the scene — environment, score, SFX and who
    # says what — sent VERBATIM, which is what unlocks soundtracks.
    mode: str = "voice"               # voice | scene
    reference_audios: list[str] = []  # scene mode: up to 3 clips → @Audio1..@Audio3
    multilingual: bool = True         # only this model does 20 languages + [s:s] timing
    subtitles: bool = False           # return word/sentence timestamps


@app.post("/api/studio/audio")
async def studio_audio(req: StudioAudioRequest):
    """Seed Audio 1.0 — synthesize speech (optionally cloning a reference voice or
    designing one from a portrait), save to the project's Studio/Audio and return the
    served path. Isolated from the pipeline; uses SEED_AUDIO_API_KEY."""
    import seed_audio
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    # SCENE mode gets the model's real ceiling; VOICE mode keeps the tighter one it has
    # always used (its prompt is wrapped in a cloning template, so it must leave headroom).
    cap = seed_audio.MAX_PROMPT_CHARS if req.mode == "scene" else _SEED_AUDIO_MAX_TEXT
    if len(text) > cap:
        raise HTTPException(status_code=400, detail=(
            f"Text is {len(text)} characters — the limit is {cap}. Split it into shorter takes."))
    if req.reference_audio.strip() and req.reference_image.strip():
        raise HTTPException(status_code=400, detail=(
            "Use EITHER a voice clip OR a portrait as the reference — Seed Audio never "
            "accepts both in one request."))

    # ── SCENE (T2A / TA2A): the prompt IS the scene and goes VERBATIM. Up to three
    #    clips become @Audio1..@Audio3 in upload order.
    if req.mode == "scene":
        clips = [c for c in (req.reference_audios or []) if (c or "").strip()][:seed_audio.MAX_REF_AUDIOS]
        if clips and req.reference_image.strip():
            raise HTTPException(status_code=400, detail=(
                "A portrait cannot be combined with voice clips — Seed Audio takes one or the other."))
        tmps: list[str] = []
        refs: list[str] = []
        for c in clips:
            p, u, t = _materialize_audio_ref(c, "audio")
            refs.append(p or u)
            if t:
                tmps.append(t)
        ip, iu, it_ = _materialize_audio_ref(req.reference_image, "image")
        if it_:
            tmps.append(it_)
        try:
            out = await asyncio.to_thread(
                seed_audio.generate, text,
                audio_refs=refs or None, image_ref=(ip or iu) or None,
                speaker=req.speaker.strip() or None,
                multilingual=req.multilingual, subtitles=req.subtitles,
                fmt=req.format, sample_rate=req.sample_rate,
                speech_rate=req.speech_rate, pitch_rate=req.pitch_rate,
                loudness_rate=req.loudness_rate,
            )
        except RuntimeError as e:
            detail = str(e)
            raise HTTPException(status_code=503 if "SEED_AUDIO_API_KEY" in detail else 502, detail=detail)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Seed Audio failed: {e}")
        finally:
            for t in tmps:
                try:
                    os.unlink(t)
                except OSError:
                    pass
        ext = "ogg" if "ogg" in req.format else ("wav" if req.format in ("pcm", "wav") else "mp3")
        saved = await asyncio.to_thread(
            proj_storage.save_studio_item, req.project_name, "audio", out["audio"], ext, req.project_path,
        )
        return {"local_path": saved["path"], "filename": saved.get("filename", ""),
                "bytes": len(out["audio"]), "duration": out["duration"],
                "billed_seconds": out["original_duration"], "cost_usd": out["cost_usd"],
                "subtitle": out["subtitle"]}

    a_path, a_url, a_tmp = _materialize_audio_ref(req.reference_audio, "audio")
    i_path, i_url, i_tmp = _materialize_audio_ref(req.reference_image, "image")
    try:
        audio = await asyncio.to_thread(
            seed_audio.synthesize,
            text,
            reference_audio_path=a_path or None, reference_audio_url=a_url or None,
            image_reference_path=i_path or None, image_reference_url=i_url or None,
            speaker=req.speaker.strip() or None,
            fmt=req.format, sample_rate=req.sample_rate,
            speech_rate=req.speech_rate, pitch_rate=req.pitch_rate,
            loudness_rate=req.loudness_rate, emotion=req.emotion or None,
        )
    except RuntimeError as e:
        detail = str(e)
        raise HTTPException(status_code=503 if "SEED_AUDIO_API_KEY" in detail else 502, detail=detail)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Seed Audio failed: {e}")
    finally:
        for t in (a_tmp, i_tmp):                     # temp uploads are ours to clean
            if t:
                try:
                    os.unlink(t)
                except OSError:
                    pass

    ext = "ogg" if "ogg" in req.format else ("wav" if req.format in ("pcm", "wav") else "mp3")
    saved = await asyncio.to_thread(
        proj_storage.save_studio_item, req.project_name, "audio", audio, ext, req.project_path,
    )
    return {"local_path": saved["path"], "filename": saved.get("filename", ""), "bytes": len(audio)}


# ── Voice anchors + dialogue synthesis + mix ─────────────────────────────────
# "Same voice always" = each character gets a LOCKED voice config (speaker + pitch
# + rate), stored once in voice_anchors.json and reused for every line they speak —
# the audio analogue of the face anchor. The account's TTS resource currently
# exposes one base voice, so pitch/rate presets differentiate characters; a
# free-text `speaker` takes over once more voices are provisioned in the console.
BASE_VOICE = "en_female_stokie_uranus_bigtts"
# Real, distinct Seed TTS voices (validated live against this account's resource —
# each is a genuinely different voice, not a pitch-shift). pitch_rate/speech_rate stay
# available as per-character fine-tuning on top. More voices exist on the resource; a
# free-text speaker override in the picker reaches any of them.
VOICE_PRESETS = [
    {"id": "stokie", "label": "Stokie — EN female",         "speaker": "en_female_stokie_uranus_bigtts", "pitch_rate": 0, "speech_rate": 0},
    {"id": "dacey",  "label": "Dacey — EN female",          "speaker": "en_female_dacey_uranus_bigtts",  "pitch_rate": 0, "speech_rate": 0},
    {"id": "tim",    "label": "Tim — EN male",              "speaker": "en_male_tim_uranus_bigtts",      "pitch_rate": 0, "speech_rate": 0},
    {"id": "kian",   "label": "Kian — male, deep",          "speaker": "zh_male_m191_uranus_bigtts",     "pitch_rate": 0, "speech_rate": 0},
    {"id": "cedric", "label": "Cedric — male",              "speaker": "zh_male_taocheng_uranus_bigtts", "pitch_rate": 0, "speech_rate": 0},
    {"id": "magnus", "label": "Magnus — male, gravelly",    "speaker": "zh_male_dayi_uranus_bigtts",     "pitch_rate": 0, "speech_rate": 0},
    {"id": "seven",  "label": "Seven — male",               "speaker": "de_male_seven_uranus_bigtts",    "pitch_rate": 0, "speech_rate": 0},
    {"id": "felipe", "label": "Felipe — male",              "speaker": "es_male_felipe_uranus_bigtts",   "pitch_rate": 0, "speech_rate": 0},
    {"id": "minimi", "label": "Minimi — female, young",     "speaker": "jp_female_minimi_uranus_bigtts", "pitch_rate": 0, "speech_rate": 0},
]


def _concat_audio_files(paths: list[str], out_path: str) -> bool:
    """Concatenate line clips (each padded with 0.35 s of trailing silence) into one
    dialogue track."""
    if not paths:
        return False
    inputs: list[str] = []
    for p in paths:
        inputs += ["-i", p]
    n = len(paths)
    filt = "".join(f"[{i}:a]apad=pad_dur=0.35[a{i}];" for i in range(n))
    filt += "".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[out]"
    try:
        r = subprocess.run([FFMPEG_BIN, "-y", *inputs, "-filter_complex", filt,
                            "-map", "[out]", out_path], capture_output=True, timeout=120)
        return r.returncode == 0 and os.path.isfile(out_path)
    except Exception as e:
        logger.warning("[Dialogue] concat error: %s", e)
        return False


def _mix_dialogue_onto_video(video_path: str, dialogue_path: str, duck: bool) -> str | None:
    """Overlay the dialogue track onto the shot video (video stream copied). Either
    replaces the audio or ducks the Seedance audio under the dialogue. Writes
    <stem>.dub.mp4. Returns its path or None."""
    if not (os.path.isfile(video_path) and os.path.isfile(dialogue_path)):
        return None
    out = f"{os.path.splitext(video_path)[0]}.dub.mp4"
    if duck and _has_audio(video_path):
        # Real sidechain ducking, keyed on the dialogue itself. The old mix pinned the
        # Seedance ambience at a flat volume=0.18 for the WHOLE shot whether anyone was
        # speaking or not, so the room went half-dead under every line and stayed dead
        # through the silences — the opposite of what a mixer does. sidechaincompress
        # pulls the bed down only while there is speech and lets it back up after
        # (release=300ms, so it breathes instead of pumping).
        #
        # normalize=0 matters: amix divides by the input count by default, which quietly
        # dropped BOTH tracks ~6 dB here. Every other amix in this file already sets it.
        cmd = [FFMPEG_BIN, "-y", "-i", video_path, "-i", dialogue_path,
               "-filter_complex",
               "[1:a]asplit=2[dlg][key];"
               "[0:a][key]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300[amb];"
               "[amb][dlg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
               "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-shortest", out]
    else:
        # apad, NOT a bare -shortest. This branch runs when the picture has NO audio of
        # its own, which is exactly the audio-filter rescue: Seedance's filter trips, the
        # clip is re-rendered MUTE, and the lines are re-spoken and muxed back on. With a
        # bare -shortest ffmpeg cuts the output at the SHORTER input — the dialogue — so
        # the shot was being truncated to the length of its own lines. Measured on
        # BLACKMIRROR 4's SHOT_004 (2026-08-31): a 16.04s take came back as a 7.18s file,
        # nine seconds of picture gone, and the pipeline reported success. The duck branch
        # above never had this because its amix uses duration=first, i.e. the ambience.
        #
        # apad makes the dialogue stream effectively infinite by appending silence, so
        # -shortest now lands on the VIDEO and the take keeps its full length with the
        # lines sitting inside it.
        cmd = [FFMPEG_BIN, "-y", "-i", video_path, "-i", dialogue_path,
               "-filter_complex", "[1:a]apad[a]",
               "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-shortest", out]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=300)
        if r.returncode != 0 or not os.path.isfile(out):
            logger.warning("[Dialogue] mix failed: %s", r.stderr.decode()[:200])
            return None
        return out
    except Exception as e:
        logger.warning("[Dialogue] mix error: %s", e)
        return None


async def _synthesize_line(text: str, cfg: dict | None, *, fmt: str = "mp3",
                           sample_rate: int = 48000, emotion: str | None = None,
                           voice_profile: str | None = None,
                           meta: dict | None = None) -> bytes:
    """Render ONE line with a character's locked voice. If the anchor uses the Seed
    Audio 1.0 clone engine AND has a reference clip on disk, the line is cloned from
    that clip (same voice every time); otherwise it falls back to Seed TTS 2.0 preset
    voices — the existing, verified path. Single decision point for every caller.

    48 kHz, not the 24 kHz this defaulted to. Every other stage of the chain — the
    concat, the overlay composite, the mix — is pinned at 48 kHz, so dialogue was the
    one asset arriving at half rate and being resampled on the way in. Seed Audio
    documents 48000 as a supported rate, so this costs nothing but bytes.
    Documented rates: 8000 | 16000 | 24000 | 32000 | 44100 | 48000.

    Pass `meta` (a fresh dict per line) to learn whether Seed Audio silently dropped
    the voice reference and spoke the line in a GENERIC voice: it comes back with
    meta["voice_fallback"]=True. Only the two Seed Audio paths can fall back; the
    Seed TTS 2.0 path uses a preset voice ID and has nothing to fall back FROM, so it
    never sets it."""
    cfg = cfg or {}
    engine = cfg.get("engine") or "seed_tts"
    speaker = cfg.get("speaker") or BASE_VOICE
    pitch = int(cfg.get("pitch_rate", 0) or 0)
    rate = int(cfg.get("speech_rate", 0) or 0)
    loud = int(cfg.get("loudness_rate", 0) or 0)
    ref_path = cfg.get("ref_audio_path", "") or ""
    img_path = cfg.get("image_ref_path", "") or ""
    # Seed Audio 1.0 — clone (audio ref) or design (portrait → inferred voice).
    if engine == "seed_audio" and ref_path and os.path.isfile(ref_path):
        import seed_audio
        return await asyncio.to_thread(
            seed_audio.synthesize, text[:2000],
            reference_audio_path=ref_path, fmt=fmt, sample_rate=sample_rate,
            speech_rate=rate, pitch_rate=pitch, loudness_rate=loud, emotion=emotion,
            # The CLONE path only. seed_audio drops it on the image/preset paths, where a
            # second voice description would fight the one the reference already fixes.
            voice_profile=voice_profile,
            meta=meta,
        )
    if engine == "seed_audio_image" and img_path and os.path.isfile(img_path):
        import seed_audio
        return await asyncio.to_thread(
            seed_audio.synthesize, text[:2000],
            image_reference_path=img_path, fmt=fmt, sample_rate=sample_rate,
            speech_rate=rate, pitch_rate=pitch, loudness_rate=loud, emotion=emotion,
            meta=meta,
        )
    import byteplus_tts
    return await byteplus_tts.synthesize(
        text[:2000], speaker, fmt=fmt, sample_rate=sample_rate,
        pitch_rate=pitch, speech_rate=rate, emotion=emotion,
    )


@app.get("/api/voices")
def list_voices():
    """Voice catalog for the AG picker. Presets differentiate characters via pitch/
    rate over the account's confirmed base voice; `speaker` can be overridden with
    any voice ID provisioned on your BytePlus TTS resource."""
    return {"presets": VOICE_PRESETS, "base_voice": BASE_VOICE}


class VoiceAssignRequest(BaseModel):
    project_name: str = ""
    project_path: str = ""
    character: str
    speaker: str = BASE_VOICE
    pitch_rate: int = 0
    speech_rate: int = 0
    loudness_rate: int = 0
    engine: str = "seed_tts"          # "seed_tts" preset | "seed_audio" clone | "seed_audio_image" design-from-portrait
    ref_audio_path: str = ""          # Seed Audio 1.0 clone-source clip (set via /reference)
    image_ref_path: str = ""          # design mode: character portrait → inferred voice
    # How the voice SOUNDS, in words — e.g. "in a calm, warm female voice, mid-high
    # pitch, smooth, with a faint metallic edge". This is the only thing that holds a
    # character's timbre steady across a render: measured 2026-07-31, attaching the Seed
    # Audio clip as a reference did NOT carry identity (our female TTS came back as a
    # male voice, with and without the clip), while naming the timbre in the prompt gave
    # the same signature on every take. The `speaker` above still drives TTS and dubbing;
    # this drives the picture.
    voice_desc: str = ""
    notes: str = ""                   # "change with notes" — recorded on the version


@app.post("/api/character/voice")
async def assign_voice(req: VoiceAssignRequest):
    """Lock a character's voice — reused for every line they speak (cross-shot vocal
    identity). Each save appends a VERSION to the anchor history (with the change note)
    so a previous voice can be restored; nothing is overwritten destructively."""
    existing = await asyncio.to_thread(proj_storage.read_voice_anchor, req.project_name, req.character, req.project_path)
    cfg = {**existing,
           "speaker": req.speaker or BASE_VOICE,
           "pitch_rate": int(req.pitch_rate), "speech_rate": int(req.speech_rate),
           "loudness_rate": int(req.loudness_rate),
           "engine": req.engine or "seed_tts",
           # Preserve an existing description when the caller omits it — the voice panel
           # can save pitch/rate without wiping the timbre the picture depends on.
           "voice_desc": req.voice_desc or existing.get("voice_desc", ""),
           # keep any previously-uploaded clip / portrait so switching modes doesn't lose it
           "ref_audio_path": req.ref_audio_path or existing.get("ref_audio_path", ""),
           "image_ref_path": req.image_ref_path or existing.get("image_ref_path", "")}
    # Append a version snapshot (history + revert), newest last, capped at 10.
    import time as _t, uuid as _uuid
    version = {"id": _uuid.uuid4().hex[:8], "createdAt": int(_t.time() * 1000),
               "notes": req.notes or "", "engine": cfg["engine"], "speaker": cfg["speaker"],
               "pitch_rate": cfg["pitch_rate"], "speech_rate": cfg["speech_rate"],
               "loudness_rate": cfg["loudness_rate"],
               "ref_audio_path": cfg["ref_audio_path"], "image_ref_path": cfg["image_ref_path"]}
    cfg["versions"] = ((existing.get("versions") or []) + [version])[-10:]
    cfg["selectedVersionId"] = version["id"]
    # write_voice_anchor used to swallow its own failures and return None, so this
    # endpoint answered 200 with the config the user picked while nothing reached disk —
    # and the next line the character speaks comes out in a different voice. It raises
    # now; translate it into an error the panel and the agent monitor both show.
    try:
        await asyncio.to_thread(proj_storage.write_voice_anchor, req.project_name, req.character, cfg, req.project_path)
    except Exception as e:
        await bus.publish("tts", "error", f"Voice NOT locked for {req.character}: {e}")
        raise HTTPException(status_code=500,
                            detail=f"Voice for {req.character} was NOT saved ({e}) — their "
                                   f"next lines would use a different voice")
    # The scene-mode identity clip was cloned from the PREVIOUS config; it is now stale.
    await asyncio.to_thread(_drop_identity_clip, req.character, req.project_name, req.project_path)
    return {"character": req.character, "voice": cfg}


class VoiceReferenceRequest(BaseModel):
    project_name: str = ""
    project_path: str = ""
    character: str
    audio_b64: str                    # data URI or bare base64 of the reference clip
    ext: str = "mp3"                  # wav | mp3 | pcm | ogg (Seed Audio ref formats)


def _probe_audio_seconds(path: str) -> "float | None":
    """Duration of an audio/media file in seconds via ffprobe, or None if ffprobe
    is unavailable / the probe fails (best-effort — never blocks the upload)."""
    ffprobe = _find_ffmpeg().rsplit("ffmpeg", 1)[0] + "ffprobe"
    try:
        r = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=15)
        if r.returncode == 0 and r.stdout.strip():
            # ffprobe prints text: "N/A" raises below, but a broken container can print
            # "inf"/"nan", which float() accepts happily. Both are poison downstream — a
            # nan makes every comparison in the export's length guard False (the guard
            # silently stops guarding) and neither survives JSON encoding in
            # /api/asset/duration. "Not measurable" is None here, same as a failed probe.
            secs = float(r.stdout.strip())
            return secs if _math.isfinite(secs) else None
    except Exception as e:
        logger.debug("[VoiceRef] ffprobe duration probe failed: %s", e)
    return None


# ── Loudness (EBU R128) ───────────────────────────────────────────────────────
# There was no loudness stage anywhere in this codebase: every clip was mixed with
# fixed `volume=` constants and `amix ... normalize=0`, so 500 separately-generated
# clips each arrived at whatever level Seedance happened to produce. Over 45 minutes
# that is a volume jump at every cut — the most audible "this was made by a machine"
# tell in the whole pipeline, and the one thing a viewer notices before any visual.
#
# Default target is -16 LUFS / -1.5 dBTP, the streaming-web convention (YouTube,
# Spotify). Broadcast delivery wants -23 LUFS (EBU R128); both are env-overridable.
LOUDNESS_TARGET_I   = float(os.getenv("TAKEONE_LOUDNESS_I", "-16"))
LOUDNESS_TARGET_TP  = float(os.getenv("TAKEONE_LOUDNESS_TP", "-1.5"))
LOUDNESS_TARGET_LRA = float(os.getenv("TAKEONE_LOUDNESS_LRA", "11"))


def _finite_floats(obj: Any) -> Any:
    """Recursively replace every non-finite float (inf/-inf/nan) with None.

    JSON has no inf and no nan, so ONE of them anywhere in a response body makes
    FastAPI raise `ValueError: Out of range float values are not JSON compliant` and
    the endpoint returns 500 — with no hint that the work it describes succeeded.
    Measured: a three-clip film whose sources carry no audio track exported a complete
    480 KB mp4 and a complete .edl.json, and POST /api/edit/render still 500'd, because
    loudnorm reports a silent programme as "-inf" (and its offset as "inf") and that
    -inf went into the body verbatim. The user was told the render failed.

    Applied to the WHOLE dict, not the one field that bit: every number in a loudness
    result comes from ffmpeg's own measurements, and any of them can come back -inf.

    BACKSTOP, NOT THE FIX. The fix is the `isfinite(measured_i)` early return in
    _normalize_loudness, which stops on a silent programme before pass 2 and returns
    {"silent": True} with no ffmpeg number in it at all. Walking its five returns: two
    carry no float at all, two carry only `measured_i` (which that early return has
    already proved finite), and the last carries the LOUDNESS_TARGET_* env overrides —
    float(os.getenv(...)), so `TAKEONE_LOUDNESS_I=inf` is the one input that still gets
    this far. On the ffmpeg-measured values this function is a no-op today; it is kept
    because it costs one call at one call site and it is what makes the NEXT measurement
    added to that dict safe to put in a response body. Do not read it as the thing that
    keeps the endpoint alive.
    """
    if isinstance(obj, float):
        return obj if _math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _finite_floats(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_finite_floats(v) for v in obj]
    return obj


def _measure_loudness(path: str) -> dict | None:
    """Integrated loudness + true peak of a finished file, via the ebur128 scanner.
    Read-only — this is how a render's level is verified, not changed."""
    try:
        r = subprocess.run(
            [FFMPEG_BIN, "-hide_banner", "-nostats", "-i", path,
             "-af", "ebur128=peak=true", "-f", "null", "-"],
            capture_output=True, text=True, timeout=600)
        tail = r.stderr[-2000:]
        out: dict = {}
        for key, label in (("I:", "lufs"), ("LRA:", "lra"), ("Peak:", "peak_dbfs")):
            m = _re.findall(rf"{_re.escape(key)}\s+(-?\d+\.?\d*)\s*(?:LUFS|LU|dBFS)", tail)
            if m:
                out[label] = float(m[-1])
        return out or None
    except Exception as e:
        logger.debug("[Loudness] measure failed for %s: %s", path, e)
        return None


def _normalize_loudness(path: str, target_i: float | None = None,
                        target_tp: float | None = None,
                        target_lra: float | None = None) -> dict:
    """Two-pass EBU R128 normalisation of a finished render, in place.

    Two passes, not one: single-pass loudnorm works on a moving window and audibly
    pumps across a long programme. The first pass only measures; the second applies a
    linear gain computed from those measurements, so the mix's internal dynamics are
    preserved and only the overall level moves.

    NON-FATAL by design. A finished 45-minute episode is expensive; if anything here
    fails the original file is left exactly as it was and the render still succeeds.
    Returns {applied: bool, ...} for the caller to report.
    """
    ti = LOUDNESS_TARGET_I if target_i is None else target_i
    tp = LOUDNESS_TARGET_TP if target_tp is None else target_tp
    lra = LOUDNESS_TARGET_LRA if target_lra is None else target_lra
    common = f"I={ti}:TP={tp}:LRA={lra}"
    try:
        # Pass 1 — measure. print_format=json puts a JSON block at the end of stderr.
        r1 = subprocess.run(
            [FFMPEG_BIN, "-hide_banner", "-nostats", "-i", path,
             "-af", f"loudnorm={common}:print_format=json", "-f", "null", "-"],
            capture_output=True, text=True, timeout=1800)
        blocks = _re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", r1.stderr, _re.S)
        if not blocks:
            logger.warning("[Loudness] no measurement returned — leaving audio untouched")
            return {"applied": False, "reason": "measurement failed"}
        m = json.loads(blocks[-1])
        measured_i = float(m["input_i"])

        # A programme with nothing audible in it measures "-inf": the R128 gate never
        # opens, so there is no level to move. Stop HERE rather than run pass 2 — it
        # rejects the -inf outright ("Value -inf for parameter 'measured_I' out of
        # range [-99 - 0]") after setting up a full re-encode of the film, and the -inf
        # then travelled into the response body and 500'd a render that was finished.
        # `silent` is reported, not raised: the file on disk is correct and complete,
        # and there are legitimately silent cuts (a title-card montage, a reel scored
        # later in another tool). Failing it would destroy exactly what it describes.
        if not _math.isfinite(measured_i):
            logger.warning("[Loudness] %s has no audible programme (measured -inf) — "
                           "audio left untouched", os.path.basename(path))
            return {"applied": False, "reason": "silent programme", "silent": True}

        # Pass 2 — apply. linear=true is what keeps it from pumping; ffmpeg falls back
        # to dynamic mode on its own if the required gain would clip.
        norm = f"{os.path.splitext(path)[0]}.loudnorm{os.path.splitext(path)[1]}"
        r2 = subprocess.run(
            [FFMPEG_BIN, "-y", "-hide_banner", "-nostats", "-i", path,
             "-af", (f"loudnorm={common}:measured_I={m['input_i']}:"
                     f"measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
                     f"measured_thresh={m['input_thresh']}:"
                     f"offset={m['target_offset']}:linear=true"),
             "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
             "-movflags", "+faststart", norm],
            capture_output=True, text=True, timeout=3600)
        if r2.returncode != 0 or not os.path.isfile(norm):
            logger.warning("[Loudness] normalisation pass failed (keeping original): %s",
                           r2.stderr[-400:])
            return {"applied": False, "reason": "normalisation failed", "measured_lufs": measured_i}
        shutil.move(norm, path)
        logger.info("[Loudness] %s: %.1f LUFS → target %.1f LUFS (TP %.1f dBTP)",
                    os.path.basename(path), measured_i, ti, tp)
        return {"applied": True, "measured_lufs": measured_i, "target_lufs": ti,
                "target_tp": tp, "target_lra": lra}
    except Exception as e:
        logger.warning("[Loudness] skipped (keeping original): %s", e)
        return {"applied": False, "reason": str(e)[:200]}


@app.post("/api/character/voice/reference")
async def upload_voice_reference(req: VoiceReferenceRequest):
    """Store an actor's reference clip and switch their voice anchor to the Seed Audio
    1.0 clone engine, so every line clones from this clip (consistent voice per actor).
    The clip must be ≤30 s and ≤10 MB (Seed Audio limits) — enforced here so the user
    gets a clear error at upload instead of a silent fallback to a generic voice at
    render time."""
    if not req.character or not req.audio_b64:
        raise HTTPException(status_code=400, detail="character and audio_b64 required")
    import seed_audio, base64 as _b64
    try:
        raw = _b64.b64decode(req.audio_b64.split(",", 1)[-1])
    except Exception:
        raise HTTPException(status_code=400, detail="audio_b64 is not valid base64")
    if len(raw) > seed_audio.MAX_REF_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Reference clip is {len(raw) // (1024 * 1024)} MB — the Seed Audio limit is 10 MB")
    try:
        path = await asyncio.to_thread(
            proj_storage.save_voice_reference,
            req.project_name, req.character, req.audio_b64, req.ext, req.project_path,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to save reference clip: {e}")
    # Duration guard (best-effort — needs ffprobe). Over the limit → drop it + 400.
    dur = await asyncio.to_thread(_probe_audio_seconds, path)
    if dur is not None and dur > seed_audio.MAX_REF_SECONDS + 0.5:
        try:
            os.remove(path)
        except OSError:
            pass
        raise HTTPException(
            status_code=400,
            detail=f"Reference clip is {dur:.0f}s — keep it ≤ {seed_audio.MAX_REF_SECONDS}s for voice cloning")
    existing = await asyncio.to_thread(proj_storage.read_voice_anchor, req.project_name, req.character, req.project_path)
    cfg = {**existing, "engine": "seed_audio", "ref_audio_path": path,
           "speaker": existing.get("speaker") or BASE_VOICE,
           "pitch_rate": int(existing.get("pitch_rate", 0) or 0),
           "speech_rate": int(existing.get("speech_rate", 0) or 0)}
    try:                                    # see assign_voice — a swallowed write here
        await asyncio.to_thread(proj_storage.write_voice_anchor,  # means the uploaded clip
                                req.project_name, req.character, cfg, req.project_path)  # is never used
    except Exception as e:
        await bus.publish("tts", "error", f"Voice NOT locked for {req.character}: {e}")
        raise HTTPException(status_code=500,
                            detail=f"Reference clip saved to {path} but the voice lock for "
                                   f"{req.character} was NOT written ({e})")
    # Any cached identity clip was SYNTHESIZED; this real actor clip supersedes it, and
    # _identity_clip_for prefers ref_audio_path anyway — clear it so nothing can serve the
    # synthesized one if the anchor is later switched back off the clone engine.
    await asyncio.to_thread(_drop_identity_clip, req.character, req.project_name, req.project_path)
    return {"character": req.character, "voice": cfg, "ref_audio_path": path}


@app.get("/api/character/voices")
async def get_character_voices(project_name: str = "", project_path: str = ""):
    anchors = await asyncio.to_thread(proj_storage.read_voice_anchors, project_name, project_path)
    return {"voices": anchors}


class VoicePreviewRequest(BaseModel):
    text: str = "This is how I sound — the same in every scene."
    speaker: str = BASE_VOICE
    pitch_rate: int = 0
    speech_rate: int = 0
    loudness_rate: int = 0
    engine: str = "seed_tts"          # audition the SAME engine used at render time
    ref_audio_path: str = ""
    image_ref_path: str = ""


@app.post("/api/voice/preview")
async def preview_voice(req: VoicePreviewRequest):
    """Synthesize a short line so the user can audition a voice config before locking it —
    through the same engine (Seed TTS preset / Seed Audio clone / Seed Audio design-from-
    portrait) production will use."""
    import base64 as _b64
    cfg = {"speaker": req.speaker or BASE_VOICE, "pitch_rate": int(req.pitch_rate),
           "speech_rate": int(req.speech_rate), "loudness_rate": int(req.loudness_rate),
           "engine": req.engine or "seed_tts", "ref_audio_path": req.ref_audio_path,
           "image_ref_path": req.image_ref_path}
    # The audition is worthless if it lies about WHICH voice you heard: when Seed Audio
    # rejects the reference it answers in a generic voice, and the user would lock a
    # config believing that generic voice is the clone. Surface it.
    meta: dict = {}
    try:
        audio = await _synthesize_line(req.text[:300], cfg, meta=meta)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Voice preview failed: {e}")
    fell_back = bool(meta.get("voice_fallback"))
    if fell_back:
        logger.warning("[Voice] preview fell back to a generic voice (engine=%s, ref=%s): %s",
                       cfg["engine"], os.path.basename(req.ref_audio_path or req.image_ref_path) or "-",
                       meta.get("voice_fallback_reason", ""))
    return {"audio_b64": "data:audio/mp3;base64," + _b64.b64encode(audio).decode(),
            "voice_fallback": fell_back}


class DialogueLine(BaseModel):
    character: str = ""
    text: str
    emotion: str = ""


class ShotDialogueRequest(BaseModel):
    shot_id: str
    project_name: str = ""
    project_path: str = ""
    video_local_path: str = ""
    lines: list[DialogueLine] = []
    duck: bool = True


@app.post("/api/shot/dialogue")
async def generate_shot_dialogue(req: ShotDialogueRequest):
    """Render each dialogue line with its character's LOCKED voice (voice anchor),
    concatenate into one track, and mix it onto the shot video — so a character
    always sounds the same across every shot. Returns the dubbed video (+ its 720p
    preview proxy so it plays in-browser)."""
    import tempfile
    lines = [ln for ln in req.lines if ln.text.strip()]
    if not lines:
        raise HTTPException(status_code=400, detail="No dialogue lines")
    if not (req.video_local_path and os.path.isfile(req.video_local_path)):
        raise HTTPException(status_code=400, detail="Shot video not found on disk (render + save it first)")
    await bus.publish("tts", "active", f"Dialogue: {req.shot_id}…", 10)
    tmp_paths: list[str] = []
    try:
        anchors = await asyncio.to_thread(proj_storage.read_voice_anchors, req.project_name, req.project_path)
        # 0-based indexes of lines Seed Audio spoke in a GENERIC voice because it
        # rejected the character's reference. Without this the dub ships with a
        # character changing voice mid-shot and nothing anywhere says so.
        fallback_lines: list[int] = []
        for i, ln in enumerate(lines):
            cfg = anchors.get(ln.character, {}) if ln.character else {}
            meta: dict = {}          # fresh per line — this is a per-line fact
            try:
                audio = await _synthesize_line(ln.text, cfg, emotion=(ln.emotion or None), meta=meta)
            except Exception as e:
                raise HTTPException(status_code=502, detail=f"TTS failed for line {i + 1}: {e}")
            if meta.get("voice_fallback"):
                fallback_lines.append(i)
                logger.warning("[Dialogue] %s line %d: %s lost their locked voice — %s",
                               req.shot_id, i + 1, ln.character or "?",
                               meta.get("voice_fallback_reason", "reference rejected"))
            tf = tempfile.NamedTemporaryFile(suffix=f"_l{i}.mp3", delete=False)
            tf.write(audio); tf.close(); tmp_paths.append(tf.name)
        dlg = tempfile.mktemp(suffix="_dialogue.mp3")
        if not await asyncio.to_thread(_concat_audio_files, tmp_paths, dlg):
            raise HTTPException(status_code=502, detail="Failed to assemble the dialogue track")
        tmp_paths.append(dlg)
        dub = await asyncio.to_thread(_mix_dialogue_onto_video, req.video_local_path, dlg, req.duck)
        if not dub:
            raise HTTPException(status_code=502, detail="Failed to mix dialogue onto the video")
        preview = await asyncio.to_thread(_make_h264_preview, dub) or ""
        if fallback_lines:
            # Announce on the bus too: the response only reaches whoever made the call,
            # and a voice swap is exactly the kind of thing that must not stay quiet.
            names = ", ".join(sorted({lines[i].character or "?" for i in fallback_lines}))
            await bus.publish("tts", "error",
                              f"{req.shot_id}: {len(fallback_lines)} line(s) rendered in a GENERIC "
                              f"voice — reference rejected for {names}")
        await bus.publish("tts", "completed", f"Dialogue dubbed: {req.shot_id}", 100)
        return {"shot_id": req.shot_id, "dub_path": dub, "preview_path": preview, "lines": len(lines),
                "voice_fallback_lines": fallback_lines}
    finally:
        for p in tmp_paths:
            try:
                os.unlink(p)
            except OSError:
                pass


# Sample length for a synthesized identity clip. NOT a duration: there is no documented
# characters→seconds rate for Seed Audio, so this only keeps the sample short and the
# ffprobe below is what actually enforces the documented ≤30 s reference limit.
_IDENTITY_CLIP_CHARS = 200


def _drop_identity_clip(character: str, project_name: str, project_path: str) -> None:
    """Delete a character's cached identity clip so the NEXT scene render re-makes it
    from the voice that was just locked.

    Called from every endpoint that re-locks a voice. Without it the cache outlives the
    config it was made from, and scene mode goes on speaking in the voice the user just
    replaced — the exact drift voice anchors exist to prevent, arriving through the one
    door that does not read voice_anchors.json at render time.

    NEVER raises: a stale cache is a wrong voice, but failing to clear it must not fail
    the endpoint that just saved the anchor (same non-fatal side-effect rule as the
    manifest write in storage.save_asset_version)."""
    try:
        root = proj_storage._resolve_root(project_name, project_path)
        fp = root / "Characters" / "IdentityClips" / f"{proj_storage._safe(character)}.mp3"
        if fp.is_file():
            fp.unlink()
            logger.info("[Dialogue] identity clip for %s dropped — voice re-locked", character)
    except Exception as e:                                       # noqa: BLE001
        logger.warning("[Dialogue] could not drop the identity clip for %s "
                       "(non-fatal; scene mode may reuse the old voice): %s", character, e)


async def _identity_clip_for(character: str, cfg: dict, sample_text: str, root: "Path",
                             voice_profile: str | None = None) -> str | None:
    """ONE short clip of a character's LOCKED voice, cached on disk — the identity
    reference a scene render clones that character from.

    Seed Audio binds a voice to @AudioN by REFERENCE, not by description, so a
    multi-character scene call needs one audio sample per speaker. Synthesizing that
    sample per shot would bill a render for every character in every shot, so it is
    written ONCE to Characters/IdentityClips/<character>.mp3 and reused for the whole
    film — the same "lock it once, reuse it everywhere" contract voice_anchors.json
    already holds for the voice CONFIG.

    NEVER raises: returns None for anything it cannot produce, because a missing clip
    must abandon scene mode rather than renumber it. audio-generation.md §9 is explicit
    that @AudioN follows the position of the item in `references`, so dropping one
    speaker's clip would hand the next speaker's line to the wrong voice."""
    import seed_audio as _sa      # module-local, like every other seed_audio user here
    cfg = cfg or {}
    # An actor's OWN uploaded reference clip already IS the identity, and it was gated at
    # ≤30 s / ≤10 MB by /api/character/voice/reference. Free, and closer to the real voice
    # than anything synthesized from it could be.
    ref_path = cfg.get("ref_audio_path", "") or ""
    if cfg.get("engine") == "seed_audio" and ref_path and os.path.isfile(ref_path):
        return ref_path

    out_dir = root / "Characters" / "IdentityClips"
    cached = out_dir / f"{proj_storage._safe(character)}.mp3"
    try:
        if cached.is_file() and cached.stat().st_size > 0:
            return str(cached)
    except OSError:
        pass

    text = (sample_text or "").strip()
    if not text:
        return None
    meta: dict = {}
    try:
        # No `emotion`: the clip is a TIMBRE sample and the scene prompt supplies its own
        # emotional direction per beat. Baking one shot's emotion into a reference that
        # every later shot reuses is how a character ends up permanently angry.
        audio = await _synthesize_line(text[:_IDENTITY_CLIP_CHARS], cfg,
                                       voice_profile=voice_profile, meta=meta)
    except Exception as e:                                       # noqa: BLE001
        logger.warning("[Dialogue] identity clip for %s failed: %s", character, e)
        return None
    if not audio:
        return None
    if meta.get("voice_fallback"):
        # The sample came back in a GENERIC voice. Caching it would lock the WRONG voice
        # for this character in every shot that reuses the cache, which is the exact
        # failure voice anchors exist to prevent. Refuse it and let the caller fall back
        # to the per-line path, which loses at most one line and announces it.
        logger.warning("[Dialogue] identity clip for %s came back in a generic voice — "
                       "not cached, scene mode unavailable for this character", character)
        return None
    if len(audio) > _sa.MAX_REF_BYTES:
        logger.warning("[Dialogue] identity clip for %s is %d MB — over the %d MB "
                       "reference limit", character, len(audio) // (1024 * 1024),
                       _sa.MAX_REF_BYTES // (1024 * 1024))
        return None

    def _write() -> None:
        # Unique tmp + os.replace, not a straight open("wb"), for storage.py's reason:
        # this file is READ concurrently — two shots of the same scene render at once and
        # both want this character — and an open("wb") TRUNCATES in place, so the reader
        # sends Seed Audio a half-written mp3 as a voice reference. A rename is atomic, so
        # a reader sees either the old clip or the new one and never a torn one.
        out_dir.mkdir(parents=True, exist_ok=True)
        tmp = f"{cached}.{os.getpid()}.tmp"
        with open(tmp, "wb") as f:
            f.write(audio)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, cached)

    try:
        await asyncio.to_thread(_write)
    except Exception as e:                                       # noqa: BLE001
        logger.warning("[Dialogue] identity clip for %s could not be written: %s", character, e)
        return None
    # Duration guard, same shape as /api/character/voice/reference: best-effort (needs
    # ffprobe), and a clip over the documented limit is dropped rather than sent.
    dur = await asyncio.to_thread(_probe_audio_seconds, str(cached))
    if dur is not None and dur > _sa.MAX_REF_SECONDS:
        logger.warning("[Dialogue] identity clip for %s is %.0fs — over the %ds reference "
                       "limit, discarded", character, dur, _sa.MAX_REF_SECONDS)
        try:
            os.remove(cached)
        except OSError:
            pass
        return None
    logger.info("[Dialogue] identity clip cached for %s → %s", character, cached)
    return str(cached)


async def _render_dialogue_scene(lines: list[dict], anchors: dict, scene_prompt: str,
                                 project_name: str, project_path: str, shot_id: str,
                                 voice_profiles: dict[str, str] | None = None) -> str | None:
    """A whole shot's dialogue in ONE Seed Audio render, so the characters can speak
    OVER each other. Returns the clip path, or None when scene mode is unavailable.

    WHY: _render_dialogue_clip below synthesizes one call PER LINE and concatenates the
    results with 0.35 s of silence between them (_concat_audio_files), so no character
    can ever interrupt another — every argument in the film is two people politely
    taking turns. Seed Audio renders a whole scene in one call when it is handed one
    identity clip per speaker (@Audio1..@AudioN, audio-generation.md §4) plus a prompt
    that directs the overlap, which is the two-step recipe verified live on 2026-08-09:
      step 1 — one identity clip per character, from that character's LOCKED voice, ONE
               reference per call (two IMAGE references in one call are rejected outright:
               HTTP 400, code 45001001 "at most one image reference is supported", which
               is why the clips have to be audio and have to be made first);
      step 2 — ONE scene call whose references are those clips, in first-speaking order.
    The single mp3 it returns is what Seedance receives as the shot's dialogue reference.

    NEVER raises. Every precondition it cannot satisfy returns None and the caller renders
    the lines one by one exactly as before — a shot must not go silent because scene mode
    was unavailable."""
    import seed_audio as _sa      # module-local, like every other seed_audio user here
    prompt = (scene_prompt or "").strip()
    if not prompt:
        return None

    # FIRST-APPEARANCE order in the dialogue array. This is the @AudioN numbering the
    # breakdown wrote the prompt against (claude_agents._DIALOGUE_SCENE_FIELD states the
    # same rule in the same words), and it is never sorted or deduped into a different
    # order: doc §9, "mis-ordering swaps voices".
    speakers: list[str] = []
    first_line: dict[str, str] = {}
    for d in lines:
        spk = (d.get("character") or "").strip()
        if not spk:
            continue
        if spk not in speakers:
            speakers.append(spk)
            first_line[spk] = (d.get("text") or "")
    if len(speakers) < 2:
        logger.info("[Dialogue] %s: scene mode skipped — %d speaker(s); a voice cannot "
                    "overlap itself", shot_id, len(speakers))
        return None
    if len(speakers) > _sa.MAX_REF_AUDIOS:
        logger.info("[Dialogue] %s: scene mode skipped — %d speakers, Seed Audio takes at "
                    "most %d references", shot_id, len(speakers), _sa.MAX_REF_AUDIOS)
        return None
    if len(prompt) > _sa.MAX_TEXT_PROMPT_CHARS:
        # Checked BEFORE step 1 so an over-long prompt costs nothing: the identity clips
        # are paid renders and synthesize() would refuse this prompt anyway.
        logger.warning("[Dialogue] %s: scene mode skipped — prompt is %d chars, cap is %d",
                       shot_id, len(prompt), _sa.MAX_TEXT_PROMPT_CHARS)
        return None

    root = proj_storage._resolve_root(project_name, project_path)
    refs: list[str] = []
    for spk in speakers:
        clip = await _identity_clip_for(spk, anchors.get(spk, {}) or {}, first_line.get(spk, ""),
                                        root, (voice_profiles or {}).get(spk))
        if not clip:
            logger.warning("[Dialogue] %s: no identity clip for %s — scene mode off, "
                           "falling back to per-line", shot_id, spk)
            return None
        refs.append(clip)

    try:
        # 48 kHz for the same reason _synthesize_line defaults to it: every other stage of
        # the chain (concat, overlay, mix) is pinned there, so anything else arrives at
        # half rate and gets resampled on the way in.
        audio = await asyncio.to_thread(
            _sa.synthesize, prompt, reference_audio_paths=refs, fmt="mp3", sample_rate=48000)
    except Exception as e:                                       # noqa: BLE001
        logger.warning("[Dialogue] %s: scene render failed — falling back to per-line: %s",
                       shot_id, e)
        return None
    if not audio:
        return None

    out_dir = root / "Shots" / proj_storage._safe(shot_id)
    out = str(out_dir / "dialogue.mp3")

    def _write() -> None:
        # Same atomic write as the identity cache above, for the same reason: this exact
        # path is what _create_video_impl picks up as the shot's APPROVED clip, and a
        # render that reads it mid-write hands Seedance a truncated dialogue track.
        out_dir.mkdir(parents=True, exist_ok=True)
        tmp = f"{out}.{os.getpid()}.tmp"
        with open(tmp, "wb") as f:
            f.write(audio)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, out)

    try:
        await asyncio.to_thread(_write)
    except Exception as e:                                       # noqa: BLE001
        logger.warning("[Dialogue] %s: scene clip could not be written — falling back to "
                       "per-line: %s", shot_id, e)
        return None
    return out


async def _render_dialogue_clip(dialogue: list[dict], project_name: str,
                                project_path: str, shot_id: str,
                                voice_profiles: dict[str, str] | None = None,
                                clips_out: dict[str, str] | None = None,
                                # LAST on purpose: _create_video_impl passes the first
                                # five POSITIONALLY, so inserting anything earlier would
                                # silently rebind voice_profiles. Same rule (and the same
                                # reason) as _breakdown_batch.segment_max_secs.
                                scene_prompt: str = "") -> str | None:
    """Render a shot's dialogue lines with each character's LOCKED voice (Seed Audio
    1.0 clone → Seed TTS fallback) and concat into ONE clip on disk. The path is then
    passed to Seedance as an audio reference (audio_url) so the video is lip-synced to
    the real dubbed voice — the whole point of locking voices with Seed Audio 1.0.
    Returns the clip path, or None when there is nothing renderable.

    A single failed line no longer discards the whole shot's audio. It used to
    `return None` on the first exception, so one refused line — a content filter, a
    rejected voiceprint, a transient 5xx — muted the entire shot, and the shot then
    rendered with no dialogue at all and nothing saying why. Now the failed line is
    skipped, the rest are still spoken, and the loss is announced on the bus so it is
    visible rather than silent. Only an all-lines failure returns None.

    `scene_prompt` (the breakdown's per-shot dialogue_scene) routes the shot through
    _render_dialogue_scene instead: ONE render for the whole shot, which is the only way
    two characters can talk over each other — the per-line body below concatenates, and a
    concatenation cannot interrupt. It is a PREFERENCE, never a requirement: an empty
    prompt, a single speaker, too many speakers or a failed scene call all fall straight
    through to the per-line path below, so a caller that never sends it renders exactly
    the bytes it rendered before scene mode existed."""
    import tempfile
    lines = [d for d in (dialogue or []) if (d.get("text") or "").strip()]
    if not lines:
        return None
    anchors = await asyncio.to_thread(proj_storage.read_voice_anchors, project_name, project_path)
    if (scene_prompt or "").strip():
        scene_clip = await _render_dialogue_scene(lines, anchors, scene_prompt,
                                                  project_name, project_path, shot_id,
                                                  voice_profiles)
        if scene_clip:
            # No per-speaker clips here, by construction: the whole point of the single
            # render is that the voices OVERLAP, so they cannot be separated back out.
            # `clips_out` stays empty and _create_video_impl's `or None` then sends this
            # fused track as the shot's audio reference — which is exactly what the
            # verified recipe hands Seedance.
            logger.info("[Dialogue] %s: SCENE mode — one render, %d line(s), %d speaker(s) → %s",
                        shot_id, len(lines),
                        len({(d.get("character") or "") for d in lines}), scene_clip)
            return scene_clip
    logger.info("[Dialogue] %s: per-line mode — %d line(s)", shot_id, len(lines))
    tmp_paths: list[str] = []
    by_speaker: dict[str, list[str]] = {}
    failed: list[str] = []
    swapped: list[str] = []   # lines Seed Audio spoke in a GENERIC voice (reference rejected)
    try:
        for i, d in enumerate(lines):
            speaker = d.get("character") or ""
            cfg = anchors.get(speaker, {}) if speaker else {}
            text = (d.get("text") or "")
            if len(text) > 300:
                # The cap is real (Seed Audio per-request limit); say so instead of
                # quietly delivering a half-spoken line.
                logger.warning("[Dialogue] %s line %d (%s): %d chars truncated to 300 — "
                               "split this line in the breakdown",
                               shot_id, i + 1, speaker or "?", len(text))
            meta: dict = {}   # fresh per line: did this one lose its cloned voice?
            try:
                audio = await _synthesize_line(
                    text[:300], cfg, emotion=(d.get("emotion") or None),
                    # ACTING SKILL §9: the character's permanent vocal identity, matched by
                    # SPEAKER NAME — the same key the voice anchors are stored under.
                    voice_profile=(voice_profiles or {}).get(speaker or ""),
                    meta=meta)
            except Exception as e:
                # Skip THIS line, keep the shot's remaining dialogue.
                failed.append(f"{speaker or '?'} (line {i + 1})")
                logger.warning("[Dialogue] %s line %d (%s) failed — line dropped, "
                               "continuing with the rest: %s", shot_id, i + 1, speaker, e)
                continue
            if meta.get("voice_fallback"):
                # Not a failure — a SWAP. The line renders, but in a generic voice, and
                # this clip is what Seedance lip-syncs to, so the character changes voice
                # on screen. Loud on the same channel as the dropped-line losses.
                swapped.append(f"{speaker or '?'} (line {i + 1})")
                logger.warning("[Dialogue] %s line %d (%s) lost their locked voice — %s",
                               shot_id, i + 1, speaker or "?",
                               meta.get("voice_fallback_reason", "reference rejected"))
            tf = tempfile.NamedTemporaryFile(suffix=f"_l{i}.mp3", delete=False)
            tf.write(audio); tf.close(); tmp_paths.append(tf.name)
            by_speaker.setdefault(speaker or "", []).append(tf.name)
        if not tmp_paths:
            logger.warning("[Dialogue] %s: every line failed — no dialogue audio", shot_id)
            # Channel is "tts", like the /api/shot/dialogue endpoint above: a bus channel
            # IS an agent card id in the monitor, and these three were published on
            # "audio", which no card owns — the panel rendered them as an unlabelled
            # ghost card. Same engine, same card.
            await bus.publish("tts", "error",
                              f"{shot_id}: no dialogue could be synthesized ({len(failed)} line(s) failed)")
            return None
        if failed:
            await bus.publish("tts", "error",
                              f"{shot_id}: {len(failed)} dialogue line(s) missing — {', '.join(failed[:3])}")
        if swapped:
            await bus.publish("tts", "error",
                              f"{shot_id}: {len(swapped)} line(s) in a GENERIC voice, reference "
                              f"rejected — {', '.join(swapped[:3])}")
        root = proj_storage._resolve_root(project_name, project_path)
        out_dir = root / "Shots" / proj_storage._safe(shot_id)
        out_dir.mkdir(parents=True, exist_ok=True)
        out = str(out_dir / "dialogue.mp3")
        if not await asyncio.to_thread(_concat_audio_files, tmp_paths, out):
            return None
        logger.info("[Dialogue] %s: rendered %d/%d line(s) → %s (Seedance audio ref)",
                    shot_id, len(tmp_paths), len(lines), out)
        # ONE CLIP PER SPEAKER, in addition to the mixed one.
        #
        # The mixed clip stays this function's return value: stage 6 and every existing
        # project read it, so nothing downstream changes. But the clip is attached to
        # Seedance as an audio REFERENCE and 2.5 accepts ten of them. A single mixed track
        # hands the model ONE fused performance for the whole cast, which is where it starts
        # inventing timbres once more than three characters speak. Per speaker, each voice
        # can be bound to that character's own picture in the prompt, which is how the
        # contract asks for it: "Images 1-2 are Character 1 and correspond to Audio 1".
        #
        # Side effects only, guarded per speaker: a failure here must never cost the caller
        # the mixed clip it came for.
        if clips_out is not None and len(by_speaker) > 1:
            for spk, paths in by_speaker.items():
                if not spk or not paths:
                    continue
                try:
                    one = str(out_dir / f"dialogue_{proj_storage._safe(spk)}.mp3")
                    if await asyncio.to_thread(_concat_audio_files, paths, one):
                        clips_out[spk] = one
                except Exception as e:                                   # noqa: BLE001
                    logger.warning("[Dialogue] %s: per-speaker clip for %s failed "
                                   "(non-fatal, mixed clip stands): %s", shot_id, spk, e)
            if clips_out:
                logger.info("[Dialogue] %s: %d per-speaker clip(s) → %s",
                            shot_id, len(clips_out), ", ".join(sorted(clips_out)))
        return out
    finally:
        for p in tmp_paths:
            try: os.unlink(p)
            except OSError: pass


# ── Consistency harness: rank candidate stills against a locked reference ─────
class ConsistencyCandidate(BaseModel):
    id: str = ""
    url: str


class ConsistencyRankRequest(BaseModel):
    reference_url: str                 # the locked character reference (anchor / approved sheet)
    candidates: list[ConsistencyCandidate] = []


def _image_to_parts(url: str) -> tuple[str, str]:
    """(media_type, base64) for a URL / disk path / data-URI — for Claude image
    blocks. Sniffs the real type from magic bytes (our .png files sometimes hold
    JPEG bytes, which Claude would reject if mislabeled)."""
    from byteplus_generative import resolve_reference_strict
    import base64 as _b64
    _, b64 = resolve_reference_strict(url).split(",", 1)
    head = _b64.b64decode(b64[:16])[:4]
    if head[:3] == b"\xff\xd8\xff":
        mt = "image/jpeg"
    elif head[:4] == b"RIFF":
        mt = "image/webp"
    elif head[:3] == b"GIF":
        mt = "image/gif"
    else:
        mt = "image/png"
    return mt, b64


@app.post("/api/consistency/rank")
async def rank_consistency(req: ConsistencyRankRequest):
    """Score each candidate still against a locked character reference and return
    them ranked most-consistent first (consistency 0–100, via Claude vision). The
    objective evaluator behind "best of N" and prompt-template A/B — pick the most
    on-model generation instead of eyeballing it."""
    claude = get_claude()
    if not req.reference_url or not req.candidates:
        raise HTTPException(status_code=400, detail="Need a reference and at least one candidate")
    try:
        ref_parts = await asyncio.to_thread(_image_to_parts, req.reference_url)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Reference image unreachable: {e}")

    async def score(c: ConsistencyCandidate) -> dict:
        try:
            cand_parts = await asyncio.to_thread(_image_to_parts, c.url)
            r = await asyncio.to_thread(claude.identity_match, ref_parts, cand_parts)
        except Exception as e:
            logger.warning("[Consistency] scoring failed for %s: %s", c.id or c.url[:40], e)
            return {"id": c.id, "url": c.url, "consistency": None, "error": str(e)[:100]}
        return {"id": c.id, "url": c.url,
                "consistency": int(r.get("consistency", 0)),
                "face": int(r.get("face", 0)), "wardrobe": int(r.get("wardrobe", 0)),
                "differs": r.get("differs", ""), "notes": r.get("notes", "")}

    scored = await asyncio.gather(*[score(c) for c in req.candidates])
    ranked = sorted(scored, key=lambda x: (x["consistency"] is None, -(x["consistency"] or 0)))
    return {"ranked": ranked, "best": ranked[0] if ranked else None}


# ── Async asset jobs: kick off, then poll — variations stream in per slot ─────
# (Seedance already works this way; this brings images to parity so the UI can
# show each board the moment it exists instead of waiting for the whole set.)

ASSET_JOBS: dict[str, dict] = {}
ASSET_JOB_TTL_SECS = 3600

# The event loop holds only a WEAK reference to a task, so a bare
# `asyncio.create_task(...)` whose result nobody keeps can be garbage-collected
# mid-await — here that aborts the render with no exception, no log, and no job
# state change: ASSET_JOBS[job_id] stays 'queued'/'rendering' forever while the UI
# polls it to the timeout. The three long-lived tasks in the lifespan survive
# because they are bound to names held for the app's lifetime; this one is
# fire-and-forget per request, so it needs an explicit owner. Same add/discard
# pattern the render-queue worker already uses for its in-flight submits.
ASSET_JOB_TASKS: set[asyncio.Task] = set()


def _prune_asset_jobs() -> None:
    now = _time.time()
    for jid in [j for j, v in ASSET_JOBS.items() if now - v["created"] > ASSET_JOB_TTL_SECS]:
        ASSET_JOBS.pop(jid, None)


@app.post("/api/assets/generate-async")
async def generate_assets_async(req: AssetGenerateRequest):
    _prune_asset_jobs()
    job_id = uuid.uuid4().hex
    n = max(1, min(req.count or 4, 8))   # up to 8 variations per asset
    job: dict = {
        "status": "preparing",   # preparing (Claude) → rendering → done | failed
        "asset_id": req.asset_id,
        "slots": [{"url": None, "error": None, "pending": True} for _ in range(n)],
        "used_prompt": "",
        "error": None,
        "status_code": None,
        "created": _time.time(),
    }
    ASSET_JOBS[job_id] = job

    def on_slot(i: int, result: dict) -> None:
        # Called from the render worker thread — plain dict writes are safe.
        job["status"] = "rendering"
        if 0 <= i < len(job["slots"]):
            job["slots"][i] = {**result, "pending": False}

    async def _run() -> None:
        ref_count = len(req.reference_images)
        await bus.publish("seedream", "active",
                          f"Generating {req.asset_id}{'  (+' + str(ref_count) + ' refs)' if ref_count else ''}…", 10)
        try:
            result = await _generate_asset_core(req, on_slot)
            job["slots"] = [{**s, "pending": False} for s in result["slots"]]
            job["used_prompt"] = result["used_prompt"]
            job["status"] = "done"
            await bus.publish("seedream", "active", f"{req.asset_id} rendered", 80)
        except HTTPException as he:
            job["status"], job["error"], job["status_code"] = "failed", str(he.detail), he.status_code
            await bus.publish("seedream", "error", str(he.detail))
        except Exception as e:
            job["status"], job["error"], job["status_code"] = "failed", str(e), 500
            await bus.publish("seedream", "error", str(e))

    task = asyncio.create_task(_run())
    ASSET_JOB_TASKS.add(task)
    task.add_done_callback(ASSET_JOB_TASKS.discard)
    return {"job_id": job_id, "slot_count": n}


@app.get("/api/assets/job/{job_id}")
async def asset_job_status(job_id: str):
    job = ASSET_JOBS.get(job_id)
    if not job:
        # ASSET_JOBS is in-memory: a backend restart (incl. uvicorn --reload picking up
        # a code edit) wipes it AND kills the in-flight generation. Say so plainly —
        # "unknown or expired" read like a mystery when it was really a restart.
        raise HTTPException(
            status_code=404,
            detail="Generation lost — the backend restarted mid-run. Click Generate on this asset to retry.",
        )
    return job


class EnvAnglesRequest(BaseModel):
    description: str
    base_image_url: str
    negative_prompt: str | None = None
    style_suffix: str = ""     # 2b: passed SEPARATELY so each angle routes through the central
                               # assemble_image_prompt (was hand-concatenated into description)
    project_name: str = ""
    project_path: str = ""     # custom storage root (localFolderRoot)
    asset_name: str = ""
    # HELL GRIND rule 1: draw the REVERSE from a short Seedance walk-through of the empty
    # location rather than asking an image model to rotate the camera (48% of those fresh
    # draws came back as the base MIRRORED). Default ON; the image path stays as the
    # automatic fallback inside generate_environment_angles, so an older client that never
    # sends this field gets the new behaviour and a client that sends false gets exactly
    # the pre-change one. Exposed as a field, not hard-wired, because the video arm costs
    # ~$0.70 and ~2-4 minutes per location and an operator regenerating twenty of them may
    # legitimately want the cheap arm.
    reverse_via_video: bool = True


def _env_angles_from_disk(project_name: str, project_path: str, asset_name: str,
                          base_url: str) -> dict:
    """The sheet this environment ALREADY has on disk, in the SAME shape the POST returns.

    Exists because the panel used to seed itself from localStorage alone, so a sheet
    generated by any other client — another browser, another machine, a script, or the
    autopilot — was invisible: the panel offered "Generate" for work already paid for and
    its autoStart re-billed it. The images have been on disk since P5; nothing read them.

    Keys come from BytePlusGenerativeAPI.ENVIRONMENT_VIEWS, the same ordered list the
    generator maps the returned set with, so reader and writer cannot drift. Sheets saved
    from 2026-08-05 on carry a {"view": …} sidecar and are matched by NAME; older ones
    (every sheet in BLOOM) have no sidecar and are matched by POSITION within the newest
    sheet — versions accumulate across regenerations, so the newest len(angle_keys) files
    ending at the manifest pointer are one sheet.

    URLs are absolute /api/asset/serve links built from the caller's own base URL: the
    values must drop straight into the panel's <img src> exactly like the POST's CDN URLs
    (which expire in ~24h — these do not), and the frontend is a different origin.
    """
    from urllib.parse import quote as _quote

    empty = {"angles": {}, "top_view": "", "qc": None}
    if not asset_name:
        return empty

    def _serve(p: str) -> str:
        return f"{base_url.rstrip('/')}/api/asset/serve?path={_quote(p, safe='')}"

    def _versions(rel: str) -> tuple[list[str], int | None]:
        try:
            info = proj_storage.list_asset_versions(project_name, rel, project_path)
        except Exception:
            return [], None          # no manifest / never generated — same as "nothing yet"
        ptr = info.get("approved") or info.get("current")
        return (info.get("versions") or []), (ptr if isinstance(ptr, int) else None)

    def _sidecar(png_path: str) -> dict:
        try:
            with open(png_path[:-4] + ".meta.json") as fh:
                return json.load(fh) or {}
        except Exception:
            return {}                # sidecar optional — position mapping covers old sheets

    angle_keys = [k for k, _ in BytePlusGenerativeAPI.ENVIRONMENT_VIEWS if k != "top_view"]

    versions, ptr = _versions(f"Assets/Environments/{asset_name}/Angles")
    end = ptr if (ptr and 1 <= ptr <= len(versions)) else len(versions)
    sheet = versions[max(0, end - len(angle_keys)):end]
    angles: dict[str, str] = {}
    # A sheet whose reverse survived every retry still MIRRORED is shipped, but flagged.
    # Read back here so a reload of the panel — and any later gate — sees the same warning
    # the generating browser saw: the sheet is the dominant environment reference
    # downstream (see _env_angle_sheet), so "degraded" has to survive a page refresh.
    checks: dict[str, dict] = {}
    for i, path in enumerate(sheet):
        meta = _sidecar(path)
        key = str(meta.get("view") or "") or (angle_keys[i] if i < len(angle_keys) else f"view{i + 1}")
        angles[key] = _serve(path)
        if isinstance(meta.get("check"), dict):
            checks[key] = meta["check"]

    tv, tptr = _versions(f"Assets/Environments/{asset_name}/TopViewMap")
    tend = tptr if (tptr and 1 <= tptr <= len(tv)) else len(tv)
    top_view = _serve(tv[tend - 1]) if tv and tend >= 1 else ""
    # Same read-back for the map: a top view that survived every retry still not being an
    # overhead of this location is shipped, but the panel must show that on a reload too.
    # Sheets written before the check existed have no sidecar and simply carry no verdict.
    if tv and tend >= 1:
        tv_meta = _sidecar(tv[tend - 1])
        if isinstance(tv_meta.get("check"), dict):
            checks["top_view"] = tv_meta["check"]

    return {"angles": angles, "top_view": top_view, "qc": None, "angle_checks": checks}


@app.get("/api/assets/environment-angles")
def read_env_angles(request: Request, project_name: str = "", project_path: str = "",
                    asset_name: str = ""):
    """P7 read side: the sheet already on disk. GET reads, POST generates — the same
    two-method idiom /api/bible, /api/project/last and /api/render/queue already use.
    A location with no sheet is NOT a 404: "nothing generated yet" is the answer the
    panel's empty state is built to show."""
    return _env_angles_from_disk(project_name, project_path, asset_name,
                                 str(request.base_url))


@app.post("/api/assets/environment-angles")
async def generate_env_angles(req: EnvAnglesRequest):
    """P7: generate the reverse angle + top-view map for an environment (two views —
    see BytePlusGenerativeAPI.ENVIRONMENT_VIEWS for what was measured and rejected)."""
    api = get_byteplus()
    claude = get_claude()
    await bus.publish("seedream", "active", f"Generating environment angles: {req.asset_name}…", 10)
    try:
        result = await asyncio.to_thread(
            api.generate_environment_angles,
            req.description, req.base_image_url, req.negative_prompt or None, req.style_suffix,
            req.reverse_via_video,
        )
        await bus.publish("seedream", "active", "Environment angles complete", 80)

        # P7: Layout Director QC gate
        angle_descs = [
            f"{k}: {req.description} — {k} angle" for k in result.get("angles", {})
        ]
        try:
            qc = await asyncio.to_thread(
                claude.qc_environment_angles, req.asset_name, angle_descs
            )
            await bus.publish("qc", "completed" if qc.get("passed") else "active",
                              qc.get("summary", "Layout Director QC done"))
            result["qc"] = qc
        except Exception as qe:
            logger.warning("[P7] Layout Director QC failed (non-fatal): %s", qe)
            result["qc"] = None

        # P5: save angle images and top-view map to disk
        if req.project_name:
            import requests as _req, base64 as _b64
            for angle_key, url in result.get("angles", {}).items():
                if url:
                    try:
                        resp = _req.get(url, timeout=30)
                        b64 = _b64.b64encode(resp.content).decode()
                        # to_thread: save_asset_version takes storage's flock (it picks
                        # the version number under it), and a waiting flock on the loop
                        # stalls every request. Same idiom as the other save_asset_version
                        # calls in this file.
                        await asyncio.to_thread(
                            proj_storage.save_asset_version,
                            req.project_name,
                            f"Assets/Environments/{req.asset_name}/Angles",
                            b64,
                            req.project_path,
                            # WHICH view this file is. The folder is one flat version list, so
                            # without this the reader can only guess by position — fine for the
                            # single-angle set, wrong the day the list grows or a save fails
                            # mid-sheet. Costs one small sidecar; _env_angles_from_disk prefers it.
                            #
                            # "check" carries the mirror verdict from the generator
                            # (byteplus_generative.score_reverse_against_base): the Hamming
                            # distances, how many attempts it took, and degraded=True when the
                            # reverse is STILL the base or its mirror after every retry. It is
                            # written to disk, not just returned, so the flag outlives the tab —
                            # shipping a mirror as if it were a reverse is exactly the silent
                            # fallback this whole path was added to stop.
                            {"view": angle_key,
                             **({"check": result["angle_checks"][angle_key]}
                                if isinstance(result.get("angle_checks"), dict)
                                and isinstance(result["angle_checks"].get(angle_key), dict)
                                else {})},
                        )
                    except Exception as se:
                        logger.warning("[P7] Could not save angle %s: %s", angle_key, se)
            if result.get("top_view"):
                try:
                    resp = _req.get(result["top_view"], timeout=30)
                    b64 = _b64.b64encode(resp.content).decode()
                    await asyncio.to_thread(          # flock — see the angle save above
                        proj_storage.save_asset_version,
                        req.project_name,
                        f"Assets/Environments/{req.asset_name}/TopViewMap",
                        b64,
                        req.project_path,
                        # "check" is the top-view verdict from the generator
                        # (byteplus_generative.score_top_view): whether it is an overhead
                        # at all, whether it is this place, and degraded=True when it is
                        # neither after every retry. Written to disk for the same reason
                        # the reverse's is — 5 of BLOOM's 20 maps invent a room that exists
                        # nowhere in the project, and this file is fed to every board of
                        # the location, so the warning has to outlive the tab.
                        {"view": "top_view",          # see the angle save above
                         **({"check": result["angle_checks"]["top_view"]}
                            if isinstance(result.get("angle_checks"), dict)
                            and isinstance(result["angle_checks"].get("top_view"), dict)
                            else {})},
                    )
                except Exception as se:
                    logger.warning("[P7] Could not save top_view: %s", se)

        await bus.publish("seedream", "completed", f"Environment {req.asset_name} angles saved", 100)
        return result
    except Exception as e:
        await bus.publish("seedream", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


class MediaInspectRequest(BaseModel):
    media: list[str]               # urls | /abs/paths — images, video (.mp4…) or audio (.mp3…)
    question: str                  # what to look for, in plain words
    max_tokens: int = 1500
    # Frame-sampling density for VIDEO, documented range [0.2, 5], default 1. Raise it
    # when the question is about motion (does anyone actually move, is the performance
    # alive); lower it for a long static take to save tokens.
    fps: float = 1.0
    # Force the reader. Empty = auto: any video/audio in the list routes to MEDIA_MODEL
    # (the only family that hears), a pure-image list to VISION_MODEL.
    model: str = ""


class MotionSkeletonRequest(BaseModel):
    """Extract a whole-body pose skeleton from footage: the drive video for motion_body /
    motion_face. Local and free — no BytePlus call, no render is paid by this."""
    video_url: str                 # http(s) url, or an absolute path already on this machine
    project_name: str = ""         # where to file the outputs; empty → alongside the source
    project_path: str = ""
    shot_id: str = ""              # files under Shots/<shot_id>/Motion when given
    # rtmlib model pair. 'performance' is the accurate/slow one — worth it for a face clip,
    # where a jittery mouth becomes a jittery performance.
    mode: str = "balanced"
    kpt_thr: float = motion_drive.DEFAULT_KPT_THR
    # The skeleton drawn over the SOURCE frames, so the operator can see whether tracking
    # held before any of this reaches a paid render. On by default for that reason.
    overlay: bool = True
    all_people: bool = False       # keep every detected person instead of the subject only


@app.post("/api/motion/skeleton")
async def motion_skeleton(req: MotionSkeletonRequest):
    """Footage in, a skeleton-on-black drive video out.

    Take One Studio's motion reference is the RAW clip today, addressed with a role that asks the
    model to take the movement and none of the subject, location or colour — i.e. to
    ignore most of what the pixels contain. A skeleton has nothing to ignore, and 2.5
    documents exactly this input ("Base-mesh reference / rendering: feed a white-model
    video; the model references its motion and renders on top").

    Optional dependency, so this is the ONE endpoint that can 503 for a reason that is not
    a missing key — and it says which command fixes it, like every other 503 here.
    """
    ok, why = motion_drive.available()
    if not ok:
        raise HTTPException(status_code=503, detail=why)
    src = (req.video_url or "").strip()
    if not src:
        raise HTTPException(status_code=400, detail="video_url is required")
    try:
        await bus.publish("motion", "active", f"Reading {Path(src).name}…", 5)
        tmp = None
        if src.startswith(("http://", "https://")):
            # The clip may be a signed CDN url with hours to live; pose extraction reads it
            # frame by frame off disk, so it comes down first rather than being streamed.
            import requests as _req
            r = await asyncio.to_thread(_req.get, src, timeout=300)
            r.raise_for_status()
            tmp = Path(tempfile.mkdtemp()) / (Path(src.split("?")[0]).name or "drive.mp4")
            tmp.write_bytes(r.content)
            local = str(tmp)
        else:
            local = src

        if req.project_name or req.project_path:
            root = proj_storage._resolve_root(req.project_name, req.project_path)
            out_dir = (root / "Shots" / proj_storage._safe(req.shot_id) / "Motion"
                       if req.shot_id else root / "Studio" / "Motion")
        else:
            out_dir = Path(local).parent

        # Minutes of CPU on a long take — never on the event loop.
        result = await asyncio.to_thread(
            motion_drive.extract, local, str(out_dir),
            mode=req.mode, kpt_thr=req.kpt_thr, overlay=req.overlay,
            all_people=req.all_people)
        await bus.publish("motion", "completed",
                          f"Drive video ready — subject tracked in "
                          f"{round(result['tracked_coverage'] * 100)}% of frames", 100)
        return result
    except HTTPException:
        raise
    except Exception as e:
        await bus.publish("motion", "error", f"Pose extraction failed: {e}", 100)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/media/inspect")
async def media_inspect(req: MediaInspectRequest):
    """Ask a free-form question about images, video and/or audio the pipeline produced.

    Take One Studio already looks at IMAGES in three places — asset QC, storyboard continuity,
    character-reference describing — each with its own fixed question and fixed output
    shape. Nothing could watch a finished clip or listen to a dialogue take: every stage-5
    and stage-6 gate reads prompts and metadata, so "the actors do not move" and "there is
    a person in this shot who should not be" were only ever findable by a human watching.
    This is the way in, and it is read-only: no persistence, no side effects.

    Routing is by file extension, because only `seed-2-0-lite/mini-260428` do audio
    (llm-and-responses-api.md §1) while `seed-2-0-pro` is the sharper eye on stills.
    """
    api = get_byteplus()
    if not req.media:
        raise HTTPException(status_code=400, detail="media is required (at least one file)")
    if not (req.question or "").strip():
        raise HTTPException(status_code=400, detail="question is required")
    av = any(str(m).lower().endswith(api._VIDEO_EXTS + api._AUDIO_EXTS) for m in req.media)
    model = req.model or (api.MEDIA_MODEL if av else api.VISION_MODEL)
    try:
        if av or req.model:
            answer = await asyncio.to_thread(api.analyze_media, req.media, req.question,
                                             req.max_tokens, req.fps)
        else:
            # Stills stay on the vision model, addressed the way the rest of the file does.
            def _look() -> str:
                content: list[dict] = [
                    {"type": "image_url", "image_url": {"url": _vision_data_uri(u, timeout=30)}}
                    for u in req.media[:8]
                ]
                content.append({"type": "text", "text": req.question})
                resp = api.llm_client.with_options(timeout=180.0).chat.completions.create(
                    model=api.VISION_MODEL, max_tokens=req.max_tokens,
                    messages=[{"role": "user", "content": content}],
                )
                try:
                    usage.record_llm(getattr(resp, "usage", None), kind="vision")
                except Exception:
                    pass   # metering must never break a read
                return (resp.choices[0].message.content or "").strip()
            answer = await asyncio.to_thread(_look)
        return {"answer": answer, "model": model}
    except Exception as e:
        logger.error("[MediaInspect] %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/assets/qc")
async def qc_asset(req: AssetQCRequest):
    claude = get_claude()
    api = get_byteplus()
    name = req.asset.get('name', '?')
    await bus.publish("qc", "active", f"Asset QC: {name}", 10)
    try:
        vision_obs: dict | None = None
        drift_score: float | None = None

        # P4 spec-compliant:
        #   Primary signal = multimodal embedding cosine distance (objective drift)
        #   Secondary signal = vision model observations (human-readable, written by Claude)
        if req.use_vision and req.image_url:
            style_ctx = req.style_suffix or req.style_label
            await bus.publish("qc", "active", f"Embedding drift: {name}", 25)
            try:
                # Primary: objective embedding cosine distance
                drift_score = await asyncio.to_thread(
                    api.compute_style_drift,
                    req.image_url,
                    style_ctx,
                    req.style_anchor_urls or None,
                )
                logger.info("[QC] %s embedding_drift=%.3f (%s)", name, drift_score,
                            "anchors" if req.style_anchor_urls else "text estimate")
            except Exception as de:
                logger.warning("[QC] Embedding drift failed (non-fatal): %s", de)

            await bus.publish("qc", "active", f"Vision analysis: {name}", 50)
            try:
                # Secondary: vision model provides human-readable observations
                vision_obs = await asyncio.to_thread(
                    api.analyze_image_vision, req.image_url, style_ctx
                )
                logger.info("[QC] %s vision render_style=%s", name, vision_obs.get("render_style"))
            except Exception as ve:
                logger.warning("[QC] Vision analysis failed (non-fatal): %s", ve)

        await bus.publish("qc", "active", f"Claude verdict: {name}", 60)
        if vision_obs is not None:
            result = await asyncio.to_thread(
                claude.qc_asset_vision,
                req.asset, req.image_url, vision_obs, drift_score, req.style_label,
                bool(req.style_anchor_urls),
            )
        else:
            result = await asyncio.to_thread(claude.qc_asset, req.asset, req.image_url)
            result["drift_score"] = None
            result["visual_observations"] = None

        await bus.publish("qc", "completed" if result.get("passed") else "active",
                          f"QC {'passed' if result.get('passed') else 'flagged'}: {name}")
        return result
    except Exception as e:
        await bus.publish("qc", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ── Stage 4: Storyboard ───────────────────────────────────────────────────────

class StoryboardShotIn(BaseModel):
    id: str
    action: str = ""
    cameraAngle: str = ""
    lighting: str = ""          # orange annotation cues derive from this
    estimatedDuration: float = 5   # a segment's shot may be fractional
    isSceneFinal: bool = False  # last shot of scene → closing beat is a held pose
    # The ACTING direction — how the character plays this beat. The breakdown has
    # written it since phase 2 and stage 5 uses it (FinalGenView passes it as
    # directorNotes), but phase 4 never received it: the boards were drawn from action
    # and camera alone, so the faces and postures on them showed nothing of the
    # performance the script had already specified.
    performance: str = ""
    # The shots INSIDE this segment. When there is more than one they ARE the board's
    # beats: the breakdown already decided how many cuts the take has and how long each
    # runs, so a uniform ~1-beat-per-1.5s grid would board a rhythm the render will not
    # have. One (or none) → the old grid, unchanged.
    segmentShots: list[dict] = []
    # Conceptual thread: the approved look of the assets in THIS shot, so the board
    # draws the real characters/props (wardrobe, helmet on/off) — not a generic
    # gladiator. [{name, type, appearance}]
    assets: list[dict] = []
    # LO QUE EL DIRECTOR AÑADE Y LO QUE QUITA. Hasta ahora el único canal de referencias
    # era `assets[].refUrl`, es decir: lo que el desglose dijera. No había forma de
    # adjuntar una imagen a UN tablero ni de retirar una derivada, y como `assets` es
    # `list[dict]` sin tipar, una clave extra se aceptaba y desaparecía sin error.
    #
    # `exclude_refs` lleva ETIQUETAS (las mismas que el preview muestra), porque es lo que
    # el director tiene delante cuando decide quitar algo.
    extra_refs: list[str] = []
    exclude_refs: list[str] = []


class StoryboardGenerateRequest(BaseModel):
    scene_id: str
    scene_heading: str
    shots: list[StoryboardShotIn]   # the shots to (re)board — one BOARD PER SHOT
    aspect_ratio: str = "16:9"      # panel cells follow the project frame shape
    notes: str = ""                 # regenerate-with-notes
    # LOCKED project style — drives the board's render medium (photoreal vs the
    # project's art style). Empty = legacy photoreal wording (backward compatible).
    style_label: str = ""
    style_suffix: str = ""
    project_name: str = ""
    project_path: str = ""
    # EVERY character the film declares, so the beat writer's output can be checked
    # against the ones this board actually carries a reference for. Only used for the
    # diagnostic; empty = the check simply does not run (older callers unaffected).
    cast_names: list[str] = []
    # Prompt transparency: the output of /api/storyboard/assemble (prompts
    # possibly edited by the user). When provided, the Claude beat-writing step
    # is skipped and each item's `prompt` is sent to Seedream VERBATIM.
    boards_spec: list[dict] = []


class StoryboardQCRequest(BaseModel):
    scene_id: str
    scene_heading: str
    panels: list[dict]
    shots: list[dict]
    grid_url: str = ""              # single board (legacy) — kept for back-compat
    board_urls: list[str] = []      # 3-qc: ALL of the scene's boards → vision sees cross-panel drift


#: A BOARD IS DRAWN. "0" restores the photorealistic boards exactly as they were — flip
#: it, restart, and nothing else changes. Default on since 2026-08-15: a photoreal board is
#: indistinguishable from a keyframe, and Seedance copies it as the opening frame instead
#: of reading the camera off it.
STORYBOARD_DRAWN = os.getenv("STORYBOARD_DRAWN", "1") != "0"


def _trim_dark_border(png: bytes) -> bytes:
    """Recorta el marco negro con que Seedream monta la hoja del storyboard.

    Best-effort en los dos sentidos: si no hay marco no toca nada, y si algo falla
    devuelve la imagen tal cual — un tablero con marco es peor que uno sin recortar, pero
    ninguno de los dos justifica perder el dibujo por el que ya se ha pagado.
    """
    try:
        import io as _io
        from PIL import Image, ImageChops
        im = Image.open(_io.BytesIO(png)).convert("RGB")
        # El fondo es el color de la esquina: si la hoja llega al borde ya es papel y el
        # recorte no encuentra nada que quitar.
        bg = Image.new("RGB", im.size, im.getpixel((0, 0)))
        box = ImageChops.difference(im, bg).convert("L").point(lambda v: 255 if v > 24 else 0).getbbox()
        if not box:
            return png
        w, h = im.size
        # Una franja mínima no es un paspartú, es el margen del papel.
        if box[0] < w * 0.01 and box[1] < h * 0.01 and box[2] > w * 0.99 and box[3] > h * 0.99:
            return png
        out = _io.BytesIO()
        im.crop(box).save(out, format="PNG")
        logger.info("[Storyboard] dark border trimmed: %dx%d → %dx%d",
                    w, h, box[2] - box[0], box[3] - box[1])
        return out.getvalue()
    except Exception as e:                                   # noqa: BLE001
        logger.warning("[Storyboard] could not trim the border (non-fatal): %s", e)
        return png


def _storyboard_grid_geometry(n_panels: int, aspect_ratio: str) -> tuple[int, int, int, int]:
    """
    Rows/cols + exact pixel size for a uniform storyboard board.
    Per-shot boards: 1 panel → single frame; 2 → 2x1 COLUMN; 3-4 → 2x2.
    Panel cells follow the project aspect ratio; total pixels kept inside
    Seedream's documented range [2560x1440, 4096x4096 worth of pixels].

    TWO PANELS STACK, they do not sit side by side, and that is the whole reason this
    docstring changed. Two 16:9 cells in a row make a 32:9 strip — measured at
    3664x1024, aspect 3.58 — and Seedance refuses it the way the API always refuses an
    aspect it cannot reconcile: it ACCEPTS the task, then kills it asynchronously with an
    opaque `InvalidParameter: Bad Request` carrying no `param` and no detail. Six shots
    died this way across three films before the shape was measured — BLACKMIRROR 4's
    SHOT_016/025/027, its predecessor's SHOT_017, and BLACK MIRROR V3's SHOT_029 and
    SHOT_031 — and every one of them was a two-stage segment, which is the only case that
    produced that strip. The cleanest control pair is in one film: SHOT_021 and SHOT_025
    are both Princess Susannah alone in the same room, four stages and two, and only the
    two-stage one failed. Stacked, two panels come out near 0.89, which is the shape an
    eight-panel board already has and renders fine.
    """
    import math
    # UNA COLUMNA hasta tres viñetas. Con 3 en rejilla de 2x2 sobra una celda, y una celda
    # sobrante es un cuadrante que el modelo tiene que rellenar con algo — hoy con negro
    # sólido, que en un plan de cámara se lee como "aquí la imagen se va a negro". Apiladas
    # en 3x1 no sobra ninguna y el tablero queda a 0.59, dentro de la banda que rueda. El
    # comentario histórico avisaba de que una TIRA de 3 se pasa de ancho y Seedream la
    # aplasta al clamp de 2K; una COLUMNA de 3 es alta, no ancha, y no toca ese límite.
    cols = 1 if n_panels <= 3 else 2
    rows = math.ceil(n_panels / cols)
    cell_ar = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0}.get(aspect_ratio, 16 / 9)
    MAX_PX, MIN_PX = 16_000_000, 3_800_000
    # cell_w² * (1/cell_ar) * rows * cols = total
    cell_w = int(math.sqrt(MAX_PX * cell_ar / (rows * cols)))
    cell_w = min(cell_w, 1600)
    cell_h = int(cell_w / cell_ar)
    total = cell_w * cols * cell_h * rows
    if total < MIN_PX:
        scale = math.sqrt(MIN_PX / total)
        cell_w, cell_h = int(cell_w * scale) + 1, int(cell_h * scale) + 1
    w, h = cell_w * cols, cell_h * rows
    # A layout change must not silently reintroduce the strip. Every board that has
    # rendered sits between 0.89 and 1.79; anything far outside that is the shape Seedance
    # refuses, and it refuses it hours later with nothing to read.
    if not 0.5 <= w / h <= 2.2:
        logger.error("[Storyboard] %d panel(s) → %dx%d (aspect %.2f) is outside the range "
                     "Seedance accepts as a reference; the render will be refused "
                     "asynchronously with an opaque Bad Request.", n_panels, w, h, w / h)
    return rows, cols, w, h


def _panel_shot_id(label: str) -> str:
    """SHOT_001-A … -H (any beat letter) → SHOT_001. Must strip the WHOLE A-H range,
    not just -A/-B — otherwise beats C+ are grouped under their own id and dropped,
    capping every board at 2 panels."""
    import re as _re
    return _re.sub(r"-[A-Z]$", "", label)


def _board_prompt_text(beats: list[dict], rows: int, cols: int, scene_heading: str,
                       assets: list[dict] | None = None,
                       style_label: str = "", style_suffix: str = "") -> str:
    """The full Seedream prompt for one shot's board — Item 6 rendered-panel spec.
    `assets` carries the approved look of the characters/props in this shot so the
    board shows the REAL character (wardrobe, helmet) instead of a generic figure.
    `style_label`/`style_suffix`: the LOCKED project style. Boards used to hardcode
    "photorealistic … NOT an illustration", which fought stylized projects AND
    propagated the wrong style into the video (the board rides to Seedance as a
    reference_image). Photoreal wording is now the photographic branch only; when
    no style is sent (legacy callers) behavior is unchanged."""
    def _beat_text(i: int, b: dict) -> str:
        head = f"Panel {i + 1}"
        if b.get("time"):
            head += f" ({b['time']})"
        parts = [b.get("shot_type", ""), b.get("desc", "")]
        # EL SITIO DONDE ESTÁ LA GENTE, dicho al que DIBUJA. Hasta aquí `anchored` y
        # `screen_side` los escribía el escritor de beats, viajaban entre escritores de
        # beats y los leían las puertas — y nunca llegaban a Seedream, que es quien pone a
        # las personas en el papel. Por eso el eje se volteaba entre tableros con toda la
        # maquinaria espacial "funcionando": el artista nunca vio ni una palabra de ella.
        # Medido en BLACKMIRROR 4: Jane a la izquierda de Michael en SHOT_004 y a su
        # derecha en SHOT_008, con la puerta cantando el conflicto y el dibujo repitiéndolo.
        if str(b.get("anchored") or "").strip():
            parts.append(f'positions in the room, keep them exactly: {b["anchored"].strip()}')
        if str(b.get("screen_side") or "").strip():
            parts.append(f'sides of frame: {b["screen_side"].strip()}')
        if b.get("name"):
            parts.append(f'moment: {b["name"]}')
        body = ". ".join(p.strip() for p in parts if p and p.strip())
        return f"{head}: {body}"

    layout_desc = (
        "a single full-frame cinematic film still" if len(beats) == 1 else
        f"an exact uniform grid of {rows} row(s) x {cols} columns of equal-size "
        f"cinematic film-still panels separated by thin black gutter lines"
        # EL PAPEL LLEGA A LOS CUATRO BORDES. Prohibir "barras laterales" en la línea del
        # medio no bastó: el modelo dejó de poner barras dentro de la viñeta y montó el
        # paspartú a nivel de PÁGINA — BLACKMIRROR 4 SHOT_016 y SHOT_025 volvieron con la
        # hoja entera enmarcada en negro. Se dice donde se define la rejilla, que es donde
        # se decide qué hay fuera de los cuadros.
        f", drawn on a sheet of cream storyboard paper that reaches ALL FOUR EDGES of the "
        f"image: no black matte, no black border, no dark margin around the grid or between "
        f"the panels beyond the thin gutter lines themselves, and every panel filled with "
        f"drawing from edge to edge of its own cell"
    )
    # AN UNDECLARED CELL IS AN INVITATION, AND HALF THE BOARDS HAVE ONE.
    #
    # _storyboard_grid_geometry fixes `cols` at 2 for everything but a single panel, so a
    # grid holds 2*ceil(n/2) cells: with an ODD number of beats that is always n+1, and one
    # cell belongs to nobody. It is not an edge case — measured across GLADIATOR II's 16
    # segments (2026-08-14), 8 of 14 boards came back with an orphan cell, because half of
    # all segments have an odd number of beats.
    #
    # What the model does with a cell we described to it as existing but never wrote:
    #   · DRAMA QUEEN 3's SHOT_001 — it invented one, and filled it with Joel and Mara at
    #     the table, in a board whose three written panels are an EMPTY kitchen. That board
    #     then went to Seedance as the composition reference, which is how two actors
    #     appeared in a take that was supposed to be a locked shot of nobody.
    #   · GLADIATOR's SHOT_011 — it left it solid black: a quarter of the board wasted, and
    #     a black quadrant sent onward as composition.
    # Both are wrong; only one is loud.
    #
    # The geometry is not what changes here. A 3-cell strip of 16:9 panels is 4800px wide
    # and Seedream Pro clamps every side to 2K, so squaring the grid to the panel count
    # trades a dead cell for a squashed one. The sd25-pe contract's own storyboard rule is
    # the fix instead: state the reading order AND what not to use. So the leftover cells
    # are DECLARED — named, and required to be empty.
    spare = rows * cols - len(beats)
    if spare > 0 and len(beats) > 1:
        layout_desc += (
            f". The grid has exactly {rows * cols} cells and only {len(beats)} panels are "
            f"described: reading left to right and top to bottom, the LAST {spare} cell(s) "
            # PAPEL, no negro. La celda vacía viaja a Seedance dentro del plan de cámara, y
            # un cuadrante negro ahí es indistinguible de la instrucción "funde a negro":
            # se vio en los tableros de BLACKMIRROR 4 SHOT_001, SHOT_018 y SHOT_033. El
            # papel en blanco dice lo mismo — aquí no hay viñeta — sin parecer una imagen.
            f"must be left as BLANK PAPER, the same cream tone as the page margin, with no "
            f"frame drawn around them — no people, no scenery, no props, no text, no "
            f"repetition of another panel, and never a black or dark filled rectangle"
        )
        logger.info("[Storyboard] %dx%d grid holds %d cells for %d panel(s) — the last %d "
                    "declared empty", rows, cols, rows * cols, len(beats), spare)
    panel_lines = ". ".join(_beat_text(i, b) for i, b in enumerate(beats))
    cast_bits = []
    for a in (assets or []):
        nm = (a.get("name") or "").strip()
        ap = (a.get("appearance") or a.get("visualDescription") or "").strip()
        if nm and ap:
            cast_bits.append(f"{nm} — {ap[:200]}")
        elif nm:
            cast_bits.append(nm)
    # IDENTIDAD, CARDINALIDAD Y EL HOMBRO DEL CONTRAPLANO. Hasta aquí esta línea sólo
    # fijaba la identidad —la misma cara en cada viñeta— y el tablero se permitía tres
    # cosas que el prompt de VÍDEO ya prohíbe y el del tablero no:
    #   · el mismo personaje DOS VECES en una viñeta (BLACKMIRROR 4 SHOT_033 y SHOT_036);
    #   · en SHOT_036 la forma exacta es más fina y más grave: Michael de frente y, en
    #     primer término, una nuca que es la SUYA — o sea, el contraplano de sí mismo, que
    #     no existe;
    #   · figurantes con una sola cara repartida entre todos (SHOT_029, SHOT_033), la misma
    #     clonación que el vídeo corrigió y el tablero seguía dibujando.
    cast_line = (
        f" The SAME character(s) appear in EVERY panel — identical face, hair, build and "
        f"wardrobe, exactly like this (their real gear; helmet only if listed): "
        f"{' ; '.join(cast_bits)}."
        f" Each named character appears AT MOST ONCE in any single panel. When a panel is "
        f"an over-the-shoulder or reverse angle, the head or shoulder in the foreground "
        f"belongs to a DIFFERENT person from the one facing camera — never to the same one. "
        f"Anyone not named above is an unnamed background figure: no two of them share a "
        f"face, a build, an age or a hairline, and none of them wears the face of a named "
        f"character."
        if cast_bits else ""
    )
    # Render medium follows the LOCKED project style. Missing style (legacy
    # callers that predate the field) keeps the original photoreal wording.
    photographic = (_is_photographic(style_label, style_suffix)
                    if (style_label or style_suffix) else True)
    if STORYBOARD_DRAWN:
        # A BOARD IS A CAMERA DOCUMENT, NOT A FRAME OF THE FILM. Take One Studio rendered boards as
        # "ultra-cinematic photorealistic production film stills", and a photoreal board is
        # indistinguishable from a keyframe: Seedance receives it as a reference and copies
        # it as the opening image instead of reading the camera off it. That is what the
        # finished clips show — SHOT_008 jumping to a different bedroom on the beat the
        # board changes plate, a presenter replaced by another man on the last panel, and
        # the storyboard's own composition reproduced shot for shot instead of animated.
        #
        # Drawn in graphite it CANNOT be mistaken for footage, which is the whole point:
        # the drawing carries framing, angle and movement, and the video prompt carries the
        # action and the performance. The arrows are wanted here — they are how a board says
        # "pan right", and they are line art the model draws well. Text is NOT: generation
        # models write garbled numbers, so the panel labels, timecodes and captions are
        # composited afterwards from the breakdown's own data, which is exact.
        #
        # STORYBOARD_DRAWN=0 restores the photoreal boards byte-for-byte.
        medium = (
            f"Hand-drawn pencil storyboard on off-white paper — graphite sketch, monochrome, "
            f"no colour: {layout_desc}. Every panel is DRAWN BY HAND: visible pencil "
            f"linework, cross-hatched shading, soft smudged greys, sketched edges, the look "
            f"of a production storyboard artist's page. NOT a photograph, NOT a render, NOT "
            f"a film still, no photorealism, no colour grade, no lens effects, no film grain. "
            f"Draw the CAMERA into each panel the way a storyboard does: a horizontal arrow "
            f"under the frame for a pan or a lateral travelling, a vertical arrow for a tilt "
            f"or a crane, arrows converging inward for a push-in and outward for a pull-out, "
            f"short vibration strokes at the frame edge for a handheld shot, and impact "
            f"strokes on a sharp physical accent."
            # SIN BARRAS Y SIN RÓTULOS. Los dos se vieron en el tablero de BLACKMIRROR 4
            # SHOT_008: las ocho viñetas llegaron con barras negras verticales a los lados
            # —el modelo dibuja más estrecho que la celda y rellena de negro, que es la
            # misma "rectángulo negro" por otra puerta— y con rótulos manuscritos cuyo
            # texto sale inventado ("Blirp Stake", "Collore fames", "Hand frembles"). Un
            # tablero viaja a Seedance como referencia y el rol le dice que no tome texto
            # de él; lo que no se dibuja no hay que prohibirlo después.
            f" Each drawing FILLS ITS CELL edge to edge: no black bars down the sides, no "
            f"letterbox or pillarbox borders, no dark filled margins inside a panel. "
            f"Write NO captions, NO panel titles and NO handwritten words anywhere on the "
            f"page — the only marks outside the frames are the camera arrows."
        )
        quality_tail = "clean graphite storyboard page, consistent hand, same character in every panel"
    elif photographic:
        medium = (
            f"Ultra-cinematic photorealistic storyboard — fully rendered production film "
            f"stills: {layout_desc}. Each panel is a complete photorealistic cinematic frame "
            f"like a shot from a feature film — dramatic motivated lighting, real shallow "
            f"depth of field, filmic color grade, fine detail, natural film grain. NOT a "
            f"sketch, NOT an illustration, NO pencil, NO arrows, NO diagram marks."
        )
        quality_tail = "ultra cinematic, highly detailed, 4K"
    else:
        style_desc = (style_suffix or style_label).strip().rstrip(".")
        medium = (
            f"Cinematic storyboard rendered EXACTLY in the project's locked art style — "
            f"{style_desc}: {layout_desc}. Each panel is a fully rendered cinematic frame "
            f"in that exact style — dramatic motivated lighting, strong composition, fine "
            f"detail. NOT a rough sketch, NO pencil linework, NO arrows, NO diagram marks."
        )
        quality_tail = "highly detailed, consistent art style, 4K"
    consistency = (
        "STRICT consistency across ALL panels: the same character identity (same face, "
        "hair, wardrobe), the same room, the same drawing hand and pencil weight — no "
        "style drift and no face drift between panels."
        if STORYBOARD_DRAWN else
        "STRICT visual consistency across ALL panels: the same character identity (same "
        "face, hair, wardrobe), the same environment continuity, the same art direction "
        "and color palette — absolutely no style drift and no face drift between panels."
    )
    return (
        f"{medium} Strong "
        f"cinematic composition and tangible motion in every panel. {consistency} Do NOT "
        f"render ANY text, captions, numbers, timecodes, labels, letters, watermarks or "
        f"UI anywhere on the panels — clean cinematic frames only (time labels are added "
        f"outside the image). {panel_lines}. Scene: {scene_heading}."
        f"{cast_line} {quality_tail}, consistent character, same "
        f"face, same outfit. Any unused grid cells are solid black."
    )


async def _assemble_storyboard(req: StoryboardGenerateRequest) -> list[dict]:
    """Claude beat-writing + per-shot board prompts — NO image generation.
    One item per shot: the exact prompt Seedream would receive, plus the
    annotated beats and grid geometry."""
    claude = get_claude()
    shots_dicts = [s.model_dump() for s in req.shots]
    # Generate beats PER SHOT, in parallel. A single all-shots call overflows the
    # 8192-token output cap once you have many shots × 4-8 beats — the model then
    # silently compresses to ~2 beats each (or stalls on the retry). Per shot, each
    # call is small and reliably yields the full 4-8 timed beats.
    heading = req.scene_heading + (f"\nDIRECTOR NOTES (honor these): {req.notes}" if req.notes else "")
    # PHASE 4 · what this scene is FOR. The beat writer was given a location and an
    # action and nothing else, so it had no reason to make any beat weigh more than
    # another — which is exactly how a board ends up as N evenly-spaced panels of
    # equal importance. The heading is the ONE string every beat call receives, so the
    # sequence's question, obstacle and value shift ride there beside the director's
    # notes. Empty bible (or a scene no sequence covers) → "" → the heading is
    # unchanged and the beats are identical to today's.
    _beat_note = _bible_beat_note(
        await asyncio.to_thread(_read_bible_quietly, req.project_name, req.project_path),
        req.scene_heading,
    )
    if _beat_note:
        heading += _beat_note
        logger.info("[Bible] %s: story context in beat prompt (%d chars)", req.scene_id, len(_beat_note))

    # PHASE 4 · THE FLOOR PLAN (HELL GRIND rule 1, quoted in claude_agents.scene_geo_layout):
    # "You write it ONCE PER SCENE and paste it into EVERY shot of that scene WITHOUT
    # CHANGES." This is the "once": derived here, where the scene's location and its whole
    # action are both in hand, persisted next to the bible, and REUSED verbatim on every
    # later call for the same scene — regen one shot tomorrow and it gets the same map.
    # It is never overwritten from this path: a map that changed between two shots of a
    # scene would be the exact defect the block exists to prevent.
    # SCENE_GEO_LAYOUT=0 → "" everywhere → every prompt below is byte-identical to what it
    # was before this existed.
    #
    # DEFAULT IS OFF, and that is a measurement, not a doubt about the idea. Boarded on
    # BLOOM SC-011, 4 runs per arm: 8 control runs produced 1 character side-flip and 8
    # runs WITH the map produced 1 — no reduction. With the existing per-beat screen_side
    # carry disabled to give the map headroom, both arms flipped in 3 of 4. So the carry
    # is what holds the axis here; the floor plan is not a substitute for it. Worse, an
    # adversarial pass found the map naming a side the location does not actually have —
    # a plan that invents geography is more dangerous than no plan, because every shot of
    # the scene gets the same invention.
    # It is kept, dormant and reversible, because it DOES contain foreign structure: a
    # character sheet reading "leans against a hangar stanchion" imported that stanchion
    # into a flooded street in 4/4 baseline runs. That is a defect in the sheet, and the
    # right fix is the sheet — not a map that papers over it. Set SCENE_GEO_LAYOUT=1 to
    # re-enable and re-measure if the beat writer ever stops carrying screen_side.
    geo_layout = ""
    if os.getenv("SCENE_GEO_LAYOUT", "0") == "1":
        _geos = await asyncio.to_thread(_read_scene_geos_quietly, req.project_name, req.project_path)
        _rec = _geos.get(req.scene_id) if isinstance(_geos.get(req.scene_id), dict) else {}
        geo_layout = str((_rec or {}).get("geo") or "").strip()
        if geo_layout:
            logger.info("[Geo] %s: reusing the scene's stored floor plan (%d chars)",
                        req.scene_id, len(geo_layout))
        else:
            try:
                geo_layout = await asyncio.to_thread(
                    claude.scene_geo_layout, req.scene_heading, shots_dicts)
            except Exception as e:              # noqa: BLE001 — richness, not correctness
                logger.warning("[Geo] %s: layout failed (%s) — boarding without it", req.scene_id, e)
                geo_layout = ""
            if geo_layout:
                try:
                    await asyncio.to_thread(
                        proj_storage.save_scene_geo, req.project_name, req.scene_id,
                        geo_layout, req.scene_heading, [s.id for s in req.shots],
                        req.project_path)
                except Exception as e:          # noqa: BLE001 — an unsaved map still boards
                    logger.warning("[Geo] %s: layout not persisted (%s) — this run still "
                                   "uses it, the next one will re-derive", req.scene_id, e)
                logger.info("[Geo] %s: floor plan derived (%d chars)", req.scene_id, len(geo_layout))
    # The scene's opening wide belongs to the shot that genuinely OPENS the scene, which
    # is not always req.shots[0] — "Regen this one shot" sends a single mid-scene board.
    # Read from the breakdown on disk; unknown → "" → no opening wide, i.e. today's
    # behaviour. `_line_before_scene` is the seam: the tail of the line this scene answers.
    _first_id, _tail = ("", "")
    if os.getenv("SCENE_OPENING_WIDE", "1") == "1":
        _first_id, _tail = await asyncio.to_thread(
            _scene_open_context, req.project_name, req.project_path, req.scene_id)
        if _first_id:
            logger.info("[Geo] %s: opening wide on %s%s", req.scene_id, _first_id,
                        f" — answering {_tail[:60]!r}" if _tail else "")

    async def _beats_for(sd: dict, prev_side: str = "", prev_state: str = "",
                         prev_anchor: str = "") -> list[dict]:
        # 3-bug2: bound cross-scene Claude fan-out. Scenes still run in parallel, so the
        # per-shot calls of N scenes overlap; the process-global beat semaphore caps
        # total Sonnet calls in flight exactly as it did.
        _opens = (os.getenv("SCENE_OPENING_WIDE", "1") == "1"
                  and bool(_first_id) and sd.get("id") == _first_id)
        async with _get_beat_sem():
            try:
                return await asyncio.to_thread(
                    claude.storyboard_panels, heading, [sd], prev_side, prev_state,
                    prev_anchor, geo_layout, _opens, _tail if _opens else "",
                    req.cast_names) or []
            except Exception as e:
                # DEGRADED, and it has to say so. This used to log a warning and hand back
                # a panel that looked exactly like a real one, so the endpoint answered
                # 200, the UI showed a board, and the caller counted a success: BLOOM
                # boarded 41/41 segments this way with zero beats on any of them, and
                # nothing anywhere said the beat writer had never run. A board with no
                # beats has no time ranges, no framing/lighting/emotion annotations and
                # none of the FOV/Kelvin numbers stage 5 reads — i.e. phase 4 did nothing
                # it exists to do. `degraded` travels with the panel so the response, the
                # UI and the gate can all tell it apart from a board that was really drawn.
                logger.error("[Storyboard] beat writer FAILED for %s (%s) — board is DEGRADED "
                             "to one flat panel with no beats", sd.get("id"), e)
                await bus.publish("storyboard", "error",
                                  f"{sd.get('id')}: no beats — the board is a single flat panel")
                return [{"label": sd.get("id"), "desc": sd.get("action") or sd.get("id"),
                         "degraded": True, "degraded_reason": str(e)[:200]}]

    # THE AXIS CROSSES THE CUT — and that costs wall clock. These calls used to run as one
    # asyncio.gather over the scene's shots, which is why the screen axis held inside a
    # board and died at its edge: the writer of SHOT_030 was in flight at the same instant
    # as the writer of SHOT_028 and could not possibly know where SHOT_028 had put anyone.
    # Measured on BLOOM SC-011 — 3 BOARDS (SHOT_028+029, SHOT_030+031+032, SHOT_033: the
    # scene's 6 shots grouped into the 3 segments the UI actually sends), 5 runs per arm,
    # 2026-08-05, seed-2-0-pro-260328:
    #
    #     parallel    22.52 / 21.11 / 20.48 / 22.28 / 20.48 s   mean 21.37 s
    #                 Beni left → right across the SHOT_028→SHOT_030 board cut in 4 of 5
    #                 runs (run 2 flipped Tomás as well). check_screen_direction PASSED
    #                 5 of 5 — the break is between boards, and that gate reads inside one.
    #     sequential  56.39 / 51.09 / 50.70 / 53.27 / 51.35 s   mean 52.56 s
    #                 0 cross-board flips in 5 of 5; SHOT_030 opens on exactly the sides
    #                 SHOT_028 closed on, in every run.
    #
    # THE PRICE IS +31.2 s ON THIS SCENE — 2.46x, and it scales with shots-per-scene, not
    # with the film: a 1-board scene is unchanged, an N-board scene goes from ~1 call of
    # latency to ~N. It is paid once, at board time, against the phase that then drives
    # every keyframe and every paid render underneath it. SCENES REMAIN PARALLEL — each
    # /api/storyboard/generate is its own task and they do not share an axis — so "board
    # all scenes" and the autopilot still overlap N scenes; only the shots INSIDE one
    # scene are now ordered, because only they share a geometry.
    results: list[list[dict]] = []
    carry = ""         # the axis the previous shot of THIS scene left behind
    carry_state = ""   # …and what it left STANDING (props placed, wardrobe established)
    carry_anchor = ""  # …and WHERE THE PEOPLE ARE in the room, which neither of the above says
    for _sd in shots_dicts:
        _beats = await _beats_for(_sd, carry, carry_state, carry_anchor)
        results.append(_beats)
        # MERGE, don't replace: a character can sit out a shot (SC-011's SHOT_029 is a
        # Tomás-only insert between two Tomás+Beni shots) and still be on their side when
        # the scene cuts back. carry_screen_side folds each shot's declarations into the
        # running axis. A shot that declares nothing leaves the carry untouched.
        carry = carry_screen_side(carry, _beats)
        # The same merge for the set: a plate that the next board's insert does not show is
        # still on the table when the scene cuts wide again. This is the half that BLOOM's
        # SC-021 was missing — the agronomist's overalls existed in SHOT_062 and nothing
        # carried them into SHOT_062_2, so the next board invented a figure without them.
        carry_state = carry_leaves_behind(carry_state, _beats)
        # El eje del CUADRO no basta: una toma invertida lo cumple mientras cruza la línea.
        # Esto lleva la posición respecto a los muebles, que es la que no puede cambiar.
        # LA PUERTA QUE MIRA ENTRE TABLEROS. check_screen_direction lee las viñetas DENTRO
        # de una página, y por eso una escena podía reflejarse entera en el corte entre dos
        # tableros con las dos páginas dando "limpio": BLACKMIRROR 4 puso a Michael a la
        # derecha de la cama en SHOT_004 y a la izquierda en SHOT_008.
        for _c in anchor_conflicts(carry_anchor, _beats):
            logger.error("[Storyboard] %s: BLOCKING AXIS BREAK — %s. The camera may cross; "
                         "the room may not. Re-board this shot.", _sd.get("id", "?"), _c)
        carry_anchor = carry_anchored(carry_anchor, _beats)
    panels = [p for sub in results for p in sub if p.get("label")]

    # Group beats by shot → ONE BOARD PER SHOT
    by_shot: dict[str, list[dict]] = {}
    for p in panels:
        by_shot.setdefault(_panel_shot_id(p["label"]), []).append(p)

    items: list[dict] = []
    for shot in req.shots:
        beats = (by_shot.get(shot.id) or [{"label": shot.id, "desc": shot.action or shot.id}])[:8]
        rows, cols, W, H = _storyboard_grid_geometry(len(beats), req.aspect_ratio)
        prompt = _board_prompt_text(beats, rows, cols, req.scene_heading, shot.assets,
                                    req.style_label, req.style_suffix)
        items.append({
            "shot_id": shot.id,
            "prompt": prompt,           # editable by the user
            "auto_prompt": prompt,      # the untouched auto version, for the meta record
            "beats": [{
                "label": b.get("label", ""), "time": b.get("time", ""),
                "name": b.get("name", ""),
                "shot_type": b.get("shot_type", ""), "desc": b.get("desc", ""),
                # The beat's DECLARED screen geometry. This whitelist is copied field by
                # field, so a beat key that is not listed here dies right here: without
                # this line phase 4 writes screen_side, the response drops it, and
                # claude_agents.check_screen_direction has nothing left to check.
                "screen_side": b.get("screen_side", ""),
                # The beat's DECLARED intent to swap sides in frame. Same reason as above:
                # dropped here, the gate falls back to reading prose and forgives any flip
                # in a beat whose scenery mentions an "exit". Note the default is False,
                # not absent — a beat that came out of THIS pipeline always states an
                # intent, so an unstated one is "no crossing claimed", not "old board".
                "crossing": bool(b.get("crossing", False)),
                # What the beat leaves standing, and whether it meant to change it. Same
                # whitelist trap as the two above: dropped here, phase 4 writes the
                # declaration, the response throws it away and check_object_continuity has
                # nothing to check — the plate would go on vanishing and the gate would go
                # on returning [] because "nobody declared anything".
                "leaves_behind": b.get("leaves_behind", ""),
                "state_change": bool(b.get("state_change", False)),
                "red": b.get("red", ""), "blue": b.get("blue", ""),
                "green": b.get("green", ""), "orange": b.get("orange", ""),
                "purple": b.get("purple", ""),
            } for b in beats],
            "rows": rows, "cols": cols, "width": W, "height": H,
            # Carried from the beat writer's failure path so the caller can tell a board
            # that was really beaten out from one that is a single flat panel. Without it
            # the two are indistinguishable in the response, which is how 41 empty boards
            # were counted as 41 successes.
            "degraded": any(b.get("degraded") for b in beats),
            "degraded_reason": next((b.get("degraded_reason") for b in beats
                                     if b.get("degraded_reason")), ""),
        })
    return items


@app.post("/api/storyboard/assemble")
async def assemble_storyboard(req: StoryboardGenerateRequest):
    """Dry run: return the exact per-shot board prompts AND references WITHOUT generating."""
    await bus.publish("cinematic", "active", f"Writing board prompts: {req.scene_id}…", 5)
    try:
        items = await _assemble_storyboard(req)
        # LAS REFERENCIAS, POR LA MISMA FUNCIÓN QUE LAS ENVÍA. Este endpoint devolvía prompt
        # y viñetas y ni una imagen, así que no había NINGÚN camino HTTP por el que saber con
        # qué se iba a dibujar un tablero: la única huella era una línea de log, y llegaba
        # después de pagarlo. Se llama a `_board_references`, la misma que usa el render, para
        # que preview y resultado no puedan divergir.
        #
        # Aditivo: el bloque va como una clave nueva por item y ningún cliente existente la
        # mira. Fallo NO fatal — un preview sin referencias sigue siendo un preview útil, y
        # nunca debe ser la razón de que no se pueda revisar un prompt.
        for it in items:
            try:
                _, _, refs_preview = await _board_references(str(it.get("shot_id") or ""), req)
                it["references"] = refs_preview
            except Exception as ref_e:
                logger.warning("[Storyboard] %s: reference preview failed (non-fatal): %s",
                               it.get("shot_id"), ref_e)
                it["references"] = []
        await bus.publish("cinematic", "completed", "Board prompts ready — review before generating", 100)
        # El tope viaja en la respuesta en vez de espejarse en el frontend: hoy no existe
        # ninguna copia de `BOARD_MAX_REFS` fuera de este fichero, y crear una es fabricar
        # una constante que se puede quedar atrás sin que nadie lo note.
        return {"scene_id": req.scene_id, "items": items, "max_refs": BOARD_MAX_REFS}
    except Exception as e:
        await bus.publish("cinematic", "error", str(e))
        raise HTTPException(status_code=500, detail=f"Storyboard assemble failed: {e}")


@app.get("/api/storyboard/recover")
def recover_storyboards(project_name: str = "", project_path: str = "", shot_ids: str = ""):
    """Recover boards already RENDERED TO DISK for shots whose UI state lost them.
    A reload during the minutes-long board render orphans the HTTP response — the
    backend finishes and saves anyway (Shots/<id>/Storyboard/Versions + meta.json
    sidecar with panels/rows/cols), but the awaiting tab is gone, leaving the scene
    stuck on 'generating' with zero boards. AG heals this via its async-job
    reconciler; the storyboard path is synchronous, so it recovers from disk."""
    import json as _json
    import re as _re
    out = []
    for sid in [s.strip() for s in shot_ids.split(",") if s.strip()]:
        try:
            info = proj_storage.list_asset_versions(project_name, f"Shots/{sid}/Storyboard", project_path)
            versions = info.get("versions") or []
            if not versions:
                continue
            latest = versions[-1]          # vNNN zero-padded → lexicographic max = latest
            meta: dict = {}
            try:
                meta = _json.loads(open(_re.sub(r"\.png$", ".meta.json", latest)).read())
            except Exception:
                pass                        # sidecar optional — board is still usable
            m = _re.search(r"v(\d+)\.png$", latest)
            out.append({
                "shot_id": sid,
                "board_local_path": latest,
                "version": int(m.group(1)) if m else len(versions),
                "rows": int(meta.get("rows") or 1),
                "cols": int(meta.get("cols") or 1),
                "panels": meta.get("panels") or [],
                "auto_prompt": meta.get("auto_prompt") or "",
                "sent_prompt": meta.get("sent_prompt") or "",
            })
        except Exception as e:
            logger.warning("[StoryboardRecover] %s: %s", sid, e)
    return {"boards": out}


# Board reference budget.
#
# Was a flat 3, characters first. Measured on BLOOM 2026-08-04 by driving this very
# endpoint with the Seedream call intercepted: of the 74 shots, 55 carry a location
# with an approved image, and 6 of those (SHOT_004/014/018/024/040/042) shipped with
# NO location reference at all — two or three characters plus a prop had already
# filled the three slots. The cap was self-imposed, not an API limit: Pro documents
# 10 (SEEDREAM_PRO_MAX_REFS, byteplus_generative.py) and generate_image already
# truncates+warns at that ceiling, so this budget only has to stay under it.
#
# 6 rather than 10 because refs travel as INLINE base64: BLOOM's 84 approved asset
# images average 481 KiB → 641 KiB each as a data URI, so 3 refs ≈ 1.9 MiB, 6 ≈ 3.8
# MiB and 10 ≈ 6.3 MiB per board request. The busiest shot in the project needs 5
# (3 characters + location + prop), so 6 covers every shot with a slot spare and the
# remaining 4 would buy nothing while costing ~2.5 MiB of upload per board.
BOARD_MAX_REFS = 6
# …of which this many are RESERVED for the location, so characters can never crowd
# it out again. TWO, because the angle sheet is a single REVERSE view, not a contact
# sheet of every angle: sent in place of the base it would only mirror the bug, so
# the location needs both frames to describe the whole room — see _env_angle_sheet.
BOARD_ENV_SLOTS = 2


def _env_angle_sheet(project_name: str, project_path: str, asset_name: str) -> str:
    """Disk path of an environment's ANGLE SHEET, or "" when the location has none.

    POST /api/assets/environment-angles has been writing these since P7 —
    Assets/Environments/<name>/Angles/Versions/vNNN.png, the same room shot from the
    REVERSE direction — and until now nothing anywhere read one back: a repo-wide grep
    for "Angles" found the writer and the UI panel, and no consumer. Measured on BLOOM:
    20/20 locations in the breakdown have a sheet on disk and 0/74 boards had ever been
    drawn with one, so every board saw only the base image and the model invented
    whatever the base did not show (the kitchen that came back with windows on both
    walls).

    Resolved SERVER-side on purpose. The UI posts {name, type, appearance, refUrl} and
    refUrl is the BASE image; it has never carried the sheet, and requiring a new field
    would break every client that sends today's body. The rel path is built the same way
    storage.reconstruct_project builds an asset folder — f"Assets/{folder}/{_safe(name)}"
    — and list_asset_versions applies _safe per segment itself and returns the
    approved/current pointer, so this reader cannot drift from the writer's key.
    """
    if not asset_name:
        return ""
    try:
        info = proj_storage.list_asset_versions(
            project_name, f"Assets/Environments/{asset_name}/Angles", project_path)
    except Exception:
        return ""       # no manifest / never generated — the caller falls back to the base
    versions = info.get("versions") or []
    if not versions:
        return ""
    # The angles panel has no approve button, so `approved` is None on every sheet in
    # BLOOM and `current` is the live pointer. Honour approved when one ever appears,
    # and fall back to the newest file if the pointer outran the files.
    pick = info.get("approved") or info.get("current")
    if pick:
        want = f"v{int(pick):03d}.png"
        for v in versions:
            if v.endswith(want):
                return v
    return versions[-1]


def _character_headshot(project_name: str, project_path: str, asset_name: str) -> str:
    """Disk path of a character's derived FACE CROP, or "" when none was ever derived.

    /api/asset/save-version has been writing these since 2a — _derive_headshot crops the
    big face out of the sheet into Assets/Characters/<name>/Headshot/headshot.png — and the
    BOARD path never read one: it sends Versions/vNNN.png, the whole SHEET, which spends
    most of its frame on full-body figures and burnt-in pose labels.

    WHICH face it crops moved with the layout on 2026-08-06 (HELL GRIND rule 1): on the old
    "4+2" sheet it was the top-left of two close-ups above four full-body figures — six
    faces, four of them tiny; on the "headless" default it is the left-column 3/4 portrait,
    the sheet's ONLY face. The box travels with the layout in _SHEET_LAYOUTS, so this
    function does not need to know which one it got.

    HONEST STATE OF THE EVIDENCE — read this before citing a number. A first pass (BLOOM
    SHOT_004, 8 trials, 4 per arm) reported the poster's specified root-system drawing
    rendering in 4/4 headshot trials against ~2/4 sheet trials, and that was the headline
    reason this function was written. It DID NOT REPRODUCE. Re-run on the same shot with the
    same prompt/size/model at N=5 per arm, arms INTERLEAVED so endpoint drift hits both
    equally: poster correct 5/5 before vs 5/5 after, figures duplicated 0/5 vs 0/5, text
    artefacts 5/5 vs 5/5 (mirrored or garbled in 3/5 vs 3/5). Three measured metrics, zero
    differences. So: no measured board-quality benefit is claimed here. What IS measured is
    that sending both is SAFE — over all 74 BLOOM shots the reference list is a strict
    superset of the old one (252 refs → 336; nothing dropped, no order change among the old
    images, environment refs 110 before and after).

    The remaining rationale is a priori, not measured: a face crop is a cleaner identity
    anchor than a frame spending itself on four figures plus burnt-in text. If a future round
    needs to buy back slots, this is the first thing to cut — it costs upload bytes and has
    not yet earned its keep on any metric anyone has managed to measure.

    The caller sends BOTH, headshot first: the crop is a FACE, so alone it loses the wardrobe
    and build the sheet carries, and wardrobe continuity is the whole identity story here.

    Resolved SERVER-side for the same reason _env_angle_sheet is: the UI posts
    {name, type, appearance, refUrl} and refUrl is the sheet; requiring a new field would
    break every client that sends today's body. Unlike the angle sheet the headshot is NOT
    versioned (fixed filename, rewritten on each approve), so list_asset_versions — which
    globs Versions/v*.png — cannot see it; this globs the folder the same way
    storage.reconstruct_project does, through storage's own _safe so it cannot drift from
    _derive_headshot's writer key ("Nuria Arroyo (child)" → "Nuria Arroyo child").
    """
    if not asset_name:
        return ""
    try:
        root = proj_storage._resolve_root(project_name, project_path)
        rel = "/".join(proj_storage._safe(p) for p in
                       f"Assets/Characters/{asset_name}/Headshot".split("/"))
        shots = sorted((root / rel).glob("*.png"))
    except Exception:
        return ""       # never derived / unreadable — the caller falls back to the sheet alone
    return str(shots[-1]) if shots else ""




async def _board_references(shot_id: str, req: "StoryboardGenerateRequest") -> tuple[list[dict], list[str], list[dict]]:
    """Las referencias de imagen que el tablero de ESTE plano lleva a Seedream.

    UNA sola implementación, a propósito. Esto vivía dentro de `_gen_board`, así que el
    endpoint de preview (`/api/storyboard/assemble`) no tenía forma de decir qué imágenes
    usaría un tablero: devolvía prompt y viñetas y ni una referencia, y la única huella era
    una línea de log DESPUÉS de haber pagado. Un preview que recalculara esto por su cuenta
    divergiría del render en cuanto una de las dos copias cambiara — que es exactamente el
    modo de fallo que este repo ya evita en los ensambladores centrales de prompt.

    Devuelve `(refs, names, preview)`. `refs` y `names` van index-alineados: los items
    resueltos que van al modelo (data URIs) y sus etiquetas legibles, que son las que el
    sidecar guarda. `preview` es la MISMA lista contada para el cliente —
    `{label, url, source, dropped}`— con la url ORIGINAL, nunca el data URI: mandar los
    base64 resueltos al navegador serían megabytes por tablero.

    `dropped` marca lo que se consideró y no cupo. Antes eso se descartaba en silencio al
    llegar al tope, así que un plano con cuatro personajes y una localización perdía una
    lámina sin que nada lo dijera ni antes ni después de pagar.

    Las políticas de selección no cambian aquí — orden, reservas, presupuesto y aritmética
    de slots son las medidas, sólo dejan de estar enterradas.
    """
    preview: list[dict] = []
    # Lock identity: pass the shot's approved CHARACTER (then environment) images
    # as Seedream references so the SAME face + wardrobe appears in every panel of
    # the cinematic board. Character first; dead/expired refs are skipped, not fatal.
    # The location gets a RESERVED share of the budget (BOARD_ENV_SLOTS) so it can
    # never be crowded out by characters the way it was on 6 of BLOOM's 55
    # located shots, and its ANGLE SHEET is preferred over the base image.
    from byteplus_generative import resolve_reference_strict
    board_refs: list[dict] = []
    board_ref_names: list[str] = []
    shot_in = next((s for s in req.shots if s.id == shot_id), None)
    # Lo que el director retiró, por ETIQUETA — que es lo que tiene delante en la tarjeta.
    # Se compara en minúsculas y sin espacios de sobra porque la etiqueta viaja al navegador
    # y vuelve.
    excluded = {str(x).strip().lower() for x in (shot_in.exclude_refs if shot_in else []) if str(x).strip()}
    if shot_in:
        # One location per shot is the norm; a second one (rare) keeps the old
        # behaviour and competes for the ordinary slots below.
        env_a = next((a for a in shot_in.assets if a.get("type") == "environment"), None)
        # INHERIT THE ROOM FROM THE SCENE when this shot does not name it.
        # This request IS one scene (scene_id + the shots to board), so every
        # other shot here happens in the same place — borrowing their
        # environment is reading the breakdown, not inventing a location.
        #
        # Measured on DRAMA QUEEN 3, 2026-08-14: SHOT_001/007/011 carried
        # "KITCHEN — 2:19 AM" and SHOT_003 carried only Joel and Mara, so its
        # board went out with 4 identity references and NO room — no angle
        # sheet, no base plate — and Seedream drew a different kitchen under a
        # different light for one board of a four-board scene. The breakdown
        # itself is repaired at source now (_ensure_scene_environments links
        # every shot to its scene's environment), but breakdowns already on
        # disk carry the gap, and re-boarding must not require regenerating
        # them: 16 of 18 projects on this machine have at least one such shot,
        # Alastor 2 has 51.
        if env_a is None:
            env_a = next((a for s in req.shots for a in s.assets
                          if a.get("type") == "environment"), None)
            if env_a:
                logger.info("[Storyboard] %s: no environment of its own — "
                            "inherited %r from the scene", shot_id,
                            env_a.get("name"))
        env_plan: list[tuple[str, str]] = []      # (url, label)
        if env_a:
            env_name = env_a.get("name") or "environment"
            sheet = _env_angle_sheet(req.project_name, req.project_path, env_name)
            if sheet:
                env_plan.append((sheet, f"{env_name} (angle sheet)"))
            # The sheet is ONE reverse view, not a multi-view contact sheet, so
            # sending it INSTEAD of the base just mirrors the bug — the model
            # would then invent the half the base used to show. Both go, which is
            # what the second reserved slot is for. The TopViewMap deliberately
            # does NOT get a third: it is a photoreal ceiling-height render at a
            # camera height no panel will ever use, and a strong ref fights the
            # panel's requested camera (the same effect generate_environment_angles
            # documents, where the reference wins over the asked-for angle).
            base_u = env_a.get("refUrl") or env_a.get("ref_url")
            if base_u:
                env_plan.append((base_u, env_name))
        # Resolved FIRST so the reserve is real, SENT last: generate_image
        # documents that order matters and identity refs go first.
        env_refs: list[dict] = []
        env_names: list[str] = []
        env_preview: list[dict] = []
        for url, label in env_plan[:BOARD_ENV_SLOTS]:
            if label.strip().lower() in excluded:
                preview.append({"label": label, "url": url, "source": "derived",
                                "dropped": True, "excluded": True})
                continue
            try:
                uri = await asyncio.to_thread(resolve_reference_strict, url)
            except Exception as re_:
                logger.warning("[Storyboard] %s: env ref skipped (expired?) — %s", shot_id, re_)
                continue
            # Weight stays at the existing 0.5 "other" value — including for the
            # sheet. It is a no-op on the default wire format anyway (the documented
            # `image` param carries no weights; only the legacy ref_images mode
            # honours them), and if that mode is ever switched back on the location
            # must still sit below the faces, which are what boards drift on.
            env_refs.append({"url": uri, "role": "reference_image", "weight": 0.5})
            env_names.append(label)
            env_preview.append({"label": label, "url": url, "source": "derived", "dropped": False})

        # LO QUE EL DIRECTOR ADJUNTA TIENE RESERVA, COMO EL ENTORNO.
        #
        # Se resuelve ANTES del reparto y se descuenta del presupuesto, que es la misma
        # mecánica que protege a la localización. La razón es simple: una referencia que
        # alguien adjunta a mano es una decisión explícita sobre ESTE tablero, y perderla
        # contra una lámina derivada que el propio sistema iba a descartar de todos modos
        # convierte el modo manual en decorado — es lo que pasaba con la primera versión de
        # esto, medido: quitabas dos derivadas para hacer sitio y el sitio se lo llevaban
        # otras dos derivadas.
        #
        # Puede empujar fuera a un personaje, y eso es aceptable AHORA y no lo era antes,
        # porque el preview enseña lo descartado tachado: el director ve qué ha desplazado
        # su imagen y decide. Silencioso sería inaceptable; visible es una elección.
        dir_refs: list[dict] = []
        dir_preview: list[dict] = []
        for extra in (shot_in.extra_refs or []):
            u = str(extra or "").strip()
            if not u or len(dir_refs) >= max(0, BOARD_MAX_REFS - len(env_refs)):
                if u:
                    dir_preview.append({"label": "director's reference", "url": u,
                                        "source": "director", "dropped": True})
                continue
            try:
                uri = await asyncio.to_thread(resolve_reference_strict, u)
            except Exception as re_:
                logger.warning("[Storyboard] %s: director ref skipped (unreadable) — %s", shot_id, re_)
                dir_preview.append({"label": "director's reference", "url": u,
                                    "source": "director", "dropped": True})
                continue
            dir_refs.append({"url": uri, "role": "reference_image", "weight": 0.85})
            dir_preview.append({"label": "director's reference", "url": u,
                                "source": "director", "dropped": False})

        budget = BOARD_MAX_REFS - len(env_refs) - len(dir_refs)
        ordered = sorted((a for a in shot_in.assets if a is not env_a),
                         key=lambda a: 0 if a.get("type") == "character" else 1)
        # A character is now worth up to TWO images — its face crop (see
        # _character_headshot) AND its 4-view sheet — so the plan is built first
        # and the slots divided second. (sheet_url, label, weight, headshot_or_"").
        plans: list[tuple[str, str, float, str]] = []
        for a in ordered:
            ru = a.get("refUrl") or a.get("ref_url")
            if not ru:
                continue
            is_char = a.get("type") == "character"
            plans.append((
                ru, a.get("name") or a.get("type") or "ref",
                0.85 if is_char else 0.5,
                _character_headshot(req.project_name, req.project_path,
                                    a.get("name") or "") if is_char else "",
            ))
        # SLOT ARITHMETIC, and it is deliberately conservative: the SHEET is the
        # guaranteed image and the headshot is an ADDITION that only spends slots
        # nothing else wanted. So the set of images a board gets today is a strict
        # SUBSET of what it gets now — no asset that had a reference loses one, and
        # no character trades its wardrobe away for a face crop.
        #
        # What that costs at the LIMIT, swept over all 74 BLOOM shots at
        # BOARD_MAX_REFS=6 / BOARD_ENV_SLOTS=2: 84 of 97 character slots get their
        # headshot — 55 shots get every one they could use, 9 get some, 1 gets none.
        # The shortfall is entirely the crowded shots: a located 2-character shot
        # that also carries a prop (8 of them) has 4 non-reserved slots for 3 sheets,
        # so only the first character gets a crop; SHOT_040 (3 characters + location)
        # gets one; SHOT_042 (3 characters + prop + location) gets none. 6 slots
        # simply cannot hold 2 images x 3 characters + a prop + the 2 reserved — that
        # would need 9, still inside Pro's documented 10 but ~2 MiB more inline base64
        # per board, which is a budget decision and not this change's to make.
        # The environment's 2 reserved slots survive all of it by construction:
        # env_refs are resolved before this and subtracted out of `budget`, so
        # characters cannot reach them however many images they now want (measured:
        # 110 environment refs sent across the 74 shots, before AND after).
        spare = max(0, budget - len(plans))
        grants: list[bool] = []      # index-aligned with plans
        for _ru, _nm, _w, hs in plans[:budget]:
            want = bool(hs) and spare > 0
            spare -= 1 if want else 0
            grants.append(want)
        grants += [False] * (len(plans) - len(grants))
        for (ru, nm, w, hs), want_hs in zip(plans, grants):
            if nm.strip().lower() in excluded:
                preview.append({"label": nm, "url": ru, "source": "derived",
                                "dropped": True, "excluded": True})
                continue
            if len(board_refs) >= budget:
                # No cabe. Se registra para que el cliente lo vea tachado en vez de que
                # desaparezca sin dejar rastro.
                preview.append({"label": nm, "url": ru, "source": "derived", "dropped": True})
                continue
            try:
                data_uri = await asyncio.to_thread(resolve_reference_strict, ru)
            except Exception as re_:
                # The sheet is the primary: if it is gone the asset is skipped
                # WHOLE, exactly as it was before the headshot existed here.
                logger.warning("[Storyboard] %s: ref skipped (expired?) — %s", shot_id, re_)
                preview.append({"label": nm, "url": ru, "source": "derived", "dropped": True})
                continue
            pair: list[tuple[str, str, str]] = []      # (resuelta, etiqueta, url original)
            if want_hs:
                try:
                    pair.append((await asyncio.to_thread(resolve_reference_strict, hs),
                                 f"{nm} (headshot)", hs))
                except Exception as re_:
                    logger.warning("[Storyboard] %s: headshot skipped — %s", shot_id, re_)
            pair.append((data_uri, nm, ru))     # face first, wardrobe second
            for uri, label, orig in pair:
                # Same 0.85 the character already carried — the crop and the sheet
                # are the same person, and weights are a no-op on the default wire
                # format anyway (see the env note above).
                board_refs.append({"url": uri, "role": "reference_image", "weight": w})
                board_ref_names.append(label)
                preview.append({"label": label, "url": orig, "source": "derived", "dropped": False})
        # Orden del wire: identidad derivada, luego lo del director, luego la localización.
        board_refs.extend(dir_refs)
        board_ref_names.extend(["director's reference"] * len(dir_refs))
        board_refs.extend(env_refs)
        board_ref_names.extend(env_names)
        # El entorno va al final del wire, así que también al final del preview: la lista
        # que ve el director es la que se envía, en el mismo orden.
        preview.extend(dir_preview)
        preview.extend(env_preview)

    if board_refs:
        # Names carry "(angle sheet)" when the sheet was used, so this line — and
        # the `references` list in the meta sidecar below — say WHICH location
        # image the board was drawn from.
        logger.info("[Storyboard] %s: %d identity ref(s) → %s", shot_id, len(board_refs), board_ref_names)
    return board_refs, board_ref_names, preview


@app.post("/api/storyboard/generate")
async def generate_storyboard(req: StoryboardGenerateRequest):
    """
    Stage 4: one cinematic photorealistic storyboard per scene — one labeled panel
    per shot (two beats for shots >8s), ≤12 panels per grid (longer scenes
    chunk into multiple grids).

    Design decision (per MODEL_AUDIT.md D1): a SINGLE grid image per scene
    beats `sequential_image_generation` here — the grid is one documented t2i
    call with deterministic cell geometry (croppable per panel) and intra-image
    consistency by construction, while sequential mode returns related-but-
    separate images with no labeled layout guarantee and costs panel slots
    against the inputs+outputs≤15 budget.
    """
    api = get_byteplus()
    import requests as _req, base64 as _b64

    await bus.publish("cinematic", "active", f"Storyboarding {req.scene_id}…", 5)
    try:
        # Prompt transparency: a reviewed boards_spec (from /assemble, possibly
        # edited) is used VERBATIM; otherwise assemble fresh.
        items = req.boards_spec or await _assemble_storyboard(req)

        # Boards render many-at-a-time. Each board is ONE Seedream call; the image
        # API is rated 500 IPM (throughput) with NO documented per-request
        # concurrency cap (enterprise-ops §3), so a whole scene can fire in ~1 wave.
        # 3-bug2: this semaphore is now PROCESS-GLOBAL (shared across ALL concurrent
        # scene requests), so "Board all scenes"/autopilot firing every scene at once
        # still keeps TOTAL boards in flight ≤ STORYBOARD_CONCURRENCY (16) — identical
        # BytePlus load, just overlapped across scenes instead of strictly serial.
        board_sem = _get_board_sem()
        done_boards = 0

        async def _gen_board(si: int, item: dict) -> dict:
            nonlocal done_boards
            shot_id = item.get("shot_id", f"SHOT_{si + 1}")
            prompt = (item.get("prompt") or "").strip()
            auto_prompt = item.get("auto_prompt") or prompt
            if not prompt:
                raise RuntimeError(f"Empty board prompt for {shot_id}")
            beats = item.get("beats") or []
            rows, cols = item.get("rows", 1), item.get("cols", 1)
            W, H = item.get("width", 2848), item.get("height", 1600)

            async with board_sem:
                await bus.publish("seedream", "active",
                                  f"Board {shot_id} ({done_boards}/{len(items)} done)",
                                  20 + int(60 * done_boards / max(1, len(items))))

                board_refs, board_ref_names, _ = await _board_references(shot_id, req)

                # Seedream 5.0 Pro for boards (better faces); generate_image clamps
                # the grid size to Pro's ≤2K / ×16 constraints automatically.
                urls = await asyncio.to_thread(
                    api.generate_image, prompt, f"{W}x{H}", 1, board_refs or None,
                    model=api.SEEDREAM_PRO_MODEL,
                )
                if not urls:
                    raise RuntimeError(f"Seedream returned no board for {shot_id}")

                resp = await asyncio.to_thread(_req.get, urls[0], timeout=120)
                resp.raise_for_status()
                # EL PASPARTÚ SE RECORTA, no se pide. Dos prohibiciones en prosa —una en la
                # línea del medio, otra donde se define la rejilla— y Seedream siguió
                # componiendo la hoja sobre un marco negro: BLACKMIRROR 4 SHOT_016 y
                # SHOT_025 volvieron con la página entera enmarcada. Ese marco viaja a
                # Seedance dentro del plan de cámara, donde un borde negro es
                # indistinguible de un plano que acaba en negro. Recortarlo es
                # determinista y no depende de que el modelo obedezca.
                _content = await asyncio.to_thread(_trim_dark_border, resp.content)
                b64 = _b64.b64encode(_content).decode()
                saved = await asyncio.to_thread(
                    proj_storage.save_asset_version,
                    req.project_name, f"Shots/{shot_id}/Storyboard", b64, req.project_path,
                    {
                        "kind": "storyboard_board",
                        "auto_prompt": auto_prompt,
                        "prompt_override": prompt if prompt != auto_prompt else None,
                        "sent_prompt": prompt,
                        "negative_prompt": None,
                        "references": [{"label": n} for n in board_ref_names],
                        "model": api.SEEDREAM_PRO_MODEL, "size": f"{W}x{H}",
                        # Persist the structured beats + grid so a reopened project can
                        # rebuild the panel breakdown (not just the board image).
                        "panels": beats,
                        "rows": rows, "cols": cols,
                    },
                )

            done_boards += 1
            logger.info("[Storyboard] %s board v%03d: %d beat(s)%s → %s",
                        shot_id, saved.get("version", 1), len(beats),
                        " (USER-EDITED PROMPT)" if prompt != auto_prompt else "",
                        saved.get("path", ""))
            return {
                "shot_id": shot_id,
                "board_url": urls[0],
                "board_local_path": saved.get("path", ""),
                "version": saved.get("version", 1),
                "rows": rows, "cols": cols,
                # full annotated beats — SG's Video Direction template consumes them
                "panels": beats,
                # transparency: the UI shows what produced this board
                "auto_prompt": auto_prompt,
                "sent_prompt": prompt,
                # A board whose beat writer never ran is a single flat panel. Saying so
                # here is what stops it being counted as a finished board upstream.
                "degraded": bool(item.get("degraded")),
                "degraded_reason": item.get("degraded_reason", ""),
            }

        results = await asyncio.gather(*[_gen_board(si, item) for si, item in enumerate(items)],
                                       return_exceptions=True)
        failures = [r for r in results if isinstance(r, BaseException)]
        boards = [r for r in results if not isinstance(r, BaseException)]
        if failures:
            # Same contract as the old sequential loop (any failure → scene errors),
            # but completed boards are already saved to disk for the resume path.
            raise RuntimeError(f"{len(failures)}/{len(items)} board(s) failed — first: {failures[0]}")

        n_deg = sum(1 for b in boards if b.get("degraded"))
        if n_deg:
            # Loud, and on the channel the error panel reads. A scene whose boards carry no
            # beats has not been storyboarded, however good the single image looks.
            logger.error("[Storyboard] %s: %d/%d board(s) DEGRADED — no beats were written",
                         req.scene_id, n_deg, len(boards))
            await bus.publish("storyboard", "error",
                              f"{req.scene_id}: {n_deg}/{len(boards)} board(s) have NO beats")
        else:
            await bus.publish("seedream", "completed", f"Storyboards ready: {req.scene_id}", 100)
        return {"scene_id": req.scene_id, "boards": boards, "degraded": n_deg}
    except HTTPException:
        raise
    except Exception as e:
        await bus.publish("seedream", "error", str(e))
        raise HTTPException(status_code=500, detail=f"Storyboard generation failed: {e}")


@app.post("/api/storyboard/qc")
async def qc_storyboard(req: StoryboardQCRequest):
    """Camera Director gate, now judging the storyboard (absorbs old Stage 4 QC)."""
    claude = get_agents()
    api = get_byteplus()
    await bus.publish("cinematic", "active", f"Storyboard QC: {req.scene_id}")
    try:
        vision_obs = None
        # 3-qc: analyze ALL the scene's boards TOGETHER so the QC sees cross-panel face/style/
        # direction drift (a single board — or the panels' own descs — can't reveal it).
        if req.board_urls:
            try:
                vision_obs = await asyncio.to_thread(api.analyze_storyboard_continuity, req.board_urls)
            except Exception as ve:
                logger.warning("[StoryboardQC] continuity vision failed (non-fatal): %s", ve)
        elif req.grid_url:
            try:
                vision_obs = await asyncio.to_thread(
                    api.analyze_image_vision, req.grid_url, "cinematic photorealistic storyboard panels"
                )
            except Exception as ve:
                logger.warning("[StoryboardQC] vision failed (non-fatal): %s", ve)
        result = await asyncio.to_thread(
            claude.qc_storyboard, req.scene_heading, req.panels, req.shots, vision_obs
        )
        await bus.publish("cinematic", "completed" if result.get("passed") else "active",
                          result.get("summary", "Storyboard QC done"))
        return result
    except Exception as e:
        await bus.publish("cinematic", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ── Stage 5: Video generation ─────────────────────────────────────────────────

class ShotDirectRequest(BaseModel):
    """P5a Magic Box: a natural-language directing instruction + the shot's
    current context. Claude returns a refined note + the cheapest regen scope."""
    instruction: str
    action: str = ""
    camera: str = ""
    lighting: str = ""
    notes: str = ""
    char_name: str = ""
    env_hint: str = ""
    style_label: str = "cinematic"


@app.post("/api/shot/direct")
async def direct_shot_endpoint(req: ShotDirectRequest):
    """P5a: interpret a natural-language shot instruction → {notes, scope, summary}."""
    claude = get_claude()
    await bus.publish("qc", "active", "Directing shot…", 20)
    try:
        result = await asyncio.to_thread(
            claude.direct_shot, req.instruction, req.action, req.camera, req.lighting,
            req.notes, req.char_name, req.env_hint, req.style_label,
        )
        await bus.publish("qc", "completed", "Shot direction ready")
        return result
    except Exception as e:
        await bus.publish("qc", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# Per-character locks so concurrent keyframe regens (Animate All / the identity
# auto-fallback fire in parallel) don't each generate a DIFFERENT face block for
# the same character — the first generates + caches, the rest wait + read it.
_face_block_locks: dict[str, asyncio.Lock] = {}


async def _get_face_block(claude, api, ch: "KeyframeCharacter", project_name: str, project_path: str) -> str:
    """Cached distinctive-fictional face block for a character, generated once.
    Vision-grounds it on the approved headshot so the pure-t2i face matches the
    approved character + stays consistent across shots. See seedance-identity-filter."""
    # La IDENTIDAD es del personaje base, no de su estado. Un estado se llama
    # "Mara Chen · Brought inside and warmed", y cachear por ese nombre generaba un
    # rostro NUEVO por cada estado: en FARO, Mara aparecía con una cara europea en las
    # rocas y otra asiática dentro del faro. El rostro se comparte; solo cambia lo que
    # le ha pasado al cuerpo.
    base_name = str(ch.name).split(" · ")[0].strip() or ch.name
    key = f"{project_path or project_name}:{base_name}"
    lock = _face_block_locks.setdefault(key, asyncio.Lock())
    async with lock:
        block = proj_storage.read_face_block(project_name, base_name, project_path)
        if block:
            return block
        observed = ""
        if ch.headshot_url:
            observed = await asyncio.to_thread(api.describe_face_vision, ch.headshot_url)
        block = await asyncio.to_thread(
            claude.fictional_face_block, ch.name, ch.description, "", "", observed,
        )
        try:
            # to_thread: the write takes storage's cross-process flock and waits on the
            # calling thread, so on the loop a peer holding this project's lock freezes
            # every request for up to file_lock.LOCK_TIMEOUT_SECS.
            await asyncio.to_thread(
                proj_storage.write_face_block, project_name, base_name, block, project_path)
        except Exception as e:
            # The block is derived and already paid for, and it is valid for THIS shot —
            # so it is still returned. What failed is the CACHE, and that is the whole
            # point of the function: the next shot of this character will derive a
            # different face, which is the "the face changed from shot to shot" bug.
            # A raise would be invisible — both callers of this function catch and
            # demote to logger.warning — so the report goes on the agent bus, which is
            # wired to the dashboard's AgentStatusMonitor and to /api/errors.
            await bus.publish(
                "seedream", "error",
                f"Face NOT locked for {base_name} ({e}) — later shots may render a "
                f"different face for this character",
            )
            logger.error("[Keyframe] face block persist FAILED for %s: %s", base_name, e)
            return block
        logger.info("[Keyframe] cached face block for %s (%s)", base_name,
                    "vision-grounded" if observed else "from description")
        return block


class ResetIdentityRequest(BaseModel):
    project_name: str = ""
    project_path: str = ""
    characters: list[str] = []     # names to reset; empty = ALL characters


@app.post("/api/keyframe/reset-identity")
async def reset_character_identity(req: ResetIdentityRequest):
    """Drop the cached fictional face block(s) so the next keyframe regenerates a
    fresh vision-grounded one — lets the user re-roll a character's face without
    editing files. See seedance-identity-filter."""
    cleared: list[str] = []
    names = req.characters or [""]   # [""] → clear all
    for nm in names:
        cleared += await asyncio.to_thread(          # flock — see _get_face_block above
            proj_storage.clear_face_block, req.project_name, nm, req.project_path)
        _face_block_locks.pop(f"{req.project_path or req.project_name}:{nm}", None)
    logger.info("[Keyframe] reset identity cache: %s", cleared or "(none)")
    return {"cleared": cleared}


class FaceAnchorRequest(BaseModel):
    project_name: str = ""
    project_path: str = ""
    character: KeyframeCharacter = KeyframeCharacter(name="")
    style: StyleConfig = StyleConfig()
    force: bool = False


async def _ensure_face_anchor(claude, api, ch: "KeyframeCharacter", project_name: str,
                              project_path: str, style: "StyleConfig", force: bool = False) -> str:
    """Generate (and cache) a character's FACE ANCHOR — a clean t2i portrait built from
    the fictional-distinctive face block. The face is FICTIONAL so it PASSES Seedance's
    real-person filter as a reference (the realistic sheet does NOT). The SAME anchor is
    used to build the E3 character sheet AND as the identity reference in every E5 shot,
    so the approved face == the face in every shot. Returns the saved anchor path.
    See seedance-identity-filter."""
    if not ch.name:
        return ""
    if not force:
        cached = proj_storage.read_face_anchor(project_name, ch.name, project_path)
        if cached and os.path.exists(cached):
            return cached
    block = await _get_face_block(claude, api, ch, project_name, project_path)
    prompt = (
        "Photorealistic studio portrait photograph of a real person, front-facing "
        "three-quarter view, head and upper body, on a clean neutral gray studio "
        "background. Render the face as a distinctive specific individual (not a celebrity "
        f"or copyrighted character): {block} "
        f"Wardrobe, hair and build context (NOT a real identity): {ch.description}. "
        "Shot on Arri Alexa 35, 85mm prime lens, soft key light, ISO 320, natural film "
        "grain, real skin texture with visible pores. A real photograph, not an "
        "illustration, not a 3D render."
    )
    urls = await asyncio.to_thread(
        api.generate_image, prompt, "2K", 1, None, style.negative_prompt or None, None, project_path,
        "png",   # lossless → keeps the trusted watermark intact through save/serve → Seedance
    )
    if not urls:
        raise RuntimeError("Seedream returned no face-anchor image")
    import requests as _req, base64 as _b64
    resp = await asyncio.to_thread(_req.get, urls[0], timeout=60)
    resp.raise_for_status()
    b64 = _b64.b64encode(resp.content).decode()
    saved = await asyncio.to_thread(
        proj_storage.save_asset_version,
        project_name, f"Characters/{ch.name}/FaceAnchor", b64, project_path,
        {"kind": "face_anchor", "sent_prompt": prompt, "model": "seedream"},
    )
    try:
        await asyncio.to_thread(                     # flock — see _get_face_block above
            proj_storage.write_face_anchor, project_name, ch.name, saved["path"], project_path)
    except Exception as e:
        # write_face_anchor used to swallow this and return None. It must not: the anchor
        # IMAGE is on disk and paid for, but nothing can find it again, so every later
        # shot of this character regenerates its own face. Raising is enough here — the
        # one caller (the endpoint below) publishes the detail on the agent bus and
        # answers 502, so the user is told instead of discovering it in the finished film.
        raise RuntimeError(
            f"anchor image saved to {saved['path']} but the identity lock for {ch.name} "
            f"could NOT be written ({e}) — later shots would render a different face"
        ) from e
    return saved["path"]


@app.post("/api/character/face-anchor")
async def generate_face_anchor(req: FaceAnchorRequest):
    """Generate/cache a character's fictional-distinctive FACE ANCHOR (see _ensure_face_anchor)."""
    claude = get_claude()
    api = get_byteplus()
    if not req.character.name:
        raise HTTPException(status_code=400, detail="character name required")
    cached = proj_storage.read_face_anchor(req.project_name, req.character.name, req.project_path)
    if cached and os.path.exists(cached) and not req.force:
        return {"anchor_path": cached, "cached": True}
    await bus.publish("seedream", "active", f"Face anchor: {req.character.name}…", 10)
    try:
        path = await _ensure_face_anchor(claude, api, req.character, req.project_name,
                                         req.project_path, req.style, req.force)
        await bus.publish("seedream", "completed", f"Face anchor saved: {req.character.name}", 100)
        return {"anchor_path": path, "cached": False}
    except Exception as e:
        await bus.publish("seedream", "error", str(e))
        raise HTTPException(status_code=502, detail=f"Face anchor failed: {e}")


@app.post("/api/video/keyframe")
async def generate_shot_keyframe(req: ShotKeyframeRequest):
    """
    0.5: Generate a Seedream still (keyframe) of a shot composition BEFORE animating.
    The approved keyframe becomes the first_frame for Seedance — the consistency anchor.
    Because i2v Seedance drops reference_image items, the refs attached HERE are the
    only channel that carries the approved character/environment into the shot.
    """
    from byteplus_generative import assemble_image_prompt, resolve_reference_strict
    api = get_byteplus()
    await bus.publish("seedream", "active", f"Keyframe: {req.shot_id}…", 10)
    try:
        # Build keyframe prompt: describe the shot composition, NOT motion
        context_parts = []
        if req.shot_action:
            context_parts.append(f"scene: {req.shot_action}")
        if req.subject_hint:
            context_parts.append(req.subject_hint)
        if req.env_hint:
            context_parts.append(req.env_hint)
        if req.lighting_hint:
            context_parts.append(req.lighting_hint)

        # F1 (seedance-identity-filter): for PHOTOGRAPHIC styles the face cannot
        # ride a reference image (that breaks Seedream's watermark → Seedance i2v
        # rejects it as a real person). Carry the face as TEXT instead: a cached
        # distinctive-fictional feature block per character, generated once and
        # reused so the face stays consistent across this character's shots.
        photographic = _is_photographic(req.style.label, req.style.prompt_suffix)
        if photographic and req.characters:
            claude = get_claude()
            blocks: list[str] = []
            for ch in req.characters:
                if not ch.name:
                    continue
                try:
                    block = await _get_face_block(claude, api, ch, req.project_name, req.project_path)
                except Exception as fe:
                    logger.warning("[Keyframe] face block gen failed for %s: %s", ch.name, fe)
                    block = ""
                if block:
                    blocks.append(f"{ch.name} — {block}")
            if blocks:
                context_parts.append(
                    "Render every human face as an ENTIRELY FICTIONAL person resembling "
                    "no real or famous person and no copyrighted character. " + " ".join(blocks)
                )

        # Board grounding (photographic): the keyframe must REPRODUCE the shot's first
        # storyboard panel, but the board can't ride as an image ref (any ref strips the
        # trusted watermark → Seedance rejects the face). Claude vision describes panel 1
        # and the composition rides as TEXT — fidelity without breaking the trust chain.
        if photographic and req.board_url:
            try:
                parts = await asyncio.to_thread(_image_to_parts, req.board_url)
                claude = get_claude()
                comp = await asyncio.to_thread(
                    claude.panel_composition, parts, max(1, req.board_rows), max(1, req.board_cols))
                if comp:
                    context_parts.append(
                        "COMPOSITION LOCK — this frame must reproduce the shot's approved "
                        "storyboard panel exactly (framing, pose, blocking, props, lighting): "
                        + comp
                    )
                    logger.info("[Keyframe] %s: board panel-1 grounding injected (%d chars)",
                                req.shot_id, len(comp))
            except Exception as be:
                logger.warning("[Keyframe] %s: board grounding failed (non-fatal): %s", req.shot_id, be)

        # P2.10: address each reference explicitly in the prompt so the model
        # binds them ("the character's face from image 1, …")
        if req.ref_descriptors:
            addressing = "; ".join(
                f"image {i + 1} is {d}" for i, d in enumerate(req.ref_descriptors) if d
            )
            match_line = "Match the character's face and wardrobe to their reference images exactly"
            context_parts.append(f"References: {addressing}. {match_line}")

        # Keyframe = the shot's first frame, so its look propagates to the whole clip.
        # Lead photographic styles with the camera + real-skin medium (the same anti-3D
        # anchor the sheets use); the style suffix alone, diluted at the END of the
        # prompt, let the still drift to a stylized/animated look despite "photoreal".
        shot_desc = req.shot_description
        if photographic:
            shot_desc = (
                "Photorealistic cinematic film still, a real photograph shot on an Arri Alexa 35 "
                "with a 50mm prime lens, natural film grain, true skin texture with visible pores "
                "and natural imperfections, photographic realism. " + shot_desc
            )
        assembled = assemble_image_prompt(
            raw_description=shot_desc,
            style_suffix=req.style.prompt_suffix,
            extra_context=", ".join(context_parts) if context_parts else "",
        )
        sent_prompt = req.prompt_override.strip() or assembled
        negative = (req.negative_override if req.negative_override is not None
                    else req.style.negative_prompt) or None

        # Dry run: show the user exactly what would be sent — prompt, negative,
        # and the ordered reference list — without spending a generation.
        if req.dry_run:
            dry_attach = (not photographic) or os.getenv("TAKEONE_I2I_TRUSTED", "") == "1"
            planned_refs = [] if not dry_attach else [
                {"url": url, "label": (req.ref_descriptors[i] if i < len(req.ref_descriptors) else "reference image")}
                for i, url in enumerate(req.approved_asset_urls[:12]) if url
            ]
            await bus.publish("seedream", "completed", f"Keyframe prompt ready: {req.shot_id}", 100)
            return {
                "dry_run": True,
                "shot_id": req.shot_id,
                "assembled_prompt": assembled,
                "negative_prompt": negative or "",
                "references": planned_refs,
            }

        # Approved asset images as identity/environment references.
        # Strict resolution: a dead ref must fail the call, not silently drop —
        # otherwise the keyframe invents a new character and consistency is gone.
        # Documented Seedream limit is 14 refs; keep 2 slots for style anchors.
        MAX_ASSET_REFS = 12
        refs: list[dict] = []
        # IDENTITY BY IMAGE — gated on the I2I-trust whitelist (TAKEONE_I2I_TRUSTED=1).
        # Validated 2026-07-07: Seedream+refs produces PERFECT shot-to-shot identity,
        # but Seedance rejects ref-conditioned keyframes with visible faces unless the
        # ACCOUNT is whitelisted for I2I trust ("KYC-verified customers… provide your
        # account ID"). Until the whitelist lands: photographic keyframes stay pure
        # t2i (trusted; identity via face-block text + SB-mode anchors), everything
        # else attaches refs. Flip the env var when BytePlus confirms the whitelist —
        # the full original design (sheet+env+prop refs on every keyframe) activates.
        attach_refs = (not photographic) or os.getenv("TAKEONE_I2I_TRUSTED", "") == "1"
        if not attach_refs:
            logger.info("[Keyframe] %s: photographic + no I2I whitelist → pure t2i (%d ref(s) withheld)",
                        req.shot_id, len([u for u in req.approved_asset_urls if u]))
        if attach_refs:
            if len(req.approved_asset_urls) > MAX_ASSET_REFS:
                logger.warning(
                    "[Keyframe] %s: DROPPING %d asset ref(s) beyond the %d-slot budget",
                    req.shot_id, len(req.approved_asset_urls) - MAX_ASSET_REFS, MAX_ASSET_REFS,
                )
            dropped_refs = 0
            for i, url in enumerate(req.approved_asset_urls[:MAX_ASSET_REFS]):
                if not url:
                    continue
                try:
                    data_uri = await asyncio.to_thread(resolve_reference_strict, url)
                except Exception as ref_err:
                    # A reference that no longer resolves is almost always an EXPIRED
                    # BytePlus URL — those 403 after 24h. Failing the whole keyframe
                    # with a 502 froze the shot in the UI and made ANY project older
                    # than a day impossible to regenerate. Skip the dead ref and keep
                    # going with whatever still resolves: a slightly less-anchored
                    # keyframe beats a hard freeze. Surface it as a warning, not a crash.
                    logger.warning(
                        "[Keyframe] %s: ref %d unreachable (expired BytePlus URL?), skipping — %s",
                        req.shot_id, i + 1, ref_err,
                    )
                    dropped_refs += 1
                    continue
                refs.append({
                    "url": data_uri,
                    "role": "reference_image",
                    # First ref = character identity anchor (weight only honoured by
                    # the legacy ref_images A/B mode; documented `image` param relies
                    # on ordering — identity refs first).
                    "weight": 0.9 if i == 0 else 0.65,
                })
            for url in req.style.anchor_image_refs[:2]:
                if url:
                    refs.append({"url": url, "role": "reference_image", "weight": 0.5})
            if dropped_refs:
                await bus.publish(
                    "seedream", "active",
                    f"{req.shot_id}: {dropped_refs} expired reference(s) skipped — regenerating anyway", 40,
                )

        logger.info("[Keyframe] %s: %d asset ref(s) attached%s, prompt=%r",
                    req.shot_id, len(refs),
                    " (USER-EDITED PROMPT)" if sent_prompt != assembled else "",
                    sent_prompt[:120])

        size = KEYFRAME_SIZE_BY_AR.get(req.aspect_ratio, "2848x1600")
        n_gen = max(1, min(req.best_of, 4))
        urls = await asyncio.to_thread(
            api.generate_image,
            sent_prompt,
            size,
            n_gen,
            refs or None,
            negative,
        )
        if not urls:
            raise RuntimeError("Seedream returned no keyframe URLs")

        # Best-of-N: score each candidate against the character reference and keep the
        # most on-model one (objective consistency, not the luck of a single draw).
        candidate_scores: list[dict] = []
        if n_gen > 1 and req.reference_url and len(urls) > 1:
            await bus.publish("seedream", "active", f"{req.shot_id}: scoring {len(urls)} candidates…", 70)
            claude = get_claude()
            try:
                ref_parts = await asyncio.to_thread(_image_to_parts, req.reference_url)

                async def _score_kf(i: int, u: str) -> dict:
                    try:
                        cand = await asyncio.to_thread(_image_to_parts, u)
                        r = await asyncio.to_thread(claude.identity_match, ref_parts, cand)
                        return {"index": i, "url": u, "consistency": int(r.get("consistency", 0)),
                                "differs": r.get("differs", "")}
                    except Exception as se:
                        logger.warning("[Keyframe best-of] score failed: %s", se)
                        return {"index": i, "url": u, "consistency": -1, "differs": "score failed"}

                candidate_scores = list(await asyncio.gather(*[_score_kf(i, u) for i, u in enumerate(urls)]))
                candidate_scores.sort(key=lambda x: -x["consistency"])
                best_i = candidate_scores[0]["index"]
                urls = [urls[best_i]] + [u for j, u in enumerate(urls) if j != best_i]
                logger.info("[Keyframe best-of] %s: winner idx=%d consistency=%d%%",
                            req.shot_id, best_i, candidate_scores[0]["consistency"])
            except Exception as be:
                logger.warning("[Keyframe best-of] ranking failed, using first candidate: %s", be)

        # Persist to disk: the local copy never expires, unlike the signed CDN URL.
        # This local path is what Seedance gets as first_frame at animation time.
        keyframe_local_path = ""
        if req.project_name or req.project_path:
            try:
                import requests as _req, base64 as _b64
                resp = await asyncio.to_thread(_req.get, urls[0], timeout=60)
                resp.raise_for_status()
                b64 = _b64.b64encode(resp.content).decode()
                saved = await asyncio.to_thread(
                    proj_storage.save_asset_version,
                    req.project_name, f"Shots/{req.shot_id}/Keyframes", b64, req.project_path,
                    {
                        "kind": "keyframe",
                        "auto_prompt": assembled,
                        "prompt_override": sent_prompt if sent_prompt != assembled else None,
                        "sent_prompt": sent_prompt,
                        "negative_prompt": negative or "",
                        "references": [
                            {"url": u, "label": (req.ref_descriptors[i] if i < len(req.ref_descriptors) else "reference image")}
                            for i, u in enumerate(req.approved_asset_urls[:12]) if u
                        ],
                        "model": "seedream", "size": size,
                    },
                )
                keyframe_local_path = saved.get("path", "")
                logger.info("[Keyframe] %s saved to %s", req.shot_id, keyframe_local_path)
            except Exception as se:
                logger.warning("[Keyframe] disk save failed (non-fatal): %s", se)

        await bus.publish("seedream", "completed", f"Keyframe: {req.shot_id} ready", 100)
        return {
            "keyframe_url": urls[0],
            "keyframe_local_path": keyframe_local_path,
            "shot_id": req.shot_id,
            "assembled_prompt": assembled,
            "sent_prompt": sent_prompt,
            "ref_count": len(refs),
            "candidates": candidate_scores,
            "consistency": candidate_scores[0]["consistency"] if candidate_scores else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        await bus.publish("seedream", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


def _resolve_ref_disk(rel_folder: str, project_name: str, project_path: str) -> str:
    """Given a reference's disk-FOLDER hint (e.g. 'Assets/Characters/Loom' or
    'Shots/SHOT_003/Storyboard'), return the CURRENT version's absolute path on disk, or ''
    if none. The disk copy is PERMANENT (versioned writes never delete), so this lets a
    reference survive an expired ~24h CDN url — the #1 cause of a mid-render
    'content[N].image_url … resource download failed' 400 (observed 2026-07-23)."""
    if not (rel_folder or "").strip():
        return ""
    try:
        root = proj_storage._resolve_root(project_name, project_path)
        vdir = root / rel_folder / "Versions"
        if not vdir.is_dir():
            return ""
        vers = sorted(p for p in vdir.glob("v*")
                      if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
        return str(vers[-1]) if vers else ""
    except Exception as e:
        logger.warning("[RefDisk] resolve failed for %r: %s", rel_folder, e)
        return ""


async def _resolve_intent_quietly(marker_id: str, task_id: str = "") -> None:
    """Drop a submit-intent marker off the event loop, never raising.

    Both properties are about the SAME line of code it protects: this runs immediately
    after BytePlus accepted a submit, so (a) blocking here freezes the server on the
    registry lock like every other call did, and (b) a LockTimeout escaping here would
    fall into _create_video_impl's `except Exception -> HTTPException 500` and destroy an
    accepted, billed task_id — the very thing the marker exists to protect.

    A marker that survives when it should not is cheap by comparison: it makes recovery
    say "a charge MAY exist" once for a shot that is in fact fine, and the next sweep
    consumes it (render_queue.recover_stalled -> resolve_submit_intent)."""
    if not marker_id:
        return
    try:
        await asyncio.to_thread(render_registry.resolve_submit_intent, marker_id, task_id)
    except Exception as e:
        logger.warning("[Seedance] could not clear submit-intent marker %s: %s (harmless "
                       "— it can only cause one extra 'charge may exist' warning)",
                       marker_id, e)


#: Disk-folder hint prefix → the ROLE that reference plays in a Seedance prompt.
#: The hint is written by FinalGenView (`assetFolder`, `Shots/<id>/Storyboard`) and is
#: already load-bearing for a different reason — _resolve_ref_disk uses it to swap in the
#: permanent copy — so classifying by it costs nothing new and cannot drift from the asset
#: type the way a label substring can. Longest prefix wins so `Assets/Environments` is not
#: matched by a hypothetical `Assets/Env…` shorthand.
_REF_KIND_BY_PATH = {
    "assets/characters":   "character",
    "assets/environments": "location",
    "assets/props":        "prop",
    "assets/wardrobe":     "wardrobe",
    "assets/fx":           "fx",
}


def _dialogue_audio_source(req: "VideoTaskRequest", ref_first_frame: bool) -> tuple[str | None, str]:
    """Which dialogue clip this take will be SENT — decided without synthesising anything.

    The submission picks in a fixed precedence: an explicit audio_url, then the approved
    Shots/<shot_id>/dialogue.mp3 on disk, then inline synthesis. Only the last of those
    produces one clip PER SPEAKER; the first two are a single mixed clip.

    A dry run must never pay Seed Audio, so it cannot run the third branch — and it used to
    describe the audio from req.dialogue instead, emitting "@Audio 1 is X's voice, @Audio 2
    is Y's voice" for a take that would be sent ONE unlabelled clip. That is not a cosmetic
    preview: the reviewed prompt is handed straight back as prompt_override and goes to the
    model verbatim, so the model was told about an @Audio 2 that was never attached — the
    same dangling-reference failure the image roles exist to prevent, in the other
    direction. Both callers now ask this one function, so a fourth source added later
    cannot be known to one of them and not the other.

    Returns (audio_url, source); source is explicit | approved_clip | none. 'none' means
    nothing is attached yet and the inline per-speaker branch is the one that would run.
    """
    if req.audio_url:
        return req.audio_url, "explicit"
    # Guarded exactly as the submission guards it: an i2v take that is not riding its
    # keyframe as a reference gets no audio at all, so there is nothing to name.
    if (not req.image_url or ref_first_frame) and req.project_name:
        try:
            _root = proj_storage._resolve_root(req.project_name, req.project_path)
            _clip = _root / "Shots" / proj_storage._safe(req.shot_id) / "dialogue.mp3"
            if _clip.is_file():
                return str(_clip), "approved_clip"
        except Exception:
            pass                    # a look at the disk must never fail a render
    return None, "none"


def _reference_roster(req: "VideoTaskRequest", ref_first_frame: bool = False) -> list[dict]:
    """The ATTACHED references, in attachment order, each with the role it plays.

    HELL GRIND rule 2, quoted: "When you feed assets to Seedance, name the role of every
    reference… or the model decides by itself, and decides wrong: it copies the composition
    instead of the face, or the face instead of the color palette." The wording that goes
    into the prompt lives in byteplus_generative.assemble_reference_roles; this function
    only answers WHICH files are attached and WHAT each one is.

    Order and membership must match create_video_task exactly or `<Image_N>` addresses the
    wrong picture:
      * i2v (a first_frame exists) → the API rejects mixing first_frame with reference
        media, so create_video_task DROPS every reference image and video. Nothing is
        attached but the keyframe, there is no role ambiguity to resolve, and this returns
        [] so the assembled prompt stays byte-identical to the pre-change one.
      * `ref_first_frame` (2.5 + dialogue) → the keyframe is demoted to a reference image
        and PREPENDED, so references are attached after all and the i2v short-circuit above
        would be exactly wrong: it returned [] while N pictures went out unlabelled. The
        keyframe is named as roster entry #1 so every later number still equals its
        attachment index.
      * reference/t2v → user refs (minus first_frame, minus empty urls), capped at the
        documented 9, then up to 3 motion videos. Style anchors are NOT attached to
        Seedance any more (2026-09-11, see _create_video_impl).
    """
    if req.image_url and not ref_first_frame:
        return []                      # i2v: references are dropped by the API — see above
    roster: list[dict] = []
    # 2.5 dialogue path: the keyframe stops being `first_frame` and is PREPENDED to the
    # attachment list (see _create_video_impl), so it is picture #1 and every user
    # reference shifts one slot right. Naming it here is what keeps the roster's numbering
    # equal to the attachment order — the invariant this whole function exists to hold.
    if ref_first_frame:
        roster.append({"kind": "first_frame", "name": req.shot_id or "this take", "label": ""})
    for i, r in enumerate(req.reference_images):
        if not r.url or r.role == "first_frame":
            continue
        if len(roster) >= 9:           # documented 2.0 multimodal-reference limit (1–9)
            break
        # The frontend's own `<Image_N> = <label>` line for this ref, parallel-indexed.
        # Its labels are "<what the asset is> — <what to do with it>" (FinalGenView), and
        # only the first half is wanted here: the second half is an instruction, and next
        # to a named role it comes out as "STORYBOARD reference — follow its composition …
        # — the approved storyboard frame — match its composition". Split on the EM dash
        # only; asset names legitimately contain hyphens ("DEPOT - YARD").
        label = (req.ref_addressing[i].split("=", 1)[-1].strip()
                 if i < len(req.ref_addressing) else "")
        label = label.split("—")[0].strip().rstrip(",")
        p = (r.path or "").replace("\\", "/").strip().lower()
        kind = ""
        for prefix, k in sorted(_REF_KIND_BY_PATH.items(), key=lambda kv: -len(kv[0])):
            if p.startswith(prefix):
                kind = k
                break
        if not kind and p.startswith("shots/") and p.endswith("/storyboard"):
            kind = "board"
        # No path hint at all. The ONE ref built without one is the previous shot's closing
        # frame (FinalGenView pushes it straight into sbRefs), and it is recognisable from
        # the line the same code writes for it. This is a documented fallback, not a guess
        # dressed as a fact: anything it does not recognise stays kind="" and
        # assemble_reference_roles then says only the label the frontend wrote — it never
        # invents a role for a reference nobody classified.
        # The caller can say outright what a ref is; nothing needs to be inferred then.
        if not kind and (r.kind or "").strip():
            kind = r.kind.strip()
        # Legacy path: bodies written before `kind` existed — and the render queue replays
        # stored ones verbatim — carry it only in the wording. Both phrasings this line has
        # ever produced are matched, because the failure mode is silent.
        if not kind and "closing frame of the" in label.lower():
            kind = "continuity"
        # The handle's name. For an asset it is the folder leaf ("DEPOT - YARD"); for a
        # board that leaf is the literal word "Storyboard", which would name every board in
        # the film `@board_storyboard`, so the SHOT id one level up is used instead.
        segs = [s for s in (r.path or "").replace("\\", "/").split("/") if s]
        name = segs[-1] if segs else ""
        if kind == "board" and len(segs) >= 2:
            name = segs[-2]
        elif kind == "continuity":
            name = "previous shot"
        # EL NOMBRE BASE, NO EL DE LA VARIANTE. Una lámina de personaje puede llamarse
        # "<Personaje> · <momento>" ("… · Shocked at the briefing"), y storage._safe borra
        # el "·" al hacer la carpeta, así que el disco guarda "<Personaje>  <momento>" con
        # DOS espacios. Ese nombre alimenta dos consumidores: el handle de la referencia y
        # la lista de reparto de `[Maintain Consistency]`. Sin limpiarlo, el prompt declara
        # como personaje distinto a "<Personaje>  <momento>" — que además rompe el recuento
        # de esa misma lista, cuyo trabajo es decir cuánta gente hay.
        #
        # El frontend ya resuelve esto para los sujetos con `baseNameOf`, pero necesita el
        # mapa de assets, que aquí no existe; el doble espacio es la huella que el
        # separador deja en la ruta y basta para cortar por el mismo sitio.
        name = _re.split(r"\s{2,}|\s+·\s+", name)[0].strip() or name
        roster.append({"kind": kind, "name": name, "label": label})
    # No style anchors here any more — see _create_video_impl, which stopped attaching
    # them. The roster names exactly what the frontend listed, in its order, and nothing
    # else, so `@Image N` in the prompt and `image N` in the review panel are the same N.
    for j, v in enumerate(req.reference_videos[:3], start=1):
        if v:
            # A drive clip says what it drives, or stays on the undivided motion role.
            _mk = (req.reference_video_kinds[j - 1].strip().lower()
                   if j - 1 < len(req.reference_video_kinds) else "")
            _kind = {"body": "motion_body", "face": "motion_face"}.get(_mk, "motion")
            roster.append({"kind": _kind, "name": f"shot_{j}", "label": ""})
    return roster


@app.post("/api/video/create")
async def create_video(req: VideoTaskRequest):
    return await _create_video_impl(req)


async def _create_video_impl(req: VideoTaskRequest) -> dict:
    """The whole body of POST /api/video/create, as a plain callable.

    B3: the background queue worker submits through THIS, not through HTTP, so a
    queued shot takes the identical path an interactive render takes — same prompt
    assembly, same `_get_video_sem` admission control, same render_registry.record()
    that hands the task to the reconciler. Anything the worker duplicated instead
    would drift from the endpoint the first time this function changed.
    """
    from byteplus_generative import (assemble_video_prompt, assemble_segment_prompt,
                                     assemble_reference_roles, board_shot_mismatch)
    api = get_byteplus()

    # 0.4: Build formula-structured Seedance prompt on the backend.
    # Use shot_action (the breakdown ACTION text) as the core motion description.
    camera = req.camera_angle or "smooth tracking shot, slow and deliberate"
    # P3.13: documented dialogue syntax — {spoken line} with the speaker named
    dialogue_lines: list[str] = []
    for d in req.dialogue:
        text = (d.get("text") or "").strip()
        if not text:
            continue
        speaker = d.get("character") or "The character"
        emotion = (d.get("emotion") or "").strip()
        tone = f" in a {emotion} tone" if emotion else ""
        dialogue_lines.append(f'{speaker} says{tone}: {{{text}}}')

    # ── The keyframe-routing decision, resolved ONCE and read everywhere below ───
    # Resolved HERE, at the top, because two separate things downstream depend on it: the
    # constraints block immediately below, and the reference roster ~40 lines on. It used
    # to be computed ~325 lines further down, next to the attachment list, which was too
    # late for both. In particular the roster could not know that on the 2.5 dialogue path
    # the keyframe becomes reference image #1, so it (a) returned [] because
    # `req.image_url` is set — the model got N unlabelled pictures and no roles at all —
    # and (b) every `<Image_N>` the prompt named pointed one slot left of the picture it
    # meant. The sd25-pe contract calls mis-numbered mapping a direct cause of "character
    # confusion or duplication".
    _resolved_model = api.resolve_tier(req.tier or None, req.resolution,
                                       req.model_choice or None)[0]
    _is_25 = _resolved_model == api.SEEDANCE_25_MODEL
    _call_caps = model_caps(_resolved_model)
    _has_dialogue = bool(req.audio_url) or bool(req.dialogue)
    # UNREACHABLE FROM STAGE 5 TODAY — verified 2026-08-09, delete if it stays that way.
    #
    # This needs image_url AND not exact_first_frame, and stage 5 can produce neither
    # combination (FinalGenView `keyframeUrl`): storyboard and motion_ref modes send no
    # image at all, and continuity mode sends the previous shot's closing frame together
    # with exact_first_frame=true, because a chained seam has to be byte-exact. Take One Studio has
    # no keyframe phase — "the storyboard is the composition approval and the approved
    # assets carry identity" — so nothing generates a first frame to route.
    #
    # Kept because it is REACHABLE from other callers (Studio, and any future keyframe
    # mode) and because it encodes a real API constraint: a first_frame excludes reference
    # media on 2.0, which would silently drop a shot's dialogue track. On 2.5 that
    # exclusion no longer holds — the prompt guide templates "First Frame with Additional
    # References" — so if a keyframe phase ever returns, prefer naming the frame per the
    # contract over this workaround.
    #
    # TIP FOR WHOEVER READS THIS NEXT: if `[Seedance] … keyframe routed as reference_image`
    # has never appeared in a log, this branch and `SubjectProfile.addr`'s first-frame slot
    # are dead weight — delete them rather than maintaining a path nobody exercises.
    ref_first_frame = bool(_is_25 and _has_dialogue and req.image_url
                           and not req.exact_first_frame)

    # Image-quality slot follows the LOCKED style: "cinematic texture, natural
    # colors" fights stylized looks (anime/illustrated), so those words are the
    # photographic branch only. The style-agnostic constraints stay for everyone.
    #
    # On 2.5 most of this block is REMOVED, because the official sd25-pe contract forbids
    # it by name — non-negotiable principle 8: "Do not automatically add unrequested
    # quality or stability boilerplate, watermarks, logos, subtitles, duplicate-subject
    # restrictions, or other generic negative constraints." Every clause here was exactly
    # that: "HD, rich details" is quality boilerplate, "Do not generate a watermark or
    # logo" is named outright, and "Preserve composition and colors" asks the model to
    # preserve something no input established. The contract's own guidance is to prefer
    # positive description and let the references carry the look.
    #
    # The subtitle clause SURVIVES on both models. It is the one negative the contract
    # explicitly supports ("Supports negative control for subtitles"), its own audio
    # section says to state that no subtitles appear when they are not wanted, and burnt-in
    # captions on a film deliverable are a product defect, not a stylistic preference.
    # 2.0 is untouched: no documented equivalent, and its prompts stay byte-for-byte.
    _vid_photographic = _is_photographic(req.style.label, req.style.prompt_suffix)
    if _is_25:
        CONSTRAINTS = "No subtitles or on-screen text appear in the video."
    else:
        CONSTRAINTS = (
            ("HD, rich details, cinematic texture, natural colors. " if _vid_photographic
             else "HD, rich details, consistent art style. ")
            + "Preserve composition "
            "and colors. Keep it subtitle-free, avoid generating any text or subtitles. "
            "Do not generate a watermark or logo."
        )
    # PHASE 5 · the story layer finally reaches the pixels. Until now the bible stopped
    # at phase 2: every shot prompt in the film was written from the action line, the
    # camera and the style, with nothing anywhere saying what the moment is FOR. That is
    # why a technically-clean episode reads as unrelated takes.
    #
    # It rides in through director_notes rather than a new parameter because that is the
    # ONE input already threaded into all four assembly branches below (vision writer,
    # text template, segment mode, classic assembler) AND already framed to the model as
    # "must be honored". A new field would have to be plumbed into four call sites and
    # two prompt writers to reach the same place.
    #
    # No bible → _bible_render_note returns "" → director_notes IS req.director_notes and
    # every branch assembles exactly the prompt it assembles today.
    story_note = _bible_render_note(
        await asyncio.to_thread(_read_bible_quietly, req.project_name, req.project_path),
        req.scene_name or req.shot_scene,
    )
    director_notes = req.director_notes
    if story_note:
        director_notes = (director_notes.rstrip() + "\n" if director_notes.strip() else "") + story_note
        logger.info("[Bible] %s: story context attached (%d chars) for scene %r",
                    req.shot_id, len(story_note), req.scene_name or req.shot_scene)
    # HELL GRIND rule 2: what each attached picture is FOR. Built here, before the
    # assembly branches, because both the segment and the classic assembler need it and it
    # has to be derived from the SAME request fields the attachment is derived from.
    # Empty on i2v (the API drops references there) → those prompts do not change at all.
    ref_roster = _reference_roster(req, ref_first_frame)
    # The acting profiles, resolved ONCE for every assembly branch. Computed here and not
    # inside one branch because the branch a real film takes is the SEGMENT one — the
    # direction template only runs for a segment of a single shot, which on DryRUN is 1 of
    # 19 cards. Scoped inside a branch, this reached almost nothing.
    _subject_profiles = (assemble_subject_profiles([s.model_dump() for s in req.subjects], True)
                         if _is_25 else "")
    if _subject_profiles:
        logger.info("[Acting] %s: %d subject profile(s) in the prompt", req.shot_id,
                    len([s for s in req.subjects if (s.acting or '').strip()]))
    _unused_block = assemble_unused_materials(req.unused_assets) if _is_25 else ""
    if _unused_block:
        logger.info("[Refs] %s: %d scene asset(s) prohibited by name", req.shot_id,
                    len(req.unused_assets))
    if ref_roster:
        logger.info("[VideoDirection] %s: %d reference role(s) named — %s",
                    req.shot_id, len(ref_roster),
                    ", ".join(r["kind"] or "unclassified" for r in ref_roster))
    # HELL GRIND rule 1: the scene's floor plan, written ONCE at board time (phase 4) and
    # pasted into EVERY shot of the scene without changes — including here, where the
    # pixels are actually bought. Built before the assembly branches because all four of
    # them need it, and looked up by SHOT ID because that is the only unambiguous handle
    # this request carries (see _geo_block_for). No board / no geo → "" → every branch
    # below assembles exactly the prompt it assembles today.
    # SCENE_GEO_LAYOUT=0 has to reach HERE too, not just phase 4. Measured 2026-08-06:
    # with the flag off, phase 4 stopped deriving but phase 5 kept reading the map an
    # earlier board had already written to disk, so the flag did NOT return the render
    # prompt to its pre-change bytes — the one thing a kill switch is for. Rule 4 of the
    # brief is the reason it must: "You write it ONCE PER SCENE and paste it into EVERY
    # shot of that scene WITHOUT CHANGES" — a half-off feature pastes it into some.
    geo_block = "" if os.getenv("SCENE_GEO_LAYOUT", "1") != "1" else _geo_block_for(
        await asyncio.to_thread(_read_scene_geos_quietly, req.project_name, req.project_path),
        req.shot_id, req.scene_name or req.shot_scene)
    if geo_block:
        logger.info("[VideoDirection] %s: scene floor plan attached (%d chars)",
                    req.shot_id, len(geo_block))
    assembled_negative = ""
    # Set by the SEGMENT branch when the approved board does not describe the shots this
    # card declares (a re-cut segment against a board nobody re-ran). None on every other
    # branch and on a matching board — so the response gains a key that is null unless
    # something is actually wrong.
    board_mismatch: dict | None = None
    if req.prompt_override.strip():
        # User-reviewed prompt: verbatim, no Claude rewrite — what they saw in
        # the panel is exactly what Seedance receives.
        assembled_prompt = req.prompt_override.strip()
        assembled_negative = (req.negative_override
                              if req.negative_override is not None
                              else req.style.negative_prompt) or ""
        logger.info("[VideoDirection] USER-EDITED prompt: %d chars", len(assembled_prompt))
    # A real segment (more than one shot) wins over the direction template. The template
    # writes ONE continuous take from a board's panels; it has no way to express "cut
    # here, then here". With boards approved — 44/44 on ROBOTECH — this branch matched
    # first and threw the segment payload away, so `assemble_segment_prompt` never ran on
    # any migrated project either. A single-shot segment still takes the template, which
    # is the richer prompt for one take.
    elif req.use_direction and len(req.segment_shots) <= 1:
        # Production Video Direction template. Preferred path (item 7b): the writer
        # SEES the actual reference images (board + assets, in attachment order) and
        # grounds the prompt in the real pixels. Text-only template is the fallback
        # when no image loads.
        #
        # get_agents(), not get_claude(): both writers moved to _text_llm (Seed first,
        # Claude only as fallback) when this account ran out of Anthropic credit and
        # 17 of BLOOM's 41 phase-5 cards started answering 502. That removed the
        # dependency on the CREDIT and left the one on the KEY, one layer upstream —
        # measured on the real SHOT_011 card with ANTHROPIC_API_KEY='' and a funded
        # BytePlus key: HTTP 503 in 0.1 s with ZERO outbound requests, the Seed leg
        # never attempted. get_agents() raises only when NEITHER backend is
        # configured, which is the honest condition here; its docstring documents
        # this exact class of locked-door-in-front-of-a-working-engine.
        claude = get_agents()
        # The ceiling is the CHOSEN model's, not a constant: clamping to 15 s here would
        # silently undo a 30 s single take on 2.5 before the builder ever saw it — and a
        # long take is the whole reason to pick 2.5 (fewer cuts, fewer continuity breaks).
        _dcaps = model_caps(api.resolve_tier(req.tier or None, req.resolution,
                                             req.model_choice or None)[0])
        clamped = max(float(_dcaps["min_duration"]),
                      min(float(_dcaps["max_duration"]), float(req.duration_secs)))
        direction = ""
        vision_used = False
        vision_error = ""          # the vision writer's reason, carried into the 502 below
        if req.use_vision_prompt:
            # Build [{label, path}] in the SAME order as the Seedance attachment:
            # i2v → the first frame; reference mode → the reference_images list.
            vision_images: list[dict] = []
            if req.image_url:
                vision_images.append({"label": "the source first frame", "path": req.image_url})
            else:
                for i, r in enumerate(req.reference_images):
                    label = (req.ref_addressing[i].split("=", 1)[-1].strip()
                             if i < len(req.ref_addressing) else "reference image")
                    vision_images.append({"label": label, "path": r.url})
            if vision_images:
                try:
                    direction = await asyncio.to_thread(
                        claude.vision_video_prompt,
                        vision_images, req.direction_mode, clamped, req.beats,
                        req.char_name or req.subject_hint or "the protagonist",
                        req.char_signature, req.env_hint, req.lighting_hint, camera,
                        req.shot_action or req.prompt, director_notes,
                        req.dialogue,
                        "the source first frame" if req.image_url else "",
                        # The floor plan reaches the WRITER as well as the final prompt.
                        # Appending it only to `parts` would leave the direction text free
                        # to place the same landmarks on the other side, and the model would
                        # then be reading two contradictory maps in one prompt.
                        geo_block,
                    )
                    vision_used = bool(direction)
                except Exception as ve:
                    # KEPT for the answer below: this is the FIRST of the two writers and
                    # its failure is the one nobody could see. Until now the only trace
                    # was this log line, so when the text template failed too the caller
                    # was told about the second failure and never the first.
                    vision_error = str(ve)
                    logger.warning("[VisionPrompt] failed (falling back to text template): %s", ve)
        if not direction:
            try:
                direction = await asyncio.to_thread(
                    claude.video_direction,
                    req.direction_mode,
                    clamped,
                    req.beats,
                    req.char_name or req.subject_hint or "the protagonist",
                    req.char_signature,
                    req.env_hint,
                    req.lighting_hint,
                    camera,
                    req.ref_addressing,
                    director_notes,   # 4E: honor the note in the text-template fallback too
                )
            except Exception as te:
                # A DEAD PROMPT WRITER IS A BAD GATEWAY, NOT AN UNHANDLED CRASH. This was
                # the ONE assembly branch that called an LLM and did not catch it, so the
                # exception walked out of the endpoint and starlette answered a bare 500
                # whose entire body is the string "Internal Server Error" — no `detail`,
                # nothing for the frontend toast to quote, and the reason (an out-of-credit
                # provider) legible only in the server log. Measured 4/4 on BLOOM SHOT_011,
                # 2026-08-07. /api/character/enrich and /api/shots/enhance have turned this
                # same class of failure into a 502-with-detail for months; this arm is that,
                # and it also carries the vision writer's failure, which had no channel out
                # at all. _queue_submit_one already reads HTTPException.detail and writes it
                # onto the queue entry (server.py:485), so the queued path gains the reason
                # for free — it used to record `str(e)` of whatever crashed.
                raise HTTPException(
                    status_code=502,
                    detail=(f"Video direction failed for {req.shot_id}: {te}"
                            + (f" (vision writer also failed: {vision_error})"
                               if vision_error else "")),
                ) from None
        if not direction.strip():
            # Both writers answered, neither wrote anything. Left alone this assembles a
            # "prompt" that is nothing but the style suffix and the constraints block and
            # pays Seedance for it — a silent degradation on the same two lines, so it
            # gets the same explicit answer rather than a 200.
            raise HTTPException(
                status_code=502,
                detail=(f"Video direction came back EMPTY for {req.shot_id} — the prompt "
                        f"writer returned no text"
                        + (f" (vision writer failed: {vision_error})" if vision_error else "")),
            )
        parts = [direction]
        # HELL GRIND rule 2 in the DIRECTION branch too. This branch does hand Claude the
        # frontend's `<Image_N> = <label>` list, but a label is a name, not a role: it says
        # "the DEPOT - YARD setting" and never "do not use it as a starting frame, do not
        # inherit the composition, the angle or the colour". The ban is the half that was
        # missing everywhere, so it is stated in the final prompt rather than trusted to a
        # writer that may or may not repeat it. Rides ahead of the style suffix for the
        # same reason it leads in the classic assembler — a reference block near the end of
        # the prompt is ignored.
        _roles = assemble_reference_roles(ref_roster, _is_25)
        if _roles:
            parts.append(_roles)
        # WHO each character IS, right after WHICH picture is which — the order the sd25-pe
        # contract lays out (material roles → subjects and relationships → event script) and
        # the reason it works: the profile names a face the model has just been shown.
        # 2.5 only, like every other change in this pass; 2.0's prompts stay byte-identical.
        if _subject_profiles:
            parts.append(_subject_profiles)
        if _unused_block:
            parts.append(_unused_block)
        # HELL GRIND rule 1 in the DIRECTION branch. Stated in the final prompt and not
        # left to the writer for the same reason the reference roles above are: a block
        # the writer "may or may not repeat" is a block that is missing whenever the
        # vision call fell back to the text template.
        if geo_block:
            parts.append(geo_block)
        if req.style.prompt_suffix:
            # Same principle-7 filter the segment branch got: the shipped presets open
            # with "photorealistic, hyperdetailed, 8k resolution", and the contract is
            # explicit that resolution, frame rate and aspect ratio are API parameters and
            # must not be written into the prompt. This branch kept carrying the 8k that
            # the other one stopped carrying — measured on BLACKMIRROR 4, the two takes
            # that reach here were the only two of nine with it.
            _sfx = (strip_output_settings(req.style.prompt_suffix) if _is_25
                    else req.style.prompt_suffix)
            if _sfx.strip():
                parts.append(_sfx.rstrip("."))
        # Dialogue lines ride the FINAL prompt ALWAYS — the documented {} syntax is
        # what makes Seedance speak them. Relying on the vision direction to carry
        # them proved silent-lossy (verified render meta: 5175-char prompt with ZERO
        # dialogue trace despite lines existing in the breakdown).
        parts.extend(dialogue_lines)
        parts.append(CONSTRAINTS)
        assembled_prompt = ". ".join(p.rstrip(".") for p in parts if p) + "."
        logger.info("[VideoDirection] assembled %d chars (%s mode)",
                    len(assembled_prompt), req.direction_mode)
    elif req.segment_shots:
        # SEGMENT mode. One call, several declared shots — verified 2026-07-31 that the
        # model honours the declared durations (asked 2s/5s/3s, cuts landed at 2.04s and
        # 6.21s; the single-shot control had none), which is the only way a sub-4s beat
        # can exist at all since the API floor is 4s PER CALL.
        #
        # Voices are resolved HERE, from the project's locked anchors, because the same
        # measurement showed that voice identity travels as a WRITTEN DESCRIPTION and not
        # as an audio reference: attaching the Seed Audio clip did not carry its timbre
        # (a female TTS came back male), while naming the timbre in the prompt held it
        # steady across renders. A character with no description simply gets none.
        voice_of: dict[str, str] = {}
        try:
            anchors = await asyncio.to_thread(
                proj_storage.read_voice_anchors, req.project_name, req.project_path)
            for name, cfg in (anchors or {}).items():
                desc = (cfg or {}).get("voice_desc", "")
                if desc:
                    voice_of[name] = desc
        except Exception as e:                       # never block a render on voice config
            logger.warning("[VideoDirection] voice anchors unreadable (non-fatal): %s", e)

        assembled_prompt = assemble_segment_prompt(
            req.segment_shots,
            # PHASE 4 FINALLY REACHES THE PIXELS ON THIS LEG. The frontend has always sent
            # the annotated board (FinalGenView.buildVideoParams → `beats: plan.beats`) and
            # the request model has always accepted it, but this call passed none — so for
            # a SEGMENT card the FOV degrees, the Kelvin, the framing/emphasis annotations
            # and the declared screen sides went no further than this function's caller.
            # Measured 2026-08-07 on BLOOM's 41 phase-5 cards: 24 take this branch, and
            # re-posting all 24 with beats=[] gave a byte-identical prompt 24/24.
            beats=req.beats,
            subject_profiles=_subject_profiles,
            dialogue_language=req.dialogue_language,
            unused_materials=_unused_block,
            visual_style=req.style.prompt_suffix,
            scene_name=req.scene_name or req.shot_scene,
            time_of_day=req.time_of_day,
            light=req.lighting_hint,
            prev_segment_end=req.prev_segment_end,
            voice_of=voice_of,
            # Los hablantes SIN CUERPO de esta toma. El tipo `voice` existe para que una
            # voz no reciba lámina; sin pasarlo aquí seguía recibiendo, en el prompt, la
            # orden de mover los labios en cuadro.
            voiceless=[a.get("name") for sh in (req.segment_shots or [])
                       for a in (sh.get("assets") or [])
                       if str(a.get("type") or "").lower() == "voice" and a.get("name")],
            subject_hint=req.subject_hint,
            env_hint=req.env_hint,
            neg_base=req.style.negative_prompt,
            photographic=_vid_photographic,
            references=ref_roster,
            geo_layout=geo_block,
            at_addressing=_is_25,
        )
        # Motion reference is video-driven: without this clause the clip is attached and
        # PAID FOR while nothing in the prompt asks the model to follow its movement.
        if req.reference_videos:
            assembled_prompt += ("\nReplicate the movement, timing and camera motion of "
                                 "the reference video.")
        if director_notes.strip():
            assembled_prompt += (f"\nDirector's note (must be honored): "
                                 f"{director_notes.strip().rstrip('.')}.")
        assembled_negative = req.style.negative_prompt or ""
        logger.info("[VideoDirection] SEGMENT mode: %d shot(s), %d chars, %d voice(s)",
                    len(req.segment_shots), len(assembled_prompt), len(voice_of))
        # THE BOARD DID NOT DESCRIBE THESE SHOTS — surfaced, not just logged. Reads the
        # same pure function the assembler took its decision with (board_shot_mismatch →
        # _merge_plan), so this can never report a merge that did not happen.
        #
        # It goes on the agent bus as an ERROR because that channel is also the persistent
        # /api/errors ring buffer: a warning that only exists in the backend's stdout is
        # not something an operator finds AFTER paying for the render, and this is the one
        # moment where re-boarding the card is still free. `severity == "info"` (the
        # scene's opening-wide panel stepping aside, which costs no shot its annotations)
        # is deliberately NOT published — it would fire once per scene and train the user
        # to ignore the channel.
        board_mismatch = board_shot_mismatch(req.segment_shots, req.beats)
        if board_mismatch and board_mismatch.get("severity") == "warning":
            await bus.publish(
                "seedance", "error",
                f"{req.shot_id}: the approved board does not describe this segment's "
                f"shots — {board_mismatch['summary']}. The prompt was built WITHOUT the "
                f"board annotations for those shots; re-board the card to get them back.")
    else:
        assembled_prompt, assembled_negative = assemble_video_prompt(
            shot_action=req.shot_action or req.prompt,
            style_suffix=req.style.prompt_suffix,
            subject_hint=req.subject_hint,
            env_hint=req.env_hint,
            camera=camera,
            lighting_hint=req.lighting_hint,
            neg_base=req.style.negative_prompt,
            dialogue=dialogue_lines or None,
            photographic=_vid_photographic,
            director_notes=director_notes,   # 4E: honor the note in the classic path too
            references=ref_roster,
            geo_layout=geo_block,
            at_addressing=_is_25,
        )
    if req.negative_override is not None:
        assembled_negative = req.negative_override

    # Prompt transparency dry run: full assembly (incl. the Claude vision step)
    # is done — return it for review WITHOUT creating a Seedance task.
    # HOW MANY people are in the take, pinned BEFORE the dry-run return so the prompt the
    # operator reviews is the prompt that gets sent. Three character sheets rendered FOUR
    # people on SCENE_TURNS_3V — Barb twice — because naming a cast never states its size.
    # Computed from the ATTACHED roster, so it can never claim a cast the model was not
    # shown, and appended because the contract puts [Maintain Consistency] last. Applies to
    # 2.0 and 2.5 alike: subject cardinality is not a 2.5-only property. Skipped for a
    # user-edited prompt, which is documented as going out verbatim.
    if not req.prompt_override.strip():
        _cast_block = assemble_cast_consistency(ref_roster)
        if _cast_block:
            assembled_prompt = assembled_prompt.rstrip() + "\n" + _cast_block
            logger.info("[Seedance] %s: cast pinned — %s", req.shot_id,
                        _cast_block.splitlines()[1][:100])

    if req.dry_run:
        # The audio roles cannot be read from _spk_clips here — the clips are rendered
        # further down, deliberately, so a dry run never pays Seed Audio. Derived from the
        # dialogue instead, in first-speaking order, which is the order they are attached
        # in; the submitted prompt below uses the clip keys themselves.
        # ...but ONLY when that inline branch is the one that will run. An explicit
        # audio_url or an approved dialogue.mp3 on disk is a single mixed clip, and naming
        # a voice per speaker over it promises an @Audio 2 that is never attached.
        _pre_url, _ = _dialogue_audio_source(req, ref_first_frame)
        _preview_speakers: list[str] = []
        if not _pre_url and (not req.image_url or ref_first_frame) and req.project_name:
            for _ln in (req.dialogue or []):
                _who = str((_ln or {}).get("character") or "").strip()
                if _who and _who not in _preview_speakers:
                    _preview_speakers.append(_who)
        _preview_roles = assemble_audio_roles(_preview_speakers, at_addressing=_is_25)
        if _preview_roles and not req.prompt_override.strip():
            assembled_prompt = _preview_roles + "\n" + assembled_prompt
        await bus.publish("seedance", "completed",
                          f"Direction prompt ready: {req.shot_id} — review before rendering", 100)
        return {
            "dry_run": True,
            "shot_id": req.shot_id,
            "assembled_prompt": assembled_prompt,
            "assembled_negative": assembled_negative,
            "board_mismatch": board_mismatch,
        }

    # Merge: user-provided refs + style anchor refs
    user_refs = [r.model_dump() for r in req.reference_images]
    # Prefer the PERMANENT disk copy over the ref's url whenever a disk-folder hint resolves —
    # a store that lost its localPath pointer falls back to an expiring ~24h CDN url, which
    # 400s the whole render once it lapses ("resource download failed"). The versioned disk
    # file never expires, so this makes every hinted ref bulletproof (2026-07-23).
    for _r in user_refs:
        if _r.get("role") == "first_frame":
            continue                                # first_frame trust is handled downstream
        _disk = _resolve_ref_disk(_r.get("path") or "", req.project_name, req.project_path)
        if _disk:
            _r["url"] = _disk                       # absolute path → create_video_task base64s it from disk
    # STYLE ANCHORS ARE NOT ATTACHED TO SEEDANCE. Until 2026-09-11 the project's anchor
    # images rode here as extra reference_images (weight 0.55) with a "STYLE reference —
    # take the rendering medium, palette and grain from it" role — INVISIBLE in the review
    # panel, which lists only what the frontend derived. Measured on El Viaje SHOT_008: the
    # panel said "References (4)", the sidecar had 5, and the fifth was the FIRST APPROVED
    # ENVIRONMENT (a bus interior, auto-set as the anchor by Stage 3) telling a kitchen
    # scene where to take its "medium, palette and grain" from. A style reference the guide
    # reserves for style transfer, on every shot, from an unrelated location, that nobody
    # could see or remove. The project's look is carried by the character and environment
    # sheets and by the style suffix; the anchors keep their other job (drift scoring).
    # From here on the wire carries exactly the frontend's list, so the review panel, the
    # `@Image N` numbering and the sidecar can never disagree again.
    all_refs = user_refs

    # ── First frame vs dialogue: the trade that cost 22 of 41 clips their voices ──
    # Seedance treats first_frame and reference media as MUTUALLY EXCLUSIVE, so a shot
    # rendered from a keyframe could never carry its dialogue track — the audio gates
    # below are all `not req.image_url` for exactly that reason. Every pipeline shot has
    # a keyframe, so every shot with dialogue lost it.
    #
    # Seedance 2.5 documents a way out: pass the keyframe as a reference_image and name
    # it the first frame IN THE PROMPT. Measured live (task cgt-20260807170955-br87p):
    # the render kept the subject, framing, lighting and background of the keyframe AND
    # carried the dialogue — output envelope correlates +0.849 with the source clip.
    # The cost is that the first frame is APPROXIMATED, not byte-exact (the docs say so
    # too), which is why this is scoped, never global:
    #   • 2.5 only — 2.0 has no such documented path and stays byte-for-byte as before
    #   • never when exact_first_frame (continuity chaining needs the exact seam)
    #   • only when the shot actually HAS dialogue — silent shots keep the exact frame
    # _resolved_model / _is_25 / _call_caps / _has_dialogue / ref_first_frame are resolved
    # ABOVE, before the reference roster, because the roster's numbering depends on this
    # decision. Read here; do not recompute — two copies would drift.

    # Dialogue → Seed Audio 1.0 → Seedance audio reference (reference mode only).
    # Resolution priority — deterministic and SERVER-side, so a stale/missing
    # frontend field can never silently drop the voice (observed: rendered shots
    # with zero dialogue despite an approved clip on disk):
    #   1. explicit req.audio_url (user soundtrack override)
    #   2. the clip generated+APPROVED next to the storyboard — fixed disk path
    #      Shots/<shot_id>/dialogue.mp3 (no re-synthesis, the reviewed voice)
    #   3. inline synthesis from req.dialogue (locked voices) as last resort
    # The precedence itself lives in _dialogue_audio_source, because the DRY RUN has to
    # ask the same question and used to answer it differently (see that docstring).
    audio_url, audio_source = _dialogue_audio_source(req, ref_first_frame)
    if audio_source == "approved_clip":
        logger.info("[Dialogue] %s: using APPROVED clip from disk", req.shot_id)
    # Bound HERE, before the branch that fills it, because it is read UNCONDITIONALLY at
    # the create_video_task call below. It used to be declared inside the `if` at the
    # inline-synthesis branch, so every render that did NOT take that branch — a silent
    # shot, a shot whose approved dialogue.mp3 was found on disk (which SETS audio_url and
    # therefore makes the branch false), an explicit audio_url, no project_name — reached
    # that line with the name unbound and died on a NameError, swallowed by the endpoint's
    # `except Exception` into an HTTP 500 on a PAID render path.
    _spk_clips: dict[str, str] = {}
    if not audio_url and (not req.image_url or ref_first_frame) and req.dialogue and req.project_name:
        try:
            # ACTING SKILL §9 — each speaker's permanent vocal identity, lifted from the
            # master profile the breakdown already wrote. Keyed by NAME because that is
            # what a dialogue line carries and what the voice anchors are stored under.
            import seed_audio as _sa      # module-local, like every other seed_audio user here
            _voices = {s.name: _sa.vocal_profile_of(s.acting)
                       for s in req.subjects if (s.acting or '').strip()}
            clip = await _render_dialogue_clip(req.dialogue, req.project_name,
                                               req.project_path, req.shot_id,
                                               {k: v for k, v in _voices.items() if v},
                                               clips_out=_spk_clips,
                                               scene_prompt=req.dialogue_scene)
            if clip:
                audio_url = clip
                audio_source = "inline"
        except Exception as e:
            logger.warning("[Dialogue] %s: dialogue render failed (continuing without): %s", req.shot_id, e)
    logger.info("[Dialogue] %s: lines=%d · audio_source=%s", req.shot_id, len(req.dialogue or []), audio_source)

    # Apply the routing decided above: the keyframe stops being `first_frame` and becomes
    # reference image #1, named as the opening frame in the prompt so the model still
    # opens on it. Prepending (not appending) matters — the 2.5 guide is explicit that
    # material mapping belongs at the START of the prompt, and that reference tasks must
    # avoid edit/extend wording, which this phrasing does.
    # WHOSE VOICE each attached clip is. `_spk_clips` is {speaker: path} and only its
    # VALUES were ever sent, so the model received unlabelled voices and had to guess who
    # each one belonged to. Prepended because the 2.5 guide places material mapping at the
    # START of the prompt (the same rule the first-frame sentence below follows), and the
    # keys are used in insertion order because that is the order create_video_task attaches
    # them in — `@Audio N` addresses the Nth ATTACHMENT.
    # Both blocks are skipped for a USER-EDITED prompt: prompt_override is documented as
    # going out verbatim — "what they saw in the panel is exactly what Seedance receives" —
    # and quietly appending to it breaks that promise. Whoever edits the prompt owns it.
    if not req.prompt_override.strip():
        if _spk_clips:
            _audio_roles = assemble_audio_roles(list(_spk_clips.keys()), at_addressing=_is_25)
            if _audio_roles:
                assembled_prompt = _audio_roles + "\n" + assembled_prompt
                logger.info("[Seedance] %s: declared %d audio role(s): %s",
                            req.shot_id, len(_spk_clips), ", ".join(_spk_clips.keys()))
        elif audio_url and (req.dialogue or []):
            # ONE clip, several voices — scene mode, and the approved dialogue.mp3 on disk,
            # which is the same shape. Neither produces per-speaker tracks, so neither used
            # to say anything at all about the voice it attached. Speakers in FIRST-SPOKEN
            # order, which is the order the single take renders them in.
            _scene_speakers: list[str] = []
            for _ln in (req.dialogue or []):
                _w = str((_ln or {}).get("character") or "").strip()
                if _w and _w not in _scene_speakers:
                    _scene_speakers.append(_w)
            _scene_role = assemble_scene_audio_role(_scene_speakers, at_addressing=_is_25)
            if _scene_role:
                assembled_prompt = _scene_role + "\n" + assembled_prompt
                logger.info("[Seedance] %s: one scene dialogue take, %d voice(s): %s",
                            req.shot_id, len(_scene_speakers), ", ".join(_scene_speakers))

    if ref_first_frame:
        all_refs = [{"url": req.image_url, "role": "reference_image"}] + all_refs
        # The sd25-pe contract fixes a first frame with an EXACT standalone sentence and
        # forbids both weakening it ("used only as a first-frame reference") and
        # compressing the role sentence together with the action that follows. The old
        # wording — "Image 1 is the first frame: open on it exactly. " glued to the whole
        # prompt — broke both rules and used the 2.0 address form on a 2.5-only path.
        assembled_prompt = ("@Image 1 is the first frame.\n"
                            "This first frame defines the opening composition, subject "
                            "position, pose, prop state, scene, and camera direction.\n"
                            + assembled_prompt)
        logger.info("[Seedance] %s: keyframe routed as reference_image so the dialogue "
                    "track can ride (2.5 reference mode); first frame is approximated",
                    req.shot_id)

    ref_img_count = len(all_refs)
    ref_vid_count = len(req.reference_videos)
    detail = f"Rendering {req.shot_id}"
    if ref_img_count: detail += f" +{ref_img_count} img ref"
    if ref_vid_count: detail += f" +{ref_vid_count} vid ref"
    if audio_url:  detail += " +dialogue audio"
    await bus.publish("seedance", "active", detail + "…", 0)
    # Seedance 2.0's documented range is [4, 15] PER CALL
    # (docs.byteplus.com/en/docs/ModelArk/2298881 — 3s requests were below spec).
    #
    # Over the ceiling this used to clamp SILENTLY: a 17 s request rendered 15 s and only
    # said so in a log line. That was survivable when a call was one shot — you lost two
    # seconds of hold. With segments it is not: the tail of the request is the LAST SHOTS
    # of the segment, so a silent clamp drops beats the director planned and paid for,
    # and nothing downstream can tell that the clip is short of its own EDL entry.
    # Under the floor there is no such risk, so 3.2 s still rounds up to the 4 s minimum.
    # The ceiling is the CHOSEN model's: 15 s on the 2.0 family, 30 s on 2.5. Reading it
    # from a constant would refuse the very long take 2.5 exists to make possible.
    _max_call_secs = _call_caps["max_duration"]
    if req.duration_secs > _max_call_secs:
        raise HTTPException(
            status_code=422,
            detail=(f"Segment is {req.duration_secs:.1f}s — {_resolved_model} renders at most "
                    f"{_max_call_secs}s per call. Split it into two segments, or switch the "
                    f"video model in Settings; clamping would silently drop its last shots."))
    # Under the floor, `max(4.0, …)` was doing two different jobs with one number. For a
    # POSITIVE value it is the legitimate 3.2 → 4 s round-up to Seedance's minimum. For a 0
    # or a negative it LAUNDERED a length nobody measured into one that looks valid — which
    # is also why create_video_task's own ValueError guard could never fire from this caller.
    # Measured against a stub: 0 and -3 both reached a paid 4 s submit. Now they answer 422
    # and NAME the shot, the same way the ceiling above does.
    if req.duration_secs <= 0:
        raise HTTPException(
            status_code=422,
            detail=(f"{req.shot_id or 'This shot'} has no duration ({req.duration_secs}) — a "
                    f"render is paid for by the second and this call will not guess one. "
                    f"Send the segment's measured length."))
    shot_duration = max(4.0, float(req.duration_secs))
    if shot_duration != req.duration_secs:
        # The round-up to the 4 s minimum MOVED the number: the clip comes back longer than
        # the beat it was cut for and the EDL has to trim it. It only ever said so inside
        # the info line below, where a moved duration reads exactly like an honoured one.
        logger.warning("[Seedance] %s: %.2fs → %.2fs (Seedance's 4s minimum) — the render "
                       "overruns the beat and the edit trims it",
                       req.shot_id, req.duration_secs, shot_duration)
    logger.info("[Seedance] shot_duration=%.2fs (requested %.2fs)", shot_duration, req.duration_secs)
    # The registry row below is written AFTER BytePlus answers, which leaves the POST
    # itself unrecorded: a process that dies in there has spent money and left nothing to
    # prove it, and the render queue then told the user "Nothing was billed for it". This
    # writes the INTENT first. create_video_task calls the hook microseconds before its
    # requests.post — deliberately not here, because everything between this line and the
    # POST (the semaphore wait, up to 10 data-URI downloads) is free, and a marker over
    # that stretch would report charges for submits that never reached BytePlus.
    _intent: dict[str, str] = {}

    def _mark_intent() -> None:
        _intent["id"] = render_registry.record_submit_intent(
            project_name=req.project_name, project_path=req.project_path,
            shot_id=req.shot_id, resolution=req.resolution, tier=req.tier or "")
    try:
        # Admission control: hold a slot for the SUBMIT only. The slot is released as
        # soon as BytePlus accepts the task — the render itself continues on their
        # side, so holding it for the whole render would serialise the episode.
        # Bucketed by the tier's ACTUAL resolution (a preview renders at 480p even in
        # a 4k project), so a preview pass is not throttled to the 4k slot of one.
        submit_res = BytePlusGenerativeAPI.TIER_RESOLUTIONS.get(req.tier or "", req.resolution)
        async with _get_video_sem(submit_res):
            result = await asyncio.to_thread(
                functools.partial(api.create_video_task, on_submit=_mark_intent),
                # Empty when the keyframe was routed into `all_refs` above: passing it
                # here too would set role=first_frame and re-trigger the very exclusion
                # that drops the dialogue track. It is one or the other, never both.
                "" if ref_first_frame else req.image_url,
                assembled_prompt,
                shot_duration,
                all_refs or None,
                req.reference_videos or None,
                audio_url,
                assembled_negative,
                req.generate_audio,
                req.ratio,
                req.resolution,
                req.seed,
                tier=req.tier or None,
                model_choice=req.model_choice or None,
                # One reference per SPEAKER when we have them; the mixed clip stays the
                # fallback inside create_video_task. See _render_dialogue_clip.
                speaker_audio_urls=(list(_spk_clips.values()) or None),
            )
        await bus.publish("seedance", "active", f"{req.shot_id} submitted", 10)
        # B2: record the task so the backend can finish + save it even if this tab
        # closes or the backend restarts (see the reconciler).
        if result.get("task_id"):
            # record_durable(), not record(), and to_thread, not a straight call. Both
            # for the same reason: this line runs AFTER BytePlus accepted, so the money
            # is already spent and this row is the only thing that can ever find the
            # render again. record() takes a cross-process lock that WAITS (freezing the
            # loop) and can RAISE — and the LockTimeout it raised was swallowed by the
            # `except Exception -> HTTPException 500` below, which threw the accepted
            # task_id away. Reproduced with a peer process holding the registry lock: the
            # id existed in no file at all. record_durable() retries and then appends to
            # an unlocked ledger the reconciler drains, and never raises.
            rec = await asyncio.to_thread(
                render_registry.record_durable,
                result["task_id"],
                status="running",
                project_name=req.project_name,
                project_path=req.project_path,
                shot_id=req.shot_id,
                # The resolution ACTUALLY submitted, which for a preview/edit tier is
                # not what the project asked for. The reconciler and the usage meter
                # both read this back, and metering the wrong resolution would report
                # a 480p preview as a 4k master.
                resolution=result.get("resolution") or req.resolution,
                tier=req.tier or "",
                model=result.get("model") or "",
                seed=req.seed,
                # EL PROMPT ENTERO, no sus primeros 500 caracteres. Cuando una tarea
                # falla no se escribe sidecar —el vídeo no existe— así que el registro es
                # lo ÚNICO que queda, y 500 caracteres son la cabecera de estilo: idéntica
                # en los que fallan y en los que no. Medido en BLACK MIRROR: tres tareas
                # murieron con «InvalidParameter: Bad Request» sin más, y reconstruir qué
                # se les envió costó capturar prompts en seco por la interfaz. Un render
                # pagado que muere debe dejar dicho con qué murió.
                prompt=assembled_prompt,
                # WHAT THIS RENDER ACTUALLY RECEIVED. The sidecar written later by
                # /api/shot/save-video records `req.references` — whatever the BROWSER
                # says on a SEPARATE request — and it is routinely short and sometimes
                # empty: measured over BLACK MIRROR's 9 takes, the sidecar held one fewer
                # reference than the render used in six of them and NONE in three, while
                # the prompt correctly addressed every image. So the file that documents a
                # paid render could not be audited, by me or by the operator. The roster
                # here is the resolved truth at submit time; save-video reconciles against
                # it.
                references=[{"kind": r.get("kind") or "", "name": r.get("name") or "",
                             "label": r.get("label") or ""} for r in (ref_roster or [])],
            )
            if rec.path:
                # Surfaced, not just logged: the render is billing and the registry does
                # not know about it yet, so the operator gets it on the agent bus (the
                # UI's error channel) and in the response body.
                await bus.publish(
                    "seedance", "error",
                    f"{req.shot_id}: render {result['task_id']} was accepted and IS "
                    f"BILLING but could not be written to the render registry. It was "
                    f"saved to {rec.path} and is picked up on the next reconciler sweep.")
                result = {**result, "registry_orphaned": rec.path}
            elif rec.nowhere:
                # Worse than the ledger case, and it used to be INDISTINGUISHABLE from
                # success: record_durable returned "" both when the registry took the row
                # and when nothing anywhere did. Nothing will poll this task, so no sweep
                # finishes or saves it — say so on the same channels, and put it in the
                # same response field, so a caller reading only `registry_orphaned` cannot
                # mistake this for a clean submit.
                logger.error(
                    "[Seedance] task %s (%s) IS BILLING and is recorded NOWHERE — "
                    "registry unwritable (%s) and the orphan ledger too. Reconcile by "
                    "hand.", result["task_id"], req.shot_id, rec.error)
                await bus.publish(
                    "seedance", "error",
                    f"{req.shot_id}: render {result['task_id']} was accepted and IS "
                    f"BILLING but could NOT be recorded anywhere ({rec.error}) — not the "
                    f"registry, not the orphan ledger. No reconciler sweep will finish or "
                    f"save it. Reconcile task {result['task_id']} by hand.")
                result = {**result, "registry_orphaned": "NOWHERE — not even the ledger"}
            # Accepted: the real row above IS the record, so the marker has served its
            # purpose and is dropped.
            await _resolve_intent_quietly(_intent.get("id", ""), result["task_id"])
        elif result.get("decided"):
            # BytePlus answered with a 4xx — the request was understood and refused, so
            # no task was created and nothing is billable. Also a verdict; also resolved.
            await _resolve_intent_quietly(_intent.get("id", ""))
        elif result.get("submit_phase") == PHASE_PREFLIGHT:
            # The POST died in its own connection phase — DNS, the TCP connect, or the TLS
            # handshake. BytePlus was never handed the request, so no task exists and
            # nothing can be billing: that is a verdict too, just one this side of the
            # wire. Keeping the marker here is how the alarm learned to cry wolf, and on
            # THIS machine it cried constantly — the corporate VPN intercepts TLS, so
            # CERTIFICATE_VERIFY_FAILED is a standing condition and every render would
            # have claimed "may be running and BILLABLE right now" over a POST that never
            # left the laptop.
            await _resolve_intent_quietly(_intent.get("id", ""))
            logger.warning(
                "[Seedance] %s: submit never reached BytePlus (%s). Nothing was billed, "
                "so the submit-intent marker is cleared rather than reported as a charge.",
                req.shot_id, str(result.get("error") or "no error text")[:200])
        elif _intent.get("id"):
            # No verdict AND the request did leave the machine: a read timeout, a
            # connection dropped after the write, a 5xx that may sit in front of a task
            # their backend already accepted, or a 2xx we could not find an id in. The
            # marker STAYS — it is the only evidence that a charge may exist — and it
            # rides back to the caller, because a caller with somewhere durable to put it
            # (the render queue) must report it THERE. _recovery_evidence, the marker's
            # other reader, only ever looks at STRANDED entries, and a queue entry that
            # gets an answer like this is marked 'failed', which is not stranded.
            logger.error(
                "[Seedance] %s: submit got no verdict from BytePlus (%s). A render MAY "
                "have started and be billable; the submit-intent marker %s is kept so "
                "recovery can say so instead of claiming nothing was billed.",
                req.shot_id, str(result.get("error") or "no error text")[:200],
                _intent.get("id", ""))
            result = {**result, "submit_intent": _intent["id"]}
        return {**result, "shot_id": req.shot_id, "assembled_prompt": assembled_prompt,
                "board_mismatch": board_mismatch}
    except ValueError as e:
        # Model/resolution capability mismatch — rejected BEFORE any request reached
        # BytePlus. That is a bad ask, not a server fault, and it costs nothing.
        await bus.publish("seedance", "error", str(e))
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        await bus.publish("seedance", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# Last progress label announced per task, so the bus carries state CHANGES rather
# than one event per poll. In-process on purpose: losing it on restart just means one
# redundant event per in-flight task, and it keeps a 5s poll off the disk registry.
_last_poll_status: dict[str, str] = {}


@app.get("/api/video/poll/{task_id}")
async def poll_video(task_id: str):
    """Status of one render task. Returns IMMEDIATELY — one upstream GET, no wait.

    This used to call poll_video_task(task_id, 60), which loops upstream every 5s for
    up to a minute. The caller (FinalGenView.pollUntilDone) ALREADY loops every 5s, so
    the server was re-implementing the client's wait on top of it: each in-flight shot
    pinned a thread-pool worker for up to 60 seconds while doing nothing but sleeping.
    Ten concurrent shots pinned ten workers, competing with ffmpeg and image generation
    for the same default executor — the ceiling that stops a 500-shot episode from
    rendering, and it bought nothing.

    Upstream request volume is unchanged (~1 GET per 5s per in-flight shot either way);
    only the thread is released. Wire format is identical, so callers need no change.
    """
    api = get_byteplus()
    try:
        # max_wait=1, interval=1 → exactly one status check, then return. Same call
        # the background reconciler uses.
        result = await asyncio.to_thread(api.poll_video_task, task_id, 1, 1)
        if result.get("status") == "completed":
            _last_poll_status.pop(task_id, None)   # terminal — stop tracking it
            await bus.publish("seedance", "completed", f"Render complete: {task_id}", 100)
            await asyncio.to_thread(_meter_video_usage, task_id, result)
        else:
            # "timeout" = the poll window elapsed while the (paid) render keeps going
            # server-side — NOT a failure. Relabel so the UI reads as progress.
            st = result.get("status")
            label = "still rendering" if st in ("timeout", "running", "queued", None) else st
            # Publish only on CHANGE. Now that this endpoint returns immediately the
            # client polls it every 5s per shot; re-announcing "still rendering" each
            # time would put ~2 events/sec on the bus for ten shots and say nothing new.
            if _last_poll_status.get(task_id) != label:
                _last_poll_status[task_id] = label
                await bus.publish("seedance", "active", f"Rendering… ({label})", 50)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/video/cancel/{task_id}")
async def cancel_video(task_id: str):
    """P3.14: cancel a queued Seedance task (documented DELETE endpoint)."""
    api = get_byteplus()
    result = await asyncio.to_thread(api.cancel_video_task, task_id)
    await bus.publish("seedance", "idle", f"Task {task_id} cancelled")
    return result


@app.get("/api/video/tasks")
async def list_video_tasks(status: str | None = None, page_size: int = 20):
    """P3.14: list recent tasks — reconcile shots orphaned by a closed browser."""
    api = get_byteplus()
    try:
        return await asyncio.to_thread(api.list_video_tasks, status, page_size)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/video/registry")
def video_registry(background: BackgroundTasks, project_path: str = "", project_name: str = ""):
    """B2: render tasks the backend recorded for a project (persists across
    restarts and the 24h CDN window). The frontend reconciles its shots against
    this on mount — adopting any render the backend finished + saved to disk
    while the tab was closed.

    Also surfaces the 720p H.264 preview proxy for 4k (HEVC) renders: returns the
    sibling if it exists, else schedules it in the background so it's ready on the
    next mount — backfilling browser-playable previews for pre-existing projects
    without blocking this response."""
    tasks = render_registry.for_project(project_path, project_name)
    for t in tasks:
        vlp = t.get("video_local_path")
        if not vlp:
            continue
        prev = os.path.splitext(vlp)[0] + ".preview.mp4"
        if os.path.isfile(prev):
            t["preview_local_path"] = prev
        elif os.path.isfile(vlp) and _needs_h264_preview(vlp, t.get("resolution")):
            background.add_task(_make_h264_preview, vlp)
    return {"tasks": tasks}


class RenderQueueRequest(BaseModel):
    project_name: str = ""
    project_path: str = ""
    jobs: list[dict] = []          # each item is a full POST /api/video/create body


class RenderQueueScopeRequest(BaseModel):
    project_name: str = ""
    project_path: str = ""


@app.post("/api/render/queue")
async def render_queue_enqueue(req: RenderQueueRequest):
    """B3: hand the WHOLE batch to the backend in one call.

    Until now the batch loop ran in the tab (FinalGenView.tsx), so a closed browser
    at shot 12 of 40 meant shots 13-40 were never submitted at all — the reconciler
    could not save what was never sent. Jobs are validated here, at enqueue time, so
    a malformed payload is a 422 the operator sees immediately instead of a failure
    discovered 30 minutes later by the worker.
    """
    if not req.jobs:
        raise HTTPException(status_code=422, detail="No jobs to queue")
    normalised: list[dict] = []
    for i, job in enumerate(req.jobs):
        try:
            # Store the VALIDATED dump, not the raw body: the worker rebuilds the model
            # from this, and defaults filled in now can't shift under a later client.
            parsed = VideoTaskRequest(**(job or {}))
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"job[{i}] is not a valid render request: {e}")
        # The SAME window _create_video_impl refuses outside of, applied here so the operator
        # learns at enqueue instead of watching the job fail alone in the queue an hour
        # later. A legacy shot longer than 15s reaches this path unclamped (the planner's
        # SEGMENT_MAX_SECS only caps segments it generated), and the queue has no retry:
        # the entry would simply die. The shot is NAMED — "job[7]" is unfindable in a
        # 40-shot pass. The whole batch is rejected, like any other invalid job above:
        # accepting 39 of 40 silently is how a missing shot gets discovered at the edit.
        #
        # The FLOOR matters more here than anywhere else: an entry is written to disk and
        # replayed by the worker, so a length nobody measured is not one mistake but one per
        # retry. Measured before this check existed: a job with duration_secs 0 was persisted
        # verbatim and drained into a paid 4 s submit.
        if parsed.duration_secs <= 0:
            raise HTTPException(
                status_code=422,
                detail=(f"job[{i}] {parsed.shot_id} has no duration ({parsed.duration_secs}) — a "
                        f"render is paid for by the second and the queue will not persist a "
                        f"length nobody measured. Nothing was queued."))
        # The ceiling belongs to the model THIS job will actually be rendered on, exactly
        # as _create_video_impl resolves it — a hardcoded 15 refused every 2.5 job (whose
        # ceiling is 30s) before it could ever be queued, so a project planned for long
        # takes could not use the background queue at all.
        _job_model = BytePlusGenerativeAPI.resolve_tier(
            parsed.tier or None, parsed.resolution, parsed.model_choice or None)[0]
        _job_max = model_caps(_job_model)["max_duration"]
        if parsed.duration_secs > _job_max:
            raise HTTPException(
                status_code=422,
                detail=(f"job[{i}] {parsed.shot_id} is {parsed.duration_secs:.1f}s — "
                        f"{_job_model} renders at most {_job_max}s per call. Split that "
                        f"segment, or switch the video model in Settings; clamping would "
                        f"silently drop its last shots. Nothing was queued."))
        normalised.append(parsed.model_dump())
    queue_id = await asyncio.to_thread(
        render_queue.enqueue, req.project_name, req.project_path, normalised)
    logger.info("[RenderQueue] enqueued %d job(s) as %s (project=%s)",
                len(normalised), queue_id, req.project_name or req.project_path)
    await bus.publish("seedance", "active",
                      f"Queued {len(normalised)} shot(s) — rendering continues if you close the tab", 5)
    return {"queue_id": queue_id, "queued": len(normalised)}


@app.get("/api/render/queue")
def render_queue_status(project_name: str = "", project_path: str = ""):
    """B3: what the backend still owes this project. `running` stays true while
    anything is queued or in flight, so the UI knows whether to keep polling.

    Each entry also carries what the queue knows about MONEY (charge_risk, charge_note,
    duplicate_task_ids) plus a `charges_at_risk` count. A superseded claim's task_id used
    to live only in the queue JSON and one server log line, so a shot that had been
    submitted — and billed — TWICE looked exactly like one that succeeded once."""
    return render_queue.status_for(project_name, project_path)


@app.post("/api/render/queue/cancel")
def render_queue_cancel(req: RenderQueueScopeRequest):
    """B3: drop everything NOT yet submitted. Shots that really reached BytePlus (they
    carry a task_id) are left alone — they are being billed and the reconciler will
    still save them; cancelling them here would only throw away a render the user has
    already paid for.

    Entries stranded in the claim window by a dead process (no task_id, claim older than
    render_queue.STALE_CLAIM_SECS) ARE cancelled — they are precisely why the queue looked
    frozen — but they are counted separately as `at_risk`. This used to say "nothing was
    billed for them", which is false for exactly those: the claim window straddles the
    paid POST, so a stranded entry may be a render that is running right now."""
    out = render_queue.cancel(req.project_name, req.project_path)
    logger.info("[RenderQueue] cancelled %d queued job(s) for %s (%d were stranded "
                "mid-submit and may already be billed)",
                out["cancelled"], req.project_name or req.project_path, out["at_risk"])
    return out


class StudioSaveRequest(BaseModel):
    url: str
    kind: str = "image"             # 'image' | 'video'
    project_name: str = ""
    project_path: str = ""
    tokens: int = 0                 # video: billable completion tokens (usage metering)
    resolution: str = ""            # video: resolution (byResolution breakdown)
    model: str = ""                 # video: tier key or model id — prices differ per model
    # Seedance return_last_frame CDN url (24h). Persisted RAW next to the clip so a later
    # Studio Extend still has a TRUSTED first_frame once that url dies — re-encoding a
    # frame is third-party compression and NULLIFIES the biometric trust (video-seedance §7).
    last_frame_url: str = ""
    # False for a clip that is not a Seedance render (a Studio upscale): the ledger
    # counts `videos` as renders, and an upscale of one would count the shot twice.
    meter: bool = True


@app.post("/api/studio/save")
async def studio_save(req: StudioSaveRequest):
    """Persist a Studio generation to disk (Studio/Images|Videos) so the gallery
    survives the 24h CDN window. Returns the local path (served via /api/asset/serve).
    Videos also record usage into the active project (images are metered at gen)."""
    import requests as _req
    try:
        resp = await asyncio.to_thread(_req.get, req.url, timeout=120)
        resp.raise_for_status()
        # LA EXTENSIÓN SIGUE A LOS BYTES, no a una suposición. Esto guardaba toda imagen
        # como .png mientras el generador podía devolver JPEG (su default), así que había
        # ficheros .png con contenido JPEG. Se mira la firma: PNG empieza por \x89PNG y
        # JPEG por \xff\xd8. Un cuerpo que no es ninguna de las dos se queda en .png,
        # como antes, para no inventar una tercera cosa.
        if req.kind == "video":
            ext = "mp4"
        elif resp.content[:2] == b"\xff\xd8":
            ext = "jpg"
        else:
            ext = "png"
        saved = await asyncio.to_thread(
            proj_storage.save_studio_item, req.project_name, req.kind, resp.content, ext, req.project_path,
        )
        # Meter video usage into the project (images are metered at generation time).
        # Skip when there's no project path (standalone) so we don't mis-attribute.
        if req.kind == "video" and req.project_path and req.meter:
            try:
                usage.record("videos", project_path=req.project_path, videos=1,
                             tokens=int(req.tokens or 0), resolution=req.resolution or "",
                             model=req.model or "")
            except Exception:
                pass
        # Videos: keep the render's OWN Seedance last-frame, byte-for-byte, so Extend has a
        # trusted first_frame after the CDN url lapses. Non-fatal — a missing frame only
        # costs the (still available) live-url path, it must never fail the save.
        last_frame_local_path = ""
        if req.kind == "video" and req.last_frame_url:
            last_frame_local_path = await asyncio.to_thread(
                _persist_raw_last_frame, saved["path"], req.last_frame_url,
            )
        logger.info("[Studio] %s saved to %s (%d KB)%s", req.kind, saved["path"], len(resp.content) // 1024,
                    " +trusted last-frame" if last_frame_local_path else "")
        return {"local_path": saved["path"], "filename": saved.get("filename", ""),
                "bytes": len(resp.content), "last_frame_local_path": last_frame_local_path}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Studio save failed: {e}")


class ShotVideoSaveRequest(BaseModel):
    shot_id: str
    video_url: str
    project_name: str = ""
    project_path: str = ""
    task_id: str = ""                  # B2: mark this task done in the registry (dedup vs reconciler)
    # Render metadata (sidecar meta.json). NOTE: seed is a NO-OP on Seedance 2.0
    # (ignored) — an HD re-render is a fresh take, not an exact reproduction.
    seed: int | None = None
    resolution: str = ""
    prompt: str = ""
    # What the shot was SUPPOSED to be, so the save can measure what came back
    # against it. Optional: a caller that omits them just gets fewer gates.
    duration_secs: float = 0.0        # the breakdown's duration for this shot
    # The shot's dialogue, so the spoken length is estimated HERE with the same
    # function the breakdown sizes shots with — duplicating that formula in the
    # client is exactly how the two drift apart.
    dialogue: list[dict] = []
    # Prompt transparency: the auto-assembled version + the user's override (if
    # any) ride alongside the sent prompt so every clip is auditable.
    auto_prompt: str = ""
    prompt_override: str = ""
    negative_prompt: str = ""
    references: list[dict] = []        # ordered [{url, label}] as attached
    last_frame_url: str = ""           # Seedance return_last_frame CDN url (24h) — persisted RAW
                                       # (no re-encode) so Extend has a trusted first_frame later.


def _sidecar_references(task_id: str, client_refs: list | None) -> list:
    """What to write into a take's sidecar as its reference list.

    Prefers the roster the submit recorded in the render registry over the client's,
    because only the submit knows the complete set. Falls back to the client's list —
    and never raises: a sidecar is bookkeeping, and bookkeeping must not fail a save
    that has the video in hand.
    """
    client = list(client_refs or [])
    if not task_id:
        return client
    try:
        entry = render_registry.get(task_id) or {}
        recorded = entry.get("references") or []
        if len(recorded) > len(client):
            logger.info("[ShotVideo] sidecar references: registry has %d, client sent %d "
                        "— writing the registry's", len(recorded), len(client))
            return list(recorded)
    except Exception as e:
        logger.warning("[ShotVideo] could not read the registry's references (non-fatal): %s", e)
    return client


def _sidecar_prompt(task_id: str, client_prompt: str) -> str:
    """What to write into a take's sidecar as the prompt that produced it.

    Same reasoning as _sidecar_references, and the same failure: the browser sends the
    prompt it has on the shot, which is not always the one this task was submitted with.
    A resumed/duplicated save sends the prompt persisted from an EARLIER take, so the
    sidecar attributes a render to a prompt that never generated it — and that sidecar is
    what any audit of "what did we actually send" reads. /api/video/create records the
    assembled prompt against the task id at submit time; that one is the truth. Falls back
    to the client's, and never raises: bookkeeping must not fail a save that has the video.
    """
    client = client_prompt or ""
    if not task_id:
        return client
    try:
        recorded = (render_registry.get(task_id) or {}).get("prompt") or ""
        if recorded and recorded != client:
            logger.info("[ShotVideo] sidecar prompt: client sent %d chars, the submit "
                        "recorded %d — writing the registry's", len(client), len(recorded))
            return recorded
    except Exception as e:
        logger.warning("[ShotVideo] could not read the registry's prompt (non-fatal): %s", e)
    return client


@app.post("/api/shot/save-video")
async def save_shot_video(req: ShotVideoSaveRequest):
    """
    Download a finished Seedance render to Shots/<shot_id>/ on disk.
    Signed CDN video URLs expire (~24h); the local copy is the stable reference
    for QC, the editor, and re-renders.
    """
    import requests as _req
    try:
        resp = await asyncio.to_thread(_req.get, req.video_url, timeout=120)
        resp.raise_for_status()
        saved = await asyncio.to_thread(
            proj_storage.save_shot_video,
            req.project_name, req.shot_id, resp.content, req.project_path,
            {
                "seed": req.seed, "resolution": req.resolution,
                # Reconciled against the submit for the same reason as `references` below.
                "prompt": _sidecar_prompt(req.task_id, req.prompt),
                "auto_prompt": req.auto_prompt or req.prompt,
                # Identifies the render this take IS, so a re-save of a task already on
                # disk is recognised as the same one instead of burning a version slot.
                "task_id": req.task_id or None,
                "prompt_override": req.prompt_override or None,
                "negative_prompt": req.negative_prompt,
                # The browser's list, RECONCILED against what the submit actually sent.
                # They disagree often and always in the same direction — the client knows
                # about the references it chose and not about the ones the assembler added
                # (the style anchor, the previous shot's closing frame), so the sidecar
                # under-reported every take and reported nothing at all for three of nine.
                # The registry entry is written by /api/video/create from the resolved
                # roster, so it is the one that can be trusted; the client's list wins only
                # when there is no registry entry to read (an older render, a replayed
                # save).
                "references": _sidecar_references(req.task_id, req.references),
            },
        )
        logger.info("[ShotVideo] %s saved to %s (%d KB)",
                    req.shot_id, saved["path"], len(resp.content) // 1024)

        # ── Deterministic render gates ────────────────────────────────────────
        # A paid render can come back broken in ways nothing downstream detects: a
        # near-empty file, a clip far shorter than the shot it is meant to fill, or
        # audio that outruns the picture. All three are measurable right here, where
        # the file has just landed and the shot's intended duration is known, and all
        # three used to pass straight into the timeline. Reported, never fatal — the
        # render is already paid for and the file is on disk either way.
        gates: list[dict] = []
        kb = len(resp.content) // 1024
        # 50 KB, not the 500 KB the client used to check. Measured: a real Seedance
        # 480p clip is ~1 MB for 6 s, but a legitimately compressible 6 s encode can be
        # 144 KB — so 500 KB false-positives on dark or static footage, which is exactly
        # the kind of shot a drama has a lot of. What a byte count CAN detect reliably
        # is a truncated download or an error page served as a video, both of which are
        # single-digit KB. A black clip of the right length and size is invisible to any
        # threshold; that is what the vision QC is for, not this.
        gates.append({
            "label": "Clip integrity", "passed": kb >= 50,
            "notes": f"{kb} KB." + ("" if kb >= 50 else " Truncated or empty — the download failed; re-render."),
        })
        vid_secs = await asyncio.to_thread(_probe_audio_seconds, saved["path"])
        if vid_secs and req.duration_secs:
            short = req.duration_secs - vid_secs
            gates.append({
                "label": "Clip duration", "passed": short <= 1.0,
                "notes": f"{vid_secs:.1f}s against a {req.duration_secs}s shot."
                         + ("" if short <= 1.0 else f" {short:.1f}s short — the beat will not fit."),
            })
        # Dialogue that outruns the picture is the failure that used to be invisible:
        # ffmpeg's -shortest trims the audio to the video, so the end of the line is
        # simply never heard and no error is raised anywhere.
        dlg_secs = 0.0
        if req.dialogue:
            from claude_agents import _estimate_dialogue_seconds as _est
            dlg_secs = _est(req.dialogue)
        if vid_secs and dlg_secs:
            over = dlg_secs - vid_secs
            gates.append({
                "label": "Dialogue fits", "passed": over <= 0.5,
                "notes": f"{dlg_secs:.1f}s of dialogue in a {vid_secs:.1f}s clip."
                         + ("" if over <= 0.5 else f" {over:.1f}s would be cut off — split the shot."),
            })
        for g in gates:
            if not g["passed"]:
                logger.warning("[ShotVideo] %s gate FAILED — %s: %s", req.shot_id, g["label"], g["notes"])
                await bus.publish("seedance", "error", f"{req.shot_id}: {g['notes']}")
        # B2: the frontend saved it — mark the registry task done so the backend
        # reconciler doesn't re-download and create a duplicate version.
        if req.task_id:
            await asyncio.to_thread(render_registry.mark_completed, req.task_id,
                                    video_local_path=saved.get("path", ""),
                                    video_url=req.video_url)
        # 4k renders are 10-bit HEVC — Safari plays them, Chrome/Firefox don't.
        # Transcode a 720p H.264 preview proxy so the in-app player works everywhere
        # (the 4k file stays the deliverable). Non-fatal: no proxy → UI falls back to
        # the original. Lower tiers are already H.264, so only 4k needs this.
        preview_path = ""
        if await asyncio.to_thread(_needs_h264_preview, saved.get("path", ""), req.resolution):
            preview_path = await asyncio.to_thread(_make_h264_preview, saved.get("path", "")) or ""
        # Persist the RAW last-frame PNG next to the video so a later Extend has a trusted
        # first_frame even after the 24h CDN url expires (shared trust-safe helper).
        last_frame_local_path = await asyncio.to_thread(
            _persist_raw_last_frame, saved.get("path", ""), req.last_frame_url)
        return {**saved, "local_path": saved.get("path", ""),
                "preview_path": preview_path, "last_frame_local_path": last_frame_local_path,
                "bytes": len(resp.content), "gates": gates}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Video download/save failed: {e}")


def _needs_h264_preview(src_path: str, resolution: str | None = None) -> bool:
    """Whether a saved render needs the browser-playable proxy. Decided by what the
    file IS — ffprobe's codec and pixel format — not by its resolution string. The
    trigger used to be `"4k" in resolution`, which was right while 4k was the only
    10-bit output; the live model list (2026-09-04) also lists 2.5's 1080p as 10-bit,
    and a string test would have shipped those to Chrome as a black frame. A probe
    failure falls back to the old string test so a broken ffprobe cannot silently
    drop the 4k proxy."""
    if not src_path or not os.path.isfile(src_path):
        return False
    try:
        proc = subprocess.run(
            [FFPROBE_BIN, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,pix_fmt", "-of", "csv=p=0", src_path],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            codec, _, pix = proc.stdout.strip().partition(",")
            return codec.strip() in ("hevc", "h265") or "10" in pix
    except Exception as e:
        logger.warning("[Preview] ffprobe failed for %s: %s", os.path.basename(src_path), e)
    return "4k" in (resolution or "").lower()


def _make_h264_preview(src_path: str) -> str | None:
    """4k Seedance renders are 10-bit HEVC (H.265): Safari plays them, but Chrome and
    Firefox show a black frame. Transcode a lightweight 720p 8-bit H.264 proxy
    (video_vNNN.preview.mp4) next to the original for in-browser preview — the 4k file
    stays the deliverable/export. Returns the proxy path, or None on any failure so
    the caller falls back to the original."""
    if not src_path or not os.path.isfile(src_path):
        return None
    stem, _ext = os.path.splitext(src_path)
    out = f"{stem}.preview.mp4"
    try:
        proc = subprocess.run(
            [FFMPEG_BIN, "-y", "-i", src_path,
             "-vf", "scale=-2:720",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out],
            capture_output=True, timeout=300,
        )
        if proc.returncode != 0 or not os.path.isfile(out):
            logger.warning("[Preview] H.264 proxy failed for %s: %s",
                           os.path.basename(src_path), proc.stderr.decode()[:200])
            return None
        logger.info("[Preview] H.264 720p proxy → %s", os.path.basename(out))
        return out
    except Exception as e:
        logger.warning("[Preview] proxy error: %s", e)
        return None


def _extract_last_frame(video_ref: str) -> str | None:
    """Extract the LAST frame of a video as a PNG (for extend/continuation: the next
    clip animates FROM this frame so the join is seamless). Local path or URL."""
    import subprocess, tempfile, requests as _req
    src, tmp_video = video_ref, None
    try:
        if not (video_ref.startswith("/") or video_ref.startswith("file://")):
            resp = _req.get(video_ref, timeout=120); resp.raise_for_status()
            tmp_video = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
            tmp_video.write(resp.content); tmp_video.close(); src = tmp_video.name
        elif video_ref.startswith("file://"):
            src = video_ref[7:]
        out = tempfile.mktemp(suffix=".png", prefix="takeone_lastframe_")
        # -sseof -0.3 seeks 0.3 s before the end; -update 1 keeps overwriting to the last frame.
        r = subprocess.run([FFMPEG_BIN, "-y", "-sseof", "-0.3", "-i", src, "-update", "1",
                            "-frames:v", "1", out], capture_output=True, timeout=60)
        return out if (r.returncode == 0 and os.path.isfile(out)) else None
    except Exception as e:
        logger.warning("[Extend] last-frame extract failed: %s", e)
        return None
    finally:
        if tmp_video:
            try: os.unlink(tmp_video.name)
            except OSError: pass


def _persist_raw_last_frame(video_path: str, last_frame_url: str) -> str:
    """Download Seedance's return_last_frame RAW (byte-for-byte, NO re-encode) and save it as
    <video>.lastframe.png next to the clip, so a later Extend has a TRUSTED first_frame even
    after the 24h CDN url expires (video-seedance §7 — the in-pixel trust survives a raw save;
    ffmpeg/PIL re-encoding — see _extract_last_frame above — kills it). This is why an EDITED /
    EXTENDED clip must persist ITS OWN Seedance last-frame, not fall back to the source clip's.
    Returns the saved path, or "" on any failure (non-fatal)."""
    if not video_path or not (last_frame_url or "").startswith(("http://", "https://")):
        return ""
    try:
        import requests as _req
        lf = _req.get(last_frame_url, timeout=60)
        if lf.status_code == 200 and lf.content:
            lfp = os.path.splitext(video_path)[0] + ".lastframe.png"
            with open(lfp, "wb") as f:
                f.write(lf.content)   # raw bytes — trust preserved
            return lfp
    except Exception as e:
        logger.warning("[LastFrame] raw persist failed (non-fatal): %s", e)
    return ""


def _concat_videos(paths: list[str], out_path: str) -> bool:
    """Concatenate video clips into one (re-encoded so slightly-different params still
    join). Handles clips with or without an audio stream."""
    if not paths:
        return False
    inputs: list[str] = []
    for p in paths:
        inputs += ["-i", p]
    n = len(paths)
    all_audio = all(_has_audio(p) for p in paths)
    try:
        if all_audio:
            filt = "".join(f"[{i}:v][{i}:a]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]"
            maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac"]
        else:
            filt = "".join(f"[{i}:v]" for i in range(n)) + f"concat=n={n}:v=1:a=0[v]"
            maps = ["-map", "[v]"]
        cmd = [FFMPEG_BIN, "-y", *inputs, "-filter_complex", filt, *maps,
               "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", out_path]
        r = subprocess.run(cmd, capture_output=True, timeout=300)
        return r.returncode == 0 and os.path.isfile(out_path)
    except Exception as e:
        logger.warning("[Extend] concat error: %s", e)
        return False


def _extract_video_frame(video_ref: str) -> str | None:
    """
    Pull a representative frame (t=1s) from a video for vision QC.
    Accepts a local path or URL (downloads first). Returns a temp PNG path.
    Claude cannot watch video — ModelArk vision analyses this frame and the
    observations are what the Animation Director actually judges.
    """
    import subprocess, tempfile, requests as _req

    src = video_ref
    tmp_video = None
    try:
        if not (video_ref.startswith("/") or video_ref.startswith("file://")):
            resp = _req.get(video_ref, timeout=60)
            resp.raise_for_status()
            tmp_video = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
            tmp_video.write(resp.content)
            tmp_video.close()
            src = tmp_video.name
        elif video_ref.startswith("file://"):
            src = video_ref[7:]

        frame_path = tempfile.mktemp(suffix=".png", prefix="takeone_qc_frame_")
        proc = subprocess.run(
            [FFMPEG_BIN, "-y", "-ss", "1", "-i", src, "-frames:v", "1", frame_path],
            capture_output=True, timeout=60,
        )
        if proc.returncode != 0 or not os.path.isfile(frame_path):
            logger.warning("[FinalQC] frame extraction failed: %s", proc.stderr.decode()[:200])
            return None
        return frame_path
    except Exception as e:
        logger.warning("[FinalQC] frame extraction error: %s", e)
        return None
    finally:
        if tmp_video:
            try:
                os.unlink(tmp_video.name)
            except OSError:
                pass


@app.post("/api/finalscene/qc")
async def qc_final_scene(req: FinalSceneQCRequest):
    claude = get_claude()
    api = get_byteplus()
    await bus.publish("qc", "active", f"Final QC: {req.shot_id}")
    try:
        # Vision pipeline: extract a frame from the (locally saved) video and let
        # ModelArk describe it — Claude judges those observations, not a raw URL.
        vision_obs: dict | None = None
        frame_path = await asyncio.to_thread(_extract_video_frame, req.video_url)
        if frame_path:
            try:
                vision_obs = await asyncio.to_thread(
                    api.analyze_image_vision, frame_path, req.shot_description[:200]
                )
                logger.info("[FinalQC] %s frame vision: %s", req.shot_id, vision_obs.get("render_style"))
            except Exception as ve:
                logger.warning("[FinalQC] vision analysis failed (non-fatal): %s", ve)
            finally:
                try:
                    os.unlink(frame_path)
                except OSError:
                    pass

        # P3.17: objective identity drift — embed the rendered video against the
        # approved character image (documented video embedding input).
        # #5 (2026-07-17): the cosine embeds the WHOLE frame, so on insert shots
        # (hands/objects/text), backs of heads, or faces too small/dark to identify
        # there is NO face to match and it returns a FALSE-HIGH "drift" (observed:
        # hand+crayon inserts scoring 76%, a character walking away 66%). Only score
        # when vision confirms an identifiable face; else leave it None so the UI shows
        # no drift badge instead of a red herring. Missing field → default 'clear'
        # (never suppress when vision didn't report it — no regression).
        identity_drift: float | None = None
        _face_vis = str((vision_obs or {}).get("face_visibility") or "clear").lower()
        if req.character_ref_url and _face_vis != "none":
            try:
                identity_drift = await asyncio.to_thread(
                    api.compute_identity_drift, req.video_url, req.character_ref_url
                )
            except Exception as ie:
                logger.warning("[FinalQC] identity drift failed (non-fatal): %s", ie)
        elif _face_vis == "none":
            logger.info("[FinalQC] %s: no identifiable face in frame — skipping identity drift (avoids false-high)", req.shot_id)

        # WATCH THE CLIP. The frame pass above samples ONE image, so the two defects this
        # pipeline actually ships — nobody moves, and a character is doubled — cannot
        # reach the verdict through it: stillness needs two moments to be visible, and a
        # transient duplicate is simply absent from whichever frame was sampled. MEDIA_MODEL
        # watches the whole clip and hears its audio in one call. Non-fatal: a QC that
        # cannot watch falls back to exactly the frame-only behaviour it had before.
        media_obs: str | None = None
        try:
            media_obs = await asyncio.to_thread(
                api.analyze_media, [req.video_url],
                "Report ONLY what is actually in this clip, as short plain lines:\n"
                "1. Every person visible, one line each, with what they wear. State "
                "explicitly if the SAME person appears more than once at the same time.\n"
                "2. Does each person MOVE, or hold still? Say which.\n"
                "3. Every word spoken aloud, verbatim in quotes. Write NONE if silent.\n"
                "4. Any visible breakage: warping, extra limbs, morphing faces, flicker, "
                "frozen frames, text artefacts.\n"
                "Do not interpret, do not praise, do not invent what you cannot see.",
                1200,
            )
            logger.info("[FinalQC] %s watched: %s", req.shot_id, (media_obs or "")[:120].replace("\n", " "))
        except Exception as me:
            logger.warning("[FinalQC] clip analysis failed (non-fatal): %s", me)

        result = await asyncio.to_thread(
            claude.qc_final_scene, req.shot_id, req.video_url, req.shot_description,
            vision_obs, identity_drift, media_obs,
        )
        result["identity_drift"] = identity_drift
        result["media_observations"] = media_obs
        status = "completed" if result.get("passed") else "active"
        await bus.publish("qc", status, result.get("summary", "QC complete"))
        return result
    except Exception as e:
        await bus.publish("qc", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ── Stage 6: Final cut ────────────────────────────────────────────────────────

def _sample_cut_frames(path: str, n: int = 8) -> list[tuple[str, str]]:
    """N frames spread evenly across a rendered cut, as (media_type, base64).

    Sampling ACROSS the film rather than per shot is the point: the question the Final
    Director is asked — does this read as one film, does the shot size ever change, does
    the grade hold — is about the relationship between distant moments, which no single
    frame can answer.
    """
    import base64 as _b64, subprocess as _sp, tempfile as _tf
    out: list[tuple[str, str]] = []
    try:
        probe = _sp.run([FFPROBE_BIN, "-v", "error", "-show_entries", "format=duration",
                         "-of", "csv=p=0", path], capture_output=True, text=True, timeout=30)
        dur = float((probe.stdout or "0").strip() or 0)
    except Exception:
        dur = 0.0
    # `dur <= 0` alone lets a nan through — every comparison against nan is False — and
    # the seek times below become nan, i.e. n ffmpeg launches that all fail and a QC pass
    # that quietly runs on no frames at all. Non-finite is "unprobeable", same as 0.
    if not _math.isfinite(dur) or dur <= 0:
        return out
    with _tf.TemporaryDirectory() as td:
        for i in range(n):
            # Inset from both ends: t=0 is often black and the last frame may be a fade.
            t = dur * (i + 0.5) / n
            fp = os.path.join(td, f"f{i}.jpg")
            try:
                _sp.run([FFMPEG_BIN, "-y", "-ss", f"{t:.2f}", "-i", path, "-frames:v", "1",
                         "-vf", "scale=512:-1", "-q:v", "4", fp],
                        capture_output=True, timeout=60)
                if os.path.isfile(fp) and os.path.getsize(fp) > 1000:
                    out.append(("image/jpeg", _b64.b64encode(open(fp, "rb").read()).decode()))
            except Exception as e:
                logger.warning("[FinalQC] frame at %.1fs failed (non-fatal): %s", t, e)
    return out


@app.post("/api/finalcut/qc")
async def qc_final_cut(req: FinalCutQCRequest):
    claude = get_claude()
    await bus.publish("qc", "active", "Final cut QC running…")
    try:
        frames: list[tuple[str, str]] = []
        if req.render_path and os.path.isfile(req.render_path):
            await bus.publish("qc", "active", "Sampling frames from the cut…", 20)
            frames = await asyncio.to_thread(_sample_cut_frames, req.render_path)
            logger.info("[FinalQC] sampled %d frame(s) from %s",
                        len(frames), os.path.basename(req.render_path))
        # PHASE 6 · the shape the cut was supposed to have. The Final Director already
        # measures runtime against target and now LOOKS at sampled frames, but it had no
        # way to answer "is this still the film the story described" — the act structure
        # was never sent. Project identity is taken from the request when a client sends
        # it, and otherwise recovered from the rendered file's own location, so this works
        # for the existing caller without a wire change. No bible → "" → the review prompt
        # is exactly what it is today.
        _story = _bible_delivery_note(await asyncio.to_thread(
            _read_bible_quietly,
            req.project_name,
            req.project_path or _project_root_of_render(req.render_path),
        ))
        if _story:
            logger.info("[Bible] final-cut QC sees the act structure (%d chars)", len(_story))
        result = await asyncio.to_thread(claude.qc_final_cut, req.sequence, req.shot_data,
                                         frames or None, req.target_secs, req.loudness,
                                         story=_story)
        await bus.publish("qc", "completed", result.get("summary", "Final cut approved"))
        return result
    except Exception as e:
        await bus.publish("qc", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ── P9/P10: NLE EDL + ffmpeg render ──────────────────────────────────────────

class EDLClip(BaseModel):
    shotId: str
    videoUrl: str
    inPoint: float = 0.0
    outPoint: float | None = None   # None = use full clip
    transitionIn: dict | None = None  # {"type": "crossfade", "dur": 0.5}
    volume: float = 1.0             # per-clip audio gain (0 = mute, 1 = unity)
    fadeIn: float = 0.0             # video fades from black + audio fades in
    fadeOut: float = 0.0            # video fades to black + audio fades out

class EDL(BaseModel):
    fps: int = 24
    clips: list[EDLClip]

class SaveEDLRequest(BaseModel):
    project_name: str
    project_path: str = ""       # custom storage root (localFolderRoot)
    edl: EDL

class AudioClipSpec(BaseModel):
    path: str
    timeline_start: float = 0.0
    in_point: float = 0.0
    out_point: float = 0.0
    volume: float = 1.0
    fade_in: float = 0.0
    fade_out: float = 0.0
    # A music bed has to BREATHE under the dialogue. Music only exists in this export
    # stage (Seedance never scores a shot), and the mix below used to sit it at one
    # flat gain for the whole film — loud enough to fight every line, or quiet enough
    # to be pointless. duck=True sidechains this clip under the programme audio, which
    # is where the dialogue lives (Seedance bakes it into the clip audio). Default True
    # because a bed is the normal case; set False for a spot effect that must land at
    # full level regardless of who is speaking.
    duck: bool = True


class OverlayClipSpec(BaseModel):
    """5C: a V2 overlay clip — a video composited ON TOP of the assembled base track
    for [timeline_start, timeline_start+(out-in)], with its own audio mixed in. Same
    positioned-clip shape as AudioClipSpec, plus it carries video."""
    path: str
    timeline_start: float = 0.0
    in_point: float = 0.0
    out_point: float = 0.0
    volume: float = 1.0
    fade_in: float = 0.0
    fade_out: float = 0.0


class RenderRequest(BaseModel):
    project_name: str
    project_path: str = ""       # custom storage root (localFolderRoot)
    edl: EDL
    output_format: str = "mp4"   # mp4 | mov | webm
    resolution: str = "1080p"    # 720p | 1080p | 4k
    audio_clips: list[AudioClipSpec] = []   # extra audio track(s) mixed under the clip audio
    master_volume: float = 1.0   # 5K: global master/bus gain applied to EVERY clip's audio (video + extra audio). 1 = unity, 0 = silent
    overlay_clips: list[OverlayClipSpec] = []   # 5C: V2 overlay video clips composited on top of the base track (default [] → old callers unaffected)


def _quality_args(vcodec: str) -> list[str]:
    """Encoder quality for a DELIVERABLE, not ffmpeg's defaults.

    No stage of the export set a rate at all, so everything fell through to x264
    CRF 23 and — for the 4k path — x265 CRF 28. CRF 28 is a streaming-preview
    setting: on a 4k master it is visibly soft exactly where generated footage is
    already weakest, in fine texture and film grain. Paying for a 4k render and then
    encoding it at preview quality throws away the thing that was paid for.

    x265 at 20 and x264 at 19 are visually-transparent delivery settings. Both are
    env-overridable for anyone who wants smaller files or a mezzanine.
    """
    if vcodec == "libx265":
        return ["-crf", os.getenv("TAKEONE_CRF_X265", "20")]
    if vcodec == "libx264":
        return ["-crf", os.getenv("TAKEONE_CRF_X264", "19")]
    if vcodec == "libvpx-vp9":
        return ["-crf", os.getenv("TAKEONE_CRF_VP9", "31"), "-b:v", "0"]
    return []                       # prores carries its own profile


def _ff_timeout(total_secs: float, per_sec: float, floor: int = 120) -> int:
    """An ffmpeg timeout that scales with the work instead of a fixed number.

    Every stage of the export was capped at 120-300 s regardless of how much film it
    was processing. That is generous for a 60-second short and a guaranteed failure
    for a 45-minute episode: 540 clips do not concat in five minutes, and when the
    timeout fired the whole run died and its temp directory was deleted, so the next
    attempt started from zero.

    per_sec is how many seconds of wall clock to allow per second of programme —
    small for stream-copy work, larger for anything that re-encodes. Capped at 4 h so
    a genuinely stuck process still dies.
    """
    return int(max(floor, min(4 * 3600, total_secs * per_sec + floor)))


# ── How long a timeline REALLY is ────────────────────────────────────────────
# `outPoint = None` means "play the whole clip" (EDLClip, above) — the NORMAL case,
# not an edge case. Every place that needed a length used some spelling of
#     (c.outPoint if c.outPoint else 0) - (c.inPoint or 0) or 5.0
# which hands every untrimmed clip a flat 5.0 s. (THREE places, not two: the .srt writer
# below kept its own copy of the formula 110 lines from this comment and went on timing
# every subtitle in every exported film to a fabricated 5 s until it was measured.)
# Measured on 26 real generated
# segments of 4-15 s: that formula reports 130.00 s for a timeline that is
# 246.59 s long — 47% short — and the damage is not cosmetic:
#   * the export guard computes shortfall = expected - xfades - actual, so with a
#     halved `expected` the shortfall goes systematically NEGATIVE (-116.71 s on the
#     clean render above). The guard that exists to catch "a shot is missing from
#     the export" therefore CANNOT FIRE in the normal case. Verified: an export that
#     silently dropped a 4.06 s shot returned HTTP 200 with shortfall -112.64 s.
#   * `_total` sizes every ffmpeg timeout in the export, so a long render was being
#     budgeted for half the film it actually has to encode.
# So probe the file, through _probe_audio_seconds, which returns None when it cannot
# read one — an unprobeable clip stays UNKNOWN and is handled at the call site instead
# of silently becoming 5.0. (_media_duration, near the top of this file, was the other
# half of the same bug and has been deleted rather than kept as a second, caller-less
# probe.) Every length in the render endpoint comes from _clip_secs — the filter graph,
# the length guard below and the .srt writer all read that one measurement, so none of
# the three can disagree with the other two about how long the film is.
_SOURCE_SECS_CACHE: dict[str, float | None] = {}


def _source_seconds(path: str) -> float | None:
    """Cached ffprobe duration of one source file; None when it cannot be probed.

    Cached because several EDL clips regularly point at ONE source (a take reused in the
    cut), and a 500-clip export must not spawn 500 ffprobe processes for the same handful
    of files. Keyed on (path, size, mtime) rather than the path alone: a re-rendered shot
    keeps its filename, and a stale duration here would either fire the export guard on a
    film that is complete or hide one that is short. A stat() is orders of magnitude
    cheaper than the subprocess it saves.
    """
    if not path:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None                     # not a readable local file — nothing to probe
    key = f"{path}\0{st.st_size}\0{st.st_mtime_ns}"
    if key not in _SOURCE_SECS_CACHE:
        # Bounded. This server is long-lived and every export probes a FRESH temp
        # directory, so an unbounded dict accumulates one dead entry per clip per render
        # forever; only one export's working set has to fit.
        if len(_SOURCE_SECS_CACHE) > 4096:
            _SOURCE_SECS_CACHE.clear()
        _SOURCE_SECS_CACHE[key] = _probe_audio_seconds(path)
    return _SOURCE_SECS_CACHE[key]


def _edl_clip_seconds(clip: EDLClip, local_path: str = "") -> float | None:
    """Seconds of programme this clip really contributes, or None when that cannot
    be known yet.

    `local_path` is the materialised copy the export has already downloaded; without
    one, only a clip whose videoUrl is itself a local file can be probed — a remote
    URL has no duration until it is fetched, and fetching it here would download the
    whole episode twice.
    """
    in_pt = clip.inPoint or 0.0
    if clip.outPoint:
        return max(0.0, clip.outPoint - in_pt)
    src = local_path
    if not src and clip.videoUrl.startswith(("/", "file://")):
        src = clip.videoUrl[7:] if clip.videoUrl.startswith("file://") else clip.videoUrl
    dur = _source_seconds(src)
    return max(0.0, dur - in_pt) if dur else None


def _srt_time(t: float) -> str:
    """Seconds → SRT timestamp (HH:MM:SS,mmm)."""
    if t < 0:
        t = 0.0
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _write_subtitles(edl: "EDL", project_name: str, project_path: str,
                     video_path: str, clip_secs: list[float | None],
                     xfades: list[float]) -> "dict | None":
    """Write an .srt beside the render, from dialogue that is ALREADY in the breakdown.

    The episode's every spoken line has been sitting in Breakdown/breakdown.json since
    phase 2 and has never been exported — there was no SRT or VTT writer anywhere in
    this repo. Subtitles cost nothing to produce here and are the single cheapest thing
    that moves both retention and accessibility.

    Timing comes from the caller's MEASURED lengths, never from the EDL's own numbers:
    `clip_secs[i]` is _edl_clip_seconds for clip i — the same list the filter graph
    trims with and the length guard compares against, so a cue cannot disagree with the
    picture. `xfades[i]` is how far clip i overlaps the one before it (0 on the concat
    path), which is what makes the last cue land at the end of the FILE rather than at
    the end of the arithmetic. Within a clip the lines are apportioned by spoken length
    (the same ~2 words/second the breakdown uses to size shots) — accurate to the clip,
    not to the syllable. Best-effort: a missing or unreadable breakdown just means no
    subtitle file, never a failed render.

    Returns {path, cues, note} — or None when there is nothing to write. `note` is the
    truncation the loop below can hit: cues stop at the first clip with no measurable
    length, and that used to be announced in the server log ALONE, so a film shipped
    with subtitles that end halfway and nobody was told. The caller puts it in the
    render response.
    """
    try:
        root = proj_storage._resolve_root(project_name, project_path)
        bd_path = root / "Breakdown" / "breakdown.json"
        if not bd_path.is_file():
            return None
        bd = json.loads(bd_path.read_text())
        # shotId → [{character, text}], both key spellings the pipeline uses.
        dlg_by_shot: dict[str, list[dict]] = {}
        for sh in bd.get("shots", []):
            sid = sh.get("id") or sh.get("shotId")
            lines = [d for d in (sh.get("dialogue") or []) if (d.get("text") or "").strip()]
            if sid and lines:
                dlg_by_shot[sid] = lines
        if not dlg_by_shot:
            return None

        # Character id → display name, so the cue reads "ELI:" not "ASSET_003:".
        names = {a.get("id"): a.get("name") for a in bd.get("assets", []) if a.get("id")}

        cues: list[tuple[float, float, str]] = []
        t = 0.0
        stopped_at = ""          # shot id the cues stopped on (empty = the whole cut is covered)
        covered = len(edl.clips)
        for i, clip in enumerate(edl.clips):
            dur = clip_secs[i] if i < len(clip_secs) else None
            if not dur or dur <= 0:
                # An unmeasurable clip has no known length, so nothing AFTER it has a
                # known start either — every later cue would be off by however long this
                # one really runs. `… if clip.outPoint else 5.0` used to stand here, and
                # outPoint=None is the NORMAL case: measured on a 6.0/9.0/5.5 s cut, the
                # .srt put cue 1 at 0→5 s and its last cue at 10→15 s on a 20.55 s file.
                # Stop at the last cue that is known to be right instead of guessing:
                # a missing subtitle is visible, a subtitle on the wrong line is not.
                logger.warning("[Subtitles] %s has no measurable duration — cues stop at %.2fs",
                               clip.shotId or f"clip {i}", t)
                stopped_at, covered = clip.shotId or f"clip {i}", i
                break
            # Where this clip STARTS: the xfade path overlaps it onto the previous one
            # (the offset chain in the render endpoint), the concat path butt-joins.
            t = max(0.0, t - (xfades[i] if i < len(xfades) else 0.0))
            lines = dlg_by_shot.get(clip.shotId) or []
            if lines:
                # Apportion the clip's time by how long each line takes to say.
                weights = [max(1, len((d.get("text") or "").split())) for d in lines]
                total_w = sum(weights)
                cursor = t
                for d, w in zip(lines, weights):
                    span = dur * (w / total_w)
                    who = names.get(d.get("characterId")) or d.get("character") or ""
                    text = (d.get("text") or "").strip()
                    cues.append((cursor, cursor + span,
                                 f"{who.upper()}: {text}" if who else text))
                    cursor += span
            t += dur

        if not cues:
            return None
        srt = os.path.splitext(video_path)[0] + ".srt"
        with open(srt, "w", encoding="utf-8") as f:
            for n, (start, end, text) in enumerate(cues, 1):
                f.write(f"{n}\n{_srt_time(start)} --> {_srt_time(end)}\n{text}\n\n")
        logger.info("[Subtitles] wrote %d cue(s) → %s", len(cues), srt)
        note = (f"Subtitles stop at {t:.1f}s — {stopped_at} has no measurable length, so "
                f"{len(edl.clips) - covered} of {len(edl.clips)} clips have no cues."
                if stopped_at else "")
        return {"path": srt, "cues": len(cues), "note": note}
    except Exception as e:
        logger.warning("[Subtitles] skipped (non-fatal): %s", e)
        return None


class SoundtrackRequest(BaseModel):
    project_name: str
    project_path: str = ""
    filename: str
    data_b64: str                # base64 of the audio file (data-URI prefix stripped)


@app.post("/api/edit/soundtrack")
async def upload_soundtrack(req: SoundtrackRequest):
    """Save an uploaded music track to the project so it can be mixed into the
    final render. Returns the stored path + display name."""
    try:
        b64 = req.data_b64.split(",", 1)[1] if req.data_b64.startswith("data:") else req.data_b64
        saved = await asyncio.to_thread(
            proj_storage.save_soundtrack, req.project_name, req.filename, b64, req.project_path,
        )
        return saved
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Soundtrack upload failed: {e}")


class DialogueClipRequest(BaseModel):
    shot_id: str
    dialogue: list[dict] = []       # [{character (NAME), text, emotion?}]
    # The breakdown's per-shot dialogue_scene: ONE Seed Audio prompt that makes the
    # speakers overlap. Empty ('' — what every existing client sends, since none knows
    # about it) renders the lines one by one exactly as before.
    dialogue_scene: str = ""
    project_name: str = ""
    project_path: str = ""


@app.post("/api/shot/dialogue-clip")
async def render_dialogue_clip(req: DialogueClipRequest):
    """Render a shot's dialogue with the characters' LOCKED voices (Seed Audio 1.0) into
    ONE clip — for the storyboard's generate/preview/approve step (3.2). No video needed.
    The approved clip is later passed to Seedance as the shot's audio reference."""
    if not [d for d in (req.dialogue or []) if (d.get("text") or "").strip()]:
        raise HTTPException(status_code=400, detail="no dialogue lines")
    clip = await _render_dialogue_clip(req.dialogue, req.project_name, req.project_path, req.shot_id,
                                       scene_prompt=req.dialogue_scene)
    if not clip:
        raise HTTPException(status_code=502, detail="dialogue synthesis failed")
    duration = 0.0
    try:
        duration = await asyncio.to_thread(_probe_audio_seconds, clip) or 0.0
    except Exception:
        pass
    return {"path": clip, "duration": duration}


class SoundtrackGenRequest(BaseModel):
    project_name: str
    project_path: str = ""
    text: str                       # narration / voiceover script
    character: str = ""             # optional: use this character's LOCKED voice
    emotion: str | None = None


@app.post("/api/soundtrack/generate")
async def generate_soundtrack_vo(req: SoundtrackGenRequest):
    """Generate a VOICEOVER / narration track with Seed Audio 1.0 and store it as an
    Audio clip for the Final Cut timeline. NOTE: Seed Audio 1.0 is a VOICE model, not
    a music generator — this produces spoken narration/VO, not a musical score. A
    character name uses that character's locked voice; otherwise the default TTS voice."""
    if not (req.text or "").strip():
        raise HTTPException(status_code=400, detail="text required")
    cfg: dict = {}
    if req.character:
        try:
            anchors = await asyncio.to_thread(proj_storage.read_voice_anchors, req.project_name, req.project_path)
            cfg = anchors.get(req.character, {}) or {}
        except Exception:
            cfg = {}
    try:
        audio = await _synthesize_line(req.text[:2000], cfg, emotion=req.emotion)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Voiceover synthesis failed: {e}")
    import base64 as _b64
    saved = await asyncio.to_thread(
        proj_storage.save_soundtrack, req.project_name, f"voiceover_{int(_time.time())}.mp3",
        _b64.b64encode(audio).decode(), req.project_path,
    )
    duration = 0.0
    try:
        duration = await asyncio.to_thread(_probe_audio_seconds, saved["path"]) or 0.0
    except Exception:
        pass
    return {"path": saved["path"], "name": saved.get("name", "voiceover.mp3"), "duration": duration}


def _concat_audio_seamless(paths: list[str], out_path: str) -> bool:
    """Concatenate audio segments with NO silence padding — for music, gaps break
    the flow (the dialogue concat pads 0.35 s between lines; music must not)."""
    if not paths:
        return False
    if len(paths) == 1:
        try:
            shutil.copyfile(paths[0], out_path)
            return os.path.isfile(out_path)
        except Exception:
            return False
    inputs: list[str] = []
    for p in paths:
        inputs += ["-i", p]
    n = len(paths)
    filt = "".join(f"[{i}:a]" for i in range(n)) + f"concat=n={n}:v=0:a=1[out]"
    try:
        r = subprocess.run([FFMPEG_BIN, "-y", *inputs, "-filter_complex", filt,
                            "-map", "[out]", out_path], capture_output=True, timeout=180)
        return r.returncode == 0 and os.path.isfile(out_path)
    except Exception as e:
        logger.warning("[Soundtrack] concat error: %s", e)
        return False


def _fit_music_to_film(src: str, out: str, target: float, fade: float = 2.0) -> bool:
    """Fit a music PHRASE to EXACTLY the film length: loop it (`-stream_loop`) until it
    reaches `target`, cut at `target`, and fade the last `fade` s out. Looping a short
    phrase to fill a background bed is standard scoring — and it sidesteps the content
    filter blocking long/multi-chunk single generations. A phrase already ≥ target is
    simply trimmed."""
    fade_start = max(0.0, target - fade)
    try:
        r = subprocess.run(
            [FFMPEG_BIN, "-y", "-stream_loop", "-1", "-i", src, "-t", f"{max(0.5, target):.2f}",
             "-af", f"afade=t=out:st={fade_start:.2f}:d={fade:.2f}", out],
            capture_output=True, timeout=180)
        return r.returncode == 0 and os.path.isfile(out)
    except Exception as e:
        logger.warning("[Soundtrack] loop/fade error: %s", e)
        return False


class SoundtrackMusicRequest(BaseModel):
    project_name: str
    project_path: str = ""
    prompt: str                      # description of the music (mood/instruments/energy)
    target_seconds: float = 15.0     # FILM length to cover; rendered as ≤120 s sections


@app.post("/api/soundtrack/music")
async def generate_soundtrack_music(req: SoundtrackMusicRequest):
    """Generate an INSTRUMENTAL MUSIC track with Seed Audio 1.0 that covers the FILM.

    Verified live (2026-07-12): Seed Audio 1.0 is prompt-driven generative audio (the
    doc's own example is "generate a suspense radio drama") and DOES emit instrumental
    music. BUT it generates in internal ~15 s chunks and the content-risk audit checks
    EACH chunk: a live A/B showed 30 s and 60 s requests blocked on EVERY attempt
    (chunk 1/2/4 rejected), while ~15 s single-chunk requests reliably pass. So the
    dependable unit is ~15 s — we cover `target_seconds` (the film length) by rendering
    N ~15 s chunks in parallel and concatenating, then trim to the exact length + fade.

    Each chunk retries with progressively NEUTRAL phrasings (the last drops the user's
    words for a generic bed); a chunk blocked on all phrasings is dropped (non-fatal).
    We over-provision by one chunk so the odd drop still covers the film."""
    import math as _math
    import re as _re2
    import seed_audio
    import base64 as _b64
    import tempfile
    prompt = (req.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt required")

    target = max(1.0, min(float(req.target_seconds or 15.0), 10 * 60.0))
    # Build a PHRASE from a few chunks, then loop it to cover the film.
    #
    # Re-measured live 2026-07-29 (the note below is from 2026-07-12 and its premise
    # no longer holds). 14 requests across 15/30/60/120 s:
    #
    #   duration:  15 s → 1/2 · 30 s → 1/2 · 60 s → 0/2 · 120 s → 0/2
    #   prompt:    minimal "Instrumental piano music." → 2/3 at BOTH 15 s and 30 s
    #              the old neutral fallback              → 1/3 at 15 s, 0/3 at 30 s
    #
    # Two conclusions, both against the previous design. Duration is NOT the limiting
    # factor — 30 s passes as often as 15 s — and what actually correlates with getting
    # through the content audit is prompt BREVITY, where the old "progressively neutral"
    # fallback was itself too wordy to be the safe option it was meant to be.
    #
    # So: 30 s chunks (same number of moderation dice, twice the unique material, half
    # the loop repetition over a 45-minute episode) and shortest-phrasing-first.
    CHUNK_SECS = 30
    n = min(4, _math.ceil(min(target, 90.0) / (CHUNK_SECS - 1.0)) + 1)

    def _gen_chunk(idx: int) -> "bytes | None":
        # Shortest FIRST — brevity is what measured best, not neutrality.
        phrasings = [
            f"Instrumental music. {prompt}."[:180],
            "Instrumental piano music.",
            f"{prompt}. Instrumental, no vocals."[:240],
        ]
        last_err = None
        for ph in phrasings:
            try:
                return seed_audio.synthesize(ph[:2000], fmt="mp3", timeout=120)
            except Exception as e:
                last_err = e
                if not _re2.search(r"risk|reject|sensitive|audit", str(e), _re2.I):
                    raise           # a non-moderation error is real — stop retrying
        logger.warning("[Soundtrack] chunk %d dropped after moderation blocks: %s", idx, last_err)
        return None

    # SEQUENTIAL with spacing — a live A/B (2026-07-12) showed the content-risk audit
    # trips far more on parallel bursts (0-1/4 passed) than spaced sequential calls
    # (4/5 passed). So generate the phrase's chunks one at a time.
    bufs: list[bytes] = []
    for i in range(n):
        try:
            b = await asyncio.to_thread(_gen_chunk, i)
        except Exception as e:
            if not bufs:
                raise HTTPException(status_code=502, detail=f"Music synthesis failed: {e}")
            break               # already have material → stop and use it
        if b:
            bufs.append(b)
        await asyncio.sleep(1.0)   # anti-burst spacing
    if not bufs:
        raise HTTPException(status_code=502,
                            detail="Music synthesis blocked by the content filter — try a different description.")

    tmpdir = tempfile.mkdtemp(prefix="takeone_music_")
    try:
        seg_paths: list[str] = []
        for i, buf in enumerate(bufs):
            sp = os.path.join(tmpdir, f"seg_{i:02d}.mp3")
            with open(sp, "wb") as f:
                f.write(buf)
            seg_paths.append(sp)
        phrase = os.path.join(tmpdir, "phrase.mp3")
        if not _concat_audio_seamless(seg_paths, phrase):
            raise HTTPException(status_code=502, detail="music concat failed")
        # Loop the phrase to EXACTLY the film length + fade out (covers the film even
        # from a single surviving chunk); fall back to the raw phrase if ffmpeg fails.
        final = os.path.join(tmpdir, "music.mp3")
        src = final if _fit_music_to_film(phrase, final, target) else phrase
        with open(src, "rb") as f:
            data_b64 = _b64.b64encode(f.read()).decode()
        saved = await asyncio.to_thread(
            proj_storage.save_soundtrack, req.project_name,
            f"soundtrack_{int(_time.time())}.mp3", data_b64, req.project_path,
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    duration = 0.0
    try:
        duration = await asyncio.to_thread(_probe_audio_seconds, saved["path"]) or 0.0
    except Exception:
        pass
    return {"path": saved["path"], "name": saved.get("name", "soundtrack.mp3"),
            "duration": duration, "segments": len(bufs), "target": target}


class ShotExtendRequest(BaseModel):
    shot_id: str
    video_path: str                  # source clip on disk (or CDN URL)
    extra_seconds: float = 5         # continuation length (clamped to Seedance 4-15)
    note: str = ""                   # optional director note for what continues
    project_name: str = ""
    project_path: str = ""
    style: StyleConfig = StyleConfig()
    ratio: str = "16:9"
    resolution: str = "1080p"        # 4k recommended for faces/lip-sync (base 2.0 only)
    concat: bool = False             # True: join onto the source (one longer clip). False
                                     # (default): return the continuation ALONE — Final Cut
                                     # inserts it as a new clip right after the source.
    clip_id: str = ""                # id to store the continuation under (defaults to shot_id)
    reference_images: list[str] = [] # 0-9 refs (approved asset paths / data-URIs) to guide identity
    last_frame: str = ""             # the render's saved RAW last-frame PNG (disk path) — fallback
    last_frame_url: str = ""         # the render's ORIGINAL CDN last_frame_url. When still live
                                     # (~24h) this is passed to Seedance BY URL, verbatim — a
                                     # Seedance-derived last-frame is a trusted face source, and
                                     # downloading/re-encoding it nullifies that trust (§7).


@app.post("/api/shot/extend")
async def extend_shot(req: ShotExtendRequest):
    """Animate a CONTINUATION of a rendered shot from its exact last frame (Seedance i2v,
    first_frame = last frame). With concat=True it is joined onto the source (one longer
    clip); with concat=False (default) the continuation is returned alone so Final Cut can
    drop it in as a new clip right after the source. Non-destructive."""
    api = get_byteplus()
    import base64 as _b64, tempfile, requests as _req
    dur = max(4, min(15, int(req.extra_seconds or 5)))
    await bus.publish("seedance", "active", f"Extending {req.shot_id} (+{dur}s)…", 5)

    # Use the ORIGINAL trusted last-frame UNALTERED. Re-encoding a frame (the ffmpeg
    # fallback below) is "third-party compression" which NULLIFIES the biometric trust
    # (video-seedance §7) → the InputImageSensitiveContentDetected.PrivacyInformation
    # reject. Verified live: the raw last-frame passes; an ffmpeg extraction does not.
    # Priority: the raw .lastframe.png saved next to the clip at render time (most robust —
    # no dependency on frontend state) → an explicit last_frame url/path → ffmpeg extraction.
    first_frame_uri = ""
    frame_source = "none"
    pass_first_frame_url = False
    import glob as _glob
    # 0. TRUSTED CDN PASSTHROUGH (best, when available): hand Seedance the render's ORIGINAL
    #    last_frame_url BY URL, verbatim. It is a Seedance-derived last-frame (a trusted face
    #    source, §7); every branch below downloads + base64's a frame, which is third-party
    #    compression that NULLIFIES that trust → the PrivacyInformation reject the user hit.
    #    Valid ~24h; for older clips the CDN url is dead, so we fall through to the raw PNG.
    if (req.last_frame_url or "").startswith(("http://", "https://")):
        # LIVENESS GATE: an EXPIRED CDN url (>24h) is still a well-formed https string. Committing
        # it here would set first_frame_uri and BLOCK every raw-PNG fallback below (all gated on
        # `not first_frame_uri`), then submit a dead first_frame → 502. HEAD-probe first; commit
        # only a LIVE url. HEAD doesn't download/re-encode, so the biometric trust is preserved.
        try:
            import requests as _rq
            # GET a 2-byte range, NOT HEAD: BytePlus signed CDN urls are signed for GET and 403 a
            # HEAD (which false-rejected LIVE urls and skipped the passthrough). stream=True + a tiny
            # Range means we read no body — just the status — and never re-download/re-encode.
            _probe = await asyncio.to_thread(
                _rq.get, req.last_frame_url, timeout=5, stream=True,
                allow_redirects=True, headers={"Range": "bytes=0-1"})
            _live = _probe.status_code < 400
            _probe.close()
            if _live:
                first_frame_uri = req.last_frame_url
                frame_source = "cdn_url"
                pass_first_frame_url = True
            else:
                logger.info("[Extend] last_frame_url not live (HTTP %s) — using local raw-PNG fallback", _probe.status_code)
        except Exception as e:
            logger.warning("[Extend] last_frame_url liveness probe failed (%s) — using local fallback", e)
    # 0a. MOST RELIABLE local: the raw last-frame lives in the video's OWN directory. Derive it
    #     straight from video_path (a disk path) — no project_name/shot_id guessing, immune
    #     to a wrong project_path or a mismatched id. This is what kept failing (frame=
    #     extracted): the by-id lookup missed the folder, so we fell to a re-encode.
    # GATED on `not first_frame_uri`: a LIVE CDN url committed by Priority-0 (the trusted
    # passthrough) must WIN — a local .lastframe.png is a downloaded/base64'd copy whose trust is
    # nullified (video-seedance §7), so it is only a fallback, never an override. (Without this
    # gate 0a shadowed Priority-0 for every fresh clip and the biometric filter kept firing.)
    if not first_frame_uri:
        try:
            _src = req.video_path
            # Accept a served URL too (…/api/asset/serve?path=<disk path>) → the real disk path.
            if _src.startswith("http") and "path=" in _src:
                from urllib.parse import urlparse, parse_qs
                _src = (parse_qs(urlparse(_src).query).get("path") or [""])[0]
            _vdir = os.path.dirname(_src)
            if _vdir and os.path.isdir(_vdir):
                cand = sorted(_glob.glob(os.path.join(_vdir, "video_v*.lastframe.png")))
                if cand:
                    first_frame_uri = await asyncio.to_thread(_url_to_data_uri, cand[-1])
                    frame_source = f"video_dir:{os.path.basename(cand[-1])}"
        except Exception as e:
            logger.warning("[Extend] video-dir last-frame lookup failed: %s", e)
    # 0b. LATEST raw last-frame in the shot's folder, by shot_id — try the resolved root AND
    #     the default project root (a doubled/wrong project_path would otherwise miss it).
    if not first_frame_uri:
        roots: list = []
        for getter in (lambda: proj_storage._resolve_root(req.project_name, req.project_path),
                       lambda: proj_storage.project_root(req.project_name)):
            try:
                r = getter()
                if r and r not in roots:
                    roots.append(r)
            except Exception:
                pass
        for root in roots:
            try:
                cand = sorted(_glob.glob(str(root / "Shots" / proj_storage._safe(req.shot_id) / "video_v*.lastframe.png")))
                if cand:
                    first_frame_uri = await asyncio.to_thread(_url_to_data_uri, cand[-1])
                    frame_source = f"shot_folder:{os.path.basename(cand[-1])}"
                    break
            except Exception as e:
                logger.warning("[Extend] shot-folder last-frame lookup failed (%s): %s", root, e)
    # 1. Sibling of the passed video_path.
    if not first_frame_uri:
        try:
            sib = os.path.splitext(req.video_path)[0] + ".lastframe.png"
            if os.path.isfile(sib):
                first_frame_uri = await asyncio.to_thread(_url_to_data_uri, sib)
                frame_source = "raw_sibling"
        except Exception:
            pass
    if not first_frame_uri and req.last_frame:
        try:
            first_frame_uri = await asyncio.to_thread(_url_to_data_uri, req.last_frame)  # raw download+base64
            frame_source = "trusted_last_frame"
        except Exception as e:
            logger.warning("[Extend] trusted last_frame unusable (%s) — falling back to extraction", e)
    if not first_frame_uri:
        last_png = await asyncio.to_thread(_extract_last_frame, req.video_path)
        if not last_png:
            raise HTTPException(status_code=502, detail="could not read the shot's last frame")
        try:
            with open(last_png, "rb") as f:
                first_frame_uri = "data:image/png;base64," + _b64.b64encode(f.read()).decode()
            frame_source = "extracted"   # re-encoded → may hit the biometric filter on real faces
        finally:
            try: os.unlink(last_png)
            except OSError: pass
    logger.info("[Extend] %s: first_frame source=%s", req.shot_id, frame_source)

    # Continuation prompt — seamless carry-on of the same shot. NOTE: Extend is i2v (first_frame
    # = the trusted last-frame), and i2v DROPS all reference_image media (create_video_task) — the
    # last-frame IS the identity anchor, so reference images are neither needed nor passed (5G: the
    # UI ref picker was removed; it was a silent no-op that made the prompt lie about "references").
    suffix = (req.style.prompt_suffix or "").strip().rstrip(".")
    note = (req.note or "").strip().rstrip(".")
    prompt = ("Continuous shot that seamlessly continues from this exact frame — the same subject, "
              "environment, wardrobe, lighting, camera framing and motion carry on naturally, with no "
              "cut, no reset and no scene change. " + (f"{note}. " if note else "")
              + (f"{suffix}. " if suffix else "")
              + "HD, rich details, natural colors. Preserve composition and colors. No text, no subtitles, no watermark.")

    try:
        task = await asyncio.to_thread(
            api.create_video_task, first_frame_uri, prompt, dur, None, None, None, None, True,
            req.ratio, req.resolution, first_frame_pass_url=pass_first_frame_url,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"continuation submit failed [frame={frame_source}]: {e}")
    tid = (task or {}).get("task_id")
    if not tid:
        if frame_source == "cdn_url":
            # A trusted last-frame WAS found (the CDN url); the submit itself failed — almost always
            # the ~24h CDN url expired between load and submit. Re-rendering refreshes it.
            hint = " — the CDN last-frame url likely expired; re-render the shot to refresh it"
        elif frame_source.startswith("shot_folder"):
            hint = ""
        else:
            # frame=extracted / a local PNG: no LIVE trusted last-frame. A downloaded/re-encoded
            # frame is untrusted (§7) and hits the biometric filter, so the real fix is a fresh
            # render whose CDN last-frame is still valid — extend it within ~24h.
            hint = (" — this clip has no live trusted last-frame; re-render the shot and Extend it "
                    "within ~24h while its CDN last-frame is valid (or use the trusted Asset Library)")
        raise HTTPException(status_code=502,
                            detail=f"continuation not submitted [frame={frame_source}]{hint}: {(task or {}).get('error')}")

    # Same B2 protection /api/shot/edit already has, and for the same reason: this
    # endpoint polls IN-REQUEST for minutes, so a backend restart (uvicorn --reload
    # fires on every code edit) or a dropped connection orphaned the render and the
    # paid clip was LOST with nothing on disk. Extend was the one submit path still
    # missing the record, so the reconciler could never rescue it. Non-fatal.
    # MUST be the same expression the save path uses below, or a reconciler rescue
    # would write the clip into a folder nothing reads.
    # record_durable + to_thread for the same two reasons as the main submit path: the
    # registry lock waits on the calling thread (it stalls the whole server) and it can
    # raise, and by this line the continuation is accepted and BILLING — "non-fatal"
    # meant the row was simply skipped, which orphans a paid clip. record_durable()
    # retries, then falls back to the append-only ledger the reconciler drains.
    try:
        _rec = await asyncio.to_thread(
            render_registry.record_durable,
            tid, status="running", kind="extend",
            project_name=req.project_name, project_path=req.project_path,
            shot_id=(req.clip_id or req.shot_id), resolution=req.resolution,
            prompt=prompt[:500],
        )
        if _rec.path:
            logger.error("[Extend] task %s IS BILLING but the registry was unwritable; "
                         "recorded in %s instead", tid, _rec.path)
        elif _rec.nowhere:
            # Not the same as success, which is what "" used to mean here too.
            logger.error("[Extend] task %s IS BILLING and is recorded NOWHERE (%s) — no "
                         "sweep can finish it; reconcile by hand", tid, _rec.error)
            await bus.publish(
                "seedance", "error",
                f"{req.shot_id}: continuation {tid} was accepted and IS BILLING but "
                f"could NOT be recorded anywhere ({_rec.error}). Reconcile by hand.")
    except Exception as e:
        logger.warning("[Extend] registry record failed (non-fatal): %s", e)

    # Poll server-side until the continuation finishes (renders take minutes).
    video_url = ""
    last_frame_url = ""
    for i in range(120):
        r = await asyncio.to_thread(api.poll_video_task, tid, 30)
        st = str(r.get("status") or "")
        if st in ("succeeded", "completed"):
            video_url = r.get("video_url") or ""
            last_frame_url = r.get("last_frame_url") or ""   # this continuation's OWN trusted last-frame
            break
        if st in ("failed", "error"):
            # Close it out, else the reconciler keeps polling a task that will never finish.
            try:
                await asyncio.to_thread(render_registry.mark_failed, tid,
                                        str(r.get("error") or "failed"))
            except Exception:
                pass
            raise HTTPException(status_code=502, detail=f"continuation render failed: {r.get('error')}")
        await bus.publish("seedance", "active", f"Extending {req.shot_id}…", min(90, 10 + i * 2))
        await asyncio.sleep(5)
    if not video_url:
        raise HTTPException(status_code=504, detail="continuation render timed out")

    tmpdir = tempfile.mkdtemp(prefix="takeone_extend_")
    try:
        cont = os.path.join(tmpdir, "cont.mp4")
        with open(cont, "wb") as f:
            f.write((await asyncio.to_thread(_req.get, video_url, timeout=180)).content)
        store_id = (req.clip_id or req.shot_id)
        if req.concat:
            # One longer clip: join the continuation onto the source.
            src = req.video_path
            if not os.path.isfile(src):
                src_dl = os.path.join(tmpdir, "src.mp4")
                with open(src_dl, "wb") as f:
                    f.write((await asyncio.to_thread(_req.get, src, timeout=180)).content)
                src = src_dl
            out = os.path.join(tmpdir, "extended.mp4")
            if not await asyncio.to_thread(_concat_videos, [src, cont], out):
                raise HTTPException(status_code=502, detail="extend concat failed")
        else:
            out = cont   # continuation alone — Final Cut inserts it after the source
        with open(out, "rb") as f:
            saved = await asyncio.to_thread(
                proj_storage.save_shot_video, req.project_name, store_id, f.read(),
                req.project_path, {"kind": "extend", "added_seconds": dur, "source": req.shot_id},
            )
        # Close the registry entry so the reconciler stops sweeping this task and can
        # never re-download it into a duplicate version (non-fatal). Mirrors /api/shot/edit.
        try:
            await asyncio.to_thread(
                render_registry.mark_completed,
                tid, video_local_path=saved.get("path", ""), video_url=video_url,
                resolution=req.resolution, last_frame_url=last_frame_url,
            )
        except Exception as e:
            logger.warning("[Extend] registry complete failed (non-fatal): %s", e)
        # Persist THIS continuation's OWN Seedance last-frame (raw, trust-safe) so extend-of-extend
        # continues from the right frame, not the source clip's (5I).
        lf_path = await asyncio.to_thread(_persist_raw_last_frame, saved["path"], last_frame_url)
        total = 0.0
        try:
            total = await asyncio.to_thread(_probe_audio_seconds, saved["path"]) or 0.0
        except Exception:
            pass
        # Persist a first-frame thumbnail next to the clip so the timeline block shows a
        # still instead of a black box (served like any versioned asset).
        thumb_path = ""
        try:
            _tp = os.path.splitext(saved["path"])[0] + ".thumb.jpg"
            _r = await asyncio.to_thread(
                subprocess.run,
                [FFMPEG_BIN, "-y", "-ss", "0.1", "-i", saved["path"], "-frames:v", "1", _tp],
                capture_output=True, timeout=60,
            )
            if _r.returncode == 0 and os.path.isfile(_tp):
                thumb_path = _tp
        except Exception as e:
            logger.warning("[Extend] thumbnail failed (non-fatal): %s", e)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    await bus.publish("seedance", "completed", f"{req.shot_id} extended (+{dur}s)", 100)
    return {"video_path": saved["path"], "duration": total, "added_seconds": dur, "thumbnail_path": thumb_path,
            "last_frame_url": last_frame_url, "last_frame_local_path": lf_path}


class ExtendRecoverRequest(BaseModel):
    project_name: str = ""
    project_path: str = ""
    clip_id: str = ""                # the continuation's store id (e.g. "SHOT_029-ext")


@app.post("/api/shot/extend-recover")
async def extend_recover(req: ExtendRecoverRequest):
    """Recover a COMPLETED take whose frontend handler was orphaned — an Extend continuation
    or a v2v Edit (both save under Shots/<clip_id>/, so both are found here). The usual cause
    is the browser giving up before the render did: a Seedance render routinely outlives the
    client's 10-minute ceiling ("timeout of 600000ms exceeded") while the server polls on to
    its own ~70-minute limit and saves the take. A tab reload or navigation does the same.
    The render already saved
    video_vNNN.mp4 under Shots/<clip_id>/ (save_shot_video), so return its LATEST take and
    let the stuck 'animating' placeholder heal WITHOUT paying for a re-render. Returns
    {video_path: ""} when nothing exists yet (render truly failed / still running) so the
    UI can drop the dead placeholder. Read-only; never renders."""
    import glob as _glob
    clip_id = proj_storage._safe(req.clip_id)
    if not clip_id:
        raise HTTPException(status_code=400, detail="clip_id is required")
    # Mirror save_shot_video's folder (root/Shots/<clip_id>), trying BOTH resolvers — the
    # same project_path/project_root mismatch that bit the extend frame lookup applies here.
    roots: list[str] = []
    try:
        roots.append(str(proj_storage._resolve_root(req.project_name, req.project_path)))
    except Exception:
        pass
    try:
        roots.append(str(proj_storage.project_root(req.project_name)))
    except Exception:
        pass
    if req.project_path:
        roots.append(req.project_path)
    vids: list[str] = []
    for root in roots:
        found = sorted(_glob.glob(os.path.join(root, "Shots", clip_id, "video_v*.mp4")))
        if found:
            vids = found
            break
    if not vids:
        return {"video_path": "", "duration": 0.0, "added_seconds": 0, "thumbnail_path": ""}
    latest = vids[-1]
    added = 0
    try:  # the +Ns is recorded in the meta sidecar written by save_shot_video (non-fatal)
        with open(os.path.splitext(latest)[0] + ".meta.json") as f:
            added = int(json.load(f).get("added_seconds", 0) or 0)
    except Exception:
        pass
    total = 0.0
    try:
        total = await asyncio.to_thread(_probe_audio_seconds, latest) or 0.0
    except Exception:
        pass
    thumb = os.path.splitext(latest)[0] + ".thumb.jpg"
    # The take's own trusted last frame, when the render saved one (_persist_raw_last_frame).
    # Without it a recovered take cannot be Extended later: the byte-exact frame is what
    # keeps Seedance's biometric trust, and re-extracting one nullifies it.
    lf = os.path.splitext(latest)[0] + ".lastframe.png"
    return {"video_path": latest, "duration": total, "added_seconds": added,
            "thumbnail_path": thumb if os.path.isfile(thumb) else "",
            "last_frame_local_path": lf if os.path.isfile(lf) else ""}


class ShotEditRequest(BaseModel):
    shot_id: str
    video_path: str                  # source clip on disk (a byte-identical Seedance output)
    video_url: str = ""              # the render's ORIGINAL CDN video_url (trusted if < 24h)
    note: str = ""                   # the transformation: what to ADD/CHANGE (e.g. "add three
                                     # ships on the horizon", "an explosion in the background")
    duration: float                  # seconds of the source clip. REQUIRED, and > 0 (checked in the
                                     # endpoint): this renders NEW paid footage, and a missing length
                                     # used to become 5s of Seedance nobody asked for. Clamped into
                                     # Seedance's 4-15s window at the endpoint.
    project_name: str = ""
    project_path: str = ""
    style: StyleConfig = StyleConfig()
    ratio: str = "16:9"
    resolution: str = "1080p"
    clip_id: str = ""                # store id for the edited take (defaults to <shot_id>-edit)
    reference_images: list[str] = [] # 0-9 optional identity/texture refs (t2v mode allows them)
    generate_audio: bool = True                   # SFX/ambient for the edited take (e.g. the
                                                  # explosion you asked for). False = a retry path
                                                  # if the audio content-filter false-positives.


@app.post("/api/shot/edit")
async def edit_shot(req: ShotEditRequest):
    """Video-to-video VFX EDIT of a rendered shot (add ships, an explosion, relight…). The
    source clip is a Seedance Trusted Output, so it clears the biometric filter ONLY if its
    bytes reach BytePlus UNALTERED (video-seedance §7): we send it as a `reference_video`
    (look + motion) in REFERENCE mode — no first_frame, since i2v excludes ALL reference media
    (verified live 2026-06-10) — and NEVER a self-extracted frame (a re-encoded real face →
    PrivacyInformation reject). The source URL is the fresh CDN video_url when still valid,
    else a byte-identical R2 re-host so BytePlus's servers can fetch it (NO transcode — that
    nullifies trust). Non-destructive: returns a NEW take that Final Cut inserts/replaces."""
    api = get_byteplus()
    import tempfile, requests as _req
    # A paid render must not invent its own length. `int(req.duration or 0) or 5` stood here,
    # so a request that omitted the field — an older bundle, a replay, any caller but the two
    # in-app ones — silently bought 5s of Seedance footage that matches nothing on the
    # timeline. Both frontend callers MEASURE the source clip (renderLengthFor /
    # paidClipSeconds) and refuse when it will not probe, so there is nothing legitimate left
    # to default for. 422, the same answer /api/video/generate gives a length it cannot honour.
    if req.duration <= 0:
        raise HTTPException(
            status_code=422,
            detail=("duration is required and must be > 0 — an edit renders a new paid clip and "
                    "its length is the source clip's, measured. Probe the source and send it."))
    dur = max(4, min(15, int(req.duration)))
    if abs(dur - req.duration) >= 1:
        logger.warning("[Edit] %s: %.2fs source → %ds render (Seedance's 4-15s window)",
                       req.shot_id, req.duration, dur)
    await bus.publish("seedance", "active", f"Editing {req.shot_id}…", 5)

    # ── A BytePlus-fetchable, TRUST-PRESERVING url for the source clip ─────────────
    # Trust is tied to the exact bytes being unaltered (no transcode). A fresh CDN url is
    # guaranteed trusted; else re-host the byte-identical local MP4 to R2 (studio-temp),
    # which BytePlus's servers can fetch. Cleaned up in the finally.
    src_url = ""
    r2_keys: list[str] = []
    if os.path.isfile(req.video_path):
        # The proven v2v path: SEND the source clip byte-identically (no transcode → biometric
        # trust kept), re-hosted to R2 so BytePlus's servers can fetch it. Always available —
        # the local copy never expires, unlike the ~24h CDN url.
        import r2_storage
        if r2_storage.is_configured():
            with open(req.video_path, "rb") as f:
                raw = f.read()           # byte-identical — NO re-encode (re-encoding nullifies trust)
            _key, src_url = await asyncio.to_thread(r2_storage.upload_temp, raw, "mp4", "video/mp4")
            r2_keys.append(_key)
        elif req.video_url.startswith(("http://", "https://")):
            src_url = req.video_url       # can't re-host → the original CDN asset (trusted if < 24h)
        else:
            raise HTTPException(status_code=503, detail=(
                "R2 not configured and no live CDN url — set R2_* in .env to edit a stored clip."))
    elif req.video_url.startswith(("http://", "https://")):
        src_url = req.video_url           # no local copy → the original CDN asset (trusted if < 24h)
    else:
        raise HTTPException(status_code=400, detail=f"source clip not found: {req.video_path}")

    try:
        # ── Transform prompt via the central assembler (never a raw string here) ──
        from byteplus_generative import assemble_video_prompt
        note = (req.note or "").strip().rstrip(".")
        photographic = _is_photographic(req.style.label, req.style.prompt_suffix)

        # Reference images (added/texture elements) built FIRST so the prompt can TAG them by
        # their per-type index — Seedance's multimodal convention: the source plate is Video 1,
        # references are Image 1..N (position within the content body; asset-library ref FAQ #3).
        ref_dicts = []
        for r in (req.reference_images or [])[:9]:
            try:
                ref_dicts.append({"url": _url_to_data_uri(r), "role": "reference_image"})
            except Exception:
                pass
        img_tags = ""
        if ref_dicts:
            names = ", ".join(f"Image {i + 1}" for i in range(len(ref_dicts)))
            img_tags = (f" Use {names} as the reference for the appearance/texture of any added or "
                        "changed elements.")
        action = (
            "Video 1 is the source clip. Preserve everything in Video 1 — its subject, faces, wardrobe, "
            "performance, framing, camera motion and pacing — EXACTLY; re-roll nothing. Change ONLY this: "
            + (note or "enhance the plate") + "." + img_tags
            + " Blend the change into the same lighting and grade so it reads as one continuous shot. "
            "NON-IP — generic designs, not any brand or character")
        pos, neg = assemble_video_prompt(
            shot_action=action,
            style_suffix=req.style.prompt_suffix,
            neg_base=req.style.negative_prompt,
            photographic=photographic,
        )

        # Reference mode: image_url="" (no first_frame) so the reference_video is NOT dropped.
        task = await asyncio.to_thread(
            api.create_video_task, "", pos, dur, (ref_dicts or None), [src_url], None, neg,
            req.generate_audio, req.ratio, req.resolution,
        )
        tid = (task or {}).get("task_id")
        if not tid:
            raise HTTPException(status_code=502, detail=f"edit not submitted: {(task or {}).get('error')}")

        # B2 for edits: this endpoint polls IN-REQUEST for minutes, so a backend restart
        # (uvicorn --reload) or a dropped connection orphaned the render and the paid clip
        # was LOST — the frontend's stranded-placeholder recovery then found nothing on disk
        # and silently restored the original ("Edit did nothing", observed 2026-07-22, task
        # cgt-20260722153940-5psbn). Recording the task lets the background reconciler finish
        # + save it after a restart, under the SAME id recover-extend looks for. Non-fatal.
        store_id = (req.clip_id or f"{req.shot_id}-edit")
        # record_durable + to_thread, same as /api/shot/extend and the main submit path:
        # the lock waits on the calling thread and can raise, and this edit is already
        # accepted and billing, so skipping the row orphans a paid clip.
        try:
            _rec = await asyncio.to_thread(
                render_registry.record_durable,
                tid, status="running", kind="edit",
                project_name=req.project_name, project_path=req.project_path,
                shot_id=store_id, resolution=req.resolution, prompt=pos[:500],
            )
            if _rec.path:
                logger.error("[Edit] task %s IS BILLING but the registry was unwritable; "
                             "recorded in %s instead", tid, _rec.path)
            elif _rec.nowhere:
                # Not the same as success — see /api/shot/extend.
                logger.error("[Edit] task %s IS BILLING and is recorded NOWHERE (%s) — no "
                             "sweep can finish it; reconcile by hand", tid, _rec.error)
                await bus.publish(
                    "seedance", "error",
                    f"{req.shot_id}: edit {tid} was accepted and IS BILLING but could "
                    f"NOT be recorded anywhere ({_rec.error}). Reconcile by hand.")
        except Exception as e:
            logger.warning("[Edit] registry record failed (non-fatal): %s", e)

        video_url = ""
        last_frame_url = ""
        for i in range(120):
            r = await asyncio.to_thread(api.poll_video_task, tid, 30)
            st = str(r.get("status") or "")
            if st in ("succeeded", "completed"):
                video_url = r.get("video_url") or ""
                last_frame_url = r.get("last_frame_url") or ""   # the EDITED clip's own trusted last-frame
                break
            if st in ("failed", "error"):
                try:
                    await asyncio.to_thread(render_registry.mark_failed, tid,
                                            str(r.get("error") or "failed"))
                except Exception:
                    pass
                raise HTTPException(status_code=502, detail=f"edit render failed: {r.get('error')}")
            await bus.publish("seedance", "active", f"Editing {req.shot_id}…", min(90, 10 + i * 2))
            await asyncio.sleep(5)
        if not video_url:
            raise HTTPException(status_code=504, detail="edit render timed out")

        tmpdir = tempfile.mkdtemp(prefix="takeone_edit_")
        try:
            out = os.path.join(tmpdir, "edited.mp4")
            with open(out, "wb") as f:
                f.write((await asyncio.to_thread(_req.get, video_url, timeout=180)).content)
            with open(out, "rb") as f:
                saved = await asyncio.to_thread(
                    proj_storage.save_shot_video, req.project_name, store_id, f.read(),
                    req.project_path, {"kind": "edit", "change": note, "source": req.shot_id},
                )
            # Close the registry entry so the reconciler stops sweeping this task (non-fatal).
            try:
                await asyncio.to_thread(
                    render_registry.mark_completed,
                    tid, video_local_path=saved.get("path", ""), video_url=video_url,
                    resolution=req.resolution, last_frame_url=last_frame_url,
                )
            except Exception as e:
                logger.warning("[Edit] registry complete failed (non-fatal): %s", e)
            # Persist the EDITED clip's OWN Seedance last-frame (raw, trust-safe) so a later Extend
            # continues from the edited frame, not the source clip's (5I).
            lf_path = await asyncio.to_thread(_persist_raw_last_frame, saved["path"], last_frame_url)
            total = 0.0
            try:
                total = await asyncio.to_thread(_probe_audio_seconds, saved["path"]) or 0.0
            except Exception:
                pass
            thumb_path = ""
            try:
                _tp = os.path.splitext(saved["path"])[0] + ".thumb.jpg"
                _r = await asyncio.to_thread(
                    subprocess.run,
                    [FFMPEG_BIN, "-y", "-ss", "0.1", "-i", saved["path"], "-frames:v", "1", _tp],
                    capture_output=True, timeout=60,
                )
                if _r.returncode == 0 and os.path.isfile(_tp):
                    thumb_path = _tp
            except Exception as e:
                logger.warning("[Edit] thumbnail failed (non-fatal): %s", e)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

        await bus.publish("seedance", "completed", f"{req.shot_id} edited", 100)
        return {"video_path": saved["path"], "duration": total, "thumbnail_path": thumb_path,
                "last_frame_url": last_frame_url, "last_frame_local_path": lf_path}
    finally:
        if r2_keys:   # best-effort cleanup of the temp re-host (never fails the result)
            try:
                import r2_storage
                await asyncio.to_thread(r2_storage.delete, r2_keys)
            except Exception:
                pass


@app.post("/api/edit/save-edl")
async def save_edl(req: SaveEDLRequest):
    try:
        root = proj_storage._resolve_root(req.project_name, req.project_path)
        edits_dir = root / "Edits"
        edits_dir.mkdir(parents=True, exist_ok=True)
        import time as _time
        ts = int(_time.time())
        edl_path = edits_dir / f"edit_{ts}.edl.json"
        edl_path.write_text(req.edl.model_dump_json(indent=2))
        return {"path": str(edl_path), "saved_at": ts}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/edit/render")
async def render_edit(req: RenderRequest, bg: BackgroundTasks):
    """
    P9/P10: Render EDL to a video file with ffmpeg.
    Downloads source clips, applies trim/concat/xfade, writes to Edits/.
    """
    import subprocess, tempfile, shutil, time as _time, requests as _req, base64 as _b64

    RESOLUTION_MAP = {
        "720p":  (1280, 720),
        "1080p": (1920, 1080),
        "4k":    (3840, 2160),
    }
    w, h = RESOLUTION_MAP.get(req.resolution, (1920, 1080))
    # Force a uniform framerate on every segment — sources with mixed fps break
    # concat -c copy (timestamps drift → clips shift / wrong duration).
    target_fps = req.edl.fps if (req.edl.fps and req.edl.fps > 0) else 24
    # 5K: master/bus gain — multiplied into every clip's per-clip volume below so
    # the whole mix scales as one. Applied per-input (linear gain distributes over
    # the amix sum), matching the live player's master fader.
    master = max(0.0, req.master_volume if req.master_volume is not None else 1.0)
    ext = {"mp4": "mp4", "mov": "mov", "webm": "webm"}.get(req.output_format, "mp4")
    # 4K matches Seedance 2.0's native output: HEVC 10-bit (yuv420p10le). Lower
    # tiers stay H.264 8-bit for universal playback.
    is_4k = req.resolution == "4k"
    if is_4k:
        vcodec, pix_fmt = "libx265", "yuv420p10le"
    else:
        vcodec = {"mp4": "libx264", "mov": "prores", "webm": "libvpx-vp9"}.get(req.output_format, "libx264")
        pix_fmt = None

    # How much film is being processed — every ffmpeg timeout below scales off this.
    # 4k re-encodes are far slower than 480p, so the factor doubles for them.
    #
    # Best effort HERE, exact later: a clip that plays in full (outPoint=None) and lives
    # behind a CDN url has no duration until it is downloaded, so it counts as
    # _NOMINAL_CLIP_SECS for now and `_total` is recomputed from the real files the moment
    # they land in `tmp` (below) — before the first timeout that uses it. Local sources,
    # which is what a saved project holds, are exact from this line on.
    _NOMINAL_CLIP_SECS = 5.0
    _clip_secs: list[float | None] = [_edl_clip_seconds(c) for c in req.edl.clips]
    _total = sum(s if s is not None else _NOMINAL_CLIP_SECS for s in _clip_secs) or 5.0
    _hd = 2.0 if is_4k else 1.0
    logger.info("[Render] %d clip(s), %.0fs of programme (%d unprobed), %s",
                len(req.edl.clips), _total, sum(1 for s in _clip_secs if s is None), req.resolution)

    try:
        root = proj_storage._resolve_root(req.project_name, req.project_path)
        out_dir = root / "Exports"
        out_dir.mkdir(parents=True, exist_ok=True)
        ts = int(_time.time())
        out_path = out_dir / f"render_{ts}_{req.resolution}.{ext}"

        await bus.publish("seedance", "active", "Downloading source clips…", 10)

        tmp = tempfile.mkdtemp(prefix="takeone_render_")
        try:
            # Materialise all clip videos to temp files.
            # Local disk paths (saved renders) are copied; URLs are downloaded.
            clip_paths: list[str] = []
            # A clip that will not load is a MISSING SHOT, and the export must say so.
            # It used to append "" and carry on, and the endpoint still returned 200 —
            # so the finished film was quietly short a shot, Stage 6 marked it approved,
            # and over a 500-shot episode nobody could see which one was gone. A render
            # is cheap to re-run and impossible to audit by eye; failing loudly is the
            # only version of this that is safe.
            missing: list[str] = []
            for i, clip in enumerate(req.edl.clips):
                if not clip.videoUrl:
                    missing.append(f"{clip.shotId or f'clip {i}'} (no source)")
                    clip_paths.append("")
                    continue
                try:
                    cp = f"{tmp}/clip_{i:03d}.mp4"
                    if clip.videoUrl.startswith("/") or clip.videoUrl.startswith("file://"):
                        src = clip.videoUrl[7:] if clip.videoUrl.startswith("file://") else clip.videoUrl
                        shutil.copyfile(src, cp)
                    else:
                        resp = await asyncio.to_thread(_req.get, clip.videoUrl,
                                                       timeout=_ff_timeout(0, 0, 180))
                        resp.raise_for_status()
                        with open(cp, "wb") as f:
                            f.write(resp.content)
                    if not os.path.getsize(cp):
                        raise ValueError("source is empty")
                    clip_paths.append(cp)
                except Exception as e:
                    logger.warning("[Render] clip %d (%s) load failed: %s", i, clip.shotId, e)
                    missing.append(f"{clip.shotId or f'clip {i}'}: {e}")
                    clip_paths.append("")

            if missing:
                await bus.publish("seedance", "error",
                                  f"Export aborted — {len(missing)} clip(s) missing")
                raise HTTPException(
                    status_code=422,
                    detail=(f"{len(missing)} of {len(req.edl.clips)} clips could not be loaded, "
                            f"so the export would be missing shots: {'; '.join(missing[:6])}"
                            + (f" (+{len(missing) - 6} more)" if len(missing) > 6 else "")
                            + ". Re-render those shots, or remove them from the timeline."),
                )
            if not any(clip_paths):
                raise HTTPException(status_code=400, detail="No valid source clips to render")

            # Every source is now on local disk, so the untrimmed ones can finally be
            # measured. Do it HERE, before the first timeout that uses `_total` and — the
            # part that matters — before the `else:` branch below deletes `tmp`: the guard
            # at the end of this function needs these numbers and the files are gone by then.
            _clip_secs = [_edl_clip_seconds(c, clip_paths[i])
                          for i, c in enumerate(req.edl.clips)]
            _total = sum(s if s is not None else _NOMINAL_CLIP_SECS for s in _clip_secs) or 5.0
            logger.info("[Render] measured %.1fs of programme across %d clip(s) (%d unprobeable)",
                        _total, len(_clip_secs), sum(1 for s in _clip_secs if s is None))

            await bus.publish("seedance", "active", "Building ffmpeg filter graph…", 30)

            # Build ffmpeg command
            # Simple concat without transitions first, then handle xfade
            has_transitions = any(c.transitionIn for c in req.edl.clips[1:] if c.transitionIn)

            input_args = []
            filter_parts = []
            valid_clips = [(i, p, req.edl.clips[i]) for i, p in enumerate(clip_paths) if p]

            if not has_transitions:
                # Simple concat approach
                list_file = f"{tmp}/concat.txt"
                with open(list_file, "w") as f:
                    for _, path, clip in valid_clips:
                        in_pt = clip.inPoint or 0.0
                        out_pt = clip.outPoint
                        # Write segment file using ffmpeg trim. KEEP AUDIO: real
                        # track when present, else a silent stereo track so every
                        # segment has matching streams for concat -c copy.
                        seg_path = f"{tmp}/seg_{_}.mp4"
                        has_aud = _has_audio(path)
                        trim_args = [FFMPEG_BIN, "-y", "-i", path]
                        if not has_aud:
                            trim_args += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
                        trim_args += ["-ss", str(in_pt)]
                        if out_pt:
                            trim_args += ["-to", str(out_pt)]
                        # setpts resets to 0 so the fade in/out start times line up.
                        fi = max(0.0, clip.fadeIn or 0.0)
                        fo = max(0.0, clip.fadeOut or 0.0)
                        # This segment's MEASURED length, in/out points already applied
                        # (_clip_secs[_] is this clip's entry). The fabricated 5.0 that used
                        # to stand in for an unprobeable clip was not cosmetic: fade=t=out
                        # HOLDS black after st, so a 6.0 s shot with a 1.0 s fade-out faded
                        # from 4.0 s and sat at mean luma 0 for its last 1.0 s (measured).
                        # Unknown → drop the out-fade and say so: a fade placed at a guessed
                        # time destroys picture that is otherwise fine.
                        seg_dur = _clip_secs[_] or 0.0
                        if fo > 0.01 and seg_dur <= 0:
                            logger.warning("[Render] %s has no measurable duration — its "
                                           "%.2fs fade-out is NOT applied", os.path.basename(path), fo)
                            fo = 0.0
                        vf = (f"setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease,"
                              f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={target_fps},setsar=1")
                        af = "asetpts=PTS-STARTPTS"
                        vol = max(0.0, (clip.volume if clip.volume is not None else 1.0) * master)
                        if abs(vol - 1.0) > 0.001:
                            af += f",volume={vol}"
                        if fi > 0.01:
                            vf += f",fade=t=in:st=0:d={fi:.3f}"
                            af += f",afade=t=in:st=0:d={fi:.3f}"
                        if fo > 0.01:
                            vf += f",fade=t=out:st={max(0, seg_dur - fo):.3f}:d={fo:.3f}"
                            af += f",afade=t=out:curve=qsin:st={max(0, seg_dur - fo):.3f}:d={fo:.3f}"
                        trim_args += [
                            "-vf", vf, "-af", af,
                            "-map", "0:v:0",
                            "-map", "1:a:0" if not has_aud else "0:a:0?",
                            "-r", str(target_fps),
                            "-c:v", vcodec,
                        ]
                        # Conditional codec flags — appending None then filtering it
                        # orphans the flag (e.g. "-pix_fmt" with no value) and breaks
                        # non-4K exports, so add each flag only when it has a value.
                        if pix_fmt:
                            trim_args += ["-pix_fmt", pix_fmt]   # 10-bit HEVC for 4K
                        if vcodec == "libx265":
                            trim_args += ["-tag:v", "hvc1"]       # QuickTime/Safari-playable
                        if vcodec in ("libx264", "libx265"):
                            trim_args += ["-preset", "fast"]
                        trim_args += _quality_args(vcodec)
                        trim_args += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]
                        if not has_aud:
                            trim_args += ["-shortest"]
                        trim_args.append(seg_path)
                        # `_` is this clip's index in the EDL, so _clip_secs[_] is its MEASURED
                        # length. (out_pt or 0) - in_pt collapsed to 0 for every untrimmed clip
                        # — i.e. a 15 s 4K segment was re-encoded on the bare 120 s floor.
                        _seg_secs = _clip_secs[_] if _clip_secs[_] is not None else _NOMINAL_CLIP_SECS
                        proc = subprocess.run(trim_args, capture_output=True,
                                          timeout=_ff_timeout(max(1.0, _seg_secs), 8 * _hd, 120))
                        if proc.returncode == 0:
                            f.write(f"file '{seg_path}'\n")
                        else:
                            logger.warning("[Render] trim failed for %s: %s", path, proc.stderr.decode())

                # Concat segments
                concat_cmd = [
                    FFMPEG_BIN, "-y", "-f", "concat", "-safe", "0",
                    "-i", list_file,
                    "-c", "copy", str(out_path),
                ]
                await bus.publish("seedance", "active", "Rendering final cut…", 60)
                proc = await asyncio.to_thread(
                    subprocess.run, concat_cmd, capture_output=True,
                    timeout=_ff_timeout(_total, 1.5 * _hd, 300)
                )
                if proc.returncode != 0:
                    raise RuntimeError(f"ffmpeg concat failed: {proc.stderr.decode()}")
            else:
                # xfade approach for transitions
                for i, path, _ in valid_clips:
                    input_args += ["-i", path]
                # Silent stereo sources for clips that have no audio, so the audio
                # acrossfade chain has a stream for every clip. Added after the
                # video inputs; remember each clip's silent-source input index.
                n_inputs = len(valid_clips)
                aud_flags = [_has_audio(p) for _, p, _ in valid_clips]
                silent_idx: dict[int, int] = {}
                for i, has_aud in enumerate(aud_flags):
                    if not has_aud:
                        input_args += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
                        silent_idx[i] = n_inputs + len(silent_idx)

                # Build filter complex with xfade (video) + acrossfade (audio)
                v_labels = []
                a_labels = []
                for i, (ci, path, clip) in enumerate(valid_clips):
                    in_pt = clip.inPoint or 0.0
                    # Untrimmed clips (outPoint=None) need their REAL length, not a
                    # placeholder — this number IS the film: it trims the clip and it
                    # advances the xfade offset chain. A fabricated 5.0 here cut every
                    # untrimmed shot down to five seconds in the delivered file, and the
                    # length guard below could not catch it because an unprobeable clip is
                    # excluded from `expected` too. There is no honest substitute, so an
                    # unmeasurable clip fails the export instead of silently shortening it.
                    dur = _clip_secs[ci]
                    if not dur or dur <= 0:
                        raise HTTPException(
                            status_code=500,
                            detail=(f"Clip {clip.shotId} ({os.path.basename(path)}) has no "
                                    "measurable duration, so the transition timeline cannot "
                                    "be built. Re-render that shot and try again."),
                        )
                    dur = max(0.1, dur)
                    label = f"v{i}"
                    fi = max(0.0, clip.fadeIn or 0.0)
                    fo = max(0.0, clip.fadeOut or 0.0)
                    vfade = ""
                    if fi > 0.01:
                        vfade += f",fade=t=in:st=0:d={min(fi, dur):.3f}"
                    if fo > 0.01:
                        vfade += f",fade=t=out:st={max(0, dur - fo):.3f}:d={min(fo, dur):.3f}"
                    filter_parts.append(
                        f"[{i}:v]trim=start={in_pt}:duration={dur},"
                        f"setpts=PTS-STARTPTS,"
                        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={target_fps},setsar=1{vfade}[{label}]"
                    )
                    v_labels.append((label, dur, clip.transitionIn))
                    # audio: real track (atrim) or the silent source (trim to dur),
                    # with the per-clip volume gain + fade in/out applied.
                    vol = max(0.0, (clip.volume if clip.volume is not None else 1.0) * master)
                    afade = ""
                    if fi > 0.01:
                        afade += f",afade=t=in:curve=qsin:st=0:d={min(fi, dur):.3f}"
                    if fo > 0.01:
                        afade += f",afade=t=out:curve=qsin:st={max(0, dur - fo):.3f}:d={min(fo, dur):.3f}"
                    if i in silent_idx:
                        filter_parts.append(f"[{silent_idx[i]}:a]atrim=duration={dur},asetpts=PTS-STARTPTS,volume={vol}{afade}[a{i}]")
                    else:
                        filter_parts.append(f"[{i}:a]atrim=start={in_pt}:duration={dur},asetpts=PTS-STARTPTS,volume={vol}{afade}[a{i}]")
                    a_labels.append((f"a{i}", dur, clip.transitionIn))

                # Chain xfades (video)
                current = v_labels[0][0]
                offset = v_labels[0][1]
                for i in range(1, len(v_labels)):
                    label, dur, transition = v_labels[i]
                    xf_dur = transition.get("dur", 0.5) if transition else (1.0 / target_fps)  # no transition = ~1-frame cut
                    xf_offset = max(0, offset - xf_dur)
                    out_label = f"xf{i}" if i < len(v_labels) - 1 else "vout"
                    filter_parts.append(
                        f"[{current}][{label}]xfade=transition=fade:duration={xf_dur}:offset={xf_offset:.3f}[{out_label}]"
                    )
                    current = out_label
                    offset += dur - xf_dur

                # Chain acrossfades (audio) — mirrors the video transition durations
                acurrent = a_labels[0][0]
                for i in range(1, len(a_labels)):
                    label, dur, transition = a_labels[i]
                    xf_dur = transition.get("dur", 0.5) if transition else (1.0 / target_fps)  # no transition = ~1-frame cut
                    out_label = f"axf{i}" if i < len(a_labels) - 1 else "aout"
                    # Equal-power crossfade. ffmpeg defaults both curves to triangular, i.e.
                    # LINEAR amplitude — and two linear ramps summing at the midpoint
                    # give a 3 dB power dip, which is the audible sag under every
                    # dissolve in the film. qsin holds the power constant across the join.
                    filter_parts.append(
                        f"[{acurrent}][{label}]acrossfade=d={xf_dur}:c1=qsin:c2=qsin[{out_label}]")
                    acurrent = out_label

                filter_complex = ";".join(filter_parts)
                cmd = [FFMPEG_BIN] + input_args + [
                    "-filter_complex", filter_complex,
                    "-map", "[vout]",
                    "-map", "[aout]",
                    "-c:v", vcodec,
                ]
                if pix_fmt:
                    cmd += ["-pix_fmt", pix_fmt]
                if vcodec == "libx265":
                    cmd += ["-tag:v", "hvc1"]
                cmd += _quality_args(vcodec) + ["-movflags", "+faststart"]
                cmd += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-y", str(out_path)]
                await bus.publish("seedance", "active", "Rendering with transitions…", 60)
                proc = await asyncio.to_thread(subprocess.run, cmd, capture_output=True,
                    timeout=_ff_timeout(_total, 6 * _hd, 300))
                if proc.returncode != 0:
                    raise RuntimeError(f"ffmpeg xfade failed: {proc.stderr.decode()}")

        except Exception:
            # KEEP the intermediates. Every downloaded and trimmed clip is in here, and
            # for a 45-minute episode that is hours of work; deleting it meant the next
            # attempt started from zero on a run that may have failed on the very last
            # step. The path is logged so a retry — or a person — can pick it up.
            logger.error("[Render] failed — intermediates kept at %s (delete when done)", tmp)
            raise
        else:
            shutil.rmtree(tmp, ignore_errors=True)

        # 5C: V2 overlay composite — paint each overlay clip ON TOP of the assembled
        # base for its [ts,te] window (ffmpeg `overlay` + `enable=between`), and swap
        # the base audio out for the overlay's during that window (ducking [0:a] to 0
        # there, then amix the overlay audio) so it matches the player, where the top
        # layer's audio wins. Re-encodes the base (overlay can't -c copy). Guarded
        # non-fatal: an overlay hiccup keeps the base video, never hard-fails the export.
        valid_overlays = [o for o in req.overlay_clips if o.path and os.path.isfile(o.path)]
        if valid_overlays:
            try:
                ov_inputs = ["-i", str(out_path)]
                vfilters, composite, aparts, alabels, windows = [], [], [], [], []
                cur = "0:v"
                for k, o in enumerate(valid_overlays, start=1):
                    ov_inputs += ["-i", o.path]
                    odur = max(0.1, o.out_point - o.in_point)
                    ts = max(0.0, o.timeline_start)
                    te = ts + odur
                    windows.append((ts, te))
                    # video: trim to content, shift PTS to its timeline slot, fit the
                    # canvas, fps/sar; own fade in/out (alpha so it dissolves over V1).
                    vf = (f"[{k}:v]trim=start={o.in_point}:end={o.out_point},"
                          f"setpts=PTS-STARTPTS+{ts:.3f}/TB,"
                          f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={target_fps},setsar=1,format=yuva420p")
                    if o.fade_in > 0.01:
                        vf += f",fade=t=in:st={ts:.3f}:d={o.fade_in:.3f}:alpha=1"
                    if o.fade_out > 0.01:
                        vf += f",fade=t=out:st={max(ts, te - o.fade_out):.3f}:d={o.fade_out:.3f}:alpha=1"
                    vf += f"[ov{k}]"
                    vfilters.append(vf)
                    outlbl = f"vb{k}"
                    composite.append(f"[{cur}][ov{k}]overlay=enable='between(t,{ts:.3f},{te:.3f})':x=0:y=0[{outlbl}]")
                    cur = outlbl
                    # audio: trimmed, gained (× master), faded, delayed to its slot.
                    avol = max(0.0, min(2.0, o.volume * master))
                    af = f"[{k}:a]atrim=start={o.in_point}:end={o.out_point},asetpts=PTS-STARTPTS,volume={avol}"
                    if o.fade_in > 0.01:
                        af += f",afade=t=in:curve=qsin:st=0:d={min(o.fade_in, odur):.3f}"
                    if o.fade_out > 0.01:
                        af += f",afade=t=out:curve=qsin:st={max(0, odur - o.fade_out):.3f}:d={min(o.fade_out, odur):.3f}"
                    delay_ms = int(ts * 1000)
                    if delay_ms > 0:
                        af += f",adelay={delay_ms}|{delay_ms}"
                    af += f"[oa{k}]"
                    aparts.append(af)
                    alabels.append(f"[oa{k}]")
                # Duck the base audio inside any overlay window, then amix overlays on top.
                # RAMPED, not switched: `volume=enable=...:volume=0` snaps the gain from
                # 1 to 0 between one sample and the next, which is a step discontinuity —
                # an audible click at both edges of every overlay. A 30 ms ramp is far too
                # short to hear as a fade and removes the click completely.
                _R = 0.03
                # Per window: 1 outside, 0 inside, linear across the ramp. Multiplied
                # together so overlapping windows still duck to zero.
                duck_expr = "*".join(
                    f"(1-clip(min((t-{ts:.3f})/{_R},({te:.3f}-t)/{_R}),0,1))"
                    for ts, te in windows
                )
                aparts.insert(0, f"[0:a]volume=volume='{duck_expr}':eval=frame[ba]")
                aparts.append(f"[ba]{''.join(alabels)}amix=inputs={len(alabels) + 1}:duration=first:dropout_transition=0:normalize=0[aout]")
                graph = ";".join(vfilters + composite + aparts)
                ov_out = out_path.with_name(out_path.stem + "_ov" + out_path.suffix)
                ov_cmd = [FFMPEG_BIN, "-y", *ov_inputs, "-filter_complex", graph,
                          "-map", f"[{cur}]", "-map", "[aout]", "-c:v", vcodec]
                if pix_fmt:
                    ov_cmd += ["-pix_fmt", pix_fmt]
                if vcodec == "libx265":
                    ov_cmd += ["-tag:v", "hvc1"]
                ov_cmd += _quality_args(vcodec) + ["-movflags", "+faststart"]
                ov_cmd += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(ov_out)]
                await bus.publish("seedance", "active", "Compositing V2 overlays…", 80)
                oproc = await asyncio.to_thread(subprocess.run, ov_cmd, capture_output=True,
                    timeout=_ff_timeout(_total, 6 * _hd, 300))
                if oproc.returncode == 0:
                    shutil.move(str(ov_out), str(out_path))
                else:
                    logger.warning("[Render] overlay composite failed (keeping base video): %s", oproc.stderr.decode()[:400])
            except Exception as _ove:  # noqa: BLE001
                logger.warning("[Render] overlay composite failed (keeping base video): %s", _ove)

        # Audio track(s): mix each positioned clip UNDER the clip audio (a second
        # pass, video copied so 4K HEVC isn't re-encoded). Each clip is trimmed,
        # gained, faded in/out, then delayed to its timeline position.
        valid_audio = [a for a in req.audio_clips if a.path and os.path.isfile(a.path)]
        if valid_audio:
            inputs = ["-i", str(out_path)]
            parts = []
            labels = []
            ducked = [k for k, a in enumerate(valid_audio, start=1) if a.duck]
            for k, a in enumerate(valid_audio, start=1):
                inputs += ["-i", a.path]
                dur = max(0.1, a.out_point - a.in_point)
                vol = max(0.0, min(2.0, a.volume * master))
                f = f"[{k}:a]atrim=start={a.in_point}:end={a.out_point},asetpts=PTS-STARTPTS,volume={vol}"
                if a.fade_in > 0.01:
                    f += f",afade=t=in:curve=qsin:st=0:d={min(a.fade_in, dur)}"
                if a.fade_out > 0.01:
                    f += f",afade=t=out:curve=qsin:st={max(0, dur - a.fade_out):.3f}:d={min(a.fade_out, dur)}"
                delay_ms = int(max(0.0, a.timeline_start) * 1000)
                if delay_ms > 0:
                    f += f",adelay={delay_ms}|{delay_ms}"
                f += f"[a{k}]"
                parts.append(f)
                # A ducked clip goes into the mix through its compressor, not directly.
                labels.append(f"[a{k}d]" if a.duck else f"[a{k}]")
            if ducked:
                # Real sidechain ducking for the music bed, same parameters as the
                # dialogue mix in _mix_dialogue_onto_video: the bed drops only while
                # someone is speaking and comes back up after (release=300ms, so it
                # breathes instead of pumping). The key is the PROGRAMME audio, which is
                # where the dialogue is — Seedance bakes it into the clip audio, so there
                # is no separate voice track to key on at this stage.
                #
                # asplit is not optional: an ffmpeg output pad can be consumed exactly
                # ONCE, so [0:a] cannot feed the mix and N compressors at the same time.
                # One branch stays in the mix, one key branch per ducked clip.
                #
                # aformat on both sides of each compressor: sidechaincompress wants both
                # inputs at the same rate/layout, and a bed dropped in by the user is
                # regularly a mono 44.1k mp3 against 48k stereo programme. Without it the
                # graph fails to configure and the whole mix is thrown away — which means
                # the export silently ships with NO music at all.
                _AF = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
                parts.insert(0, f"[0:a]asplit={len(ducked) + 1}[a0]"
                                + "".join(f"[key{k}]" for k in ducked))
                for k in ducked:
                    parts.append(f"[key{k}]{_AF}[key{k}f]")
                    parts.append(f"[a{k}]{_AF}[a{k}f]")
                    parts.append(f"[a{k}f][key{k}f]sidechaincompress="
                                 f"threshold=0.03:ratio=8:attack=5:release=300[a{k}d]")
                prog = "[a0]"
            else:
                prog = "[0:a]"
            # normalize=0: amix otherwise divides by the input count and drops everything ~6 dB.
            parts.append(f"{prog}{''.join(labels)}amix=inputs={len(labels) + 1}:duration=first:dropout_transition=0:normalize=0[a]")
            mixed = out_path.with_name(out_path.stem + "_mix" + out_path.suffix)
            mix_cmd = [FFMPEG_BIN, "-y", *inputs, "-filter_complex", ";".join(parts),
                       "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", str(mixed)]
            await bus.publish("seedance", "active", "Mixing audio tracks…", 85)
            mproc = await asyncio.to_thread(subprocess.run, mix_cmd, capture_output=True,
                    timeout=_ff_timeout(_total, 6 * _hd, 300))
            if mproc.returncode == 0:
                shutil.move(str(mixed), str(out_path))
            else:
                logger.warning("[Render] audio mix failed (keeping clip audio): %s", mproc.stderr.decode()[:400])

        # Does the file actually contain the film? Loading every clip is not the same as
        # ffmpeg keeping every clip: a trim that silently produces nothing, or a filter
        # graph that drops a stream, both end with a short file and a 0 exit code. The
        # EDL says how long the cut should be, so measure the result and refuse to hand
        # back something materially shorter. Transitions overlap clips, so the tolerance
        # has to allow for them; this catches a MISSING SHOT, not a rounding error.
        #
        # `expected` comes from _clip_secs — the REAL length of each clip, measured off the
        # materialised sources above. It used to be `… or 5.0` per clip, which on a normal
        # timeline (every clip untrimmed) reported half the runtime and drove the shortfall
        # permanently negative, i.e. this guard could not fire at all. A clip that would not
        # probe contributes NOTHING here rather than a made-up 5.0: the sum is then a lower
        # bound on the timeline, and a lower bound can only under-report the shortfall — it
        # can never invent one.
        unprobeable = sum(1 for s in _clip_secs if s is None)
        expected = sum(s for s in _clip_secs if s is not None)
        actual = await asyncio.to_thread(_probe_audio_seconds, str(out_path)) or 0.0
        # The xfade path overlaps EVERY join, not only the ones carrying a transition: a
        # clip with no transitionIn still gets a ~1-frame xfade (xf_dur = 1/fps, above).
        # Counting the declared transitions alone left len(clips)/fps of overlap out of the
        # arithmetic — 21 s on a 500-clip episode — which the old 5% tolerance absorbed and
        # the per-shot tolerance below would not. The concat path butt-joins; nothing overlaps.
        # Kept PER JOIN as well as summed: the subtitle writer needs where each clip
        # starts, and clip i starts dur[i-1] − xf_each[i] after clip i-1 (the same
        # offset chain the xfade graph is built on). xf_each[0] is 0 — nothing overlaps
        # the first clip.
        xf_each = (
            [0.0] + [(c.transitionIn.get("dur", 0.5) if c.transitionIn else 1.0 / target_fps)
                     for c in req.edl.clips[1:]]
            if has_transitions else [0.0] * len(req.edl.clips)
        )
        xf_total = sum(xf_each)
        shortfall = expected - xf_total - actual
        # Tolerance derived from the error this can actually accumulate, not from a
        # percentage and not from a round number. Two sources, and only two:
        #   · frame quantisation — every segment lands on a whole frame at target_fps, so
        #     each clip contributes up to ±1/fps with random sign. That grows like
        #     sqrt(n)/fps, not n/fps. Measured over 26 real 4-15 s clips the finished file
        #     came out 0.12 s LONGER than the timeline (~3 frames at 24 fps) — longer
        #     shrinks the shortfall, so the bias runs away from a false alarm.
        #   · one container/encoder rounding on `actual` at the end — an AAC frame is 21 ms,
        #     plus the moov rewrite. 0.10 s covers it, once, not per clip.
        # What it must NOT absorb is a missing SHOT, and shots are no longer 4 s+: a segment
        # holds its own cuts, so a 1.2 s clip in the EDL is legal. The old floor was
        # `max(1.5, …)` applied AFTER the per-shot cap, which put it straight back above a
        # whole shot: razoring one 1.2 s shot's footage out of a 10-clip cut returned HTTP
        # 200 at +1.03 s short (concat) and +0.70 s (xfade), both under a 1.50 s tolerance.
        # The cap goes LAST now: whatever the noise estimate says, the tolerance never
        # reaches half the shortest clip, so a single missing shot exceeds it by
        # construction. Verified on clean exports of 10/20/40 clips — every one came out
        # LONGER than its timeline (-0.14 / -0.27 / -0.51 s of shortfall on the concat
        # path, -0.01 / -0.02 / -0.00 s on xfade), i.e. the noise runs away from the guard.
        tol = 0.10 + max(1, len(req.edl.clips)) ** 0.5 / target_fps
        shortest = min((s for s in _clip_secs if s), default=0.0)
        if shortest:
            tol = min(tol, 0.5 * shortest)
        logger.info("[Render] length check: timeline %.2fs − %.2fs xfade vs file %.2fs "
                    "→ shortfall %+.2fs (tolerance %.2fs%s)",
                    expected, xf_total, actual, shortfall, tol,
                    f", {unprobeable} clip(s) unprobeable and NOT counted" if unprobeable else "")
        if expected > 0 and shortfall > tol:
            await bus.publish("seedance", "error",
                              f"Export is {shortfall:.1f}s short of the timeline")
            raise HTTPException(
                status_code=500,
                detail=(f"The rendered file is {actual:.1f}s but the timeline is "
                        f"{expected - xf_total:.1f}s — {shortfall:.1f}s of footage is missing "
                        "from the export. It has NOT been accepted; re-render."),
            )

        # Loudness: bring the whole programme to one level. Every clip came from a
        # separate generation at whatever level it happened to land on, so without this
        # the cut jumps in volume all the way through. Last step, after every mix, so it
        # measures what the viewer will actually hear. Non-fatal.
        await bus.publish("seedance", "active", "Normalising loudness (EBU R128)…", 95)
        # Every number in here is an ffmpeg measurement, and a silent programme measures
        # -inf — which JSON cannot encode, so it 500'd this whole endpoint on a film that
        # was already complete on disk. Scrubbed on the way into the body, not per-field.
        loudness = _finite_floats(await asyncio.to_thread(_normalize_loudness, str(out_path)))
        # And say it out loud. A film with no audible programme is nearly always an
        # upstream failure — clips generated with generate_audio off, a mix at zero, a
        # dialogue pass that never ran — and the export is where it becomes visible,
        # because the anullsrc that keeps concat's streams matching also makes silence
        # look exactly like success. A warning, not a gate: the deliverable is correct
        # for the timeline it was given, so the user is told, not blocked.
        audio_note = ("Nothing audible in this export — the whole programme measures as "
                      "digital silence. If that is not deliberate, the shots were most "
                      "likely generated without audio; the picture is unaffected."
                      if loudness.get("silent") else "")
        if audio_note:
            await bus.publish("seedance", "active", audio_note, 96)

        # Subtitles from the dialogue the breakdown already holds (non-fatal).
        subs = await asyncio.to_thread(
            _write_subtitles, req.edl, req.project_name, req.project_path, str(out_path),
            _clip_secs, xf_each) or {}

        # Save EDL alongside render
        edl_path = str(out_path).replace(f".{ext}", ".edl.json")
        with open(edl_path, "w") as f:
            f.write(req.edl.model_dump_json(indent=2))

        await bus.publish("seedance", "completed", f"Render complete: {out_path.name}", 100)
        return {
            "output_path": str(out_path),
            "filename": out_path.name,
            "resolution": req.resolution,
            "format": req.output_format,
            "edl_path": edl_path,
            "loudness": loudness,
            # Non-empty when the finished film has no audible programme — Stage 6 shows
            # it next to the file, beside the subtitle note.
            "audio_note": audio_note,
            "subtitles_path": subs.get("path", ""),
            "subtitles_cues": subs.get("cues", 0),
            # Non-empty when the cues stop early — Stage 6 shows it next to the file.
            "subtitles_note": subs.get("note", ""),
        }

    except HTTPException:
        # Already a deliberate, correctly-coded failure (a 422 for missing clips, a
        # 500 for a short render). Re-raise untouched — the broad handler below was
        # rewrapping these as 500 with the real status stringified into the message,
        # which tells the client to retry something that will fail identically.
        raise
    except Exception as e:
        await bus.publish("seedance", "error", str(e))
        raise HTTPException(status_code=500, detail=str(e))


# ── P5: Project storage & versioning ─────────────────────────────────────────

class ProjectInitRequest(BaseModel):
    name: str
    project_type: str   # "tv" | "film" | "vfx_shot"
    structure: dict     # e.g. {season: "01", episode: "01", scene: "01"}
    storage_root: str | None = None  # custom root; None → ~/Documents/TakeOne

class SaveStateRequest(BaseModel):
    project_path: str       # the project folder (from localFolderRoot)
    state: dict             # the partialized pipeline store snapshot

class AssetSaveRequest(BaseModel):
    name: str
    asset_rel_path: str
    image_b64: str = ""
    image_url: str = ""        # alternative: backend downloads from URL
    project_path: str = ""     # full path (from localFolderRoot) so custom roots work
    derive_headshot: bool = False  # characters: crop a clean big face → Headshot/ (2a, anti-drift)
    # WHICH sheet layout this image is, because the face sits somewhere different in each
    # and the crop has to follow (_SHEET_LAYOUTS["<layout>"]["crop"]). Defaults to the
    # layout identity_board_prompt builds when nobody asks for another, which is what the
    # pipeline's Stage-3 save sends — it posts no layout field and must keep working.
    sheet_layout: str = SHEET_LAYOUT_DEFAULT
    # Prompt transparency: {auto_prompt, prompt_override, sent_prompt,
    # negative_prompt, references} → written as a vNNN.meta.json sidecar
    prompt_meta: dict | None = None

class AssetRevertRequest(BaseModel):
    name: str
    asset_rel_path: str
    version: int
    project_path: str = ""

class AssetApproveRequest(BaseModel):
    name: str
    asset_rel_path: str
    version: int
    project_path: str = ""


@app.post("/api/project/init")
def project_init(r: ProjectInitRequest):
    try:
        root = proj_storage.init_project(r.name, r.project_type, r.structure, r.storage_root or None)
        return {"root": root}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/project/storage-default")
def project_storage_default():
    """Return the default storage root (uses Path.home(), never a hardcoded path)."""
    return {"default_root": proj_storage.default_storage_root()}


@app.get("/api/project/list")
def project_list(roots: str | None = None):
    """`roots` is an optional comma-separated list of custom storage roots
    (the frontend passes its localFolderRoot) scanned in addition to TAKEONE_ROOT."""
    try:
        extra = [r.strip() for r in roots.split(",")] if roots else []
        return {"projects": proj_storage.list_projects([r for r in extra if r])}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/fs/list")
def fs_list(path: str | None = None):
    """Folder browser for the New/Open project dialogs — lists sub-directories of
    `path` (default: home), flagging which are Take One Studio projects. Local-only."""
    try:
        return proj_storage.list_dirs(path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# EL GUARDADO NO COMPITE POR EL POOL COMPARTIDO. Un endpoint `def` corre en el pool de
# anyio (40 hilos, `run_in_threadpool`) junto con los otros 23 endpoints síncronos de este
# fichero — asset_serve, image_proxy, el registro de renders, la cola… Medido con las
# versiones del venv: 45 llamadas síncronas en vuelo cuelgan cualquier endpoint `def`
# durante todo lo que duren (20 s en la sonda), mientras que 48 `asyncio.to_thread`
# ocupados —lo que usan los tableros— no le quitan ni un milisegundo. El guardado del
# snapshot es la escritura que NO puede esperar: es la copia durable, y el navegador
# se rinde a los 120 s y avisa "Not saving to disk". Con su propio limitador, un
# atasco del pool compartido no lo toca. Dos plazas: un guardado y el siguiente.
_SAVE_LIMITER = anyio.CapacityLimiter(2)


@app.post("/api/project/save-state")
async def project_save_state(r: SaveStateRequest):
    """Persist the full pipeline store snapshot into the project folder so the
    project can be reopened later (autosaved by the frontend on change)."""
    try:
        if not r.project_path:
            raise HTTPException(status_code=400, detail="project_path required")
        return await anyio.to_thread.run_sync(
            proj_storage.save_pipeline_state, r.project_path, r.state, limiter=_SAVE_LIMITER)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/project/load")
def project_load(path: str):
    """Return a project's saved pipeline snapshot + manifest. `state` is null when
    the project predates state-persistence (UI warns / offers a fresh start)."""
    try:
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        return proj_storage.load_pipeline_state(path)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/project/last")
def project_last():
    """F2c: the project this machine last worked on — the ONLY boot path left when the
    browser holds no localStorage at all (cleared site data, a fresh browser, incognito).
    Both keys the frontend uses are localStorage and die together; storage.py keeps this
    pointer next to the render registry/queue instead.

    Absence is NOT a 404, exactly like GET /api/bible: "no project yet" is a normal answer
    (a first run has none), and a 404 there reads to the client as a broken backend. The
    empty shape carries the same keys with empty values, and a pointer whose folder has
    since been deleted reads back as empty too (storage.read_last_project)."""
    try:
        return proj_storage.read_last_project() or {"project_path": "", "project_name": "", "savedAt": ""}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/project/last")
def project_last_forget():
    """Forget the pointer above. Reset (frontend TopBar) calls this: it already clears the
    browser's copy of the root, and without clearing ours the next boot would reopen the
    project the user just reset — a reset that undoes itself."""
    try:
        proj_storage.forget_last_project()
        return {"forgotten": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/project/usage")
def project_usage(path: str):
    """Aggregated per-project consumption (LLM/vision tokens, image + video counts,
    video tokens by resolution) + an estimated USD cost. Metered from now on —
    projects predating this read back zeros.

    `estimatedCostUsd` only covers what has a DOCUMENTED rate. `costBreakdown` carries
    the per-line split plus `unpricedImages` / `unpricedModels` — images whose model or
    pixel tier has no published price and are therefore NOT in the total. Both the count
    and the model ids are returned so the panel can say so; the previous version priced
    every image at one flat figure and reported a third of the truth."""
    try:
        if not path:
            raise HTTPException(status_code=400, detail="path required")
        return usage.get(path)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _derive_headshot(sheet_path: str, sheet_layout: str = SHEET_LAYOUT_DEFAULT) -> str:
    """Crop the BIG face out of a character reference sheet and save it as
    Headshot/headshot.png next to the asset (2a). The sheet's full-body figures have TINY
    faces that confuse Seedance into identity drift; this clean, large face becomes the
    dominant facial reference.

    WHERE the big face is depends on which sheet identity_board_prompt built, so the box
    comes from that layout's own entry (_SHEET_LAYOUTS[…]["crop"]) rather than being
    written out here a second time. On the "4+2"/"2+2" sheets it is the top-left of the
    two close-ups along the top row; on the "headless" sheet it is the 3/4 portrait
    filling the left column — and cutting a headless sheet with the old top-left-quadrant
    box returns a forehead, which is why the two travel together. An unknown layout falls
    back to the default's box (a wrong crop is a bad face reference, never a crash).

    Returns the saved path, or "" on failure (non-fatal — the sheet still works as today).
    """
    try:
        from PIL import Image
        im = Image.open(sheet_path)
        W, H = im.size
        spec = _SHEET_LAYOUTS.get(sheet_layout) or _SHEET_LAYOUTS[SHEET_LAYOUT_DEFAULT]
        l, t, r_, b = spec["crop"]
        crop = im.crop((int(W * l), int(H * t), int(W * r_), int(H * b)))
        hs_dir = os.path.join(os.path.dirname(os.path.dirname(sheet_path)), "Headshot")
        os.makedirs(hs_dir, exist_ok=True)
        out = os.path.join(hs_dir, "headshot.png")
        # Publish atomically. crop.save(out) wrote straight to a FIXED name, so an
        # interrupted or concurrent derive left a 0-byte headshot.png — and the board
        # path has no size check: resolve_reference_strict only looks for the `data:`
        # prefix, so the empty file goes out as an empty data URI and BytePlus answers
        # 400 InvalidParameter, failing the WHOLE board. Measured. The sheet next to it
        # has been written atomically since storage.py:333; this was the one writer in
        # the board path that was not, which is exactly the shape of the zero-byte
        # pipeline_state.json bug.
        import io as _io
        from pathlib import Path as _Path       # local, like the other Path users in this file
        buf = _io.BytesIO()
        crop.save(buf, format="PNG")
        raw = buf.getvalue()
        if not raw:
            raise RuntimeError("crop encoded to zero bytes")
        proj_storage.atomic_write_bytes(_Path(out), raw)
        return out
    except Exception as e:
        logger.warning("[Headshot] derive failed (non-fatal): %s", e)
        return ""


@app.post("/api/asset/save-version")
def asset_save(r: AssetSaveRequest):
    try:
        b64 = r.image_b64
        if not b64 and r.image_url:
            import requests as _req, base64 as _b64
            resp = _req.get(r.image_url, timeout=30)
            resp.raise_for_status()
            b64 = _b64.b64encode(resp.content).decode()
        if not b64:
            raise HTTPException(status_code=400, detail="Provide image_b64 or image_url")
        result = proj_storage.save_asset_version(r.name, r.asset_rel_path, b64, r.project_path, r.prompt_meta)
        # Characters: derive a clean big-face headshot from the sheet's top-left close-up (2a),
        # so the dominant facial signal to Seedance isn't the tiny full-body faces (anti-drift).
        headshot_local_path = _derive_headshot(result.get("path", ""), r.sheet_layout) \
            if r.derive_headshot else ""
        # Return the absolute disk path so the frontend can use it as a stable reference
        # (local paths never expire, unlike signed CDN URLs)
        return {**result, "local_path": result.get("path", ""), "headshot_local_path": headshot_local_path}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Security: touch only files inside a project tree. Custom storage roots
# (localFolderRoot outside ~/Documents/TakeOne) previously 403'd here, which
# rendered as broken <img>s in the UI. A path qualifies if any ancestor directory
# (within 8 levels) holds a project.json manifest. Module level because
# /api/asset/duration enforces the same rule — one predicate, not two copies.
def _inside_project_tree(p: str) -> bool:
    from pathlib import Path as _Path
    if p.startswith(str(proj_storage.TAKEONE_ROOT)) or p.startswith("/tmp/"):
        return True
    cur = _Path(p).parent
    for _ in range(8):
        if (cur / "project.json").is_file():
            return True
        if cur.parent == cur:
            break
        cur = cur.parent
    return False


@app.get("/api/asset/serve")
def asset_serve(path: str):
    """
    Serve a saved asset image from the local filesystem.
    The path parameter must be an absolute path inside the TAKEONE_ROOT tree.
    This endpoint returns a stable image that never expires.
    """
    import os as _os
    import mimetypes as _mt
    from pathlib import Path as _Path
    from fastapi.responses import FileResponse

    root_str = str(proj_storage.TAKEONE_ROOT)
    abs_path = _os.path.abspath(path)

    # Self-heal stale absolute media paths. Persisted client state stores ABSOLUTE
    # paths, which break when a project is moved, renamed, or accidentally nested
    # (…/Proj/Proj/…) — a recurring cross-project bug that renders as broken <img>s.
    # Rather than 404, reconstruct the real file: (a) collapse a duplicated
    # consecutive dir (…/X/X/… → …/X/…, root-agnostic so custom roots heal too);
    # (b) rebuild the project-relative tail (<Project>/<marker>/…) under the current
    # TAKEONE_ROOT. Best-effort: only ever resolves to a file that actually exists.
    def _heal_stale_path(p: str) -> "str | None":
        markers = ("Shots", "Assets", "Characters", "Breakdown",
                   "Edits", "Exports", "Script", "Studio", "Usage")
        parts = list(_Path(p).parts)
        for i in range(len(parts) - 1):        # (a) collapse …/X/X/…
            if parts[i] == parts[i + 1] and parts[i] != "/":
                cand = str(_Path(*parts[:i + 1], *parts[i + 2:]))
                if _os.path.isfile(cand):
                    return cand
        for i in range(1, len(parts)):         # (b) rebuild under TAKEONE_ROOT
            if parts[i] in markers:
                cand = _os.path.join(root_str, parts[i - 1], *parts[i:])
                if _os.path.isfile(cand):
                    return cand
                break
        return None

    if not _os.path.isfile(abs_path):
        healed = _heal_stale_path(abs_path)
        if healed:
            logger.info("[serve] healed stale path: %s → %s", abs_path, healed)
            abs_path = healed

    if not _inside_project_tree(abs_path):
        raise HTTPException(status_code=403, detail="Path outside project storage")
    if not _os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="Asset file not found")
    media_type = _mt.guess_type(abs_path)[0] or "image/png"
    # Cache policy by path mutability:
    #   VERSIONED paths (…/Versions/vNNN.*, video_vNNN.*) are never overwritten →
    #   immutable, so the browser stops re-downloading every ~1MB board on each
    #   back/forward (the "storyboard goes blank for a while" lag).
    #   MUTABLE paths (dialogue.mp3, *.dub.mp4, *.preview.mp4, soundtracks…) are
    #   overwritten in place on regenerate → no-store forces a revalidation so a
    #   regenerated dialogue/dub never plays back stale from cache.
    import re as _re
    name = _os.path.basename(abs_path)
    # video_vNNN.mp4 is the raw versioned render (never rewritten); its .dub.mp4 /
    # .preview.mp4 siblings ARE rewritten in place → they must NOT be immutable.
    versioned = "/Versions/" in abs_path or bool(_re.fullmatch(r"video_v\d+\.\w+", name))
    cache = "public, max-age=31536000, immutable" if versioned else "no-cache"
    return FileResponse(abs_path, media_type=media_type, headers={"Cache-Control": cache})


@app.get("/api/asset/duration")
def asset_duration(path: str):
    """Measured length of a saved media file in seconds, or null when it cannot be
    measured. Same ffprobe (cached, via _source_seconds) that the export trims and
    times subtitles with, so the browser and the render agree on how long a file is.

    Exists because the browser cannot measure a file it cannot decode, and both
    callers of a length in Stage 6 were inventing one when it did not know:
    Edit/Re-take sent a hard 5 s as the PAID Seedance duration for a clip whose take
    never probed, and an undecodable audio upload claimed a flat 30 s. null here is
    the answer, not an error — the caller must handle "unknown", never substitute.
    """
    import os as _os
    abs_path = _os.path.abspath(path or "")
    if not _inside_project_tree(abs_path):
        raise HTTPException(status_code=403, detail="Path outside project storage")
    if not _os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="File not found")
    return {"duration": _source_seconds(abs_path)}


@app.get("/api/image/proxy")
def image_proxy(src: str):
    """Universal image loader for the Pro editor <canvas>: serves a disk path
    (project-tree gated, via asset_serve) OR proxies a BytePlus/volces CDN URL
    server-side. Needed because a cross-origin CDN image cannot be fetch()'d into
    a canvas (tainting / CORS) and CDN links expire — the browser hits us instead."""
    s = (src or "").strip()
    if not s:
        raise HTTPException(status_code=400, detail="src required")
    if s.startswith("file://"):
        s = s[7:]
    if s.startswith("/"):
        return asset_serve(s)   # disk path — reuse the gated file server (+ self-heal)
    if s.startswith("http://") or s.startswith("https://"):
        from urllib.parse import urlparse
        host = (urlparse(s).hostname or "").lower()
        allowed = ("bytepluses.com", "volces.com", "volccdn.com", "byteintl.com", "byteplus.com")
        if not any(host == h or host.endswith("." + h) for h in allowed):
            raise HTTPException(status_code=400, detail="host not allowed")
        import requests as _req
        from fastapi import Response as _Response
        try:
            r = _req.get(s, timeout=30)
            r.raise_for_status()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"fetch failed: {e}")
        ct = (r.headers.get("Content-Type", "image/png").split(";")[0].strip()) or "image/png"
        return _Response(content=r.content, media_type=ct)
    raise HTTPException(status_code=400, detail="unsupported src")


@app.get("/api/studio/list")
def studio_list(project_name: str = "", project_path: str = ""):
    """List Studio-generated images (durable disk copies) for the current project —
    lets the Pro editor pull a separately-generated asset (e.g. glasses) as a ref."""
    from pathlib import Path as _Path
    try:
        root = _Path(proj_storage._resolve_root(project_name, project_path))
    except Exception:
        return {"images": []}
    gdir = root / "Studio" / "Images"
    if not gdir.is_dir():
        return {"images": []}
    exts = (".png", ".jpg", ".jpeg", ".webp")
    imgs = [p for p in gdir.glob("*") if p.suffix.lower() in exts]
    imgs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return {"images": [{"path": str(p), "filename": p.name} for p in imgs[:60]]}


@app.get("/api/asset/versions")
def asset_versions(name: str, asset_rel_path: str, project_path: str = ""):
    try:
        return proj_storage.list_asset_versions(name, asset_rel_path, project_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/asset/revert")
def asset_revert(r: AssetRevertRequest):
    try:
        return proj_storage.revert_asset(r.name, r.asset_rel_path, r.version, r.project_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/asset/approve-version")
def asset_approve(r: AssetApproveRequest):
    try:
        return proj_storage.approve_asset_version(r.name, r.asset_rel_path, r.version, r.project_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    claude_ok = bool(os.getenv("ANTHROPIC_API_KEY"))
    byteplus_ok = bool(os.getenv("BYTEPLUS_API_KEY"))
    return {
        "status": "ok",
        "claude": "configured" if claude_ok else "missing ANTHROPIC_API_KEY",
        "byteplus": "configured" if byteplus_ok else "missing BYTEPLUS_API_KEY",
    }


if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
