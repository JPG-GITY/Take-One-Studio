/**
 * Studio (Free Gen) store — fully INDEPENDENT of the pipeline store.
 *
 * The Studio is a standalone Lumina-style playground: generate images (Seedream)
 * and videos (Seedance) with no project required. Its history lives here, in its
 * own persisted slice (`takeone-studio-v1`), and never touches the pipeline store
 * — so nothing the Studio does can affect Script / Breakdown / SG / Final Cut.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Keep the persisted blob small: localStorage is ~5 MB, and reference inputs are
// data-URIs (often MB each). If we persisted them the store would overflow quota
// and SILENTLY drop new writes — which is why freshly generated videos vanished
// on reload while older items survived. So we strip data-URIs on write (in-memory
// state keeps them for this session's Re-edit/Regenerate; CDN urls persist fine).
const noDataUri = (u: string | null) => (u && u.startsWith('data:') ? null : u)

export type StudioKind = 'image' | 'video' | 'audio'

export interface StudioItem {
  id: string
  kind: StudioKind
  prompt: string
  model: string                 // label, e.g. "Seedream 5.0 Lite"
  imageUrls: string[]
  videoUrl: string | null
  audioUrl: string | null       // TTS output (served url)
  posterUrl: string | null      // first frame / reference thumbnail for video cards
  refImages: string[]           // reference inputs (data URIs / https) — for Re-edit / Regenerate
  createdAt: number
  params: Record<string, unknown>   // snapshot of the request (ratio, resolution…)
  // ── Video Extend / Edit inputs. All OPTIONAL + read-time defaulted, so the
  //    already-persisted v1 blob stays valid (no migration).
  /** The clip on disk — the durable source for Extend/Edit (CDN urls die in ~24h). */
  videoLocalPath?: string | null
  /** Seedance's ORIGINAL return_last_frame url. Passed VERBATIM while it is alive:
   *  it is a trusted Seedance-derived frame, and downloading + re-encoding it would
   *  nullify that trust (video-seedance §7). */
  lastFrameUrl?: string | null
  /** The same frame saved RAW next to the clip — the trusted fallback once the url
   *  above expires. Written by /api/studio/save. */
  lastFrameLocalPath?: string | null
}

/** An AI MediaKit upscale the SERVER is still working on. Persisted, because the task
 *  outlives this tab: the vendor keeps processing (and billing) after a reload, and the
 *  backend now finishes the file on its own — this record is how the gallery finds it
 *  again and shows a pending card meanwhile. */
export interface PendingUpscale {
  id: string                    // the card id the result will get
  taskId: string                // the vendor task, as answered by POST /api/studio/upscale
  sourceId: string              // the clip it came from
  prompt: string
  model: string                 // "AI MediaKit · Standard 4K"
  ratio: string
  posterUrl: string | null
  params: { resolution: string; tier: string; style: string }
  startedAt: number
}

interface StudioState {
  items: StudioItem[]
  /** OPTIONAL + read-time defaulted: the v1 blob on disk has no such field. */
  pendingUpscales?: PendingUpscale[]
  addItem: (item: StudioItem) => void
  patchItem: (id: string, patch: Partial<StudioItem>) => void
  removeItem: (id: string) => void
  /** Remove a single image (by index) from a multi-image generation; drops the
   *  whole item if it was the last one. */
  removeImage: (id: string, index: number) => void
  /** Clear one KIND only. The gallery is filtered by kind, so a trash button that
   *  wiped everything while you were looking at videos was a trap. */
  clearKind: (kind: StudioKind) => void
  addPendingUpscale: (p: PendingUpscale) => void
  removePendingUpscale: (id: string) => void
  clearAll: () => void
}

const MAX_ITEMS = 120   // keep history bounded so localStorage stays small

export const useStudioStore = create<StudioState>()(
  persist(
    (set) => ({
      items: [],
      pendingUpscales: [],
      addPendingUpscale: (p) => set((s) => ({ pendingUpscales: [p, ...(s.pendingUpscales ?? []).filter((x) => x.id !== p.id)] })),
      removePendingUpscale: (id) => set((s) => ({ pendingUpscales: (s.pendingUpscales ?? []).filter((x) => x.id !== id) })),
      addItem: (item) => set((s) => ({ items: [item, ...s.items].slice(0, MAX_ITEMS) })),
      patchItem: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
      removeItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      removeImage: (id, index) => set((s) => ({
        items: s.items.flatMap((i) => {
          if (i.id !== id) return [i]
          const imageUrls = i.imageUrls.filter((_, k) => k !== index)
          if (!imageUrls.length) return []   // last image gone → drop the generation
          const posterUrl = imageUrls.includes(i.posterUrl ?? '') ? i.posterUrl : imageUrls[0]
          return [{ ...i, imageUrls, posterUrl }]
        }),
      })),
      clearKind: (kind) => set((s) => ({ items: s.items.filter((i) => i.kind !== kind) })),
      clearAll: () => set({ items: [] }),
    }),
    {
      name: 'takeone-studio-v1',
      version: 1,
      // Persist only lightweight fields — never data-URIs (see noDataUri above).
      partialize: (s) => ({
        pendingUpscales: (s.pendingUpscales ?? []).map((p) => ({ ...p, posterUrl: noDataUri(p.posterUrl) })),
        items: s.items.map((i) => ({
          ...i,
          refImages: (i.refImages ?? []).filter((u) => !u.startsWith('data:')),
          posterUrl: noDataUri(i.posterUrl ?? null),
        })),
      }),
    },
  ),
)
