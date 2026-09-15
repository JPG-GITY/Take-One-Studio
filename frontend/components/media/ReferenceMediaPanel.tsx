'use client'

import { useState, useRef, useCallback } from 'react'
import { Image, Film, Music, Plus, X, Upload, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePipelineStore } from '@/store/pipeline.store'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

// ─── Types ───────────────────────────────────────────────────────────────────

export type RefRole = 'first_frame' | 'last_frame' | 'reference_image'

export interface ReferenceImage {
  id: string
  url: string      // data URI (uploaded) or https URL
  role: RefRole
  weight: number   // 0.0–1.0 for Seedream style influence
  label?: string   // user's optional label
}

/** What a drive clip drives. Undefined = the undivided motion role Seedance has always
 *  been given: movement, timing and camera path together. A performance is really two
 *  signals, and a face clip left on that role has nothing addressing its expression work
 *  — worse, nothing forbidding it from carrying identity over the character sheet. */
export type MotionKind = 'body' | 'face'

export interface ReferenceVideo {
  id: string
  url: string
  label?: string
  motion?: MotionKind
}

export interface ReferenceAudio {
  url: string
  label?: string
}

export interface ReferenceMedia {
  images: ReferenceImage[]
  videos: ReferenceVideo[]
  audio:  ReferenceAudio | null
}

interface Props {
  value: ReferenceMedia
  onChange: (v: ReferenceMedia) => void
  /** Whether video + audio inputs are shown (Stage 5 / Seedance) */
  showVideoAudio?: boolean
  /** Max reference images (Seedream: 4, Seedance: 9 incl. first_frame) */
  maxImages?: number
  maxVideos?: number
  disabled?: boolean
  className?: string
  /** Start the panel expanded instead of collapsed */
  defaultOpen?: boolean
  /** The project's APPROVED assets, offered as a third source next to upload and URL.
   *  Stage 5 passes them so a director can hand a shot the sheet of a character who is
   *  not in its breakdown, or any prop, without leaving the panel. */
  projectAssets?: Array<{ id: string; name: string; type: string; url: string }>
  /** Header text. The default names the panel; a stage can name the ACTION instead. */
  headerLabel?: string
  /** The role a newly added image gets. The historical default makes the FIRST image a
   *  `first_frame` — which in Stage 5 turns the shot into image-to-video and silently drops
   *  every derived reference. A stage whose panel is for REFERENCES passes 'reference_image'. */
  defaultRole?: RefRole
}

const MOTION_LABELS: Record<MotionKind, string> = {
  body: 'Body motion',
  face: 'Facial motion',
}

const ROLE_LABELS: Record<RefRole, string> = {
  first_frame:      'First Frame',
  last_frame:       'Last Frame',
  reference_image:  'Style Ref',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function nanoId() {
  return Math.random().toString(36).slice(2, 9)
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ReferenceMediaPanel({
  value,
  onChange,
  showVideoAudio = false,
  maxImages = 4,
  maxVideos = 3,
  disabled = false,
  className,
  defaultOpen = false, projectAssets = [], headerLabel, defaultRole,
}: Props) {
  const [open,       setOpen]       = useState(defaultOpen)
  const [urlInput,   setUrlInput]   = useState('')
  const [urlMode,    setUrlMode]    = useState<'image' | 'video' | 'audio'>('image')
  const [dragging,   setDragging]   = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // P3b: shared reference tray (filled from the Studio gallery)
  const tray = usePipelineStore((s) => s.referenceTray)

  const totalImages = value.images.length
  const hasMedia = totalImages > 0 || value.videos.length > 0 || !!value.audio

  // ── Image handlers ────────────────────────────────────────────────────────

  const addImages = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const remaining = maxImages - totalImages
    if (remaining <= 0) return
    const toAdd = arr.slice(0, remaining)
    const newRefs: ReferenceImage[] = []
    for (const file of toAdd) {
      const url = await fileToDataUrl(file)
      newRefs.push({
        id: nanoId(),
        url,
        role: defaultRole ?? (totalImages + newRefs.length === 0 ? 'first_frame' : 'reference_image'),
        weight: 0.7,
        label: file.name,
      })
    }
    onChange({ ...value, images: [...value.images, ...newRefs] })
  }, [value, onChange, totalImages, maxImages, defaultRole])

  const addImageUrl = () => {
    const u = urlInput.trim()
    if (!u || totalImages >= maxImages) return
    onChange({
      ...value,
      images: [...value.images, {
        id: nanoId(), url: u,
        role: defaultRole ?? (totalImages === 0 ? 'first_frame' : 'reference_image'),
        weight: 0.7,
      }],
    })
    setUrlInput('')
  }

  const removeImage = (id: string) =>
    onChange({ ...value, images: value.images.filter((i) => i.id !== id) })

  const updateImageRole = (id: string, role: RefRole) =>
    onChange({ ...value, images: value.images.map((i) => i.id === id ? { ...i, role } : i) })

  const updateVideoMotion = (id: string, motion?: MotionKind) =>
    onChange({ ...value, videos: value.videos.map((v) => v.id === id ? { ...v, motion } : v) })

  const updateImageWeight = (id: string, weight: number) =>
    onChange({ ...value, images: value.images.map((i) => i.id === id ? { ...i, weight } : i) })

  // ── Video handlers ────────────────────────────────────────────────────────

  const addVideoUrl = () => {
    const u = urlInput.trim()
    if (!u || value.videos.length >= maxVideos) return
    onChange({ ...value, videos: [...value.videos, { id: nanoId(), url: u }] })
    setUrlInput('')
  }

  const removeVideo = (id: string) =>
    onChange({ ...value, videos: value.videos.filter((v) => v.id !== id) })

  // ── Audio handler ─────────────────────────────────────────────────────────

  const setAudioUrl = () => {
    const u = urlInput.trim()
    if (!u) return
    onChange({ ...value, audio: { url: u } })
    setUrlInput('')
  }

  const removeAudio = () => onChange({ ...value, audio: null })

  // P3b: add a reference from a URL (a tray chip or a dragged gallery item)
  const addRefFromUrl = useCallback((url: string, kind: 'image' | 'video') => {
    if (!url) return
    if (kind === 'video' && showVideoAudio) {
      if (value.videos.length >= maxVideos) return
      onChange({ ...value, videos: [...value.videos, { id: nanoId(), url }] })
    } else {
      if (value.images.length >= maxImages) return
      onChange({ ...value, images: [...value.images, {
        id: nanoId(), url,
        role: defaultRole ?? (value.images.length === 0 ? 'first_frame' : 'reference_image'),
        weight: 0.7,
      }] })
    }
  }, [value, onChange, showVideoAudio, maxImages, maxVideos, defaultRole])

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    // A dragged gallery/tray item carries our mime; files are the upload path.
    const ref = e.dataTransfer.getData('application/x-takeone-ref')
    if (ref) {
      try { const r = JSON.parse(ref); addRefFromUrl(r.url, r.kind === 'video' ? 'video' : 'image') } catch { /* ignore */ }
      return
    }
    const files = e.dataTransfer.files
    if (files.length) await addImages(files)
  }, [addImages, addRefFromUrl])

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={cn('rounded-lg border border-border bg-elevated overflow-hidden', className)}>
      {/* Header toggle */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-text-primary/[0.04] transition-colors"
      >
        <div className="flex items-center gap-1.5">
          <Image size={12} className="text-cyan" />
          {showVideoAudio && <Film  size={12} className="text-orange" />}
          {showVideoAudio && <Music size={12} className="text-green"  />}
        </div>
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest flex-1 text-left">
          {headerLabel ?? 'Reference Media'}
        </span>
        {hasMedia && (
          <span className="text-[9px] font-mono text-cyan bg-cyan/10 border border-cyan/30 px-1.5 py-0.5 rounded">
            {totalImages}i{value.videos.length > 0 ? ` ${value.videos.length}v` : ''}{value.audio ? ' ♪' : ''}
          </span>
        )}
        {open ? <ChevronUp size={12} className="text-text-muted" /> : <ChevronDown size={12} className="text-text-muted" />}
      </button>

      {open && (
        <div className="border-t border-border p-3 flex flex-col gap-4">

          {/* The project's approved assets — same mechanics as the tray: one click adds. Named
              and typed, because in a large project "v001.png" tells nobody anything. */}
          {projectAssets.length > 0 && totalImages < maxImages && (
            <section data-testid="ref-project-assets">
              <p className="text-[9px] font-semibold text-text-dim uppercase tracking-widest mb-1.5">
                From project
              </p>
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {projectAssets.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => addRefFromUrl(a.url, 'image')}
                    disabled={disabled}
                    data-testid={`ref-project-add-${a.id}`}
                    title={`${a.name} (${a.type}) — add as reference`}
                    className="relative shrink-0 w-12 h-12 rounded overflow-hidden border border-border hover:border-cyan/60"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.url.startsWith('/') ? `${API_BASE}/api/asset/serve?path=${encodeURIComponent(a.url)}` : a.url} alt={a.name} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            </section>
          )}
          {/* P3b: reference tray — picked from the Studio gallery, reusable here */}
          {tray.length > 0 && (
            <section data-testid="ref-tray">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                <Plus size={10} className="text-cyan" />
                From tray
                <span className="text-text-dim normal-case">(click to add as reference)</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {tray.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => addRefFromUrl(t.url, t.kind)}
                    data-testid={`tray-add-${t.id}`}
                    title="Add as reference"
                    className="w-11 h-11 rounded border border-border overflow-hidden hover:border-cyan/60 transition-colors shrink-0"
                  >
                    {t.kind === 'video'
                      ? <video src={t.url} className="w-full h-full object-cover" muted />
                      : <img src={t.url} alt="" className="w-full h-full object-cover" />}
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* ── Image references ─────────────────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest flex items-center gap-1">
                <Image size={10} className="text-cyan" />
                Reference Images
                <span className="text-text-dim" data-testid="ref-image-count">({totalImages}/{maxImages})</span>
              </p>
              {totalImages < maxImages && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="text-[9px] text-cyan hover:underline flex items-center gap-1"
                >
                  <Upload size={10} /> Upload
                </button>
              )}
            </div>

            {/* Drag zone */}
            {totalImages < maxImages && (
              <div
                className={cn(
                  'border-2 border-dashed rounded-lg p-3 mb-2 text-center transition-colors cursor-pointer',
                  dragging ? 'border-cyan/70 bg-cyan/5' : 'border-border hover:border-cyan/40',
                )}
                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileRef.current?.click()}
              >
                <p className="text-[10px] text-text-muted">
                  Drag & drop images or click to browse
                </p>
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addImages(e.target.files)}
            />

            {/* Image thumbnails */}
            {value.images.length > 0 && (
              <div className="grid grid-cols-4 gap-1.5 mb-2">
                {value.images.map((img) => (
                  <div key={img.id} className="flex flex-col gap-1">
                    <div className="relative aspect-square rounded overflow-hidden border border-border group">
                      <img src={img.url} alt="" className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeImage(img.id)}
                        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-bg/80 text-red flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={9} />
                      </button>
                    </div>
                    {/* Role selector */}
                    <select
                      value={img.role}
                      onChange={(e) => updateImageRole(img.id, e.target.value as RefRole)}
                      className="w-full bg-bg border border-border rounded px-1 py-0.5 text-[8px] text-text-muted focus:outline-none"
                    >
                      {(Object.keys(ROLE_LABELS) as RefRole[]).map((r) => (
                        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                      ))}
                    </select>
                    {/* Weight slider (Seedream influence) */}
                    <div className="flex items-center gap-1">
                      <input
                        type="range" min={0} max={1} step={0.1}
                        value={img.weight}
                        onChange={(e) => updateImageWeight(img.id, parseFloat(e.target.value))}
                        className="flex-1 h-1"
                        title={`Influence: ${Math.round(img.weight * 100)}%`}
                      />
                      <span className="text-[8px] font-mono text-text-dim w-6 text-right">
                        {Math.round(img.weight * 100)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* URL input for images */}
            <div className="flex gap-1.5">
              <input
                type="url"
                placeholder="Paste image URL…"
                value={urlMode === 'image' ? urlInput : ''}
                onFocus={() => setUrlMode('image')}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addImageUrl()}
                className={cn(
                  'flex-1 bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary',
                  'placeholder:text-text-dim focus:outline-none focus:border-cyan/50 transition-colors'
                )}
              />
              <button type="button" onClick={addImageUrl}
                className="px-2 py-1 rounded bg-cyan/10 text-cyan text-xs border border-cyan/30 hover:bg-cyan/20 transition-colors">
                <Plus size={12} />
              </button>
            </div>
          </section>

          {/* ── Video references (Seedance only) ─────────────────────────── */}
          {showVideoAudio && (
            <section className="border-t border-border pt-3">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                <Film size={10} className="text-orange" />
                Reference Videos
                <span className="text-text-dim">({value.videos.length}/{maxVideos})</span>
              </p>

              {value.videos.map((vid) => (
                <div key={vid.id} className="flex items-center gap-2 mb-1.5 px-2 py-1.5 bg-bg rounded border border-border">
                  <Film size={11} className="text-orange shrink-0" />
                  <span className="text-[10px] text-text-primary truncate flex-1 font-mono">{vid.url}</span>
                  {/* Which half of the performance this clip drives. Mirrors the image role
                      selector above; the empty value keeps the whole-take role. */}
                  <select
                    value={vid.motion ?? ''}
                    data-testid={`ref-video-motion-${vid.id}`}
                    onChange={(e) => updateVideoMotion(vid.id, (e.target.value || undefined) as MotionKind | undefined)}
                    className="bg-bg border border-border rounded px-1 py-0.5 text-[9px] text-text-muted focus:outline-none shrink-0"
                  >
                    <option value="">Whole take</option>
                    {(Object.keys(MOTION_LABELS) as MotionKind[]).map((m) => (
                      <option key={m} value={m}>{MOTION_LABELS[m]}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => removeVideo(vid.id)}
                    className="text-text-muted hover:text-red transition-colors">
                    <X size={11} />
                  </button>
                </div>
              ))}

              {value.videos.length < maxVideos && (
                <div className="flex gap-1.5">
                  <input
                    type="url"
                    placeholder="Paste video URL…"
                    data-testid="ref-video-url"
                    value={urlMode === 'video' ? urlInput : ''}
                    onFocus={() => setUrlMode('video')}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addVideoUrl()}
                    className={cn(
                      'flex-1 bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary',
                      'placeholder:text-text-dim focus:outline-none focus:border-orange/50 transition-colors'
                    )}
                  />
                  <button type="button" onClick={addVideoUrl} data-testid="ref-video-add"
                    className="px-2 py-1 rounded bg-orange/10 text-orange text-xs border border-orange/30 hover:bg-orange/20 transition-colors">
                    <Plus size={12} />
                  </button>
                </div>
              )}
            </section>
          )}

          {/* ── Audio (Seedance only) ─────────────────────────────────────── */}
          {showVideoAudio && (
            <section className="border-t border-border pt-3">
              <p className="text-[9px] font-semibold text-text-muted uppercase tracking-widest mb-2 flex items-center gap-1">
                <Music size={10} className="text-green" />
                Audio Track (overrides auto-generate)
              </p>

              {value.audio ? (
                <div className="flex items-center gap-2 px-2 py-1.5 bg-bg rounded border border-green/30">
                  <Music size={11} className="text-green shrink-0" />
                  <span className="text-[10px] text-green truncate flex-1 font-mono">{value.audio.url}</span>
                  <button type="button" onClick={removeAudio}
                    className="text-text-muted hover:text-red transition-colors">
                    <X size={11} />
                  </button>
                </div>
              ) : (
                <div className="flex gap-1.5">
                  <input
                    type="url"
                    placeholder="Paste audio URL (mp3, wav, m4a)…"
                    value={urlMode === 'audio' ? urlInput : ''}
                    onFocus={() => setUrlMode('audio')}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && setAudioUrl()}
                    className={cn(
                      'flex-1 bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary',
                      'placeholder:text-text-dim focus:outline-none focus:border-green/50 transition-colors'
                    )}
                  />
                  <button type="button" onClick={setAudioUrl}
                    className="px-2 py-1 rounded bg-green/10 text-green text-xs border border-green/30 hover:bg-green/20 transition-colors">
                    <Plus size={12} />
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Blank initial value helper ───────────────────────────────────────────────

export function emptyReferenceMedia(): ReferenceMedia {
  return { images: [], videos: [], audio: null }
}
