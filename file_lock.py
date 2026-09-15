"""The CROSS-PROCESS half of the lock on render_queue.json / render_registry.json.

Both of those modules serialise their whole-file read-modify-write with a
threading.Lock. That is process-local, and the files are not: they default to
~/.takeone/*.json, shared by every Take One Studio process on the machine. Measured, not
theorised — two plain python processes enqueued 20 jobs and drained the queue
concurrently:

  * 4-10 of 20 entries were claimed by BOTH processes, each with its own
    claim_token. Every one of those is a SECOND PAID Seedance render.
  * 7-20 FileNotFoundError crashes out of claim_next() -> _save(), because the tmp
    filename was fixed ("render_queue.json.tmp") and the two processes' replace()
    calls raced for the same path — one unlinked the other's tmp mid-flight.
  * whole entries silently vanished (one run claimed only 6 distinct of 20): each
    _save() writes the FULL file from a snapshot read before the other process's
    write, so the loser's mutations are erased. Those shots are never rendered and
    nothing reports it.

`_held` cannot see any of this — it is an in-memory set, so it is blind by
construction to a second process. Neither can the WEB_CONCURRENCY guard in
server.py's lifespan: it reads an env var, which says nothing about
`uvicorn --workers N` or about a second server started on another port.

So: fcntl.flock on a sidecar lockfile, held around the ENTIRE critical section
(read -> mutate -> write). Locking only the write would not help — the two
processes still interleave read/read/write/write and the second write wins.

flock is the right primitive here because the kernel releases it when the process
dies or the fd closes, so there is no such thing as a stale lockfile to clean up —
which matters for a queue whose whole reason to exist is surviving crashes.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

# How long a caller may wait for another PROCESS to finish its read-modify-write.
#
# NON-BLOCKING + retry, deliberately, rather than a plain blocking flock, so that a
# peer that wedges while holding the lock cannot make this process wait on it
# FOREVER. Be precise about what that buys, because the comment here used to claim
# more: the retry loop below still BLOCKS THE CALLING THREAD, with time.sleep, for as
# long as the peer holds the lock. It bounds the freeze at LOCK_TIMEOUT_SECS; it does
# not remove it.
#
# Removing it is the CALLER's job, and it is not optional: every call into
# render_queue / render_registry from a coroutine goes through asyncio.to_thread, so
# the wait happens on a worker thread and the event loop keeps serving. That was
# measured the hard way — these calls used to run straight on the loop
# (render_queue.claim_next()/.mark()/.prune(), render_registry.record()), and a peer
# holding the queue lock for 3 s produced a 2.81 s gap in a 10 ms heartbeat: the whole
# server stalled, every request, for as long as the peer held it. Nothing in this
# module can detect that mistake, so if you add a caller, dispatch it off the loop.
#
# 15 s is enormous for what it guards — parsing and rewriting a few dozen JSON
# entries is single-digit milliseconds — and it is deliberately far above any real
# contention, because the callers that CANNOT tolerate a raise are the ones that
# have already paid for a render (render_registry.record() runs right after the
# Seedance POST is accepted; losing that write orphans a billed task). Hitting this
# timeout means something is genuinely wedged, and then failing loudly beats both
# waiting forever and writing without the lock. Loudly is not the same as safely:
# the paid paths wrap these writes in a retry and an append-only fallback
# (render_registry.record_durable) precisely because a raise here still lands on a
# task_id that is already being billed.
LOCK_TIMEOUT_SECS = float(os.environ.get("TAKEONE_FILE_LOCK_TIMEOUT", "15"))
_POLL_SECS = 0.005

# A peer counts as live only if its pid still exists AND its heartbeat is this
# fresh. Both halves are needed: pids get recycled, and a process killed with
# SIGKILL never gets to remove its own entry.
PEER_TTL_SECS = int(os.environ.get("TAKEONE_PEER_TTL_SECS", "90"))


class LockTimeout(TimeoutError):
    """Another process held the file lock past LOCK_TIMEOUT_SECS."""


# One long-lived fd per guarded file, per process. Reopening per call would be
# correct too but strictly worse: closing ANY fd on a file drops every flock this
# process holds on it, so a short-lived fd in one thread can silently unlock a
# critical section another thread is inside.
_fds: dict[str, int] = {}
_fds_guard = threading.Lock()


def lock_path(path: Path | str) -> Path:
    """The sidecar this file is locked through. Never the data file itself: _save()
    replaces that one by rename, and a rename swaps the inode — every process still
    flocking the old inode would think it holds a lock on a file nobody reads."""
    return Path(str(path) + ".lock")


def _lock_fd(path: Path | str) -> int:
    key = str(path)
    with _fds_guard:
        fd = _fds.get(key)
        if fd is None:
            lp = lock_path(path)
            lp.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(lp), os.O_RDWR | os.O_CREAT, 0o644)
            _fds[key] = fd
        return fd


@contextmanager
def hold(path: Path | str) -> Iterator[int]:
    """Hold the cross-process lock for `path` for the whole `with` body.

    BLOCKS THE CALLING THREAD while a peer holds it (time.sleep, up to
    LOCK_TIMEOUT_SECS, then LockTimeout). Never call this — or anything that calls it —
    from a coroutine without asyncio.to_thread; see the note at LOCK_TIMEOUT_SECS and
    the 2.81 s event-loop stall it cost.

    CALLERS MUST ALREADY HOLD THEIR MODULE'S threading.Lock. flock does NOT
    serialise threads inside one process: the lock belongs to the open file
    description, and every thread here shares the one cached fd, so a second
    thread's LOCK_EX|LOCK_NB on that fd succeeds immediately instead of waiting —
    and worse, its LOCK_UN on the way out would unlock the first thread's critical
    section. threading.Lock outside, flock inside; that ordering is also why the
    two locks can never deadlock against each other.
    """
    fd = _lock_fd(path)
    deadline = time.monotonic() + LOCK_TIMEOUT_SECS
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError as e:
            if e.errno not in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                raise
            if time.monotonic() >= deadline:
                raise LockTimeout(
                    f"another process held the lock on {path} for more than "
                    f"{LOCK_TIMEOUT_SECS:g}s"
                )
            time.sleep(_POLL_SECS)
    try:
        yield fd
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)


def announce(path: Path | str, ttl_secs: int = PEER_TTL_SECS) -> list[int]:
    """Heartbeat this process against `path`; return the OTHER live pids using it.

    MUST be called inside hold(path) — it rewrites the lockfile's body, and only the
    lock makes that read-modify-write safe.

    This exists because no env var can answer "is a second Take One Studio touching this
    file right now?". The lockfile can: every process that writes the queue already
    opens it, so stamping a pid + timestamp in it costs nothing and catches exactly
    the cases the WEB_CONCURRENCY check is blind to — `uvicorn --workers N`, and a
    second server the operator started on another port.

    The body is written IN PLACE (seek/truncate/write on the locked fd). It must
    never be replaced by rename or unlinked: the flock lives on the inode, and
    swapping it would leave two processes locking two different inodes, i.e. no lock
    at all.
    """
    fd = _lock_fd(path)
    now = time.time()
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, 65536).decode() or "{}"
        seen: dict[str, Any] = json.loads(raw)
        if not isinstance(seen, dict):
            seen = {}
    except (OSError, ValueError, UnicodeDecodeError):
        seen = {}

    peers: list[int] = []
    fresh: dict[str, Any] = {}
    for pid_s, beat in seen.items():
        try:
            pid = int(pid_s)
            last = float((beat or {}).get("ts") or 0)
        except (TypeError, ValueError):
            continue
        if pid == os.getpid() or now - last > ttl_secs:
            continue
        try:
            os.kill(pid, 0)          # signal 0 = liveness probe, sends nothing
        except ProcessLookupError:
            continue                 # died without cleaning up (SIGKILL, crash)
        except PermissionError:
            pass                     # alive, just owned by another user
        except OSError:
            continue
        fresh[pid_s] = beat
        peers.append(pid)

    fresh[str(os.getpid())] = {"ts": now, "at": datetime.now(timezone.utc).isoformat()}
    body = json.dumps(fresh).encode()
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    os.write(fd, body)
    return sorted(peers)


def unique_tmp(path: Path) -> Path:
    """A per-process tmp name for the write-then-rename in _save().

    The tmp name used to be fixed, so two processes wrote the same
    "render_queue.json.tmp" and one's replace() ran after the other had already
    renamed it away: 7-20 FileNotFoundError crashes inside claim_next() per 20-job
    run. The pid makes the intermediate file private to the writer; the rename onto
    the real path stays atomic, and the lock above is what orders the renames."""
    return path.with_name(f"{path.name}.tmp.{os.getpid()}")
