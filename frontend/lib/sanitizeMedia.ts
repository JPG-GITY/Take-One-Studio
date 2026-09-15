'use client'

/**
 * Cross-project media sanitizer.
 *
 * Before the useProjectGuard fix, an async closure from project A could commit
 * its shots into project B's store, and autosave persisted the mix — so saved
 * states exist whose media fields (previewUrl, videoLocalPath, thumbnails…)
 * point into ANOTHER project's folder. Rewriting the files on disk is futile
 * while the app is open (autosave re-writes the in-memory state), so instead we
 * heal AT HYDRATION: any media field whose local path resolves outside the
 * current project root is dropped. The shot simply shows as not-rendered; its
 * real takes (if any) still live on disk in the RIGHT project and are re-adopted
 * by the registry/reconstruct paths.
 */

/** Local filesystem path behind a media URL, or null for CDN/data URIs. */
function extractLocalPath(url: string): string | null {
  const q = url.match(/[?&]path=([^&]+)/)
  if (q) {
    try { return decodeURIComponent(q[1]) } catch { return q[1] }
  }
  if (url.startsWith('file://')) return url.slice(7)
  if (url.startsWith('/')) return url
  return null
}

const MEDIA_FIELDS = [
  'videoUrl', 'videoLocalPath', 'previewUrl', 'thumbnailUrl',
  'keyframeLocalPath', 'lastFrameUrl', 'audioUrl',
] as const

/** Strip media fields that point outside the current project root. */
export function sanitizeShotMedia<T extends { videoUrl?: string; thumbnailUrl?: string }>(
  shot: T,
  root: string | null | undefined,
): T {
  if (!root) return shot
  const boundary = root.endsWith('/') ? root : root + '/'
  let changed = false
  const out = { ...shot } as Record<string, unknown>
  for (const f of MEDIA_FIELDS) {
    const v = out[f]
    if (typeof v !== 'string' || !v) continue
    const p = extractLocalPath(v)
    if (p && p !== root && !p.startsWith(boundary)) {
      // Required string fields go empty; optional ones disappear.
      out[f] = f === 'videoUrl' || f === 'thumbnailUrl' ? '' : undefined
      changed = true
    }
  }
  return changed ? (out as T) : shot
}
