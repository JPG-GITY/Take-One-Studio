"""Drive-video extraction: turn footage into a motion-ONLY reference for Seedance.

Take One Studio's motion reference has always been the RAW clip, handed to the model under a role
that says to take movement and "no subject, location or colour from it" — that is, to
ignore most of what is actually in those pixels. A whole-body skeleton painted on black
has nothing to ignore: it carries the performance and nothing else, so it cannot leak a
face, a wardrobe or a room over the approved character sheet.

This is not a workaround for a missing feature. The 2.5 capability table names it:
"Base-mesh reference / rendering (new) — feed a coarse- or fine-grained white-model
(blockmesh) video; the model references its motion and renders on top. Stackable with
entity + scene reference." A pose skeleton is that input.

OPTIONAL DEPENDENCY BY DESIGN. rtmlib + onnxruntime + opencv are ~200 MB and only matter
to someone driving a character with footage, so they are NOT in requirements.txt and the
imports happen inside the call. A machine without them gets an actionable sentence naming
the install command — the same contract get_byteplus() has for a missing key — instead of
an ImportError at boot that would take the whole server down for a feature nobody used.

    .venv-mac/bin/pip install -r requirements-motion.txt

Weights (~100 MB of RTMPose ONNX) download on first run and are cached by rtmlib.
"""
from pathlib import Path
import logging
import subprocess
import tempfile

logger = logging.getLogger(__name__)

# rtmlib's own vocabulary. 'performance' is the accurate/slow model pair, 'lightweight' the
# fast one; 'balanced' is the default because a drive video is judged on whether the limbs
# stay attached, not on millimetres.
MODES = ("performance", "balanced", "lightweight")

# Below this a joint is not drawn. rtmlib's own default (0.3) keeps low-confidence limbs,
# which read as jitter — and jitter in a drive video is motion the model will faithfully
# reproduce. Raised to the value the reference pipeline settled on.
DEFAULT_KPT_THR = 0.43

_MISSING = ("Pose extraction needs rtmlib, onnxruntime and opencv, which Take One Studio does not "
            "install by default (~200 MB, only used for motion drive videos). Install them "
            "with:  .venv-mac/bin/pip install -r requirements-motion.txt")


def available() -> tuple[bool, str]:
    """Whether this machine can extract. Never raises — callers turn it into a 503."""
    try:
        import cv2          # noqa: F401
        import rtmlib       # noqa: F401
        return True, ""
    except Exception as e:
        return False, f"{_MISSING} ({e.__class__.__name__}: {e})"


def _h264(src: Path, dst: Path) -> bool:
    """Re-encode to H.264/yuv420p. OpenCV writes mp4v, which Safari and Chrome refuse to
    play and which Seedance has no reason to like either — and the whole point of the
    overlay is that a human WATCHES it before paying for a render. Best-effort: if ffmpeg
    is missing the mp4v file is still returned rather than nothing."""
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                        str(dst)], check=True)
        return True
    except Exception as e:
        logger.warning("[MotionDrive] ffmpeg re-encode failed (non-fatal, keeping mp4v): %s", e)
        return False


def _primary(keypoints, scores, previous):
    """Which detected person this frame's skeleton is.

    Default rtmlib behaviour is "draw everyone", and on real footage that means the drive
    video hops onto whoever walks through the background — the character then inherits a
    passer-by's gait mid-shot. The subject is the biggest person in the first frame that
    has one, and thereafter the detection whose centroid is nearest the previous one, so
    it stays on them through a crossing instead of jumping to the larger body.
    """
    import numpy as np
    if keypoints is None or len(keypoints) == 0:
        return None, previous
    def centroid(i):
        pts = keypoints[i][scores[i] > 0.1] if scores is not None else keypoints[i]
        return pts.mean(axis=0) if len(pts) else None
    if previous is None:
        areas = []
        for i in range(len(keypoints)):
            pts = keypoints[i]
            areas.append(float((pts[:, 0].max() - pts[:, 0].min()) *
                               (pts[:, 1].max() - pts[:, 1].min())) if len(pts) else 0.0)
        idx = int(np.argmax(areas))
    else:
        best, idx = None, 0
        for i in range(len(keypoints)):
            c = centroid(i)
            if c is None:
                continue
            d = float(np.hypot(c[0] - previous[0], c[1] - previous[1]))
            if best is None or d < best:
                best, idx = d, i
    return idx, (centroid(idx) if centroid(idx) is not None else previous)


def extract(video_path: str, out_dir: str, *, mode: str = "balanced",
            kpt_thr: float = DEFAULT_KPT_THR, overlay: bool = True,
            all_people: bool = False) -> dict:
    """Write <stem>-skeleton.mp4 (and <stem>-overlay.mp4) into out_dir.

    RAISES on a missing dependency or an unreadable video: a caller asking for a drive
    video cannot do anything useful with a silent empty result, and the next thing that
    happens to that file is a PAID render. Returns the paths plus the frame count and the
    share of frames a subject was actually found in — a skeleton that tracked 12% of the
    take is not a drive video, and only the number says so.
    """
    ok, why = available()
    if not ok:
        raise RuntimeError(why)
    import cv2
    from rtmlib import Wholebody, draw_skeleton

    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, got {mode!r}")
    src = Path(video_path)
    if not src.is_file():
        raise FileNotFoundError(f"no such video: {video_path}")
    outd = Path(out_dir)
    outd.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise RuntimeError(f"could not open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if not w or not h:
        cap.release()
        raise RuntimeError(f"video reports no frame size: {video_path}")

    # onnxruntime on CPU: the machine that runs Take One Studio is a Mac, and this is the one
    # stage of the whole pipeline that costs nothing to run, so it stays local.
    model = Wholebody(to_openpose=True, mode=mode, backend="onnxruntime", device="cpu")

    import numpy as np
    tmpdir = Path(tempfile.mkdtemp())
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    raw_skel = tmpdir / "skeleton.mp4"
    raw_over = tmpdir / "overlay.mp4"
    w_skel = cv2.VideoWriter(str(raw_skel), fourcc, fps, (w, h))
    w_over = cv2.VideoWriter(str(raw_over), fourcc, fps, (w, h)) if overlay else None

    frames = tracked = 0
    previous = None
    try:
        while True:
            got, frame = cap.read()
            if not got:
                break
            frames += 1
            keypoints, scores = model(frame)
            if not all_people:
                idx, previous = _primary(keypoints, scores, previous)
                if idx is not None:
                    keypoints, scores = keypoints[idx:idx + 1], scores[idx:idx + 1]
                else:
                    keypoints, scores = None, None
            if keypoints is not None and len(keypoints):
                tracked += 1
            black = np.zeros((h, w, 3), dtype=np.uint8)
            if keypoints is not None and len(keypoints):
                black = draw_skeleton(black, keypoints, scores, openpose_skeleton=True,
                                      kpt_thr=kpt_thr)
            w_skel.write(black)
            if w_over is not None:
                over = frame.copy()
                if keypoints is not None and len(keypoints):
                    over = draw_skeleton(over, keypoints, scores, openpose_skeleton=True,
                                         kpt_thr=kpt_thr)
                w_over.write(over)
    finally:
        cap.release()
        w_skel.release()
        if w_over is not None:
            w_over.release()

    if not frames:
        raise RuntimeError(f"video had no readable frames: {video_path}")

    stem = src.stem
    skel = outd / f"{stem}-skeleton.mp4"
    if not _h264(raw_skel, skel):
        skel.write_bytes(raw_skel.read_bytes())
    over_path = None
    if w_over is not None:
        over_path = outd / f"{stem}-overlay.mp4"
        if not _h264(raw_over, over_path):
            over_path.write_bytes(raw_over.read_bytes())

    coverage = round(tracked / frames, 3)
    logger.info("[MotionDrive] %s: %d frames, subject found in %.0f%% → %s",
                src.name, frames, coverage * 100, skel.name)
    return {
        "skeleton_path": str(skel),
        "overlay_path": str(over_path) if over_path else "",
        "frames": frames,
        "fps": round(float(fps), 3),
        "seconds": round(frames / float(fps), 2) if fps else 0.0,
        # The honest quality number. Anything low means the skeleton is blank for most of
        # the take, and a blank drive video does not drive anything.
        "tracked_coverage": coverage,
    }
