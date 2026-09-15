# Take One Studio — AI Cinema Engine

**AI-native film & TV pipeline, from concept to final cut.**
A 6-stage Human-in-the-Loop production pipeline: every stage generates, a human approves, and downstream stages consume only approved work.

---

## The pipeline

| Stage | Name | Engine |
|-------|------|--------|
| 1 | Script | Claude |
| 2 | Breakdown (assets, shots, dialogue) | Claude |
| 3 | AG — Asset Generation (character sheets, props, environments, voice locks) | Seedream 5.0 + Seed TTS |
| 4 | Storyboard (cinematic photoreal panels, identity-locked) | Claude + Seedream 5.0 |
| 5 | SG — Shot Generation (panel-grounded keyframes → video, dialogue dubbing) | Seedream 5.0 + Seedance 2.0 + Seed TTS |
| 6 | Final Cut & Export (timeline, soundtrack, ffmpeg render) | ffmpeg |

Plus a standalone **Studio** (freeform image/video/voice generation) and an **Autopilot** (one prompt → full pipeline, pausing at approval gates).

Cross-cutting systems: identity locking (trusted face anchors that pass Seedance's real-person filter), per-character voice anchors, an objective consistency harness (score any still against the approved character), version history with staleness cascade, per-project usage metering, and a persistent error log.

---

## Architecture

| Component | Technology |
|-----------|-----------|
| Frontend | Next.js (`frontend/`) — port 3000 |
| Backend | FastAPI (`server.py`) — port 8000 |
| Text / QC / vision | Claude (`claude_agents.py`) |
| Image | Seedream 5.0 (`byteplus_generative.py`) |
| Video | Seedance 2.0 (`byteplus_generative.py`) |
| Voice / TTS | Seed TTS 2.0 (`byteplus_tts.py`) |
| Storage | Per-project folders under `~/Documents/TakeOne-Project/` (`storage.py`) |

Model IDs are env-overridable (see `.env.example`) so a new model release is a one-line swap.

## Quick start

```bash
# 1. Install
python3.11 -m venv .venv-mac && .venv-mac/bin/pip install -r requirements.txt   # backend
cd frontend && npm install && cd ..      # frontend

# 2. Credentials
cp .env.example .env                     # add BYTEPLUS_API_KEY, ANTHROPIC_API_KEY, SEED_TTS_API_KEY

# 3. Run both servers
./start.sh
# or: npm run backend  /  npm run frontend
# App: http://localhost:3000 · API: http://localhost:8000/docs
```

## Project files

| File | Purpose |
|------|---------|
| `server.py` | FastAPI backend — all pipeline endpoints |
| `claude_agents.py` | Claude agents: script, breakdown, storyboard beats, QC personas, prompt engineering |
| `byteplus_generative.py` | Seedream/Seedance client + prompt assemblers |
| `byteplus_tts.py` | Seed TTS websocket client (voice synthesis) |
| `storage.py` | Per-project disk layout, versioning, anchors/blocks caches |
| `usage.py` | Per-project usage metering → `Usage/usage.json` |
| `render_registry.py` | Crash-safe registry of in-flight Seedance renders |
| `r2_storage.py` | Cloudflare R2 temp hosting (video references need public URLs) |
| `frontend/` | Next.js app (stages, Studio, autopilot) |
| `skills/qc/` | QC persona skill files consumed by the backend |
| `byteplus-models-genius/` | BytePlus model reference docs (model IDs, params, limits) — do not delete |

## Notes

- Generated projects live OUTSIDE the repo in `~/Documents/TakeOne-Project/<name>/`.
- `_studio/` holds the standalone Studio gallery (gitignored, live data).
- The BytePlus solution-guide PDF is closed-door material: keep it untracked (gitignored).
