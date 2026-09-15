"""
P5: Local filesystem storage for Take One Studio projects.
Runs on the user's machine — ~/Documents/TakeOne-Project is their disk, not a server's.
"""

from pathlib import Path
import base64, itertools, json, logging, math, os, re, shutil, subprocess, threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

import file_lock

# This module had NO logger at all, so every non-fatal write failure below was
# invisible: a full disk, a read-only folder or a corrupt json left the pointer
# stale and produced no trace anywhere to diagnose it from. The bookkeeping stays
# non-fatal — the generated file itself is what matters — but it is now audible.
logger = logging.getLogger(__name__)

# Default storage root for projects WITHOUT an explicit folder. This must NEVER
# be the repo directory: new projects were silently saving into the git worktree
# (and the folder browser suggested it). Generated data lives in TakeOne-Project.
TAKEONE_ROOT = Path(os.environ.get("TAKEONE_HOME", Path.home() / "Documents" / "TakeOne-Project"))

# F2c: pointer to the project that was last worked on. It lives in the app's OWN state
# directory (~/.takeone — where render_registry.json and render_queue.json already are),
# NEVER inside a project folder: the whole point is to be readable when nothing knows
# which folder to look in. Env-overridable like the other two so a test run can be
# redirected away from the user's real pointer.
LAST_PROJECT_PATH = Path(
    os.environ.get("TAKEONE_LAST_PROJECT", Path.home() / ".takeone" / "last_project.json")
)


# ── Atomic writes ─────────────────────────────────────────────────────────────
# Every write in this module publishes through the helpers below, and so does the
# usage meter (usage.py imports them). They exist because the pattern they replace
# — write a FIXED "<name>.tmp", then .replace() it — is only atomic for ONE writer
# at a time, and this app has never had only one.
#
# render_queue.py and render_registry.py hit the identical wall from the other side
# and answered it with file_lock.py (cross-process flock + a per-pid tmp name). Both
# halves of the answer now live in BOTH places: this module takes file_lock around its
# read-modify-writes (see _exclusive below) and those two modules fsync before their
# replace(), so there is one diagnosis and one idiom.
#
# /api/project/save-state is a sync `def`, so FastAPI runs it in its threadpool:
# two open tabs are two THREADS writing the SAME pipeline_state.json.tmp (the
# autosave debounce coalesces bursts, it does not serialise writers), and a second
# server process shares ~/.takeone with the first. Measured on the old code with 12
# threads + 6 processes x 40 saves against a scratch TAKEONE_HOME: 329 of 720 writes
# died with FileNotFoundError — writer A renamed the shared tmp out from under B —
# and a reader racing them found pipeline_state.json ZERO-BYTE or half-written on
# ~28% of its reads, because B had truncated the tmp that A then published. Two of
# 25 bursts ENDED on a file load_pipeline_state could no longer parse. That file is
# the durable copy of the project (localStorage has a quota a long-form project
# exceeds, and boot-from-disk reads exactly this file), so the app's own autosave
# was the thing most likely to destroy a project.
#
# Three rules, applied at every write site:
#   1. a UNIQUE tmp name per write (pid + counter), created in the SAME directory
#      so replace() stays a rename and never a cross-device copy;
#   2. serialise to a string/bytes BEFORE touching the filesystem, so a payload that
#      cannot be encoded fails while the good file is still in place;
#   3. flush + os.fsync BEFORE replace — a replace() of an unflushed file is atomic
#      in NAME only: the new directory entry points at bytes still sitting in the
#      page cache, so a crash or a power cut publishes an empty or short file. That
#      is the same zero-byte project, arriving the slow way.
_write_lock = threading.RLock()
_tmp_seq = itertools.count()


# ── Cross-process exclusion ───────────────────────────────────────────────────
# Rules 1-3 make ONE write indivisible. They do nothing for a READ-MODIFY-WRITE, and
# every map in this module is one: read face_anchors.json, add a character, write the
# WHOLE map back. Two processes interleave read/read/write/write and the loser's
# character is erased by the winner's whole-map write. The file parses perfectly
# afterwards, which is exactly why this never looked like corruption and never showed
# up as an error. Measured on a scratch project, 6 processes x 60 write_face_anchor()
# for DISTINCT characters: 360 expected, 60-62 on disk, ~299 LOST.
#
# A lost face anchor has one symptom and one only — the NEXT SHOT RENDERS A DIFFERENT
# FACE. That is the user's oldest complaint about their finished film.
#
# The same race at the version-number sites erases an approved IMAGE instead: n =
# len(glob)+1 is a read that decides a filename, so 6 processes x 10
# save_asset_version() landed on 28-39 distinct v0NN.png out of 60 — up to 32 approved
# images overwritten at a name two processes both chose.
#
# _write_lock alone cannot fix any of it: it is a threading lock and the losers are
# other PROCESSES (a second uvicorn, `uvicorn --workers N`, a CLI script, the render
# worker). flock alone cannot fix it either: it belongs to the open file description
# and file_lock caches ONE fd per path, so two threads here would both "acquire" it
# and the first to leave would unlock the other. Both, in this order — threading
# outside, flock inside — which is also why they cannot deadlock against each other.
# Same idiom as render_queue._exclusive(); the long form of the argument is there.
@contextmanager
def _exclusive(fp: Path) -> Iterator[None]:
    """Hold both locks for a WHOLE read-modify-write of `fp` (a file, or a directory
    whose contents decide a filename).

    Wraps the entire critical section, never just the write: locking only the write
    leaves the processes free to interleave read/read/write/write, which is precisely
    the sequence that loses the update.

    Raises file_lock.LockTimeout when a peer holds the file past the timeout, rather
    than proceeding unlocked — for these files, an unlocked write is how a face is
    lost.

    Nesting is allowed for DIFFERENT paths only (save_asset_version takes the Versions
    dir, then project.json, always in that order). Never nest on the SAME path: flock
    lives on the open file description, so the inner block's exit would unlock the
    outer one while it is still running."""
    with _write_lock:                      # threads of THIS process (RLock: the
        with file_lock.hold(fp):           # atomic_write_* helpers re-enter it)
            yield


def _tmp_for(fp: Path) -> Path:
    """A tmp sibling no other writer can be holding: pid distinguishes processes,
    the counter distinguishes threads. Dot-prefixed so the globs elsewhere in this
    module (v*.png, video_v*.mp4, <character>.*) can never pick a tmp up as content."""
    return fp.with_name(f".{fp.name}.{os.getpid()}.{next(_tmp_seq)}.tmp")


def atomic_write_bytes(fp: Path, data: bytes) -> None:
    """Publish `data` at `fp` in one indivisible step — a reader sees either the
    previous file or the whole new one, never an empty or partial one."""
    tmp = _tmp_for(fp)
    with _write_lock:
        try:
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())   # rule 3: replace() alone is atomic in name only
            tmp.replace(fp)
        except BaseException:
            # A failed write must cost nothing: leave neither a tmp behind nor a
            # damaged target (the target was never opened, so it is untouched).
            try:
                tmp.unlink()
            except OSError:
                pass
            raise


def atomic_write_text(fp: Path, text: str) -> None:
    """Atomic text write. Explicit utf-8 — the old write_text() took the locale's
    encoding, which is not the same thing on every machine that reads it back."""
    atomic_write_bytes(fp, text.encode("utf-8"))


def atomic_write_json(fp: Path, payload: dict | list) -> None:
    """Serialise FIRST, check the result is non-empty, THEN write (rules 1-3).
    The emptiness check is the last line of defence: whatever else goes wrong,
    this function cannot replace a good file with a zero-byte one."""
    text = json.dumps(payload, indent=2)
    if not text.strip():
        raise ValueError(f"refusing to write an empty {fp.name}")
    atomic_write_text(fp, text)


def preserve_corrupt(fp: Path) -> None:
    """Move an unreadable file aside instead of letting the next write erase it.

    Every reader here treats a zero-byte or unparseable file as ABSENT — which is
    correct, but on its own it means the read-modify-write callers (the face/voice
    anchor maps) immediately write a fresh file over bytes nobody has looked at yet,
    and the autosave does the same to a damaged pipeline_state.json. Those bytes are
    the only evidence of what happened to a project, and a partly-readable snapshot
    can be worth recovering by hand. So: keep it, once, under a stamped sibling.

    An empty file holds nothing to preserve, so it is simply left to be replaced.
    Never raises — preservation is a courtesy and must not fail a write."""
    try:
        if not fp.is_file() or fp.stat().st_size == 0:
            return
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        fp.replace(fp.with_name(f"{fp.name}.corrupt-{stamp}"))
    except OSError:
        pass


def _load_json_map(fp: Path) -> dict:
    """Read a {key: value} JSON map for a read-modify-write. Missing, empty or
    unparseable all read as {} — but an unparseable file is preserved first, so
    the write that follows cannot silently erase it (see preserve_corrupt)."""
    if not fp.is_file():
        return {}
    try:
        data = json.loads(fp.read_text())
    except (json.JSONDecodeError, ValueError, OSError):
        preserve_corrupt(fp)
        return {}
    return data if isinstance(data, dict) else {}


def _as_secs(raw: object) -> float | None:
    """A recorded duration as a float, or None when there is no usable number.

    None is NOT zero and NOT five: reconstruct_project feeds the phase-6 gate, which
    refuses to score a clip whose length it does not know and counts one it does. A
    default in here would turn "nobody wrote this down" into a measurement."""
    if raw in (None, ""):
        return None
    try:
        return float(raw)                   # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


# ffprobe next to whichever ffmpeg this machine uses, resolved the way server.py does
# (FFMPEG_BIN wins, then the two install prefixes, then PATH). Kept here rather than
# imported because server.py imports THIS module.
_FFPROBE = (
    (os.environ.get("FFMPEG_BIN", "").strip()[:-6] + "ffprobe"
     if os.environ.get("FFMPEG_BIN", "").strip().endswith("ffmpeg") else "")
    or next((p for p in ("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe") if os.path.isfile(p)), "")
    or shutil.which("ffprobe") or "ffprobe"
)


def _probe_seconds(path: Path | None) -> float | None:
    """A media file's real duration, or None when it cannot be measured.

    None on every failure — no ffprobe, a stream with no duration in its header, a
    truncated file. The caller must carry the None; substituting a number here is the
    bug this module is being cleaned of."""
    if path is None:
        return None
    try:
        r = subprocess.run(
            [_FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=15)
        if r.returncode != 0 or not r.stdout.strip():
            return None
        # `float("inf")` and `float("nan")` both PARSE — ffprobe printing either would put a
        # non-finite duration on a shot, and this value reaches GET /api/project/load, where
        # JSON cannot encode it (the same shape that 500'd /api/edit/render on a silent film).
        # Unmeasurable is None here, and inf is not a measurement.
        secs = float(r.stdout.strip())
        return secs if math.isfinite(secs) else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _safe(name: str) -> str:
    """Sanitize a path segment: block traversal and junk chars."""
    cleaned = "".join(c for c in name if c.isalnum() or c in " -_").strip()
    return cleaned or "untitled"


def project_root(name: str, storage_root: str | None = None) -> Path:
    """Return the project directory. Uses storage_root when provided, else TAKEONE_ROOT."""
    base = Path(storage_root).expanduser().resolve() if storage_root else TAKEONE_ROOT
    return base / _safe(name)


def default_storage_root() -> str:
    """Return the default storage root (never hardcoded — always from Path.home())."""
    return str(TAKEONE_ROOT)


def init_project(name: str, project_type: str, structure: dict, storage_root: str | None = None) -> str:
    # Anti-nesting guard: a "re-create" on an already-open project passed its OWN
    # folder as storage_root, and project_root() appended the name again → the
    # dreaded <root>/Alastor/Alastor. If storage_root already IS this project's
    # folder (basename matches, or it already holds a project.json), use it
    # directly instead of nesting a project inside a project.
    if storage_root:
        base = Path(storage_root).expanduser().resolve()
        root = base if (base.name == _safe(name) or (base / "project.json").exists()) else base / _safe(name)
    else:
        root = project_root(name, storage_root)
    base_dirs = [
        "Script", "Breakdown",
        "Assets/Characters", "Assets/Props", "Assets/FX", "Assets/Environments",
        "Shots", "Edits", "Exports",
    ]
    for sub in base_dirs:
        (root / sub).mkdir(parents=True, exist_ok=True)

    # For TV, also create the season/episode/scene tree
    if project_type == "tv":
        season  = _safe(structure.get("season", "S01"))
        episode = _safe(structure.get("episode", "E01"))
        scene   = _safe(structure.get("scene", "Scene01"))
        (root / "Shots" / f"Season{season}" / f"Episode{episode}" / f"Scene{scene}").mkdir(
            parents=True, exist_ok=True
        )

    manifest = {
        "name": name,
        "type": project_type,
        "structure": structure,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "assets": {},
    }
    manifest_path = root / "project.json"
    atomic_write_json(manifest_path, manifest)
    return str(root)


def _resolve_root(name: str, project_path: str = "") -> Path:
    """Project root honouring a custom storage location (localFolderRoot)."""
    return Path(project_path) if project_path else project_root(name)


def _read_manifest(name: str, project_path: str = "") -> dict:
    return json.loads((_resolve_root(name, project_path) / "project.json").read_text())


def _write_manifest(name: str, m: dict, project_path: str = "") -> None:
    atomic_write_json(_resolve_root(name, project_path) / "project.json", m)


def save_asset_version(name: str, asset_rel_path: str, image_b64: str,
                       project_path: str = "", meta: dict | None = None) -> dict:
    """Write a new versioned image. Never overwrites; returns version number + path.
    meta (prompt transparency: auto prompt, override, what was sent, refs used)
    is written as a vNNN.meta.json sidecar so any artifact can be audited later."""
    root = Path(project_path) if project_path else project_root(name)
    safe_rel = "/".join(_safe(p) for p in asset_rel_path.split("/"))
    vdir = root / safe_rel / "Versions"
    vdir.mkdir(parents=True, exist_ok=True)
    # The version number is a READ that decides a filename, and the manifest update
    # below is a read-modify-write. Both belong inside the lock, and it has to be the
    # CROSS-PROCESS one: assets generate in parallel and not only in this process, so
    # two savers that each computed n = len(glob)+1 before either wrote picked the SAME
    # v003.png — the second base64 blob landing on the first one's approved image.
    # Measured with 6 processes x 10 saves: 28-39 distinct files out of 60 before the
    # flock, 60 after. The filename MUST be decided INSIDE this block; hoisting the
    # glob out puts the collision straight back.
    with _exclusive(vdir):
        n = len(list(vdir.glob("v*.png"))) + 1
        fp = vdir / f"v{n:03d}.png"
        atomic_write_bytes(fp, base64.b64decode(image_b64))
        if meta:
            meta_payload = {**meta, "savedAt": datetime.now(timezone.utc).isoformat()}
            atomic_write_json(vdir / f"v{n:03d}.meta.json", meta_payload)

        # Update manifest — use the same root so we don't create a ghost project.
        # Its own lock: a different file, and every other manifest read-modify-write
        # (revert_asset, approve_asset_version) takes the same one. Always acquired
        # AFTER the Versions lock and never the other way round, so the two orders
        # cannot cross.
        manifest_path = root / "project.json"
        try:
            with _exclusive(manifest_path):
                m = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
                if not isinstance(m, dict):
                    m = {}          # non-dict JSON: same shape as the load guards below
                m.setdefault("assets", {}).setdefault(safe_rel, {"current": None, "approved": None})
                m["assets"][safe_rel]["current"] = n
                atomic_write_json(manifest_path, m)
        except Exception as e:  # noqa: BLE001
            # Non-fatal: vNNN.png is already on disk and is the source of truth. But a
            # failed manifest write leaves project.json's "current" pointer on the OLD
            # version, so the UI keeps serving the previous render — say so.
            logger.warning("[Storage] manifest 'current' pointer NOT updated for %s v%d (non-fatal): %s",
                           safe_rel, n, e)
    return {"version": n, "path": str(fp)}


def read_face_block(name: str, character: str, project_path: str = "") -> str:
    """Cached distinctive-fictional facial-feature block for a character (keyed
    by name). Empty string if not generated yet. See seedance-identity-filter."""
    root = Path(project_path) if project_path else project_root(name)
    fp = root / "Characters" / "face_blocks.json"
    try:
        if fp.exists():
            return json.loads(fp.read_text()).get(character, "") or ""
    except Exception:
        pass
    return ""


def write_face_block(name: str, character: str, block: str, project_path: str = "") -> None:
    """Persist a character's fictional facial-feature block so every shot of that
    character reuses the SAME face (cross-shot consistency without image refs).

    RAISES on a write it could not complete. It used to `except Exception: pass`, so
    on a read-only Characters/ it returned None having written nothing at all — and
    the only place that shows up is the next shot, wearing a different face."""
    if not (character and block):
        return
    root = Path(project_path) if project_path else project_root(name)
    d = root / "Characters"
    d.mkdir(parents=True, exist_ok=True)
    fp = d / "face_blocks.json"
    # Read-modify-write under BOTH locks: several shots derive their face blocks in
    # parallel, in this process and in any other one open on the same project, and two
    # writers that both read the pre-update map each write one back missing the other's
    # character.
    with _exclusive(fp):
        data = _load_json_map(fp)
        data[character] = block
        atomic_write_json(fp, data)


def read_face_anchor(name: str, character: str, project_path: str = "") -> str:
    """Cached path to a character's FACE ANCHOR — a clean t2i portrait with the
    fictional-distinctive face (the recipe that passes Seedance's filter). Reused
    as the identity reference in every shot so the face is locked cross-shot.
    See seedance-identity-filter (BREAKTHROUGH 2026-06-29)."""
    root = Path(project_path) if project_path else project_root(name)
    fp = root / "Characters" / "face_anchors.json"
    try:
        if fp.exists():
            return json.loads(fp.read_text()).get(character, "") or ""
    except Exception:
        pass
    return ""


def write_face_anchor(name: str, character: str, path: str, project_path: str = "") -> None:
    """Persist a character's face-anchor image path so every shot reuses the SAME
    fictional face (cross-shot identity lock that passes the real-person filter).

    RAISES on a write it could not complete — see write_face_block. This is the single
    highest-cost silent failure in the app: without this mapping the anchor image is on
    disk and unreachable, so the next shot generates a fresh face and the character
    changes mid-film, with nothing logged anywhere."""
    if not (character and path):
        return
    root = Path(project_path) if project_path else project_root(name)
    d = root / "Characters"
    d.mkdir(parents=True, exist_ok=True)
    fp = d / "face_anchors.json"
    with _exclusive(fp):                    # read-modify-write — see write_face_block
        data = _load_json_map(fp)
        data[character] = path
        atomic_write_json(fp, data)


def read_voice_anchor(name: str, character: str, project_path: str = "") -> dict:
    """A character's VOICE ANCHOR — the locked TTS voice config
    ({speaker, pitch_rate, speech_rate}) reused for EVERY line they speak so the
    voice is identical across the whole film (the audio analogue of the face anchor)."""
    root = Path(project_path) if project_path else project_root(name)
    fp = root / "Characters" / "voice_anchors.json"
    try:
        if fp.exists():
            return json.loads(fp.read_text()).get(character, {}) or {}
    except Exception:
        pass
    return {}


def read_voice_anchors(name: str, project_path: str = "") -> dict:
    """All character → voice-config mappings for the project (drives the AG panel)."""
    root = Path(project_path) if project_path else project_root(name)
    fp = root / "Characters" / "voice_anchors.json"
    try:
        if fp.exists():
            return json.loads(fp.read_text()) or {}
    except Exception:
        pass
    return {}


def write_voice_anchor(name: str, character: str, config: dict, project_path: str = "") -> None:
    """Persist a character's locked voice config so every dialogue line reuses the
    SAME voice (cross-shot vocal identity lock).

    RAISES on a write it could not complete — see write_face_block. The audio twin of
    the lost face anchor: the next line this character speaks comes out in a different
    voice, and the endpoint that thought it saved returned 200."""
    if not character:
        return
    root = Path(project_path) if project_path else project_root(name)
    d = root / "Characters"
    d.mkdir(parents=True, exist_ok=True)
    fp = d / "voice_anchors.json"
    with _exclusive(fp):                    # read-modify-write — see write_face_block
        data = _load_json_map(fp)
        data[character] = config
        atomic_write_json(fp, data)


def save_voice_reference(name: str, character: str, data_b64: str, ext: str = "mp3",
                         project_path: str = "") -> str:
    """Persist an actor's VOICE REFERENCE clip (the Seed Audio 1.0 clone source) under
    <project>/Characters/VoiceRefs/. One clip per character — overwrites the prior clip
    so the anchor always points at the latest reference. Returns the absolute path."""
    root = Path(project_path) if project_path else project_root(name)
    d = root / "Characters" / "VoiceRefs"
    d.mkdir(parents=True, exist_ok=True)
    ext = "".join(c for c in (ext or "mp3") if c.isalnum()) or "mp3"
    fp = d / f"{_safe(character)}.{ext}"
    # Drop any stale clip in a different container so the anchor isn't ambiguous.
    for old in d.glob(f"{_safe(character)}.*"):
        if old != fp:
            try: old.unlink()
            except OSError: pass
    # Atomic: this path OVERWRITES the previous clip, so a torn write would leave the
    # voice anchor pointing at an unplayable file.
    atomic_write_bytes(fp, base64.b64decode(data_b64.split(",", 1)[-1]))
    return str(fp)


def save_soundtrack(name: str, filename: str, data_b64: str, project_path: str = "") -> dict:
    """Persist an uploaded audio track under <project>/Audio/. Unique filename so
    multiple audio clips don't overwrite each other. Returns its path."""
    root = Path(project_path) if project_path else project_root(name)
    d = root / "Audio"
    d.mkdir(parents=True, exist_ok=True)
    ext = "".join(c for c in Path(filename).suffix if c.isalnum() or c == ".") or ".mp3"
    stem = _safe(Path(filename).stem) or "audio"
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")[:-3]
    fp = d / f"{stem}_{ts}{ext}"
    atomic_write_bytes(fp, base64.b64decode(data_b64))
    return {"path": str(fp), "name": Path(filename).name}


def clear_face_block(name: str, character: str = "", project_path: str = "") -> list[str]:
    """Drop cached fictional face block(s) so the next keyframe regenerates a fresh
    (vision-grounded) one. character="" clears ALL. Returns the names cleared."""
    root = Path(project_path) if project_path else project_root(name)
    fp = root / "Characters" / "face_blocks.json"
    if not fp.exists():
        return []
    with _exclusive(fp):                    # read-modify-write — see write_face_block
        data = _load_json_map(fp)
        if not data:
            return []
        if character:
            cleared = [character] if data.pop(character, None) is not None else []
        else:
            cleared = list(data.keys())
            data = {}
        # RAISES rather than reporting a clear that did not happen: a stale face block
        # left on disk is how the OLD face kept resurfacing after an identity-changing
        # regen, which is the very thing this function exists to prevent.
        atomic_write_json(fp, data)
    return cleared


def clear_face_anchor(name: str, character: str, project_path: str = "") -> bool:
    """Drop a character's cached face-anchor path so the next shot regenerates the
    anchor from the CURRENT approved look — required after an identity-changing
    regen (e.g. director note changes ethnicity), else the old face resurfaces."""
    if not character:
        return False
    root = Path(project_path) if project_path else project_root(name)
    fp = root / "Characters" / "face_anchors.json"
    if not fp.exists():
        return False
    with _exclusive(fp):                    # read-modify-write — see write_face_block
        data = _load_json_map(fp)
        if data.pop(character, None) is None:
            return False
        # No `except: return False` any more. False means "there was nothing cached",
        # and a failed clear returning it too made the two indistinguishable — while
        # the stale anchor stayed on disk and put the pre-regen face back in the next
        # shot. A failure now raises and the caller reports it.
        atomic_write_json(fp, data)
        return True


def list_asset_versions(name: str, asset_rel_path: str, project_path: str = "") -> dict:
    safe_rel = "/".join(_safe(p) for p in asset_rel_path.split("/"))
    vdir = _resolve_root(name, project_path) / safe_rel / "Versions"
    versions = sorted(str(p) for p in vdir.glob("v*.png")) if vdir.exists() else []
    m = _read_manifest(name, project_path)
    ptr = m.get("assets", {}).get(safe_rel, {"current": None, "approved": None})
    return {"versions": versions, **ptr}


def revert_asset(name: str, asset_rel_path: str, version: int, project_path: str = "") -> dict:
    """Point 'current' at an older version — NEVER deletes history."""
    safe_rel = "/".join(_safe(p) for p in asset_rel_path.split("/"))
    # Read-modify-write of the whole manifest, so it takes the manifest's lock like
    # save_asset_version does: without it a concurrent approve/save rewrites project.json
    # from a snapshot taken before this one and the revert is silently undone.
    with _exclusive(_resolve_root(name, project_path) / "project.json"):
        m = _read_manifest(name, project_path)
        m.setdefault("assets", {}).setdefault(safe_rel, {})["current"] = version
        _write_manifest(name, m, project_path)
    return {"current": version}


def approve_asset_version(name: str, asset_rel_path: str, version: int, project_path: str = "") -> dict:
    safe_rel = "/".join(_safe(p) for p in asset_rel_path.split("/"))
    with _exclusive(_resolve_root(name, project_path) / "project.json"):   # see revert_asset
        m = _read_manifest(name, project_path)
        m.setdefault("assets", {}).setdefault(safe_rel, {})["approved"] = version
        _write_manifest(name, m, project_path)
    return {"approved": version}


def get_asset_latest_path(name: str, asset_rel_path: str, storage_root: str | None = None) -> str | None:
    """Return the disk path of the latest saved version, or None if not found."""
    safe_rel = "/".join(_safe(p) for p in asset_rel_path.split("/"))
    vdir = project_root(name, storage_root) / safe_rel / "Versions"
    if not vdir.exists():
        return None
    versions = sorted(vdir.glob("v*.png"))
    return str(versions[-1]) if versions else None


def save_shot_video(name: str, shot_id: str, video_bytes: bytes, project_path: str = "",
                    meta: dict | None = None) -> dict:
    """Write a shot's rendered video under Shots/<shot_id>/. Versioned, never overwrites.
    meta (seed, resolution, prompt) is written as a sidecar video_vNNN.meta.json so a
    later HD re-render can replay the exact take."""
    root = Path(project_path) if project_path else project_root(name)
    vdir = root / "Shots" / _safe(shot_id)
    vdir.mkdir(parents=True, exist_ok=True)
    # Lock + atomic write, same reason as save_asset_version: shots come back from the
    # render queue concurrently — and not only in this process, since the reconciler
    # can be draining the registry from a second one. Two savers that both counted
    # before either wrote would publish the same video_vNNN.mp4, i.e. one PAID render
    # overwritten by the next; a half-written one is what reconstruct_project would
    # hand the player as "the latest take". The name is chosen inside the lock.
    with _exclusive(vdir):
        # One render, one version. The browser can ask to save the same finished task
        # twice: the reconciler that resumes "orphaned" renders keys off an in-memory
        # Set of active polls, and a remount starts that Set empty while the original
        # poll is still running — so it re-saves a task nobody lost. Measured on
        # BLACK MIRROR V3 SHOT_014: video_v003.mp4 and video_v004.mp4, identical to the
        # byte (19480958) eight seconds apart, and the duplicate's sidecar recorded a
        # prompt from a take two hours earlier. That costs a slot in a 20-entry ring
        # that is meant to hold twenty real takes, and it makes the audit trail lie
        # about what was sent. Same task id => same render: hand back what is already
        # on disk. Older sidecars carry no task id and fall through unchanged.
        tid = (meta or {}).get("task_id") or ""
        if tid:
            for sc in sorted(vdir.glob("video_v*.meta.json")):
                try:
                    if json.loads(sc.read_text()).get("task_id") == tid:
                        prior = vdir / (sc.name.replace(".meta.json", ".mp4"))
                        if prior.exists():
                            return {"version": int(prior.stem.split("_v")[-1]), "path": str(prior),
                                    "deduped": True}
                except Exception:
                    continue        # an unreadable sidecar must never block a paid save
        n = len(list(vdir.glob("video_v*.mp4"))) + 1
        fp = vdir / f"video_v{n:03d}.mp4"
        atomic_write_bytes(fp, video_bytes)
        if meta:
            meta_payload = {**meta, "savedAt": datetime.now(timezone.utc).isoformat()}
            atomic_write_json(vdir / f"video_v{n:03d}.meta.json", meta_payload)
    return {"version": n, "path": str(fp)}


def save_studio_item(name: str, kind: str, content: bytes, ext: str = "png",
                     project_path: str = "") -> dict:
    """Persist a Studio generation under the project's Studio/Images or
    Studio/Videos folder. Versioned, never overwrites, project-prefixed name. The
    local copy is the durable reference (CDN URLs expire ~24h)."""
    root = Path(project_path) if project_path else project_root(name)
    safe_kind = kind if kind in ("video", "audio") else "image"
    sub = {"video": "Videos", "audio": "Audio"}.get(safe_kind, "Images")
    gdir = root / "Studio" / sub
    gdir.mkdir(parents=True, exist_ok=True)
    prefix = _safe(name) if name and name not in ("_studio", "") else "studio"
    with _exclusive(gdir):                  # numbered filename + write — see save_asset_version
        n = len(list(gdir.glob(f"{prefix}_{safe_kind}_*.{ext}"))) + 1
        fp = gdir / f"{prefix}_{safe_kind}_{n:04d}.{ext}"
        atomic_write_bytes(fp, content)
    return {"path": str(fp), "filename": fp.name}


def save_script(name: str, script_text: str, concept: str = "", project_path: str = "") -> dict:
    """Write script to Script/script.json + Script/script.txt (1.2).
    Uses project_path (full path) when provided, else derives from name + TAKEONE_ROOT."""
    root = Path(project_path) if project_path else project_root(name)
    script_dir = root / "Script"
    script_dir.mkdir(parents=True, exist_ok=True)
    script_json = {"concept": concept, "content": script_text, "savedAt": datetime.now(timezone.utc).isoformat()}
    atomic_write_json(script_dir / "script.json", script_json)
    atomic_write_text(script_dir / "script.txt", script_text)
    return {"path": str(script_dir)}


def save_bible(name: str, bible: dict, project_path: str = "") -> dict:
    """Persist the film bible next to the script. Derived once per script and reused,
    so a breakdown re-run does not pay for it again."""
    root = Path(project_path) if project_path else project_root(name)
    d = root / "Script"
    d.mkdir(parents=True, exist_ok=True)
    payload = {**bible, "savedAt": datetime.now(timezone.utc).isoformat()}
    fp = d / "bible.json"
    atomic_write_json(fp, payload)          # was a FIXED bible.json.tmp — see the rules above
    return {"path": str(fp)}


def read_bible(name: str, project_path: str = "") -> dict:
    """The saved film bible, or {} when the project predates it / has none."""
    root = Path(project_path) if project_path else project_root(name)
    fp = root / "Script" / "bible.json"
    if not fp.is_file():
        return {}
    try:
        doc = json.loads(fp.read_text())
        if not isinstance(doc, dict):
            # VALID JSON that is not an object — 'null', '[1,2,3]', '"x"', '7'. It used
            # to be returned as-is (or, for the falsy ones, as {}), so a list reached the
            # caller's .get() and raised AttributeError. Same treatment as unparseable:
            # ABSENT, and preserved.
            raise ValueError(f"bible.json holds {type(doc).__name__}, not an object")
        return doc or {}
    except (json.JSONDecodeError, ValueError, OSError):
        # Zero-byte or unparseable reads as ABSENT (the caller regenerates the bible)
        # — but the bytes are moved aside first, never silently replaced. A bible is a
        # paid derivation; if it ever does go bad the user should still have it.
        preserve_corrupt(fp)
        return {}


def read_scene_geos(name: str, project_path: str = "") -> dict:
    """Every scene's GEO SPATIAL LAYOUT, keyed by scene id, or {}.

    HELL GRIND rule: "It is a floor plan of the place in a few lines… You write it ONCE
    PER SCENE and paste it into EVERY shot of that scene WITHOUT CHANGES." The "once"
    is the whole point and it is what makes this a FILE and not a local variable: the
    shots of a scene are boarded across several requests (Regen one shot, board the
    rest tomorrow) and phase 5 renders them days later still. A map derived per call
    would drift between the shots it is supposed to lock together.

    Never raises — a missing or damaged map costs the geo block, which must never take
    down the phase that asked for it (same contract read_bible has always had).
    """
    root = Path(project_path) if project_path else project_root(name)
    fp = root / "Script" / "geo_layouts.json"
    try:
        if fp.is_file():
            doc = json.loads(fp.read_text())
            return doc if isinstance(doc, dict) else {}
    except (json.JSONDecodeError, ValueError, OSError):
        preserve_corrupt(fp)
    return {}


def save_scene_geo(name: str, scene_id: str, geo: str, heading: str = "",
                   shot_ids: list[str] | None = None, project_path: str = "") -> dict:
    """Persist ONE scene's geo map. Read-modify-write under _exclusive, because scenes
    are boarded IN PARALLEL (each /api/storyboard/generate is its own task) and this is
    one file for the whole film — the exact shape that lost 32 approved images at the
    version-number sites before the lock went in.

    `shot_ids` accumulates rather than replaces: a "Regen this one shot" call carries a
    single shot and must not erase the scene's other shots from the record, which is
    what phase 5 matches a render against (it is given a shot id, never a scene id).

    THE MAP ITSELF IS FIRST-WRITER-WINS, and that is the whole contract: HELL GRIND
    rule 1, "You write it ONCE PER SCENE and paste it into EVERY shot of that scene
    WITHOUT CHANGES." The caller only reaches here when it read no stored map, so in a
    sequential world nothing overwrites anything — but two /api/storyboard/generate
    calls for the SAME scene are two independent tasks (Regen one shot while the scene
    batch is in flight), both can read empty, and the loser's shots have already been
    boarded against the map the winner then replaced. That is the defect this block
    exists to prevent, arriving through the concurrency door. Under the lock the first
    map stays; later callers only add their shot ids to it.
    """
    if not (scene_id and (geo or "").strip()):
        return {}
    root = Path(project_path) if project_path else project_root(name)
    d = root / "Script"
    d.mkdir(parents=True, exist_ok=True)
    fp = d / "geo_layouts.json"
    with _exclusive(fp):                    # read-modify-write — see write_voice_anchor
        data = _load_json_map(fp)
        prev = data.get(scene_id) if isinstance(data.get(scene_id), dict) else {}
        ids = list(dict.fromkeys((prev.get("shot_ids") or []) + list(shot_ids or [])))
        kept = str(prev.get("geo") or "").strip()
        data[scene_id] = {
            "heading": heading or prev.get("heading", ""),
            "geo": kept or geo.strip(),
            "shot_ids": ids,
            # The timestamp belongs to the MAP, so it survives with it; a record written
            # before this field existed still gets one rather than a null.
            "savedAt": (prev.get("savedAt") if kept else None) or datetime.now(timezone.utc).isoformat(),
        }
        atomic_write_json(fp, data)
    return data[scene_id]


def save_breakdown(name: str, breakdown: dict, script_excerpt: str = "", project_path: str = "") -> dict:
    """Write breakdown to Breakdown/breakdown.json + Breakdown/asset_breakdown.csv (1.2)."""
    import csv, io
    root = Path(project_path) if project_path else project_root(name)
    bd_dir = root / "Breakdown"
    bd_dir.mkdir(parents=True, exist_ok=True)

    # JSON
    bd_payload = {**breakdown, "savedAt": datetime.now(timezone.utc).isoformat(), "scriptExcerpt": script_excerpt[:500]}
    atomic_write_json(bd_dir / "breakdown.json", bd_payload)

    # CSV — flat table: one row per asset, one row per shot
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["kind", "id", "name", "type", "visual_description", "scene", "action", "assets_used", "duration_sec"])
    for a in breakdown.get("assets", []):
        w.writerow(["asset", a.get("id",""), a.get("name",""), a.get("type",""), a.get("visual_description",""), "", "", "", ""])
    for s in breakdown.get("shots", []):
        w.writerow(["shot", s.get("id",""), s.get("scene",""), s.get("type",""), s.get("visual_description",""),
                    s.get("scene",""), s.get("action",""), ";".join(s.get("assets_used",[])), s.get("duration_sec","")])
    atomic_write_text(bd_dir / "asset_breakdown.csv", buf.getvalue())

    return {"path": str(bd_dir), "assets": len(breakdown.get("assets",[])), "shots": len(breakdown.get("shots",[]))}


def list_dirs(path: str | None = None) -> dict:
    """Folder browser backing: list sub-directories of `path` (default: home).
    Each entry flags whether it is itself an Take One Studio project (holds project.json)
    so the UI can offer a one-click Open. Hidden dirs are skipped. The browser is
    local-only (this server runs on the user's own machine)."""
    base = Path(path).expanduser() if path else Path.home()
    base = base.resolve()
    if not base.is_dir():
        base = Path.home().resolve()
    entries: list[dict] = []
    try:
        for child in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if child.name.startswith(".") or not child.is_dir():
                continue
            try:
                has_project = (child / "project.json").is_file()
            except OSError:
                has_project = False
            entries.append({"name": child.name, "path": str(child), "isDir": True, "hasProject": has_project})
    except PermissionError:
        pass
    parent = str(base.parent) if base.parent != base else None
    is_project = (base / "project.json").is_file()
    return {"path": str(base), "parent": parent, "home": str(Path.home()),
            "isProject": is_project, "entries": entries}


def remember_last_project(project_path: str) -> None:
    """F2c: record which project the backend last saw being worked on.

    The browser remembers the project root in localStorage (the snapshot, plus the
    standalone 'takeone-project-root-v1' key added by F2b) — and BOTH die together with
    cleared site data, a fresh browser or an incognito window. A complete project then
    sits on disk with no boot path able to name it: /api/project/list exists but nothing
    in the frontend ever called it. This file is the memory that survives the browser.

    Written from save_pipeline_state on purpose. An autosave is the only signal that a
    project is both OPEN and holds work (ProjectAutosave refuses to save an empty
    snapshot), so the pointer never names a folder with nothing in it. /api/project/load
    was the other candidate and is worse: boot itself calls it, so the fallback would
    keep re-arming itself for a project the user may not have wanted; /api/project/init
    names a folder that may never receive a single scene.

    Never raises — the pointer is a convenience and must not be able to fail a save.
    """
    try:
        root = Path(project_path).expanduser()
        name = ""
        mp = root / "project.json"
        if mp.is_file():
            try:
                name = json.loads(mp.read_text()).get("name", "") or ""
            except (json.JSONDecodeError, OSError):
                name = ""
        payload = {
            "project_path": str(root),
            "project_name": name or root.name,
            "savedAt": datetime.now(timezone.utc).isoformat(),
        }
        LAST_PROJECT_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Same discipline as render_registry/render_queue: a crash mid-write must never
        # leave a truncated pointer that reads back as garbage. This used a FIXED
        # last_project.json.tmp, which made it the OTHER file every concurrent autosave
        # fought over (save_pipeline_state calls this on every save).
        atomic_write_json(LAST_PROJECT_PATH, payload)
    except Exception as e:  # noqa: BLE001
        # Non-fatal: the snapshot itself is what matters. But this is the pointer boot
        # reads to restore "the project you were last working on", so losing it silently
        # looks to the user like the app forgot their project.
        logger.warning("[Storage] last-project pointer NOT written (non-fatal): %s", e)


def read_last_project() -> dict:
    """The last-worked-on project, or {} when there is none — or when its folder is gone.

    The existence check belongs HERE, not in the caller: a pointer to a deleted or moved
    folder is worse than no pointer at all, because the UI would announce it reopened a
    project and then show an empty one."""
    try:
        doc = json.loads(LAST_PROJECT_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    path = str(doc.get("project_path") or "")
    if not path or not (Path(path).expanduser() / "project.json").is_file():
        return {}
    return {
        "project_path": path,
        "project_name": doc.get("project_name") or Path(path).name,
        "savedAt": doc.get("savedAt") or "",
    }


def forget_last_project() -> None:
    """Drop the pointer — the user reset the project. Without this a Reset would clear the
    browser's copy of the root and the very next boot would pull the same project back out
    of the backend, which is precisely the undo-proof behaviour rememberProjectRoot(null)
    exists to prevent on the frontend side."""
    try:
        LAST_PROJECT_PATH.unlink()
    except (FileNotFoundError, OSError):
        pass


def save_pipeline_state(project_path: str, state: dict) -> dict:
    """Persist the full pipeline store snapshot to the project folder so the
    project can be reopened later. One file, atomically replaced.

    "Atomically" used to mean a FIXED pipeline_state.json.tmp with no lock, which is
    a single-writer assumption this endpoint has never satisfied — see the measured
    numbers in the atomic-writes section at the top of this module. It now goes
    through atomic_write_json, so a reader gets the previous snapshot or the whole
    new one and never a zero-byte file.

    No last-known-good sibling on purpose: with a genuinely atomic publish there is
    no window in which a good snapshot becomes a bad one, and this runs every ~1.5s
    on a file that reaches hundreds of KB — a rotating copy would cost a full extra
    write per keystroke burst to protect against a state that can no longer occur."""
    root = Path(project_path).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    payload = {"savedAt": datetime.now(timezone.utc).isoformat(), "state": state}
    fp = root / "pipeline_state.json"
    atomic_write_json(fp, payload)
    # F2c: this snapshot is also the moment we know WHICH project is live — record it
    # outside the project folder so a browser that lost its localStorage can find it
    # again. A few hundred bytes next to a snapshot write; non-fatal by construction.
    remember_last_project(str(root))
    return {"path": str(fp)}


_TYPE_FOLDER = {
    "character": "Characters", "environment": "Environments",
    "prop": "Props", "vfx": "FX", "fx": "FX",
}


def reconstruct_project(project_path: str) -> dict:
    """Best-effort reconstruction of a LEGACY project (one created before
    pipeline_state.json existed) from its on-disk artifacts. Pure disk discovery
    — the frontend assembles these raw pieces into store state (it owns the
    normalize/shape logic). Returns the script, the raw breakdown, the resolved
    asset images (matched breakdown-id ↔ disk folder via _safe + approved
    pointer) and the per-shot media paths."""
    root = Path(project_path).expanduser()

    # Each of these three is .get()-ed below, so each has to be a dict or ABSENT: a file
    # holding valid non-object JSON ('[1,2,3]', '"x"', '7') would otherwise raise
    # AttributeError out of here — and this runs inside load_pipeline_state, so that is
    # the same permanent 500 on GET /api/project/load the guard there describes.
    script = None
    sp = root / "Script" / "script.json"
    if sp.is_file():
        try:
            d = json.loads(sp.read_text())
            if isinstance(d, dict):
                script = {"concept": d.get("concept", ""), "content": d.get("content", "")}
        except (json.JSONDecodeError, OSError):
            script = None

    breakdown = None
    bp = root / "Breakdown" / "breakdown.json"
    if bp.is_file():
        try:
            breakdown = json.loads(bp.read_text())
        except (json.JSONDecodeError, OSError):
            breakdown = None
        if not isinstance(breakdown, dict):
            breakdown = None

    manifest = {}
    mp = root / "project.json"
    if mp.is_file():
        try:
            manifest = json.loads(mp.read_text())
        except (json.JSONDecodeError, OSError):
            manifest = {}
        if not isinstance(manifest, dict):
            manifest = {}
    asset_ptrs = manifest.get("assets", {})
    if not isinstance(asset_ptrs, dict):
        asset_ptrs = {}

    # Assets: map each breakdown asset to its disk folder + approved/current image
    assets = []
    for a in (breakdown.get("assets", []) if breakdown else []):
        name = a.get("name", "")
        typ = str(a.get("type", "prop"))
        aid = a.get("id")
        folder = _TYPE_FOLDER.get(typ, "Props")
        rel = f"Assets/{folder}/{_safe(name)}"
        vdir = root / rel / "Versions"
        if not vdir.is_dir():
            continue
        versions = sorted(vdir.glob("v*.png"))
        if not versions:
            continue
        ptr = asset_ptrs.get(rel, {})
        approved = ptr.get("approved")
        pick = approved or ptr.get("current") or len(versions)
        vf = vdir / f"v{int(pick):03d}.png"
        if not vf.is_file():
            vf = versions[-1]
        # headshot, if one was derived at approval time
        hs_dir = root / rel / "Headshot"
        headshots = sorted(hs_dir.glob("*.png")) if hs_dir.is_dir() else []
        assets.append({
            "assetId": aid, "name": name, "type": typ,
            "status": "approved" if approved else "pending",
            "localPath": str(vf),
            "headshotLocalPath": str(headshots[-1]) if headshots else "",
        })

    # Shots: scan Shots/<id> for a rendered video + keyframe
    shots = []
    shot_vids: list[Path | None] = []      # index-aligned with `shots`, for the probe below
    for s in (breakdown.get("shots", []) if breakdown else []):
        sid = s.get("id")
        if not sid:
            continue
        sdir = root / "Shots" / sid
        # Exclude derived siblings: *.preview.mp4 (720p H.264 in-browser proxy for 4k
        # HEVC) and *.dub.mp4 (dialogue-mixed copy) — not separate takes.
        vids = sorted(v for v in sdir.glob("*.mp4")
                      if not (v.name.endswith(".preview.mp4") or v.name.endswith(".dub.mp4"))) if sdir.is_dir() else []
        kf_dir = sdir / "Keyframes"
        kfs = sorted(kf_dir.glob("*.png")) if kf_dir.is_dir() else []

        # Storyboard board (one per shot): latest version PNG + its meta sidecar.
        # The structured panels aren't persisted, but the grid (rows x cols) is
        # parseable from the saved prompt; the board IMAGE is what the UI shows.
        sb_dir = sdir / "Storyboard" / "Versions"
        board = None
        if sb_dir.is_dir():
            bnds = sorted(sb_dir.glob("v*.png"))
            if bnds:
                bf = bnds[-1]
                meta = {}
                mf = sb_dir / f"{bf.stem}.meta.json"
                if mf.is_file():
                    try:
                        meta = json.loads(mf.read_text())
                    except (json.JSONDecodeError, OSError):
                        meta = {}
                prompt = meta.get("auto_prompt", "") or meta.get("sent_prompt", "")
                # Prefer the persisted grid; older boards only have it in the prompt.
                rows = meta.get("rows")
                cols = meta.get("cols")
                if rows is None:
                    rm = re.search(r"(\d+)\s*row", prompt)
                    rows = int(rm.group(1)) if rm else 1
                if cols is None:
                    cm = re.search(r"x\s*(\d+)\s*column", prompt)
                    cols = int(cm.group(1)) if cm else 1
                try:
                    version = int(bf.stem.lstrip("v"))
                except ValueError:
                    version = 1
                board = {
                    "boardLocalPath": str(bf), "version": version,
                    "rows": rows, "cols": cols,
                    "panels": meta.get("panels", []),  # structured beats (empty for pre-persist boards)
                    "autoPrompt": meta.get("auto_prompt", ""),
                    "sentPrompt": meta.get("sent_prompt", ""),
                }

        latest_vid = vids[-1] if vids else None
        preview = latest_vid.parent / f"{latest_vid.stem}.preview.mp4" if latest_vid else None
        shots.append({
            "shotId": sid,
            "videoLocalPath": str(latest_vid) if latest_vid else "",
            "previewLocalPath": str(preview) if (preview and preview.is_file()) else "",
            "keyframeLocalPath": str(kfs[-1]) if kfs else "",
            "status": "ready" if vids else "queued",
            # A shot with no take on disk has never been rendered, so the breakdown's
            # PLAN is the only recorded length and it stands in for no measurement.
            # A shot WITH a take gets the file's real length, filled in below.
            "duration": _as_secs(s.get("duration_sec")) if latest_vid is None else None,
            "board": board,
        })
        shot_vids.append(latest_vid)

    # The take on disk IS the shot's length — this whole function is reconstruction from
    # files, and the file is the only thing here that was measured. `duration_sec` is what
    # was ASKED for (Seedance rounds it, and the cut may have been retimed since), so it
    # does not stand in for a take that exists; a take that will not probe stays None,
    # which travels to the phase-6 gate as "not measured". What used to be here —
    # `s.get("duration_sec", 5)` — handed a literal 5 to every legacy shot with no
    # recorded plan, and qc_final_cut counts that as MEASURED (verified: a 6.0 s take
    # reached the gate as 5).
    #
    # Probed in parallel because it is 23.9 ms of subprocess wait per shot (measured), so
    # a 500-shot episode would stall its own reopen for 12 s. Bounded at 8 so reopening a
    # project cannot fork hundreds of ffprobes at once.
    if any(v is not None for v in shot_vids):
        with ThreadPoolExecutor(max_workers=8) as pool:
            for sh, secs in zip(shots, pool.map(_probe_seconds, shot_vids)):
                if secs is not None:
                    sh["duration"] = secs

    return {"script": script, "breakdown": breakdown, "assets": assets, "shots": shots}


def _heal_missing_shot_media(state: dict, root: Path) -> list[str]:
    """Re-point or demote shots whose recorded video is no longer on disk.

    A shot that says `approved` while its file is gone is the pipeline lying to the
    operator: stage 5 draws it as finished work, the player asks /api/asset/serve for it
    and gets a 404, and the whole thing reads as a black clip nobody can explain. Seen on
    BLACKMIRROR 4's SHOT_004 (2026-08-31): status `approved`, videoLocalPath naming a
    video_v001.mp4 that is not there, and its own lastframe.png sitting next to the empty
    slot from the render that did complete on 08-27. Nothing in the pipeline noticed.

    TWO OUTCOMES, and the first is the common one:
      * a NEWER take exists (the pointer names v001 and disk holds v002) — the pointer is
        stale, so it is moved forward. This is the same self-heal GET /api/asset/serve
        already does for moved paths.
      * NO take exists at all — the shot is demoted to `draft` and its dead media fields
        are cleared, so the UI shows it as not-yet-rendered and offers to render it, which
        is the truth.

    NOTHING IS DELETED. Files on disk are never touched; only a pointer that names a file
    that is not there is corrected. Returns (log lines, corrections) — the corrections go
    to the frontend as `media_heals` so they can be applied even when boot keeps the
    browser's own copy of the project.
    """
    # Deduped: the same shot lives in every version of the stage's 20-entry ring, so an
    # un-deduped log printed one identical line per version and read like four failures.
    healed: list[str] = []
    seen: set[str] = set()
    # …and the same corrections as data. The frontend needs them separately because boot
    # DELIBERATELY keeps a populated browser copy over the disk snapshot (it may hold
    # unsaved work), which means the healed snapshot is thrown away on the one path that
    # matters most: reopening a project you already have in this tab. A media pointer is
    # not work — it is a fact about the disk — so it is applied on its own.
    changes: dict[str, dict] = {}
    for stage_key in ("5", "6"):
        stage = ((state.get("stages") or {}).get(stage_key)) or {}
        for version in (stage.get("versions") or []):
            for shot in (((version or {}).get("data") or {}).get("shots") or []):
                if not isinstance(shot, dict):
                    continue
                shot_id = str(shot.get("shotId") or "")
                recorded = str(shot.get("videoLocalPath") or "")
                # THE SIDECAR IS WHAT WAS SENT. `assembledPrompt` is the store's copy of
                # the prompt behind this take, and stage 5 shows it to the operator under
                # "Sent prompt" — the one panel whose whole job is to answer "what did we
                # actually ask for?". It is written by the browser, so it drifts whenever
                # the tab does not survive to the final write: BLACKMIRROR 4's SHOT_004
                # rendered on 2026-08-31 through the audio-filter retry, the tab closed
                # while the dub was still running, and the field kept the prompt from the
                # 08-28 attempt — 7 mentions of the drawing medium and none of the 2.5
                # template blocks, i.e. a panel showing a prompt that was never sent.
                # video_vNNN.meta.json is written by the BACKEND beside the take at save
                # time and holds the real one, so it wins.
                if recorded:
                    side = Path(recorded)
                    if side.name.endswith(".dub.mp4"):
                        side = side.with_name(side.name[:-len(".dub.mp4")] + ".mp4")
                    side = side.with_suffix(".meta.json")
                    try:
                        if side.is_file():
                            sent = (json.loads(side.read_text()) or {}).get("prompt") or ""
                            if sent and sent.strip() != str(shot.get("assembledPrompt") or "").strip():
                                shot["assembledPrompt"] = sent
                                _line = f"{shot_id}: assembledPrompt refreshed from {side.name}"
                                if _line not in seen:
                                    seen.add(_line)
                                    healed.append(_line)
                                # SOLO la clave que cambia. Una entrada con `shot_id` y
                                # `assembled_prompt` y nada mas NO significa "sin video":
                                # el consumidor aplica clave a clave, nunca el objeto
                                # entero, o una correccion de prompt borraria el puntero.
                                changes.setdefault(shot_id, {"shot_id": shot_id})["assembled_prompt"] = sent
                    except (OSError, ValueError):
                        pass        # a corrupt sidecar must never block a project opening
                if not recorded:
                    continue
                if Path(recorded).is_file():
                    # THE DUB IS THE TAKE. When Seedance's audio filter trips, the clip is
                    # re-rendered MUTE and the pipeline then re-speaks the lines with the
                    # characters' locked voices, writing `<take>.dub.mp4` beside it. The
                    # store swaps its pointer to that file — but only if the tab is still
                    # open a minute later, when the dub lands. Measured on BLACKMIRROR 4's
                    # SHOT_004 (2026-08-31): video_v001.mp4 mute at 11:12, video_v001.dub
                    # .mp4 with voices at 11:13, and the saved state still naming the mute
                    # one. The dubbed file is the take the pipeline decided on; a pointer
                    # left on the silent one is the same divergence as a missing file, and
                    # for a shot whose whole content is a phone call it costs the dialogue.
                    dub = Path(recorded).with_suffix(".dub.mp4")
                    if dub.is_file() and dub.stat().st_mtime >= Path(recorded).stat().st_mtime:
                        shot["videoLocalPath"] = str(dub)
                        shot["videoUrl"] = ""       # named the mute file
                        # FUSIONAR, no reemplazar: este mismo plano puede llevar ya una
                        # correccion de prompt de arriba, y asignar el dict entero la
                        # borraba — el estado quedaba bien y el navegador no la recibia.
                        changes.setdefault(shot_id, {"shot_id": shot_id}).update(
                            {"video_local_path": str(dub), "video_url": "", "status": shot.get("status")})
                        _line = f"{shot_id}: pointed at the dubbed take ({dub.name})"
                        if _line not in seen:
                            seen.add(_line)
                            healed.append(_line)
                    continue
                # Whatever this shot DOES have on disk, newest last. _safe() keeps a
                # crafted shotId from walking out of the project.
                takes = sorted((root / "Shots" / _safe(shot_id)).glob("video_v*.mp4")) if shot_id else []
                if takes:
                    newest = str(takes[-1])
                    shot["videoLocalPath"] = newest
                    shot["videoUrl"] = ""       # the old signed URL named the missing file
                    shot["previewUrl"] = ""
                    changes.setdefault(shot_id, {"shot_id": shot_id}).update(
                        {"video_local_path": newest, "video_url": "", "status": shot.get("status")})
                    _line = f"{shot_id}: re-pointed to {takes[-1].name}"
                    if _line not in seen:
                        seen.add(_line)
                        healed.append(_line)
                else:
                    if shot.get("status") in ("ready", "approved"):
                        shot["status"] = "draft"
                    for dead in ("videoLocalPath", "videoUrl", "previewUrl", "duration"):
                        if dead in shot:
                            shot[dead] = "" if dead != "duration" else 0
                    changes.setdefault(shot_id, {"shot_id": shot_id}).update(
                        {"video_local_path": "", "video_url": "", "status": shot.get("status")})
                    _line = f"{shot_id}: no take on disk — demoted to draft"
                    if _line not in seen:
                        seen.add(_line)
                        healed.append(_line)
    return healed, list(changes.values())


def load_pipeline_state(project_path: str) -> dict:
    """Read back a saved pipeline snapshot + the manifest. `state` is None when the
    project predates state-persistence; `reconstruct` then carries the on-disk
    artifacts so the UI can rebuild the project."""
    root = Path(project_path).expanduser()
    state = None
    saved_at = None
    fp = root / "pipeline_state.json"
    if fp.is_file():
        try:
            doc = json.loads(fp.read_text())
            if not isinstance(doc, dict):
                # VALID JSON that is not an object — 'null', '[1,2,3]', '"x"', '7'. This
                # sailed past the except clause and hit .get() as an AttributeError, which
                # came out of GET /api/project/load as a 500 with preserve_corrupt never
                # running: the bad bytes stayed put and EVERY subsequent boot 500ed the
                # same way, with no route back into the project. It is a corrupt shape
                # like any other, so it reads as ABSENT and is preserved.
                raise ValueError(f"pipeline_state.json holds {type(doc).__name__}, not an object")
            state = doc.get("state")
            saved_at = doc.get("savedAt")
        except (json.JSONDecodeError, ValueError, OSError):
            # A zero-byte or unparseable snapshot is ABSENT, never propagated as state:
            # boot falls through to `reconstruct` and rebuilds from the on-disk artifacts.
            # Move the bad bytes aside so the next autosave doesn't quietly bury the one
            # piece of evidence about what happened to the project.
            preserve_corrupt(fp)
            state = None
    manifest = {}
    mp = root / "project.json"
    if mp.is_file():
        try:
            manifest = json.loads(mp.read_text())
        except (json.JSONDecodeError, OSError):
            manifest = {}
        if not isinstance(manifest, dict):
            manifest = {}       # non-dict JSON — see the pipeline_state guard above
    # The one door every project boot goes through, so the one place worth checking that
    # what the snapshot CLAIMS is rendered is actually on disk. Non-fatal by construction:
    # a heal that raises must never be the reason a project cannot be opened.
    media_heals: list[dict] = []
    if isinstance(state, dict):
        try:
            lines, media_heals = _heal_missing_shot_media(state, root)
            for line in lines:
                logger.info("[Storage] healed stale shot media — %s", line)
        except Exception as e:
            logger.warning("[Storage] shot-media heal failed (non-fatal): %s", e)
    reconstruct = reconstruct_project(project_path)
    return {"state": state, "savedAt": saved_at, "manifest": manifest,
            "reconstruct": reconstruct, "path": str(root), "media_heals": media_heals}


def list_projects(extra_roots: list[str] | None = None) -> list[dict]:
    """Scan TAKEONE_ROOT plus any custom storage roots (the frontend's
    localFolderRoot) for project.json manifests. De-duped by resolved path so an
    overlapping root never double-lists a project."""
    roots = [TAKEONE_ROOT, *[Path(r).expanduser() for r in (extra_roots or []) if r]]
    projects: list[dict] = []
    seen: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        for p in sorted(root.iterdir()):
            manifest = p / "project.json"
            if not manifest.exists():
                continue
            key = str(p.resolve())
            if key in seen:
                continue
            seen.add(key)
            try:
                data = json.loads(manifest.read_text())
                projects.append({
                    "name": data.get("name", p.name),
                    "type": data.get("type", "unknown"),
                    "structure": data.get("structure", {}),
                    "createdAt": data.get("createdAt"),
                    "path": str(p),
                })
            except Exception as e:  # noqa: BLE001
                # A project whose project.json is corrupt or unreadable is DROPPED from
                # the list — to the user their project has simply vanished from the
                # picker. Skipping is still the right behaviour; being silent was not.
                logger.warning("[Storage] project at %s skipped — manifest unreadable: %s", p, e)
    return sorted(projects, key=lambda x: x.get("createdAt", "") or "", reverse=True)
