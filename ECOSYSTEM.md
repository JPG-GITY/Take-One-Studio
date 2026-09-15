# ECOSYSTEM.md — Take One Studio technical decisions

Companion to [`ARCHITECTURE.md`](ARCHITECTURE.md) (the 6-stage pipeline map). This file records
**what** the project is built on and **why**, so a change never has to guess the
stack. Every entry is grounded in a real file — if you add or swap a dependency or
pattern, update this file in the same change.

> Scope note: this documents decisions verified against the repo (`package.json`,
> `requirements.txt`, and the cited source files). Where a rationale is inferred
> rather than stated in-code, it's marked _(rationale)_.

---

## Shape

Two processes, launched together by `start.sh`:

- **Backend** — Python FastAPI app `server:app` (`server.py`), port 8000.
- **Frontend** — Next.js app in `frontend/`, port 3000.

The frontend never calls BytePlus/Anthropic directly; it talks only to the FastAPI
backend, which owns all model calls, keys, and disk I/O.

---

## Backend stack (`requirements.txt`)

| Dependency | Role | Notes |
|---|---|---|
| `fastapi` + `uvicorn[standard]` | HTTP app + ASGI server | app is `server:app`; run with `.venv-mac/bin/uvicorn` |
| `sse-starlette` | Server-Sent Events | the `AgentEventBus` streams live agent progress via `EventSourceResponse` (`server.py:82,344`) |
| `pydantic` v2 | request/response models | every POST endpoint has a `<Purpose>Request` model |
| `openai` (SDK) | **BytePlus client** | ModelArk is OpenAI-compatible, so the OpenAI SDK is pointed at `BYTEPLUS_BASE_URL` (`byteplus_generative.py:20,256`) — _not_ used for OpenAI models |
| `anthropic` (SDK) | Claude "brain" | breakdown, prompt-writing, face blocks, QC fallback (`claude_agents.py`) |
| `websockets` | Seed TTS 2.0 | `byteplus_tts.py` speaks the bidirectional binary TTS protocol |
| `requests` / `httpx` | HTTP | `requests` used by `seed_audio.py` (Seed Audio 1.0 REST) + `r2_storage.py` |
| `python-dotenv` | env loading | keys from `.env` |
| `certifi` | TLS roots | macOS Python's cert store is incomplete; used by the TTS WS client |

**Retired:** the old Streamlit / Pinecone / RAG / torch stack is gone — install only
from `requirements.txt` (its header says so).

**Virtualenv:** `.venv-mac` is the live one (wired into `start.sh` + root
`package.json`). `.venv` is a leftover **Windows** venv (Python 3.14, `home = C:\…`) —
it won't run on macOS; do not use it.

---

## Frontend stack (`frontend/package.json`)

| Dependency | Version | Role |
|---|---|---|
| `next` | 16.2.7 | App Router framework — **customized; see [`frontend/AGENTS.md`](frontend/AGENTS.md)**, read `node_modules/next/dist/docs/` before writing Next code |
| `react` / `react-dom` | 19.2.4 | UI |
| `typescript` | ^5 | typed; gate is `npx tsc --noEmit` (no npm script) |
| `tailwindcss` | ^4 | styling via `@tailwindcss/postcss`; v4 `@theme` CSS-vars (light/dark tokens in `app/globals.css`) |
| `zustand` | ^5 | **state** — see below |
| `immer` | ^11 | immutable store updates (mutate the draft) |
| `@tanstack/react-query` | ^5 | provider mounted in `app/providers.tsx`; most data flow actually goes through the axios client + store, not query hooks |
| `axios` | ^1 | **the API client** — `lib/api/client.ts` (`axios.create({ baseURL: NEXT_PUBLIC_API_URL ?? 'http://localhost:8000' })` + a response interceptor); typed calls live in `lib/api/pipeline.api.ts` |
| `nanoid` | ^5 | client-side IDs |
| `lucide-react` | ^1 | icons (import from `lucide-react`) |
| `clsx` + `tailwind-merge` | — | the `cn()` helper in `lib/utils.ts` |
| `@playwright/test` | ^1.60 | E2E — 35 specs in `frontend/e2e/`; no `webServer` config, so start the app first |
| `eslint` + `eslint-config-next` | ^9 / 16.2.7 | `npm run lint` |

---

## State management — Zustand single store

`frontend/store/pipeline.store.ts` is the persisted single source of truth:
`create<PipelineStore>()(persist(immer((set) => ({…}))))`.

- **Why Zustand + Immer + Persist** _(rationale)_: the whole film pipeline state
  (script → breakdown → assets → storyboard → shots → cut) must survive navigation
  and reload; a single persisted store with draft-mutation setters keeps every stage
  view reading one truth.
- Persist key `takeone-pipeline-v1`, `version: 5`; `migrate()` stays a no-op by making
  new fields optional + read-time-defaulted (`pipeline.store.ts:398`).
- `partialize` **strips `data:` URIs** before persisting (localStorage quota guard); a
  custom storage wrapper swallows `QuotaExceededError`.
- **Non-linear versioning:** each stage keeps a 20-entry ring buffer
  (`MAX_VERSIONS=20`, `pipeline.store.ts:29`); a `DOWNSTREAM` map cascades
  `invalidated`/`isDirty` on upstream edits — nothing is ever deleted or
  auto-regenerated.
- Other stores: `store/agents.store.ts`, `store/studio.store.ts`, `store/theme.store.ts`.
- **Rule:** mutate only through store actions; no component-local shadow copies; never
  call a setter inside a React `setState` updater.

---

## Models (BytePlus ModelArk + Anthropic)

All model IDs read from env with a code default — **swap a model in `.env`, never
hardcode a call site.** Defaults (`byteplus_generative.py:286-305`, `claude_agents.py:20,28`):

| Purpose | Default ID | Env var |
|---|---|---|
| Image | `seedream-5-0-260128` | `SEEDREAM_MODEL` |
| Image (Pro, editor only) | `dola-seedream-5-0-pro-260628` | `SEEDREAM_PRO_MODEL` |
| Video | `dreamina-seedance-2-0-260128` | `SEEDANCE_MODEL` |
| Vision / QC | `seed-2-0-pro-260328` | `BYTEPLUS_VISION_MODEL` / `QC_MODEL` |
| Embeddings | `skylark-embedding-vision-251215` | `BYTEPLUS_EMBED_MODEL` |
| Text (utility) | `deepseek-v4-flash-260425` | `DEEPSEEK_MODEL` |
| Claude "brain" | `claude-sonnet-4-6` | `CLAUDE_AGENT_MODEL` |
| Voice — cloning | `seed-audio-1.0` | `SEED_AUDIO_MODEL` (`seed_audio.py`, REST) |
| Voice — TTS | Seed TTS 2.0 | `SEED_TTS_RESOURCE_ID` (`byteplus_tts.py`, WebSocket) |

- **QC billing split** (`.env.example`, QC section): QC gate verdicts run on Seed 2.0 Pro
  (`QC_BACKEND=seed`) to preserve the Anthropic budget; Claude is fallback only.
- **Two distinct voice products:** Seed Audio 1.0 (REST `voice.ap-southeast-1…/v3/tts/create`,
  per-actor voice cloning) vs Seed TTS 2.0 (WebSocket bidirectional). Don't conflate them.
- **Reference for model APIs:** the `byteplus-genius` skill (bundled BytePlus docs) and
  the `claude-api` skill (Anthropic SDK). Consult them before using any model
  ID/parameter/endpoint — never invent one.

---

## Storage

- **Local disk is the store.** `storage.py` writes to the user's machine
  (`TAKEONE_ROOT = $TAKEONE_HOME` or `~/Documents/TakeOne-Project` — never the repo).
  Every path segment passes through `_safe()`; versioned writes never overwrite
  (`vNNN.png`, `video_vNNN.mp4`); `pipeline_state.json` is written atomically.
- **Cloudflare R2** (`r2_storage.py`, `R2_*` env) is used **only** to host Seedance
  video references at a public URL — Seedance rejects base64 refs, so a ref is
  uploaded, the public URL is passed, then it's cleaned up.

---

## Testing & tooling — decisions

- **No unit-test runner** (no pytest, no `npm test` script) by design. Quality gates
  are: `.venv-mac/bin/python -m py_compile <files>` (backend), `npx tsc --noEmit` +
  `npm run lint` + `npm run build` (frontend), and Playwright E2E for behaviour.
- **Playwright has no `webServer`** — the dev server must already be running on :3000.
- The repo ships `/run` and `/verify` skills to drive the app end-to-end; prefer them
  over ad-hoc manual checks for any behaviour change.

---

## Environment keys (`.env`, loaded by python-dotenv)

| Key | Required? | For |
|---|---|---|
| `BYTEPLUS_API_KEY` | yes | all BytePlus image/video/vision/embedding/DeepSeek calls |
| `SEEDDREAM4_API_KEY` | optional | separate Seedream key; falls back to `BYTEPLUS_API_KEY` |
| `BYTEPLUS_BASE_URL` | yes | ModelArk endpoint (region) |
| `ANTHROPIC_API_KEY` | yes | Claude brain + QC fallback |
| `SEED_TTS_API_KEY` (+ `SEED_TTS_RESOURCE_ID`) | for voice | Seed TTS 2.0 |
| `SEED_AUDIO_API_KEY` (+ `SEED_AUDIO_MODEL`) | for cloning | Seed Audio 1.0; falls back to `SEED_TTS_API_KEY` |
| `R2_*` | for video refs | public hosting of Seedance references |

Model-ID / QC / `CLAUDE_AGENT_MODEL` env vars are optional overrides (defaults above).

---

_When you introduce a new library, model, store, or storage target — add it here with
its role and, if non-obvious, the reason. Frequent “why did we pick X?” questions mean
this file has a gap._
