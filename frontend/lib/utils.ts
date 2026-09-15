import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTimecode(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const f = Math.floor((seconds % 1) * 30) // 30fps
  return [h, m, s, f].map((n) => String(n).padStart(2, '0')).join(':')
}

export function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(timestamp).toLocaleDateString()
}

// ── Playable media URLs ───────────────────────────────────────────────────────
// Seedance returns a SIGNED CDN url that 403s after ~24 hours. Every render also
// saves a permanent copy on disk, and /api/asset/serve streams it — so the disk
// copy is the one to play and the CDN url is only a last resort. Stage 6 learned
// this early and kept the rule in a local helper; stage 5's player and thumbnail
// strip never got it, so BLACKMIRROR 4 reopened days after the shoot showed
// twelve clips that all played BLACK with the files sitting on disk (2026-08-26).
// Shaped structurally, not against GeneratedShot, so this file keeps importing
// no domain types.
const MEDIA_API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

type PlayableMedia = { videoUrl?: string; videoLocalPath?: string; previewUrl?: string }

/** The durable full-resolution source: the saved copy, else the expiring CDN url. */
export function playableUrl(shot?: PlayableMedia | null): string {
  if (shot?.videoLocalPath) {
    return `${MEDIA_API_BASE}/api/asset/serve?path=${encodeURIComponent(shot.videoLocalPath)}`
  }
  return shot?.videoUrl || ''
}

/** Same, but the small preview proxy first — for scrubbing and thumbnails, where
 *  the light file is the point. Every previewUrl written is already a served
 *  local path, so this never reintroduces an expiring link. */
export function previewSrc(shot?: PlayableMedia | null): string {
  return shot?.previewUrl || playableUrl(shot)
}
