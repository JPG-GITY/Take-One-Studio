# Dola-Seed-2.1-turbo — model note + measured A/B vs Seed 2.0 Pro

> **Status:** evaluated for Take One Studio on 2026-08-04, **not adopted**. Available as an env option.
> Everything below marked *measured* comes from a 4-arm benchmark on Take One Studio's real shipped
> prompts (59 cases × 4 arms across 9 surfaces, frozen corpus, two full runs on the long-JSON
> path). Everything marked *unknown* was not obtainable — do not fill those gaps by guessing.

## 1. Identity

| | |
|---|---|
| **Model ID** | `dola-seed-2-1-turbo-260628` |
| Display name | Dola-Seed-2.1-turbo · version 260628 |
| Endpoint | `https://ark.ap-southeast.bytepluses.com/api/v3` — OpenAI-compatible `chat/completions` |
| Region | `ap-southeast-1` (present in that region's `GET /v3/models`) |
| Console detail page | `https://ai.byteplus.com/ark/region:ap-southeast-1/model/detail?name=dola-seed-2-1-turbo` |

Verified 2026-08-04 against the live catalog on this account (60 models). It is the **only**
2.1 variant listed — no pro/lite/mini siblings. The `dola-` prefix matches
`dola-seedream-5-0-pro-260628`; note that `seed-2-0-pro-260328` carries **no** prefix, so the
prefix is not predictable from the family and must be read from the catalog.

## 2. Capabilities — probed, not assumed

All confirmed working via `chat/completions`:

| Capability | Result |
|---|---|
| Vision, single image (data-URI) | ✅ |
| Vision, multiple images in one message | ✅ |
| `thinking: {"type": "disabled"}` | ✅ accepted **and honoured** — see §3 |
| `response_format: {"type": "json_object"}` | ✅ |
| `response_format` **+** `thinking:disabled` on the same call | ✅ |
| `temperature`, `max_tokens`, system+user messages | ✅ |

**Unknown — not published anywhere reachable:** context window, max output tokens, RPM/TPM
limits, whether reasoning tokens count against `max_tokens`, availability in `eu-west-1`.
Pricing *is* published (the model appears on the ModelArk pricing page) but that page is a JS
SPA whose table could not be reconstructed reliably from the SSR payload — **read the real
figure from the console before making any cost claim.**

The model is absent from this skill's bundled `model-catalog.md` and from `sources.json`
(19,259 entries) — both predate it.

## 3. Deep thinking is ON by default — the single most important fact

The default arm spends 3–8× the output tokens and 2.4–17.5× the latency of the same model with
`thinking:{"type":"disabled"}`. That gap is **hidden reasoning, not content**: with thinking off
the model returns *more* visible text on several surfaces while billing far fewer output tokens.

Measured on one identical vision call (`describe_face_vision`, same image, same prompt):

| arm | latency | output tokens |
|---|---|---|
| `seed-2-0-pro-260328` (default) | 9.3 s | 441 |
| `dola-seed-2-1-turbo-260628` (default) | 17.7 s | 888 |
| `dola-seed-2-1-turbo-260628` + thinking off | 7.4 s | 132 |

⚠️ **Seed 2.0 Pro also defaults to thinking ON**, so any 2.1-vs-2.0 comparison that omits a
`2.0 + thinking:disabled` control arm measures the flag and calls it the model. That is exactly
what happened in the first round of this evaluation.

⚠️ **Patching the client instance does not work.** Callers that do
`client.with_options(timeout=…)` get a **copy**, and an instance-level patch is silently dropped
on it — producing a "thinking disabled" arm that is really the default arm with a different
label. Inject into the `create()` kwargs, or patch the SDK `Completions` class.

## 4. Measured A/B — 4 arms, Take One Studio's real prompts

Means across 8 surfaces (6 vision + 2 reasoning), 44 calls per arm:

| arm | latency | output tokens | hard failures |
|---|---|---|---|
| `2.0-pro` + thinking off | **4.3 s** | **93** | 0/44 |
| `2.1-turbo` + thinking off | 7.2 s | 122 | 0/44 |
| `2.0-pro` (default) | 9.7 s | 382 | 0/44 |
| `2.1-turbo` (default) | 75.5 s | 597 | **3/44** |

**With thinking disabled on both, the older model is 1.7× faster and 1.3× cheaper in output
tokens.** 2.1-turbo's apparent speed advantage in round 1 was an artifact of comparing against
2.0 with thinking on.

Deep-thinking-by-default won **zero of eight** surfaces. Its three hard failures were all
timeouts (182 s ×2, 273.5 s ×2, 185.25 s) against 60–90 s SDK timeouts, and all were swallowed
by the callers' `except` blocks — the pipeline degrades **silently** rather than erroring.

### Where 2.1-turbo is genuinely better (survives the control)

1. **It does not fabricate evidence.** Given a QC prompt whose vision + drift sections rendered
   **empty**, both 2.0 arms invented the identical figure *"Style drift measured at 31%, well
   below the 55% failure threshold"* — plus a palette and a lighting assessment nobody supplied —
   and **passed the asset on it**. Both 2.1 arms correctly reported the data was absent on all
   five checks. Disabling thinking does **not** fix this, so it is a 2.0 model property.
   Counterpoint: 2.1 returns `passed=false` on absent input, which may over-block.
2. **Wider identity-match separation.** Pixel-identical pair vs genuinely drifted pair:
   `2.0` scored 92 vs 95 (a **rank inversion** — it ranks the drifted candidate higher, and it
   invented a difference on two identical files); `2.0+nothink` 96 vs 93 (correct, 3-pt margin);
   `2.1+nothink` 98 vs 88 (correct, 10-pt margin, and the only arm that named the drift).

### Where it is worse or neutral

- **Storyboard continuity:** both 2.1 arms regress. The default arm timed out 2/2; the nothink
  arm produced concrete cross-panel drift claims that did not survive checking against pixels.
- **Prompt writing:** 2.0 is the only arm inside the documented word budget on all three sheet
  writers. Both 2.1 arms invent unsupported identity content (freckles, a cardigan) against a
  system prompt that explicitly forbids inventing marks.
- **Everything else:** no demonstrated quality difference, at higher latency and token cost.

## 5. `thinking:disabled` is not universally safe

On **`derive_film_bible`** — the longest output in the pipeline (`max_tokens=2600`) —
`2.0-pro + thinking:disabled` returned **malformed JSON on 2 of 2 runs**
(`Expecting property name enclosed in double quotes`, char 3763 and 3401). The other three arms
parsed both times. The failure is silent: the function logs a warning, returns `{}`, and the
project proceeds with no bible.

So the flag must be applied **per surface**, never in bulk. It is a large win on short vision
calls and QC verdicts, and a demonstrated regression on the longest structured-JSON path.

## 6. If Take One Studio ever adopts it

Two independent env vars, neither of which should move on this evidence:

- `BYTEPLUS_VISION_MODEL` (`byteplus_generative.py:567`) — one constant, six vision call sites,
  no per-call override. Storyboard continuity regresses, so a blanket switch trades one gate for
  five with no measured gain.
- `QC_MODEL` (`claude_agents.py:28`) — one constant feeding **three** different things:
  `_qc_seed` (the six QC gates, where 2.1 wins on fabrication), `_seed_text` → `_text_llm`
  (every Seedream prompt writer, where 2.0 wins), and `_breakdown_complete` when
  `BREAKDOWN_BACKEND=seed`. Splitting that variable is a prerequisite, not a nicety.

Setting either variable **alone** ships 2.1-turbo at its thinking-ON default — the worst arm
measured, and the one with silent timeouts. The env change and the thinking flag are one change
or neither.

## 7. What this benchmark did not answer

- Absolute cost — no reliable published rate was obtained. All cost claims here are token counts.
- Quality under load / concurrency; every timeout was seen on a lightly loaded harness.
- Whether reasoning tokens count against `max_tokens` (inferred from an absence, not verified).
- No pixels were rendered: motion prompts and sheet prompts were judged as **text**, so
  "better prompt" is not yet "better image".
- Sample size: n=6 per surface (n=2 on board continuity), one project's corpus.
