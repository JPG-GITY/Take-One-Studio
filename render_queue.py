"""
B3: a persistent queue of renders WAITING TO BE SUBMITTED.

render_registry.py rescues renders that were already sent to BytePlus — the
reconciler polls them, downloads them and saves them even if the tab closed. What
nothing rescued was the SUBMISSION itself: the batch loop lived in the browser
(frontend/features/stage5-final-gen/FinalGenView.tsx), so closing the tab at shot
12 of 40 meant shots 13-40 were never sent at all. A 40-shot episode therefore
required the operator to babysit a tab for an hour.

This module is the enqueue side. The browser posts the whole batch ONCE; every job
lands here with its full /api/video/create payload, and a backend worker drains the
queue at its own pace. Once a job is submitted it leaves this file's problem domain
— the registry + reconciler own it from there.

Same discipline as render_registry.py on purpose (JSON on disk, one lock around the
whole-file read/write, write-then-rename): a queue is a few dozen entries at a time,
and matching the registry keeps the two files' failure modes identical. That lock is
now TWO locks — a threading.Lock for the threads of this process and an fcntl.flock
for the other processes on the machine; see _exclusive() and file_lock.py, and the
measured double-billing that forced it.

Statuses (wire contract C3): queued | submitted | done | failed | cancelled.
Note that claim_next() flips an entry to "submitted" BEFORE the API call, not after.
That is deliberate: if the process dies between the claim and the response we do not
know whether BytePlus accepted (and started billing) the task, and re-submitting a
paid render is the one mistake that costs the user real money; a double-submitted 4k
shot cannot be un-paid.

The cost of that ordering used to be a PERMANENT leak: an entry claimed by a process
that then died sat at "submitted" with an empty task_id and nothing could ever move
it — in_flight() requires a task_id, claim_next() only takes "queued", cancel() only
touched "queued", prune() never drops an ACTIVE_STATES entry, and there is no
re-queue endpoint. status_for().running therefore stayed true forever and the UI
(FinalGenView.tsx) polled /api/render/queue every 5 s for the life of the tab. Not a
theoretical crash either: start.sh runs uvicorn with --reload, so any file save during
development restarts the process mid-submit. recover_stalled() below closes that leak.

Recovery is itself the dangerous half: re-queueing an entry whose submit was merely SLOW
hands the same paid render to a second worker. It used to decide that on age alone, with
arithmetic that did not hold (see STALE_CLAIM_SECS). It now needs two independent proofs
of death — the claim is old AND no live worker in this process holds it (_held) — and a
claimer that wakes up after being superseded can no longer overwrite the entry (mark()).

Death is still not the same as "never submitted", though: the claim window straddles the
paid POST. So before re-queueing anything, recovery tries to ADOPT the task an earlier
submit may already have created (stranded_candidates() → server.py _recovery_evidence →
recover_stalled(evidence)), and when it cannot find one it says the charge is UNKNOWN
rather than promising nothing was billed. See CHARGE_RISKS.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import file_lock

QUEUE_PATH = Path(
    os.environ.get("TAKEONE_RENDER_QUEUE", Path.home() / ".takeone" / "render_queue.json")
)

# Entries the worker (or the user) can still act on
ACTIVE_STATES = {"queued", "submitted"}

# How long an entry may sit at "submitted" with an EMPTY task_id before we conclude the
# process that claimed it died mid-submit. Everything _create_video_impl() does before
# the Seedance POST happens inside that claim window.
#
# This number used to be the ONLY thing standing between a slow-but-alive submit and a
# double charge, and the arithmetic this comment claimed for it was FALSE. The biggest
# term in the window was unbounded: claude_agents.py builds anthropic.Anthropic(api_key)
# with the SDK's own defaults, measured on anthropic 0.107.1 as
# Timeout(connect=5, read=600, write=600, pool=600) with max_retries=2 — 3 x 600 =
# 1800 s for ONE call, already double this grace. And the submit path makes TWO such
# calls: server.py vision_video_prompt, then video_direction when that one throws.
# 3600 s of legal, still-working submit against a 900 s grace. Proven consequence:
# recover_stalled() re-queued a LIVE claim, the worker claimed it again (attempts=2) and
# submitted a SECOND PAID RENDER; both task_ids went into render_registry and were
# billed, while the slow caller's late mark() overwrote the entry so the queue showed
# only one of them.
#
# Two things fixed that, and NEITHER of them is this number:
#   1. _held below — an entry a live worker in THIS process is holding is never
#      recovered, at any age. That closes the same-process race outright, and a process
#      restart empties the set, which is exactly and only when recovery should fire.
#   2. claude_agents.SUBMIT_PATH_TIMEOUT_SECS / _MAX_RETRIES / _IMAGE_FETCH_SECS — the
#      two Claude calls and the reference-image fetches now carry explicit per-request
#      budgets instead of the SDK defaults.
#
# That replacement arithmetic was ALSO short, by a whole term. It stopped at the
# Seedance POST and never counted what create_video_task does BEFORE it: every
# reference and the dialogue clip are turned into base64 data URIs one at a time
# (byteplus_generative._url_to_data_uri, timeout=30 s each), and in reference/t2v mode
# that is up to 9 images plus 1 audio. 300 s, inside the claim window, omitted.
#
# Real worst case inside the window, with the omitted term restored:
#   Claude prompt calls     2 calls x (1 + 1 retry) x 90 s = 360 s  (claude_agents.py)
#   reference-image fetch   <= 9 refs x 20 s               = 180 s  (_image_block)
#   Seedance data-URI pulls (9 refs + 1 audio) x 30 s      = 300 s  (_url_to_data_uri)
#   Seedance submit POST    30 s + one 30 s legacy retry   =  60 s  (byteplus_generative)
#                                                            -----
#                                                            900 s
# 900 s of BOUNDED work against a 900 s grace: zero margin, and that is before the two
# terms nothing here can bound — the Seed Audio dialogue clip (one request per line,
# seed_audio timeouts 120-180 s each: 5 lines x 180 s = 900 s on its own) and the wait
# on the Seedance admission semaphore (server.py _get_video_sem — 10 non-4k slots, 1 at
# 4k, so a 4k pass queues behind whole renders' submits). The old 900 was therefore not
# a grace at all; a perfectly healthy submit could cross it.
#
#   1800 s = 900 (bounded, above) + 900 (5 dialogue lines x 180 s).
#
# The semaphore wait is still outside the number and always will be. It is survivable
# because of (1): the process working on the entry holds it in _held and recovery skips
# it at any age. This number is the floor for the case _held cannot see — a claim left
# by a process that is genuinely gone, or one held by a SECOND drainer that this
# process's _held knows nothing about (see announce_worker).
#
# The asymmetry stays on purpose: waiting too long only means a truly stranded entry
# clears half an hour late, while acting too early used to pay twice. It no longer pays
# twice on its own — recover_stalled() now tries to ADOPT the task an earlier submit
# already created before it re-queues anything — but adoption depends on finding that
# task, and the grace is what makes finding it unnecessary in the first place.
STALE_CLAIM_SECS = int(os.environ.get("TAKEONE_QUEUE_STALE_SECS", "1800"))

# How many times one entry may be claimed at all. Without a bound, a job that reliably
# kills the process (an oversized payload, a segfault in a dependency) would be
# re-queued, kill the process again, and loop for as long as the operator keeps
# restarting the server. Two claims = one retry, then it fails loudly with the reason.
MAX_CLAIM_ATTEMPTS = 2

# What may honestly be said about MONEY for an entry stranded in the claim window.
#
# The old copy was "Nothing was billed for it; re-queue the shot if you still want it."
# That is false in the one case that costs anything: a process that died AFTER BytePlus
# accepted the submit but BEFORE mark() recorded the task_id leaves an entry byte-for-byte
# identical to one that died before the POST. The queue cannot tell them apart, so it may
# not claim the negative — and a user who believes it re-queues and pays a second time.
#
#   ""          nothing to say (the entry never left "queued")
#   "adopted"   recovery FOUND the task an earlier submit created; it was adopted rather
#               than re-submitted, so there is exactly one charge
#   "unknown"   stranded, no evidence either way — the honest default
#   "likely"    a submit-intent marker survived (render_registry.INTENT_STATUS): the POST
#               went out and never got a verdict, so a render may be running and billing
#   "duplicate" PROVEN: a superseded claim filed a task_id of its own, so two paid tasks
#               exist for this one shot
CHARGE_RISKS = ("", "adopted", "unknown", "likely", "duplicate")
# Risks worth interrupting the operator for. "unknown" is real but unactionable noise on
# every re-queue; it rides in the note instead of the banner.
CHARGE_RISKS_ALARMING = {"likely", "duplicate"}

# Default note when nothing was found either way. Names WHERE to look and WHEN, because
# "a charge may exist" the user cannot act on is only marginally better than the lie.
# Weakest → strongest. Recovery may RAISE an entry's risk but never lower it: the
# evidence for a stranding is CONSUMED once reported (render_registry.resolve_submit_
# intent), so a second stranding of the same entry finds nothing and would otherwise
# walk a "likely" back to "unknown" — quietly retracting a warning that was true.
_RISK_RANK = {"": 0, "adopted": 0, "unknown": 1, "likely": 2, "duplicate": 3}

CHARGE_NOTE_UNKNOWN = (
    "A charge MAY already exist for this shot: it was handed to BytePlus and no task id "
    "came back, so an accepted render and a refused one look the same from here. Before "
    "re-queueing, list the account's recent tasks (GET /api/video/tasks, or the ModelArk "
    "console task list) and look for one created around {claimed_at}."
)

_lock = threading.Lock()


@contextmanager
def _exclusive() -> Iterator[None]:
    """The lock every read-modify-write of QUEUE_PATH runs under. BOTH halves are
    required and neither substitutes for the other:

      * threading.Lock serialises the threads of this process. flock cannot: it
        belongs to the open file description, and file_lock caches one fd per file,
        so two threads would both "acquire" it and the first to leave would unlock
        the other (see file_lock.hold).
      * flock serialises the PROCESSES. threading.Lock cannot even see them, and
        ~/.takeone/render_queue.json is shared by every Take One Studio on the machine.
        Measured with two plain processes draining 20 jobs: 4-10 entries claimed
        TWICE, each claim a second paid render, plus 7-20 FileNotFoundError crashes
        out of _save() and whole entries erased by the losing whole-file write.

    It wraps the whole critical section — the _load(), the mutation and the _save()
    — because locking only the write leaves the two processes free to interleave
    read/read/write/write, which is exactly the sequence that lost those entries.

    On contention past file_lock.LOCK_TIMEOUT_SECS this raises LockTimeout instead
    of proceeding unlocked: an unlocked write here costs the user money."""
    with _lock:
        with file_lock.hold(QUEUE_PATH):
            yield


# Entry ids a LIVE worker coroutine in THIS process is holding right now. Added under
# the lock by claim_next(), removed by release() from the worker's finally (server.py
# _queue_submit_one). recover_stalled() and cancel() skip anything in here NO MATTER HOW
# OLD the claim is: the owner is demonstrably alive, and the claim window legitimately
# outlives STALE_CLAIM_SECS (see the arithmetic above). This is the primary fix for the
# double-submit — the timeouts in claude_agents.py only shrink the window, this makes the
# same-process race impossible. It is deliberately IN MEMORY: a process that dies takes
# its held set with it, so the entries it abandoned become recoverable again the moment
# the new process starts, which is precisely when recovery is correct.
#
# That last property is also its limit, and the file lock does NOT lift it: a SECOND
# live process cannot see this set either, so its recover_stalled() would read an entry
# this process is legitimately still submitting as abandoned and hand it out again.
# Only one process may drain the queue — server.py's lifespan refuses WEB_CONCURRENCY>1
# and warns when announce_worker() finds a live peer.
_held: set[str] = set()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> dict[str, dict[str, Any]]:
    try:
        return json.loads(QUEUE_PATH.read_text())
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save(data: dict[str, dict[str, Any]]) -> None:
    QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Write-then-rename so a crash mid-write can't truncate the queue. The tmp name
    # carries the pid: it used to be one fixed path, so two processes wrote the same
    # file and one's replace() found it already renamed away — FileNotFoundError
    # raised straight out of claim_next() (see file_lock.unique_tmp).
    # flush + fsync BEFORE the rename (storage.py's rule 3, which this file was still
    # missing): replace() is atomic in NAME only, so between the two the new directory
    # entry points at bytes that are still only in the page cache. A crash or a power
    # cut there publishes a ZERO-LENGTH queue — every job the user is waiting on
    # forgotten, and this is one of the two files where that costs money.
    tmp = file_lock.unique_tmp(QUEUE_PATH)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, indent=2))
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(QUEUE_PATH)


def _matches(entry: dict[str, Any], project_name: str, project_path: str) -> bool:
    """Project scoping, same precedence the registry uses: path wins, name is the
    fallback for callers that only know the project by name."""
    if project_path:
        return entry.get("project_path") == project_path
    if project_name:
        return entry.get("project_name") == project_name
    return True


def _is_stranded(entry: dict[str, Any]) -> bool:
    """"submitted" with no task_id — the claim window of claim_next(). A submit that
    actually reached BytePlus ALWAYS ends up with a task_id (server.py
    _queue_submit_one marks "submitted" with one, or "failed"), so an empty one means
    the entry is either in the middle of being submitted right now, or was abandoned
    there by a process that died. Age (below) is what separates those two."""
    return entry.get("status") == "submitted" and not entry.get("task_id")


def _claim_age_secs(entry: dict[str, Any], now: datetime) -> float:
    """Seconds since claim_next() stamped this entry. An entry with no (or unparseable)
    claimed_at reads as infinitely old on purpose: this process always writes the stamp
    when it claims, so a missing one can only come from an older build's file, and such
    an entry is by definition not a submit anyone is still working on."""
    try:
        claimed = datetime.fromisoformat(entry.get("claimed_at") or "")
    except (TypeError, ValueError):
        return float("inf")
    if claimed.tzinfo is None:
        claimed = claimed.replace(tzinfo=timezone.utc)
    return (now - claimed).total_seconds()


def _ordered(data: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """FIFO: enqueue order within a batch, then batch order. `seq` is the index the
    job had in its POST body, so the episode renders front-to-back rather than in
    whatever order dict iteration happens to yield."""
    return sorted(data.values(), key=lambda e: (e.get("created_at", ""), e.get("seq", 0)))


def enqueue(project_name: str, project_path: str, jobs: list[dict[str, Any]]) -> str:
    """Append a batch. `jobs` are FULL /api/video/create bodies — the worker replays
    them verbatim, so nothing about the render depends on the browser still existing.
    Returns the queue_id shared by the batch."""
    queue_id = uuid.uuid4().hex[:12]
    stamp = _now()
    with _exclusive():
        data = _load()
        for i, job in enumerate(jobs):
            entry_id = f"{queue_id}-{i:03d}"
            data[entry_id] = {
                "entry_id": entry_id,
                "queue_id": queue_id,
                "seq": i,
                "project_name": project_name,
                "project_path": project_path,
                "shot_id": str((job or {}).get("shot_id") or ""),
                "status": "queued",
                "task_id": "",
                "error": "",
                "attempts": 0,
                "job": job,
                "created_at": stamp,
                "updated_at": stamp,
            }
        _save(data)
    return queue_id


def claim_next() -> dict[str, Any] | None:
    """Take the oldest queued entry and flip it to 'submitted' under the lock, so two
    concurrent worker slots can never claim the same (paid) job. Returns a COPY of the
    entry — the caller submits it and then calls mark() with the outcome, passing back
    the entry's claim_token, and MUST call release() in a finally when it is done."""
    with _exclusive():
        data = _load()
        for entry in _ordered(data):
            if entry.get("status") != "queued":
                continue
            entry["status"] = "submitted"
            # attempts + claimed_at are what recover_stalled() reads: the stamp says
            # how long this claim has been open (so a live-but-slow submit is not
            # snatched away from the caller), the counter bounds how many times the
            # same entry may be handed out before it is failed instead.
            entry["attempts"] = int(entry.get("attempts") or 0) + 1
            entry["claimed_at"] = _now()
            # Receipt for THIS claim. A new claim mints a new one, which is how mark()
            # tells the current claimer from a superseded one that woke up late.
            entry["claim_token"] = uuid.uuid4().hex[:12]
            entry["updated_at"] = _now()
            data[entry["entry_id"]] = entry
            _save(data)
            # Under the same lock as the write, so no sweep can observe the entry as
            # claimed-but-not-held and re-queue it in the gap.
            _held.add(entry["entry_id"])
            return dict(entry)
        return None


def release(entry_id: str) -> None:
    """Give back a claim this process was holding (see _held). MUST run in a finally in
    the worker: an entry left in _held after its worker is gone would be immune to
    recover_stalled() for the life of the process — the same permanent leak this file
    exists to close, just with a different cause."""
    if not entry_id:
        return
    # Plain _lock, not _exclusive(): _held is memory, this touches no file, and the
    # file lock has a timeout that RAISES. A raise here runs inside _queue_submit_one's
    # finally and would leave the entry held forever — the exact permanent leak this
    # docstring is about.
    with _lock:
        _held.discard(entry_id)


def is_held(entry_id: str) -> bool:
    """Is this entry being worked on by a live worker in THIS process? Exposed for the
    worker's logging and for tests that need to prove the held set is what stops
    recovery (recover_stalled() reads _held directly)."""
    with _lock:   # memory only — see release()
        return entry_id in _held


def announce_worker() -> list[int]:
    """Heartbeat this process against the queue file; return the OTHER live pids on it.

    The queue tolerates concurrent WRITERS now (that is what _exclusive() buys), but it
    still tolerates exactly one DRAINER: _held is in-memory, so a second process's
    recover_stalled() cannot tell an entry this one is legitimately still submitting
    from one a dead process abandoned, and re-queueing a live claim pays for the shot
    twice. Nothing in the environment can detect that second drainer — WEB_CONCURRENCY
    is blind to `uvicorn --workers N` and to a second server on another port — but the
    lockfile can, since every drainer already opens it. server.py calls this at startup
    and on every sweep so the operator gets a loud warning instead of a silent double
    charge."""
    with _exclusive():
        return file_lock.announce(QUEUE_PATH)


def mark(entry_id: str, status: str, claim_token: str = "", **fields: Any) -> bool:
    """Write an outcome. Returns False when nothing was written.

    `claim_token` is the receipt claim_next() handed the caller. When it is supplied and
    no longer matches the entry's, this caller's claim was SUPERSEDED — recover_stalled()
    re-queued the entry and someone else claimed it (or failed it) while this caller was
    still inside its submit. This used to be written blindly, so the slow caller's late
    mark() overwrote the second claim's task_id with its own: BOTH renders had been
    submitted and billed (server.py _create_video_impl records every task_id in
    render_registry) but the queue only ever showed one, which made the double charge
    invisible. Now the live claim's outcome stands and the orphan is APPENDED to
    `superseded` instead of thrown away, so the operator can see what was paid for.

    An empty claim_token means "not speaking for a claim" — that is _queue_sync_terminal
    promoting an already-submitted entry from the registry, which is not racing anyone.
    """
    if not entry_id:
        return False
    with _exclusive():
        data = _load()
        if entry_id not in data:
            return False
        entry = data[entry_id]
        if claim_token and claim_token != entry.get("claim_token", ""):
            entry.setdefault("superseded", []).append({
                "at": _now(),
                "status": status,
                "claim_token": claim_token,
                "task_id": str(fields.get("task_id") or ""),
                "error": str(fields.get("error") or "")[:200],
            })
            _save(data)
            return False
        entry["status"] = status
        entry.update(fields)
        entry["updated_at"] = _now()
        _save(data)
    return True


def in_flight() -> list[dict[str, Any]]:
    """Entries already submitted to BytePlus that still have no terminal outcome. The
    worker walks these against the render registry to promote them to done/failed —
    the queue itself never polls BytePlus, the reconciler already does."""
    with _exclusive():
        return [e for e in _load().values()
                if e.get("status") == "submitted" and e.get("task_id")]


def _recoverable(entry: dict[str, Any], now: datetime) -> bool:
    """The three-part test recovery acts on, in one place so stranded_candidates() and
    recover_stalled() cannot drift apart — they are two halves of one decision, run a
    network round trip apart, and a candidate the second half no longer recognises would
    silently drop its adoption on the floor."""
    return (_is_stranded(entry)
            # a LIVE worker owns this one — age says nothing, see _held
            and entry.get("entry_id") not in _held
            # could still be a live submit — never race one, it costs money
            and _claim_age_secs(entry, now) >= STALE_CLAIM_SECS)


def stranded_candidates() -> tuple[list[dict[str, Any]], set[str]]:
    """What recover_stalled() would act on right now, plus every task_id the queue
    already owns. Job payloads are dropped — the caller only needs the identity.

    Split out of recover_stalled() so the caller can go LOOK FOR THE TASK before
    anything is re-submitted (server.py _recovery_evidence): that lookup reads the render
    registry and may call BytePlus, and neither may happen under _exclusive() — the queue
    lock would be held across a network round trip, on the event-loop thread, while every
    status poll and claim blocks behind it.

    The returned task_id set is what stops an adoption from stealing a task another entry
    is already tracking: two queue entries pointing at one render would have the second
    shot silently saved with the first one's video.
    """
    now = datetime.now(timezone.utc)
    with _exclusive():
        data = _load()
        cands = [{k: v for k, v in e.items() if k != "job"}
                 for e in _ordered(data) if _recoverable(e, now)]
        bound = {str(e.get("task_id") or "") for e in data.values() if e.get("task_id")}
    return cands, bound


def recover_stalled(evidence: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Rescue entries a dead process stranded inside the claim window.

    claim_next() flips an entry to "submitted" before the API call, and nothing else in
    this file can move it back: in_flight() needs a task_id, claim_next() only takes
    "queued", prune() never drops an ACTIVE_STATES entry. So "submitted" + empty task_id
    + a claim older than STALE_CLAIM_SECS means whoever claimed it is gone.

    What it does NOT mean is that nothing was submitted. The stranding window straddles
    the paid call: a process killed after BytePlus accepted the task but before mark()
    wrote the task_id leaves exactly the same entry as one killed before the POST. Blindly
    re-queueing it hands a second worker a shot that is already rendering and BILLED.

    So the entry is ADOPTED before it is re-queued: `evidence[entry_id]["adopt_task_id"]`
    is a task the caller proved belongs to this project+shot (server.py _recovery_evidence
    matches on render_registry's project_path/project_name/shot_id keys, inside the claim
    window). Adopting attaches it and hands the entry straight to the existing reconciler
    — one render, one charge, and the shot still lands.

    Only when nothing can be adopted does the old behaviour apply: re-queue, bounded by
    MAX_CLAIM_ATTEMPTS, past which the entry fails. Both outcomes carry the honest
    `charge_risk`/`charge_note` from the evidence (see CHARGE_RISKS) instead of the
    "Nothing was billed for it" this function used to assert.

    Age alone was never proof of death, only of slowness — see the arithmetic at
    STALE_CLAIM_SECS. _held is the proof: an entry a live worker in this process is
    still submitting is skipped here no matter how old its claim is.

    Returns {"requeued": n, "failed": n, "adopted": n, "entry_ids": [...]} — the ids so
    the caller can consume the evidence it spent (render_registry.resolve_submit_intent),
    which is what keeps one ambiguous submit from warning once per sweep forever.
    """
    now = datetime.now(timezone.utc)
    ev = evidence or {}
    out: dict[str, Any] = {"requeued": 0, "failed": 0, "adopted": 0, "entry_ids": []}
    with _exclusive():
        data = _load()
        for entry in data.values():
            if not _recoverable(entry, now):
                continue
            eid = str(entry.get("entry_id") or "")
            found = ev.get(eid) or {}
            adopt = str(found.get("adopt_task_id") or "")
            note = str(found.get("note") or "")
            risk = str(found.get("risk") or "unknown")
            # Never retract a stronger verdict this entry already carries (_RISK_RANK).
            # NOT applied to an adoption: finding the task is what RESOLVES an earlier
            # "likely", so carrying that note forward would warn about a charge we have
            # just accounted for.
            was = str(entry.get("charge_risk") or "")
            if not adopt and _RISK_RANK.get(risk, 0) < _RISK_RANK.get(was, 0):
                risk, note = was, str(entry.get("charge_note") or note)
            if adopt:
                # The shot IS already rendering. Attach the task and let the reconciler
                # finish it — in_flight()/_queue_sync_terminal take it from here exactly
                # as if this claim had succeeded, because as far as BytePlus knows, it did.
                entry["status"] = "submitted"
                entry["task_id"] = adopt
                entry["adopted_task"] = True
                entry["charge_risk"] = "adopted"
                entry["charge_note"] = note or (
                    f"Recovered without re-submitting: task {adopt} was already accepted "
                    "for this shot, so it was adopted instead of paid for twice.")
                entry["error"] = ""
                out["adopted"] += 1
            elif int(entry.get("attempts") or 0) >= MAX_CLAIM_ATTEMPTS:
                entry["status"] = "failed"
                entry["charge_risk"] = risk
                entry["charge_note"] = note or CHARGE_NOTE_UNKNOWN.format(
                    claimed_at=entry.get("claimed_at") or "the time it was claimed")
                # Kept short because `error` is capped at 500 and is what the UI shows
                # inline; the actionable half lives in charge_note, which is not capped.
                entry["error"] = (
                    f"submission never completed after {MAX_CLAIM_ATTEMPTS} attempts — the "
                    "server died between claiming this shot and hearing back from BytePlus "
                    "each time, and no task for it could be found to adopt. Whether it was "
                    "billed is UNKNOWN — check before re-queueing."
                )[:500]
                out["failed"] += 1
            else:
                entry["status"] = "queued"
                entry["claimed_at"] = ""
                # The risk RIDES the re-queue. If the first submit did reach BytePlus, the
                # retry about to happen is the second charge, and that is precisely what
                # the operator has to be able to see afterwards.
                entry["charge_risk"] = risk
                entry["charge_note"] = note or CHARGE_NOTE_UNKNOWN.format(
                    claimed_at=entry.get("claimed_at") or "the time it was claimed")
                out["requeued"] += 1
            entry["updated_at"] = _now()
            out["entry_ids"].append(eid)
        if out["entry_ids"]:
            _save(data)
    return out


def duplicate_task_ids(entry: dict[str, Any]) -> list[str]:
    """task_ids of submits that were PAID FOR but lost the entry.

    mark() files a superseded claim's outcome under `superseded` instead of letting it
    overwrite the live claim's — which is the only reason the second task_id survives at
    all. Until now it survived ONLY in the JSON and one logger.error line, so a duplicate
    4k charge was invisible to the person paying for it. A superseded record with no
    task_id never reached BytePlus and is not money, so it is not listed."""
    seen: set[str] = set()
    out: list[str] = []
    for s in entry.get("superseded") or []:
        tid = str((s or {}).get("task_id") or "")
        if tid and tid != entry.get("task_id") and tid not in seen:
            seen.add(tid)
            out.append(tid)
    return out


def _charge_risk_of(entry: dict[str, Any]) -> str:
    """'duplicate' outranks whatever recovery wrote: a superseded task_id is PROOF that
    a second render was accepted and billed, not a suspicion about one."""
    if duplicate_task_ids(entry):
        return "duplicate"
    return str(entry.get("charge_risk") or "")


def status_for(project_name: str = "", project_path: str = "") -> dict[str, Any]:
    """C3 status payload for one project. `running` means the worker still has work
    here — anything queued or in flight — which is what the UI needs to decide
    whether to keep polling.

    Also carries what the queue knows about MONEY per shot (charge_risk / charge_note /
    duplicate_task_ids, see CHARGE_RISKS). That was previously buried in the queue JSON
    and the server log, so the UI could tell a user a shot "failed" while a render it
    had already paid for was still going."""
    with _exclusive():
        entries = [e for e in _ordered(_load()) if _matches(e, project_name, project_path)]
    counts = {"queued": 0, "submitted": 0, "done": 0, "failed": 0}
    for e in entries:
        st = e.get("status", "")
        if st in counts:
            counts[st] += 1
    # The queue_id of the most recent batch for this project — the one a status poll
    # started right after an enqueue is asking about.
    queue_id = entries[-1].get("queue_id", "") if entries else ""
    wire = [
        {"shot_id": e.get("shot_id", ""), "status": e.get("status", ""),
         "task_id": e.get("task_id", ""), "error": e.get("error", ""),
         "charge_risk": _charge_risk_of(e),
         "charge_note": str(e.get("charge_note") or ""),
         "duplicate_task_ids": duplicate_task_ids(e)}
        for e in entries
    ]
    return {
        "queue_id": queue_id,
        "running": any(e.get("status") in ACTIVE_STATES for e in entries),
        "entries": wire,
        "counts": counts,
        # How many shots the operator should actually go look at a bill for. Only the
        # evidenced risks count — "unknown" is true of every recovered entry and would
        # turn the badge into wallpaper.
        "charges_at_risk": sum(1 for w in wire if w["charge_risk"] in CHARGE_RISKS_ALARMING),
    }


def cancel(project_name: str = "", project_path: str = "") -> dict[str, int]:
    """Cancel everything NOT yet sent, and only that. An entry already submitted is a
    render BytePlus is billing for; dropping it from the queue would just orphan the
    result the reconciler is about to save.

    "Not yet sent" also covers an entry stranded in the claim window (same test recovery
    uses, _recoverable). Cancel is exactly what a user reaches for when the queue looks
    frozen, and leaving those behind meant the button visibly did nothing while `running`
    stayed true. An entry in _held is not frozen — its worker may be POSTing to BytePlus
    this second, so cancelling it would either lose a render the user is billed for or be
    silently undone by the worker's mark().

    Returns {"cancelled": n, "at_risk": m}. `at_risk` is the stranded subset, and it is
    reported separately because those two groups mean opposite things about money: a
    "queued" entry was never sent and is free to drop, a stranded one was handed to
    BytePlus with no verdict and may be rendering right now. The endpoint used to say
    "nothing was billed for them" about both."""
    now = datetime.now(timezone.utc)
    with _exclusive():
        data = _load()
        out = {"cancelled": 0, "at_risk": 0}
        for entry in data.values():
            if not _matches(entry, project_name, project_path):
                continue
            stranded = _recoverable(entry, now)
            if entry.get("status") != "queued" and not stranded:
                continue
            entry["status"] = "cancelled"
            if stranded:
                entry["charge_risk"] = entry.get("charge_risk") or "unknown"
                entry["charge_note"] = entry.get("charge_note") or CHARGE_NOTE_UNKNOWN.format(
                    claimed_at=entry.get("claimed_at") or "the time it was claimed")
                out["at_risk"] += 1
            entry["updated_at"] = _now()
            out["cancelled"] += 1
        if out["cancelled"]:
            _save(data)
        return out


def prune(max_entries: int = 400) -> None:
    """Keep the file bounded — drop the oldest terminal entries past the cap. Higher
    cap than the registry's: one enqueue is a whole episode (40+ entries), and each
    entry carries its full job payload, so a handful of batches must still fit."""
    with _exclusive():
        data = _load()
        if len(data) <= max_entries:
            return
        items = sorted(data.values(), key=lambda e: e.get("updated_at", ""), reverse=True)
        active_entries = [e for e in items if e.get("status") in ACTIVE_STATES]
        terminal = [e for e in items if e.get("status") not in ACTIVE_STATES]
        keep = active_entries + terminal[: max(0, max_entries - len(active_entries))]
        _save({e["entry_id"]: e for e in keep})
