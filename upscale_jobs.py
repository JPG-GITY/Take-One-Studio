"""
The ledger of AI MediaKit tasks this server is watching (Studio clips and Stage 6 masters).

Why it exists: an enhancement task the browser stopped polling — tab closed, page reloaded,
the client's own deadline ran out, the backend restarted — was still processed and billed by
the vendor, and its output (kept 24 h on their side) was simply never fetched. The Studio
message "keep this tab open" was the symptom. Now the SERVER owns the wait: a task is
written here at submit, a watcher polls the vendor until it ends and writes the file where
it belongs, and at startup every job still `running` gets its watcher back.

One JSON file under ~/.takeone (TAKEONE_UPSCALE_JOBS overrides), read-modify-write behind
the module lock and the cross-process flock, atomic on disk — the same discipline as
render_registry.py. Finished jobs stay for a week so a late poll still gets its answer.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

import file_lock
from storage import atomic_write_json

logger = logging.getLogger(__name__)

JOBS_PATH = Path(os.environ.get("TAKEONE_UPSCALE_JOBS", Path.home() / ".takeone" / "upscale_jobs.json"))
KEEP_FINISHED_SECS = 7 * 24 * 3600

_lock = threading.Lock()


def _load() -> dict[str, Any]:
    try:
        d = json.loads(JOBS_PATH.read_text())
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict[str, Any]) -> None:
    JOBS_PATH.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(JOBS_PATH, d)


def put(job: dict[str, Any]) -> dict[str, Any]:
    """Insert (or replace) a job keyed by its task_id. Sets created/updated stamps."""
    now = time.time()
    job = {**job, "created_at": job.get("created_at") or now, "updated_at": now}
    with _lock, file_lock.hold(JOBS_PATH):
        d = _load()
        d[job["task_id"]] = job
        _save(d)
    return job


def get(task_id: str) -> dict[str, Any] | None:
    with _lock, file_lock.hold(JOBS_PATH):
        return _load().get(task_id)


def update(task_id: str, **fields: Any) -> dict[str, Any] | None:
    """Merge fields into a job; returns the updated job (None when unknown)."""
    with _lock, file_lock.hold(JOBS_PATH):
        d = _load()
        job = d.get(task_id)
        if not job:
            return None
        job.update(fields)
        job["updated_at"] = time.time()
        d[task_id] = job
        _save(d)
        return job


def running() -> list[dict[str, Any]]:
    with _lock, file_lock.hold(JOBS_PATH):
        return [j for j in _load().values() if j.get("status") == "running"]


def prune() -> int:
    """Drop finished jobs older than KEEP_FINISHED_SECS. Returns how many were dropped."""
    cutoff = time.time() - KEEP_FINISHED_SECS
    with _lock, file_lock.hold(JOBS_PATH):
        d = _load()
        keep = {k: j for k, j in d.items()
                if j.get("status") == "running" or float(j.get("updated_at") or 0) >= cutoff}
        dropped = len(d) - len(keep)
        if dropped:
            _save(keep)
        return dropped
