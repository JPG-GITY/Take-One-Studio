/**
 * Pre-generation cost forecast. ROUGH by nature — the real shot/asset count
 * depends on what Claude writes — so it's shown as "~$X". Video dominates the
 * cost; image/LLM are minor. Per-shot video prices are the documented BytePlus
 * 5s estimates (16:9, no video input).
 */

import { videoCostPer5s } from '@/lib/types/pipeline.types'

type Res = '720p' | '1080p' | '4k'

// USD per 5-second shot comes from the per-model table in pipeline.types — the same
// figures the promotion buttons quote, so a forecast and a render never disagree.
const IMAGE_EACH = 0.03
const AVG_SHOT_SECS = 5

export interface CostForecast {
  shots: number
  videos: number
  images: number
  llmCalls: number
  costUsd: number
  video: number
  image: number
  llm: number
}

export function forecastProjectCost(durationSecs: number, resolution: Res, model?: string): CostForecast {
  const d = Math.max(AVG_SHOT_SECS, Math.round(durationSecs || 0))
  const shots = Math.max(1, Math.round(d / AVG_SHOT_SECS))
  // A (model, resolution) the model cannot render — 4k on 2.5 — is priced at what the
  // backend will actually coerce it to: the model's own ceiling.
  const per5s = videoCostPer5s(model, resolution) || videoCostPer5s(model, '1080p') || videoCostPer5s(model, '720p')

  const video = shots * per5s
  // keyframe + storyboard per shot, plus a rough allowance for asset sheets
  const images = shots * 2 + Math.max(6, Math.round(shots * 0.8))
  const image = images * IMAGE_EACH
  // script + breakdown + a few QC passes + per-shot prompt/QC (small token cost)
  const llmCalls = 4 + shots * 2
  const llm = 0.15 + shots * 0.015

  return {
    shots,
    videos: shots,
    images,
    llmCalls,
    costUsd: video + image + llm,
    video,
    image,
    llm,
  }
}

/** "$24" / "$48" — whole dollars for the headline; "<$1" for tiny. */
export function fmtCost(usd: number): string {
  if (usd < 1) return '<$1'
  return `$${Math.round(usd)}`
}
