"""
B2: a small persistent registry of Seedance render tasks.

The render flow used to live entirely in the browser: the frontend created a
task, polled it, and saved the result. If the backend restarted or the tab
closed mid-render, the task→project/shot mapping was lost and the (paid) render
was orphaned — recoverable only from ModelArk's 24h task list, and only if the
browser still had the shot in localStorage.

This module records every task to a JSON file the moment it's submitted, so a
backend-side reconciler can finish and save renders autonomously — surviving
restarts and closed tabs. It's tiny (a handful of in-flight tasks at a time) and its
only dependency is file_lock; _exclusive() guards the whole-file read/write.

That guard used to be a threading.Lock alone, which is process-local while
~/.takeone/render_registry.json is shared by every Take One Studio process on the machine.
The same shape, and the same gap, that was measured double-billing renders through
render_queue.py (two processes draining 20 jobs: 4-10 entries claimed twice, whole
entries erased by the losing whole-file write, FileNotFoundError raised out of the
fixed tmp name). Here the damage is quieter but the same kind: two writers, one
stale snapshot each, and the loser's record() disappears — which is an orphaned PAID
render that the reconciler will now never see, i.e. exactly what this file exists to
prevent.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, NamedTuple

import file_lock

logger = logging.getLogger(__name__)

REGISTRY_PATH = Path(
    os.environ.get("TAKEONE_REGISTRY", Path.home() / ".takeone" / "render_registry.json")
)

# ── Last-resort ledger for a task that is ALREADY BEING BILLED ────────────────
# Every write above is a read-modify-write behind two locks, and the cross-process
# half can RAISE: file_lock.hold() gives up after LOCK_TIMEOUT_SECS and throws
# LockTimeout. Almost every caller can live with that. record() cannot, in exactly one
# case: it runs immediately after BytePlus accepted a submit, so the task_id it is
# handed is money already spent, and the row it writes is the ONLY thing that can find
# that render again (the reconciler polls the registry; nothing else knows the task
# exists). Measured with a peer process holding the registry lock: the LockTimeout out
# of record() was caught by server.py's trailing `except Exception -> HTTPException
# 500`, and the accepted task_id ended up in no file at all — an orphaned paid render.
#
# So the paid path calls record_durable(), which retries and then appends ONE line
# here. The fallback deliberately uses no lock: O_APPEND on a file nobody
# read-modify-writes is atomic for a line this size, which is what makes it work in
# precisely the situation the locked path does not. drain_orphans() folds the lines
# back into the registry on the reconciler's next sweep, so the render is finished and
# saved rather than merely logged.
ORPHAN_PATH = Path(
    os.environ.get("TAKEONE_ORPHAN_TASKS", REGISTRY_PATH.parent / "orphaned_tasks.jsonl")
)

# A wedged peer is not usually wedged for long, and a task_id is worth waiting for.
# 3 x LOCK_TIMEOUT_SECS is the worst case, on a worker thread, never on the event loop.
RECORD_RETRIES = 3
RECORD_RETRY_SECS = 0.25

# Terminal vs in-flight states
ACTIVE_STATES = {"queued", "running", "submitted"}

# ── Submit-intent markers ─────────────────────────────────────────────────────
# record() runs AFTER BytePlus returns a task_id, which leaves one window with no
# record at all: the POST itself. A process that dies in there has quite possibly
# spent money and left nothing behind to prove it — and the render queue then told
# the user "Nothing was billed for it", which is false in exactly the case that
# matters. A marker is a registry row for a submit that has been handed to the
# network but has no verdict yet. It never carries a task_id; there isn't one.
#
# This block used to claim the marker "cannot itself become a source of false
# positives, by construction". That was false about the POST's OWN connection phase.
# The hook fires microseconds before requests.post, which is early enough to catch a
# process death but ALSO early enough to catch every way the connection can fail before
# a single byte reaches BytePlus: DNS, a refused TCP connect, a connect timeout, a
# rejected TLS handshake. All four came back as "no verdict", all four kept the marker,
# and the queue then told the operator a render "may be running and BILLABLE right now"
# over a request that never left the laptop. Measured here, and not as an edge case: a
# corporate VPN intercepts TLS on this machine, so CERTIFICATE_VERIFY_FAILED against
# ark.ap-southeast.bytepluses.com is a STANDING condition. An alarm that cries wolf is
# ignored, which destroys the value of the one true warning it exists to give.
#
# What is true of the marker now:
#   * it is written from create_video_task's on_submit hook, microseconds before
#     requests.post — every pre-POST failure (tier/resolution mismatch, an
#     unloadable reference image, prompt assembly, the admission semaphore) happens
#     before the marker exists, so none of them can be mistaken for a charge;
#   * it is DELETED on a verdict of any kind — accepted (the real task row replaces
#     it) or refused with an HTTP status (nothing was created) — AND on a proven
#     PRE-FLIGHT failure, where the request demonstrably never reached BytePlus
#     (byteplus_generative._submit_failure_phase / PHASE_PREFLIGHT);
#   * it therefore survives only when the request DID leave and no verdict came back:
#     a read timeout, a connection dropped after the write, a 5xx, a 2xx with no id
#     in it, or the process dying inside the POST. Those are genuinely ambiguous —
#     "sent it and heard nothing" looks identical to "accepted and the answer was
#     lost" — so they are all treated as possibly billed;
#   * each marker belongs to ONE attempt (unique id + project + shot + timestamp),
#     so it can never be read as evidence about a different shot;
#   * whoever reports it consumes it (resolve_submit_intent), so one ambiguous
#     submit produces exactly one warning instead of one per recovery sweep. There
#     are TWO such reporters: server.py's recovery sweep for an entry stranded at
#     'submitted', and _queue_submit_one for a submit that answered without a
#     task_id (that entry goes 'failed', which recovery never looks at).
INTENT_PREFIX = "submit-intent:"
INTENT_STATUS = "submitting"

_lock = threading.Lock()


@contextmanager
def _exclusive() -> Iterator[None]:
    """threading.Lock for the threads of this process, fcntl.flock for the other
    processes. Both are needed and neither substitutes for the other; the reasoning,
    including why the whole read-modify-write has to be inside and not just the write,
    is written out once in render_queue._exclusive() and file_lock.hold()."""
    with _lock:
        with file_lock.hold(REGISTRY_PATH):
            yield


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict[str, dict[str, Any]]:
    try:
        return json.loads(REGISTRY_PATH.read_text())
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save(data: dict[str, dict[str, Any]]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename so a crash mid-write can't truncate the registry. The tmp name
    # carries the pid: one fixed tmp path meant two processes wrote the same file and
    # the second replace() found it already renamed away (see file_lock.unique_tmp).
    # flush + fsync BEFORE the rename (storage.py's rule 3, which this file was still
    # missing): replace() is atomic in NAME only, so a crash between the write and the
    # rename publishes a directory entry pointing at unflushed bytes — a zero-length
    # registry, i.e. every in-flight PAID render orphaned with no record it existed.
    tmp = file_lock.unique_tmp(REGISTRY_PATH)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2))
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(REGISTRY_PATH)


def record(task_id: str, **fields: Any) -> None:
    """Insert (or refresh) a task. Defaults status to 'running'."""
    if not task_id:
        return
    with _exclusive():
        data = _load()
        entry = data.get(task_id, {"task_id": task_id, "created_at": _now()})
        entry.update(fields)
        entry.setdefault("status", "running")
        entry["updated_at"] = _now()
        data[task_id] = entry
        _save(data)


class Durable(NamedTuple):
    """Where a paid task's row actually landed. THREE states, not two.

    record_durable() used to return a bare str: "" for the registry taking the row and
    "" again for nothing anywhere taking it. Measured with the registry directory made
    unwritable: the caller read that "" as success, published no bus error, filed no
    /api/errors entry, and server.py logged that the task "is recorded in the render
    registry" at the exact moment nothing held it. A paid task_id vanished quietly,
    which is the one outcome this module exists to prevent.

    `where` is the state; `path` is the ledger it fell back to (only when orphaned)."""
    where: str            # "registry" | "orphaned" | "nowhere"
    path: str = ""        # the orphan ledger, when there is one
    error: str = ""       # why the registry refused the row

    @property
    def ok(self) -> bool:
        """The registry itself took the row — the reconciler will find it."""
        return self.where == "registry"

    @property
    def nowhere(self) -> bool:
        """NOTHING holds this task id. The render is billing and is unfindable."""
        return self.where == "nowhere"


def record_durable(task_id: str, **fields: Any) -> Durable:
    """record() for a task BytePlus has already accepted, i.e. one that is already being
    billed. NEVER raises. Returns a Durable naming which of the three things happened:
    the registry took the row, the orphan ledger took it, or NOTHING did.

    Plain record() can raise LockTimeout, and its callers cannot do anything useful with
    that: server.py's _create_video_impl caught it in its trailing `except Exception` and
    turned it into an HTTP 500, throwing away the task_id of a render that was already
    running and billing (measured with a peer process holding the registry lock — the id
    landed in no file at all). The money is spent by the time we get here; the id is the
    only way to ever find that render again, so this tries hard, and then writes it
    somewhere that cannot fail for the same reason.

    Retry first: LockTimeout means a peer is wedged, and a peer that is wedged now is
    often not wedged in 250 ms. Only then the ledger. Callers must dispatch this off the
    event loop like every other lock-taking call (asyncio.to_thread) — it sleeps."""
    if not task_id:
        return Durable("registry")
    last: Exception | None = None
    for attempt in range(RECORD_RETRIES):
        try:
            record(task_id, **fields)
            return Durable("registry")
        except Exception as e:
            last = e
            if attempt + 1 < RECORD_RETRIES:
                time.sleep(RECORD_RETRY_SECS)
    written = _write_orphan(task_id, str(last), fields)
    return (Durable("orphaned", written, str(last)) if written
            else Durable("nowhere", "", str(last)))


def _write_orphan(task_id: str, error: str, fields: dict[str, Any]) -> str:
    """Append one line to ORPHAN_PATH and shout. Returns the ledger path, or "" if even
    this failed — in which case the ERROR log below is all that is left, which is exactly
    why it carries every field needed to reconcile the charge by hand.

    O_APPEND, no lock, no read-modify-write: the whole point is to be writable when the
    locked path is not. drain_orphans() folds these back in on the reconciler's next
    sweep, so the render is actually finished and saved rather than merely recorded."""
    row = {"task_id": task_id, "orphaned_at": _now(), "orphan_error": error[:300], **fields}
    line = json.dumps(row) + "\n"
    written = ""
    try:
        ORPHAN_PATH.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(ORPHAN_PATH), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, line.encode())
            os.fsync(fd)        # this file exists for crashes; unflushed bytes are no record
        finally:
            os.close(fd)
        written = str(ORPHAN_PATH)
    except OSError as e:
        logger.error("[Registry] could not even append the orphan ledger %s: %s",
                     ORPHAN_PATH, e)
    logger.error(
        "[Registry] PAID TASK NOT RECORDED: %s could not be written to %s (%s). It was "
        "accepted by BytePlus and IS BILLING. Recorded instead in %s. Reconcile by hand "
        "if that file is lost: %s",
        task_id, REGISTRY_PATH, error[:200], written or "NOTHING — this log line only",
        json.dumps(row))
    return written


def drain_orphans() -> int:
    """Fold ledger lines back into the registry; return how many were adopted.

    Without this the fallback would preserve the task_id and still lose the render: the
    reconciler polls REGISTRY ROWS, so a task that only exists as a line in a text file
    is never downloaded and never saved. Called from the reconciler's sweep.

    Adoption is idempotent — record() upserts by task_id — which is what makes the
    conservative rewrite below safe."""
    if not ORPHAN_PATH.is_file():
        return 0
    adopted = 0
    try:
        # The ledger's OWN sidecar lock, deliberately not the registry's: a wedged
        # registry lock must not also wedge the file that exists because of it.
        with file_lock.hold(ORPHAN_PATH):
            size = ORPHAN_PATH.stat().st_size
            lines = ORPHAN_PATH.read_text().splitlines()
            left: list[str] = []
            stop = False
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                if stop:
                    left.append(line)
                    continue
                try:
                    row = json.loads(line)
                    tid = str(row.pop("task_id", "") or "")
                    row.pop("orphaned_at", None)
                    row.pop("orphan_error", None)
                    if not tid:
                        continue            # nothing actionable, and nothing to lose
                    record(tid, **row)
                    adopted += 1
                except file_lock.LockTimeout:
                    # Still wedged. Keep this line AND the rest — retrying each of them
                    # would burn LOCK_TIMEOUT_SECS apiece for the same answer.
                    left.append(line)
                    stop = True
                except (ValueError, TypeError, OSError):
                    left.append(line)       # unreadable line: never silently dropped
            # Rewrite ONLY if nobody appended while we worked. _write_orphan takes no
            # lock (that is the point), so truncating a file that grew mid-drain would
            # destroy the record it just made. Leaving it costs one idempotent re-record
            # on the next sweep.
            if ORPHAN_PATH.stat().st_size == size:
                with open(ORPHAN_PATH, "w", encoding="utf-8") as f:
                    f.write("".join(l + "\n" for l in left))
                    f.flush()
                    os.fsync(f.fileno())
    except Exception as e:
        logger.warning("[Registry] orphan ledger drain failed (will retry): %s", e)
    return adopted


def record_submit_intent(project_name: str = "", project_path: str = "",
                         shot_id: str = "", **fields: Any) -> str:
    """Write a submit-intent marker (see above) and return its id.

    Deliberately tiny: this runs on the hot path, microseconds before the request
    that costs money, so it must not do anything that can itself fail slowly."""
    marker_id = f"{INTENT_PREFIX}{uuid.uuid4().hex[:12]}"
    stamp = _now()
    with _exclusive():
        data = _load()
        data[marker_id] = {
            "task_id": "",          # there is none yet — that is the entire point
            "marker_id": marker_id,
            "status": INTENT_STATUS,
            "project_name": project_name,
            "project_path": project_path,
            "shot_id": shot_id,
            "created_at": stamp,
            "updated_at": stamp,
            **fields,
        }
        _save(data)
    return marker_id


def resolve_submit_intent(marker_id: str, task_id: str = "") -> None:
    """Drop a marker because the ambiguity is over.

    Call it with a task_id when BytePlus ACCEPTED (record() has already written the
    real row) and without one when BytePlus REFUSED with an HTTP status — both are
    verdicts, and a verdict means we know whether anything was created. NEVER call it
    after a timeout, a dropped connection or a process death: those are the cases the
    marker exists for, and deleting one there re-creates the lie it replaced.

    The one other legitimate caller is whoever has already REPORTED the marker onto
    something durable — server.py's recovery writes it into the queue entry's
    charge_risk/charge_note — because the warning now lives there and an un-consumed
    marker would re-raise the same one on every 5 s sweep for the life of the file."""
    if not marker_id:
        return
    with _exclusive():
        data = _load()
        if data.pop(marker_id, None) is None:
            return
        _save(data)


def submit_intents(project_path: str = "", project_name: str = "") -> list[dict[str, Any]]:
    """Unresolved markers for a project — submits that went out and never came back.
    Same path-wins-over-name precedence for_project() uses."""
    with _exclusive():
        data = _load()
    out = []
    for e in data.values():
        if e.get("status") != INTENT_STATUS:
            continue
        if project_path:
            if e.get("project_path") == project_path:
                out.append(e)
        elif project_name:
            if e.get("project_name") == project_name:
                out.append(e)
        else:
            out.append(e)
    return out


def update(task_id: str, **fields: Any) -> None:
    if not task_id:
        return
    with _exclusive():
        data = _load()
        if task_id not in data:
            return
        data[task_id].update(fields)
        data[task_id]["updated_at"] = _now()
        _save(data)


def mark_completed(task_id: str, **fields: Any) -> None:
    update(task_id, status="completed", **fields)


def mark_failed(task_id: str, error: str = "") -> None:
    update(task_id, status="failed", error=error[:500])


def get(task_id: str) -> dict[str, Any] | None:
    with _exclusive():
        return _load().get(task_id)


def active() -> list[dict[str, Any]]:
    """In-flight tasks the reconciler should still poll. Submit-intent markers are
    excluded for free (INTENT_STATUS is not in ACTIVE_STATES) and must stay that way:
    a marker has no task_id, so polling one would be a guaranteed 404 every sweep."""
    with _exclusive():
        return [e for e in _load().values() if e.get("status") in ACTIVE_STATES]


def for_project(project_path: str = "", project_name: str = "") -> list[dict[str, Any]]:
    """All tasks for a project (so the frontend can reconcile its shots on mount).
    Markers are NOT tasks — they have no task_id and nothing downstream could do
    anything with one — so they are filtered out here; read them via submit_intents()."""
    with _exclusive():
        out = []
        for e in _load().values():
            if e.get("status") == INTENT_STATUS:
                continue
            if project_path and e.get("project_path") == project_path:
                out.append(e)
            elif project_name and e.get("project_name") == project_name:
                out.append(e)
            elif not project_path and not project_name:
                out.append(e)
        return out


def prune(max_entries: int = 200) -> None:
    """Keep the file bounded — drop the oldest terminal entries past the cap."""
    with _exclusive():
        data = _load()
        if len(data) <= max_entries:
            return
        # Keep all active + the most recent terminal ones. Submit-intent markers count
        # as active: they are the ONLY evidence that a paid submit may be outstanding,
        # and they are consumed explicitly (resolve_submit_intent) rather than aged out,
        # so pruning one would silently destroy the answer to "was I billed?".
        items = sorted(data.values(), key=lambda e: e.get("updated_at", ""), reverse=True)
        keep_states = ACTIVE_STATES | {INTENT_STATUS}
        active_entries = [e for e in items if e.get("status") in keep_states]
        terminal = [e for e in items if e.get("status") not in keep_states]
        keep = active_entries + terminal[: max(0, max_entries - len(active_entries))]
        # A marker is keyed by its marker_id (it has no task_id) — task_id would collide
        # on "" and collapse every marker into one row.
        _save({(e.get("marker_id") or e["task_id"]): e for e in keep})
