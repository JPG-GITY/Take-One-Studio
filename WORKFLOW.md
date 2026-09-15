# Take One Studio — Video Production Workflow

Canonical workflow (matches the product diagram). This is the source of truth for
how a script becomes a finished film. Per the project rules ("no inventar / decir la verdad
del estado") each step is marked with its **real** status in the code today.

```
1 SCRIPT ──▶ 2 BREAKDOWN ──┬────────────────────────────────▶ SHOTS ─▶ 4 STORYBOARDS/shot
 (ingest)     (assets/       │  ASSETS          SCENES                    (4.1 + acting desc)
              shots/scenes)   ▼                                                   │
                            3 ASSET GEN (Seedream 5.0 PRO)                        │
                              ├─ 3.1 Voice preview (Seed Audio 1)                 │
                              └─ 3.2 Dialogue gen per approved char/scene         │
                                     (describe ACTING INTENT) ─┐                  │
                                                               ▼                  ▼
   char + env refs ───────────────────────────────────▶ 5 MULTIMODAL RENDER ◀────┘
   storyboards (camera motion) ─────────────────────────▶ (SEEDANCE 2.0 multimodal)
   dialogues (audio ref) ───────────────────────────────▶  renders each shot from refs
                                                               │
                                                               ▼
                                                          6 FINAL CUT ──▶ 🎬
                                                          (+ soundtrack, Seed Audio 1)
```

## Steps

| # | Step | What it does |
|---|------|--------------|
| **1** | **Script ingestion** | Load / paste / generate the screenplay. |
| **2** | **Breakdown** | Extract **assets**, **shots** and **scenes** from the script. |
| **3** | **Asset generation — Seedream 5.0 Pro** | Generate character / prop / wardrobe / environment sheets. |
| **3.1** | **Voice preview — Seed Audio 1.0** | Clone/preview each character's locked voice. |
| **3.2** | **Dialogue generation** | Render the approved characters' dialogue per scene with Seed Audio 1.0, **describing the acting intent**, to hand to Seedance. |
| **4** | **Storyboards per shot** | One board per shot. |
| **4.1** | **Acting description on the board** | Boards carry the shot's action/acting description + camera. |
| **5** | **Multimodal render — Seedance 2.0** | Pass as references: **characters + environments** (identity/look), **storyboard** (camera motion / composition), **dialogues** (audio ref). Seedance renders **each shot from the approved references**. |
| **6** | **Final cut** | NLE timeline + render. Audio track can hold a soundtrack (Seed Audio 1.0 = voice/VO). |

## Real status today (honest)

| Step | Status | Detail |
|------|--------|--------|
| 1 Script | ✅ built | Stage 1. |
| 2 Breakdown | ✅ built | Stage 2 (assets + shots + scenes; long-form chunked). |
| 3 Assets on **Pro** | ✅ built | Default `SEEDREAM_MODEL` is now `dola-seedream-5-0-pro-260628` (all image gen on Pro). ⚠️ Pro caps at ~2K — the 4096² character sheet auto-clamps to ~2144². |
| 3.1 Voice preview | ✅ built | Seed Audio 1.0 clone + preview + presets per character; auto-lock at AG approval. |
| 3.2 Dialogue → Seedance | ✅ built | Per-shot **generate → preview → approve** dialogue panel next to the storyboard (Seed Audio 1.0 locked voices) + batch "Generate all dialogue"; the APPROVED clip rides to Seedance as the audio reference (`generate_audio: true` per video-seedance §4 for synced vocals); inline render remains the fallback. Dedicated **acting-intent field** (`Shot.performance`) auto-filled by the director pass, editable + Enhance. |
| 4 Storyboards | ✅ built | One board per shot (Pro), auto-QC. |
| 4.1 Acting desc on board | ✅ built | Each board shows the shot's **Acting ·** line (`Shot.performance`); it also folds into the Seedance direction prompt. Camera-Director QC checks it. |
| 5 Seedance multimodal | ✅ built | Reference mode (no first-frame): approved **character headshot+sheet + environment + storyboard board** as `reference_image`, **+ dialogue clip as `audio_url`**. Composes + animates + lip-syncs from the approved refs. |
| 6 Final cut + soundtrack | ✅ built | Timeline + ffmpeg render ✅. **"Generate soundtrack"** bar above the timeline: write a prompt + length → an **instrumental music** track (Seed Audio 1.0) drops on the audio track; file upload still available. ⚠️ **Correction (2026-07-12, verified live):** Seed Audio 1.0 IS prompt-driven generative audio and *does* emit instrumental music — but only ~15 s per internal chunk, and the content-risk audit blocks 30 s+ single requests and parallel bursts. So the backend renders a few ~15 s chunks **sequentially** (spaced, neutral-phrasing retry), concatenates a phrase, and **loops it to the exact film length + fade**. (Sung songs with a real person's voice remain out — voiceprint rules.) |

## Cross-cutting safeguards (added 2026-07-13)

- **Breakdown reconciliation** — regenerating the breakdown no longer cross-wires downstream state: the LLM's renumbered ASSET/SHOT/SC IDs are rewritten to reuse the previous IDs for matching entities (assets by type+name, scenes by heading, shots by scene+action); `assetsUsed` + `dialogue.characterId` are remapped; a summary names the **affected tomas** (kept / changed / new / removed) and content-identical shots keep their approvals. (`frontend/lib/reconcileBreakdown.ts`)
- **Cache policy** — `/api/asset/serve`: versioned paths (`/Versions/vNNN`, `video_vNNN.mp4`) are immutable-cached (instant back/forward); mutable siblings (`dialogue.mp3`, `.dub.mp4`, `.preview.mp4`) are `no-cache` so regenerated audio/video never plays stale.

## Compliance — BytePlus KYC / face-detection exemption

> **Source:** BytePlus exemption note (user-provided).
> Transcribed as reference — **verify with your BytePlus contact before relying on it.**
> This is NOT verified from code; models, contacts and terms may change.

**Models eligible for exemption (per that note):**

| Family | Eligible models |
|---|---|
| Seedance | Seedance 2.0 · 2.0 mini · 2.5 |
| Seedream | Seedream 5.0 **Lite** · 5.0 **Pro** |

> The note lists **5.0 Lite / 5.0 Pro** (not the plain flagship). Take One Studio's AG already
> runs on **Pro** (`dola-seedream-5-0-pro-260628`) and video on **Seedance 2.0** — both
> on the eligible list.

**Full-exemption scenario:** `Text-to-Image → Image → Image-to-Video`, all on the
**same account → full exemption.** This is exactly Take One Studio's chain (Seedream image →
Seedance i2v, one account), so the full-exemption scenario applies.

**Two ways to apply** — START: apply for **KYC HIGH** certification for the Seedance
series, then branch by platform:

| Platform | Path |
|---|---|
| **Volcano** (manual whitelisting) | 1) KYC HIGH passed → 2) request manual whitelisting through BytePlus support |
| **BytePlus** (automatic) | 1) KYC HIGH passed → 2) **image-to-image scenario auto-exempted** (no manual step) |

Take One Studio runs on **BytePlus** (`ark.ap-southeast.bytepluses.com`) → the **automatic**
path applies: once KYC HIGH is passed, i2i is auto-exempted.

**⚠️ Critical boundary — exemption ≠ real faces:**
- ✅ **"Virtual humans" only** (per the KYC HIGH agreement).
- ❌ **Real human faces as input are still prohibited.**

This is *why* Step 3 / the consistency chain uses **fictional, distinctive faces** — it
keeps the pipeline on the ✅ side of this boundary. Never feed a real person's face as a
reference anywhere in the flow.

---

_Last updated after commits: Pro-default (73b0bc3), SG approved-refs (0db1751), dialogue→Seedance audio (7fc2785). Compliance section added from a BytePlus exemption note._
