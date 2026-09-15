'use client'

// ── Seedream 5.0 Pro image editor ────────────────────────────────────────────
// Edit an APPROVED asset (character / prop / FX / environment) with three
// combinable channels, all sent to the Pro model via /api/assets/edit:
//   1. Reference images  — swap a face for likeness, add a hat/glasses, etc.
//   2. On-image markup    — draw boxes / circles / arrows / crosshair targets /
//                           freehand; the flattened image guides the edit and the
//                           model removes the marks (Pro "Freeform Markup").
//   3. Text instruction   — with an Enhance button (Seed 2.0 Pro, not Claude).
// Every edit is saved as a NEW asset version (non-destructive).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Square, Circle, ArrowUpRight, Crosshair, Pencil, Undo2, Trash2, X,
  Upload, Wand2, Sparkles, Maximize2, Loader2, CheckCircle, Image as ImageIcon, RefreshCw,
  Lock, Unlock, Shuffle,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { pipelineApi } from '@/lib/api/pipeline.api'
import { usePipelineStore } from '@/store/pipeline.store'
import { cn } from '@/lib/utils'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const serveUrl = (p: string) => `${API_BASE}/api/asset/serve?path=${encodeURIComponent(p)}`
// disk path → served URL; data-URI / http passthrough (for <img> display only)
const toSrc = (p: string) => (p.startsWith('/') ? serveUrl(p) : p)
// Canvas loader: proxies disk paths AND CDN URLs through our backend so the
// browser can fetch pixels (a cross-origin CDN image can't be drawn+exported).
const proxyUrl = (src: string) =>
  src.startsWith('data:') ? src : `${API_BASE}/api/image/proxy?src=${encodeURIComponent(src)}`

/** Seedream Pro acepta base + 9. El número estaba escrito a mano en el slice, en el
 *  slice de la paleta y en el contador de la cabecera; tres copias de un límite es
 *  como se quedan dos atrás. */
const MAX_EDIT_REFS = 9

type Tool = 'box' | 'circle' | 'arrow' | 'target' | 'pen'
// Fuentes de referencia: subida de disco, Studio y los ASSETS APROBADOS del proyecto.
// La tercera faltaba, y era la que más falta hacía: para editar una lámina con otra
// del mismo proyecto —poner el abrigo de una toma en otra, casar un prop— había que
// exportar el asset a disco y volver a subirlo.
type Shape =
  | { kind: 'box'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'circle'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { kind: 'target'; x: number; y: number; color: string }
  | { kind: 'pen'; pts: Array<[number, number]>; color: string }

const TOOLS: Array<{ id: Tool; label: string; icon: React.ElementType }> = [
  { id: 'box',    label: 'Box',    icon: Square },
  { id: 'circle', label: 'Circle', icon: Circle },
  { id: 'arrow',  label: 'Arrow',  icon: ArrowUpRight },
  { id: 'target', label: 'Target', icon: Crosshair },
  { id: 'pen',    label: 'Draw',   icon: Pencil },
]

const COLORS = ['#FF2D2D', '#00D4FF', '#00E5A0', '#FFD400', '#FFFFFF']

// Quick templates — a compact dropdown (short label → full instruction text).
const PRESETS: Array<{ label: string; text: string }> = [
  { label: 'Swap face (from reference)',   text: 'Swap the face for the likeness in the reference image, keep everything else.' },
  { label: 'Add accessory (hat / glasses)', text: 'Add the accessory from the reference image (hat / glasses) onto the character.' },
  { label: 'Place into environment',        text: 'Place the subject into the environment from the reference, matched lighting.' },
  { label: 'Change wardrobe',               text: 'Change the wardrobe to: ' },
  { label: 'Remove marked object',          text: 'Remove the marked object and fill the area naturally.' },
]

// Color palette — Seedream 5.0 Pro reads exact color codes and applies them to the
// target region with material/lighting response (Pro "Precise Color Code" capability).
const COLOR_SWATCHES = ['#B3282D', '#1D4E89', '#2E7D46', '#E4B23C', '#6D4C9F', '#111111', '#F5F5F5']

// ── Harmonic palette generator (HSL schemes). The generated palette is rendered to a
//    swatch-strip PNG and passed to Seedream as a color-palette REFERENCE image — the
//    doc's "Change color palette · input image + color palette reference" flow. ──
function hslToHex(h: number, s: number, l: number): string {
  l /= 100
  const a = (s * Math.min(l, 1 - l)) / 100
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase()
}
const PALETTE_SCHEMES = ['analogous', 'complementary', 'triad', 'monochromatic'] as const
type PaletteScheme = typeof PALETTE_SCHEMES[number]
/** Generate a 5-colour harmonic palette. `keep` preserves locked slots (non-null). */
function generatePalette(keep: Array<string | null> = []): { scheme: PaletteScheme; colors: string[] } {
  const baseHue = Math.floor(Math.random() * 360)
  const scheme = PALETTE_SCHEMES[Math.floor(Math.random() * PALETTE_SCHEMES.length)]
  const sat = 55 + Math.floor(Math.random() * 30)
  let hues: number[]
  if (scheme === 'analogous') hues = [-30, -15, 0, 15, 30].map((d) => baseHue + d)
  else if (scheme === 'complementary') hues = [0, 20, 180, 200, 190].map((d) => baseHue + d)
  else if (scheme === 'triad') hues = [0, 120, 240, 60, 180].map((d) => baseHue + d)
  else hues = [0, 0, 0, 0, 0].map((d) => baseHue + d)
  const lights = scheme === 'monochromatic' ? [22, 38, 54, 70, 86] : [38, 48, 58, 50, 42]
  const colors = hues.map((h, i) => keep[i] ?? hslToHex(((h % 360) + 360) % 360, sat, lights[i]))
  return { scheme, colors }
}
/** Render the palette to a horizontal swatch-strip PNG data-URI (the reference image). */
function paletteToDataURI(colors: string[]): string {
  const c = document.createElement('canvas')
  c.width = 640; c.height = 128
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  const w = c.width / colors.length
  colors.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect(Math.floor(i * w), 0, Math.ceil(w) + 1, c.height) })
  return c.toDataURL('image/png')
}

// Draw all shapes onto ctx at pixel size (W×H). Coords are normalized [0,1].
function drawShapes(ctx: CanvasRenderingContext2D, W: number, H: number, shapes: Shape[], draft: Shape | null) {
  const sw = Math.max(2, Math.round(W * 0.004))
  const all = draft ? [...shapes, draft] : shapes
  for (const s of all) {
    ctx.strokeStyle = s.color
    ctx.fillStyle = s.color
    ctx.lineWidth = sw
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    if (s.kind === 'box') {
      ctx.strokeRect(s.x * W, s.y * H, s.w * W, s.h * H)
    } else if (s.kind === 'circle') {
      ctx.beginPath()
      ctx.ellipse((s.x + s.w / 2) * W, (s.y + s.h / 2) * H, Math.abs(s.w / 2) * W, Math.abs(s.h / 2) * H, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (s.kind === 'arrow') {
      const x1 = s.x1 * W, y1 = s.y1 * H, x2 = s.x2 * W, y2 = s.y2 * H
      const ang = Math.atan2(y2 - y1, x2 - x1)
      const head = Math.max(10, W * 0.02)
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6))
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6))
      ctx.stroke()
    } else if (s.kind === 'target') {
      const cx = s.x * W, cy = s.y * H, r = Math.max(10, W * 0.025)
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - r * 1.6, cy); ctx.lineTo(cx + r * 1.6, cy)
      ctx.moveTo(cx, cy - r * 1.6); ctx.lineTo(cx, cy + r * 1.6)
      ctx.stroke()
    } else if (s.kind === 'pen') {
      ctx.beginPath()
      s.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px * W, py * H) : ctx.moveTo(px * W, py * H)))
      ctx.stroke()
    }
  }
}

export function ProImageEditor({
  onClose, title, baseImage, assetRelPath, projectName, projectPath, onApplied,
}: {
  onClose: () => void
  /** Header label — the asset name or shot id being edited. */
  title: string
  baseImage: string
  assetRelPath: string
  projectName: string
  projectPath: string
  /** Called when the user keeps an edit → make it the asset's approved image. */
  onApplied?: (edited: { url: string; localPath: string }) => void
}) {
  const { success, error } = useToast()
  // Locked project style — edits render in the project's style, not hardcoded photoreal
  const style = usePipelineStore((s) => s.style)
  // LOS ASSETS APROBADOS DEL PROYECTO, como tercera fuente de referencias.
  //
  // Se derivan aquí y no se reciben por prop porque este editor tiene tres puntos de
  // llamada (etapas 3, 4 y Studio) y todos tendrían que calcular lo mismo. Es el patrón
  // que la etapa 5 ya usa para `approvedAssetUrls`: nombre desde el desglose (etapa 2),
  // ruta desde el estado de la etapa 3, y sólo lo aprobado.
  // EL SELECTOR DEVUELVE LO ESTABLE; LA DERIVACIÓN VA EN UN useMemo.
  //
  // Escrito de la forma obvia —toda la derivación dentro del selector— esto cuelga la
  // etapa: `flatMap` construye un array NUEVO en cada llamada, zustand compara por
  // identidad para decidir si hubo cambio, siempre difiere, y React avisa de que "the
  // result of getSnapshot should be cached to avoid an infinite loop" antes de entrar en
  // bucle. El selector tiene que devolver una referencia estable; `stages` lo es.
  const stages = usePipelineStore((st) => st.stages)
  const projectAssets = useMemo(() => {
    const s2 = stages[2]
    const s3 = stages[3]
    const v2 = s2?.versions.find((v) => v.id === s2.activeVersionId)
    const v3 = s3?.versions.find((v) => v.id === s3.activeVersionId)
    const declared = ((v2?.data as { assets?: Array<{ id: string; name: string; type: string }> } | undefined)?.assets) ?? []
    const states = ((v3?.data as { assetStates?: Record<string, { status?: string; localPath?: string; selectedUrl?: string }> } | undefined)?.assetStates) ?? {}
    return declared.flatMap((a) => {
      const st3 = states[a.id]
      const url = st3?.localPath || st3?.selectedUrl || ''
      return st3?.status === 'approved' && url ? [{ id: a.id, name: a.name, type: a.type, url }] : []
    })
  }, [stages])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bitmapRef = useRef<ImageBitmap | HTMLImageElement | null>(null)
  const natRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const draftRef = useRef<Shape | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)

  const [disp, setDisp] = useState<{ w: number; h: number }>({ w: 512, h: 512 })
  const [loading, setLoading] = useState(true)
  const [tool, setTool] = useState<Tool>('box')
  const [color, setColor] = useState(COLORS[0])
  const [shapes, setShapes] = useState<Shape[]>([])
  const [uploads, setUploads] = useState<Array<{ id: string; src: string }>>([])
  const [studioImgs, setStudioImgs] = useState<Array<{ path: string; filename: string }>>([])
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioLoaded, setStudioLoaded] = useState(false)
  const [selectedStudio, setSelectedStudio] = useState<Set<string>>(new Set())
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [selectedAssets, setSelectedAssets] = useState<Set<string>>(new Set())
  const [instruction, setInstruction] = useState('')
  const [targetColor, setTargetColor] = useState<string | null>(null)   // exact color for the region
  // Color area: 'recolor' = one exact color on the marked region; 'palette' = recolor
  // the whole scene to a generated harmonic palette (sent as a reference image).
  const [colorMode, setColorMode] = useState<'recolor' | 'palette'>('recolor')
  const [palette, setPalette] = useState(() => generatePalette())
  const [paletteLocks, setPaletteLocks] = useState<boolean[]>(() => Array(5).fill(false))
  const regenPalette = useCallback(() => {
    setPalette((prev) => generatePalette(prev.colors.map((c, i) => (paletteLocks[i] ? c : null))))
  }, [paletteLocks])
  // Spacebar regenerates — but ONLY when not typing in a field (the modal has a textarea).
  useEffect(() => {
    if (colorMode !== 'palette') return
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase()
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault(); regenPalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [colorMode, regenPalette])
  const [enhancing, setEnhancing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ url: string; version?: number; localPath: string } | null>(null)
  const [zoom, setZoom] = useState<string | null>(null)

  // Lo que se envía: subidas (data-URI) + Studio + assets aprobados (rutas de disco).
  // Las tres tienen la misma forma en el wire — `reference_images` es `list[str]` y el
  // servidor resuelve rutas y URLs igual — así que añadir la tercera es aditivo puro: sin
  // cambio de esquema, de endpoint ni de prompt.
  const chosenRefs: string[] = [
    ...uploads.map((u) => u.src),
    ...Array.from(selectedStudio),
    ...Array.from(selectedAssets),
  ].slice(0, MAX_EDIT_REFS)

  const paint = useCallback(() => {
    const cv = canvasRef.current
    const bmp = bitmapRef.current
    if (!cv || !bmp) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height)
    drawShapes(ctx, cv.width, cv.height, shapes, draftRef.current)
  }, [shapes])

  // Load the base image (fetch → bitmap avoids canvas taint; CORS is allowed for :3000).
  // The component is mounted fresh each time it opens (parent gates with `open &&`),
  // so initial state is already clean — no synchronous reset here.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(proxyUrl(baseImage))
        if (!resp.ok) throw new Error(`image ${resp.status}`)
        const blob = await resp.blob()
        const bmp = await createImageBitmap(blob)
        if (cancelled) return
        bitmapRef.current = bmp
        natRef.current = { w: bmp.width, h: bmp.height }
        const maxW = 560
        const w = Math.min(maxW, bmp.width)
        const h = Math.round((w / bmp.width) * bmp.height)
        setDisp({ w, h })
        setLoading(false)
      } catch (e) {
        if (!cancelled) { setLoading(false); error('Could not load image', String(e).slice(0, 120)) }
      }
    })()
    return () => { cancelled = true }
  }, [baseImage, error])

  // Repaint whenever the canvas is sized or shapes change.
  useEffect(() => { if (!loading) paint() }, [loading, disp, paint])

  const norm = (e: React.PointerEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    }
  }

  const onDown = (e: React.PointerEvent) => {
    if (loading) return
    ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
    const p = norm(e)
    startRef.current = p
    if (tool === 'target') {
      setShapes((s) => [...s, { kind: 'target', x: p.x, y: p.y, color }])
      startRef.current = null
      return
    }
    draftRef.current =
      tool === 'pen' ? { kind: 'pen', pts: [[p.x, p.y]], color }
      : tool === 'arrow' ? { kind: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color }
      : { kind: tool, x: p.x, y: p.y, w: 0, h: 0, color }
    paint()
  }

  const onMove = (e: React.PointerEvent) => {
    if (!draftRef.current || !startRef.current) return
    const p = norm(e)
    const d = draftRef.current
    if (d.kind === 'pen') d.pts.push([p.x, p.y])
    else if (d.kind === 'arrow') { d.x2 = p.x; d.y2 = p.y }
    else if (d.kind === 'box' || d.kind === 'circle') {
      d.x = Math.min(startRef.current.x, p.x); d.y = Math.min(startRef.current.y, p.y)
      d.w = Math.abs(p.x - startRef.current.x); d.h = Math.abs(p.y - startRef.current.y)
    }
    paint()
  }

  const onUp = () => {
    const d = draftRef.current
    draftRef.current = null; startRef.current = null
    if (!d) return
    // Ignore accidental zero-size marks
    const tiny = (d.kind === 'box' || d.kind === 'circle') && d.w < 0.01 && d.h < 0.01
    if (!tiny) setShapes((s) => [...s, d])
    else paint()
  }

  const flatten = (): string => {
    const nat = natRef.current
    // Pro outputs ≤2K anyway; cap the long side so the PNG stays well under the
    // 30 MB input limit while keeping the markup crisp.
    const scale = Math.min(1, 2048 / Math.max(nat.w, nat.h))
    const w = Math.round(nat.w * scale), h = Math.round(nat.h * scale)
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    const ctx = off.getContext('2d')!
    ctx.drawImage(bitmapRef.current as CanvasImageSource, 0, 0, w, h)
    drawShapes(ctx, w, h, shapes, null)
    return off.toDataURL('image/png')
  }

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    files.forEach((f) => {
      const reader = new FileReader()
      reader.onload = () => setUploads((u) => [...u, { id: `up-${Date.now()}-${Math.random()}`, src: String(reader.result) }])
      reader.readAsDataURL(f)
    })
    e.target.value = ''
  }

  const toggleStudio = () => {
    const next = !studioOpen
    setStudioOpen(next)
    if (next && !studioLoaded) {
      setStudioLoaded(true)
      void pipelineApi.listStudioImages(projectName, projectPath)
        .then(setStudioImgs)
        .catch(() => setStudioImgs([]))
    }
  }

  const runEnhance = async () => {
    if (!instruction.trim()) { error('Nothing to enhance', 'Write an instruction first.'); return }
    setEnhancing(true)
    try {
      const out = await pipelineApi.enhanceEditInstruction(instruction, shapes.length > 0, chosenRefs.length > 0)
      if (out) setInstruction(out)
    } catch (e) {
      error('Enhance failed', (e instanceof Error ? e.message : String(e)).slice(0, 140))
    } finally { setEnhancing(false) }
  }

  const runEdit = async () => {
    const paletteMode = colorMode === 'palette'
    if (!paletteMode && !instruction.trim() && !targetColor) {
      error('Describe the edit', 'Say what to change, or pick a color.'); return
    }
    const hasMarkup = shapes.length > 0
    let finalInstruction = instruction.trim()
    let refs = chosenRefs
    let tool: 'markup' | 'edit' = hasMarkup ? 'markup' : 'edit'
    let base = hasMarkup ? flatten() : baseImage   // flattened data-URI when annotated, else disk path

    if (paletteMode) {
      // Whole-scene recolor to the generated palette: attach the swatch strip as a
      // reference image and match to it (the doc's color-palette-reference flow). Use
      // the CLEAN base (don't bake markup in) — the palette applies to the whole scene.
      const paletteRef = paletteToDataURI(palette.colors)
      refs = [...chosenRefs, paletteRef].slice(0, MAX_EDIT_REFS)
      tool = 'edit'; base = baseImage
      const named = `Change the overall color palette of image 1 to match the color swatches in the reference palette image (${palette.colors.join(', ')}); recolor walls, fabrics, objects and props harmoniously to those hues while PRESERVING all structure, shapes, composition and lighting.`
      finalInstruction = finalInstruction ? `${finalInstruction} ${named}` : named
    } else if (targetColor) {
      // Fold the picked color into the instruction as an exact hex code (Pro color response).
      finalInstruction = finalInstruction
        ? `${finalInstruction} Apply this exact color to the target region: ${targetColor}, matched to its material and the scene lighting.`
        : `Change the color of the marked region to exactly ${targetColor}, matched to its material and the scene lighting.`
    }
    setBusy(true); setResult(null)
    try {
      const res = await pipelineApi.editAsset({
        baseImage: base,
        tool,
        instruction: finalInstruction,
        referenceImages: refs,
        saveVersion: true,
        assetRelPath, projectName, projectPath,
        styleSuffix: style.promptSuffix,
      })
      setResult({ url: res.url, version: res.version, localPath: res.localPath || '' })
      success('Edit rendered', 'Review it below, then "Use this edit" to keep it.')
    } catch (e) {
      error('Edit failed', (e instanceof Error ? e.message : String(e)).slice(0, 160))
    } finally { setBusy(false) }
  }

  const applyEdit = () => {
    if (!result) return
    onApplied?.({ url: result.url, localPath: result.localPath })
    success('Edit applied', 'It is now the approved image for this asset.')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      {zoom && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-6 cursor-zoom-out"
          onClick={(e) => { e.stopPropagation(); setZoom(null) }}>
          <img src={zoom} alt="Full size" className="max-h-full max-w-full object-contain rounded" />
        </div>
      )}
      <div className="bg-surface border border-border rounded-lg w-full max-w-4xl max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border sticky top-0 bg-surface z-10">
          <Wand2 size={15} className="text-violet" />
          <span className="text-sm font-semibold">Edit with Pro — {title}</span>
          <button onClick={onClose} className="ml-auto p-1 rounded text-text-muted hover:text-text">
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col md:flex-row gap-4 p-4">
          {/* ── Canvas stage ── */}
          <div className="flex flex-col gap-2">
            {/* Toolbar */}
            <div className="flex items-center gap-1 flex-wrap">
              {TOOLS.map((t) => (
                <button key={t.id} onClick={() => setTool(t.id)} title={t.label}
                  className={cn('flex items-center gap-1 px-2 py-1 rounded text-[11px] border',
                    tool === t.id ? 'border-violet bg-violet/15 text-violet' : 'border-border text-text-muted hover:border-violet/40')}>
                  {createElementSafe(t.icon)} {t.label}
                </button>
              ))}
              <div className="w-px h-5 bg-border mx-1" />
              {COLORS.map((c) => (
                <button key={c} onClick={() => setColor(c)} title={c}
                  className={cn('w-5 h-5 rounded-full border-2', color === c ? 'border-text' : 'border-border')}
                  style={{ background: c }} />
              ))}
              <div className="w-px h-5 bg-border mx-1" />
              <button onClick={() => setShapes((s) => s.slice(0, -1))} disabled={!shapes.length}
                title="Undo" className="p-1 rounded text-text-muted hover:text-text disabled:opacity-40">
                <Undo2 size={14} />
              </button>
              <button onClick={() => setShapes([])} disabled={!shapes.length}
                title="Clear" className="p-1 rounded text-text-muted hover:text-red disabled:opacity-40">
                <Trash2 size={14} />
              </button>
            </div>

            <div className="relative rounded overflow-hidden border border-border bg-bg" style={{ width: disp.w, height: disp.h }}>
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center text-text-muted">
                  <Loader2 size={20} className="animate-spin" />
                </div>
              )}
              <canvas
                ref={canvasRef}
                width={disp.w}
                height={disp.h}
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                className="touch-none cursor-crosshair"
                style={{ width: disp.w, height: disp.h }}
              />
            </div>
            <p className="text-[10px] text-text-muted max-w-[560px]">
              Draw where to change things — the model follows the marks and removes them from the result.
            </p>
          </div>

          {/* ── Controls ── */}
          <div className="flex-1 flex flex-col gap-3 min-w-[260px]">
            {/* Reference images — upload from disk, or pick from Studio */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-text">Reference images</span>
                <span className="text-[10px] text-text-muted">{chosenRefs.length}/{MAX_EDIT_REFS}</span>
                {projectAssets.length > 0 && (
                  <button onClick={() => setAssetsOpen((o) => !o)}
                    data-testid="editor-project-assets-toggle"
                    className={cn('ml-auto flex items-center gap-1 px-2 py-0.5 rounded border text-[10px]',
                      assetsOpen ? 'border-violet text-violet' : 'border-border text-text-muted hover:border-violet/40')}>
                    <ImageIcon size={11} /> From project
                  </button>
                )}
                <button onClick={toggleStudio}
                  className={cn('flex items-center gap-1 px-2 py-0.5 rounded border text-[10px]',
                    projectAssets.length === 0 && 'ml-auto',
                    studioOpen ? 'border-violet text-violet' : 'border-border text-text-muted hover:border-violet/40')}>
                  <ImageIcon size={11} /> From Studio
                </button>
                <label className="flex items-center gap-1 px-2 py-0.5 rounded border border-border text-[10px] text-text-muted hover:border-violet/40 cursor-pointer">
                  <Upload size={11} /> Upload
                  <input type="file" accept="image/*" multiple className="hidden" onChange={onUpload} />
                </label>
              </div>

              {/* Los assets aprobados del proyecto — misma mecánica que la tira de Studio:
                  clic para alternar, borde violeta cuando está elegido. Se etiquetan con
                  nombre y tipo porque en un proyecto grande "v001.png" no distingue nada. */}
              {assetsOpen && (
                <div className="flex gap-1.5 overflow-x-auto pb-1 border-b border-border/60 mb-1"
                     data-testid="editor-project-assets">
                  {projectAssets.map((a) => (
                    <button key={a.id} title={`${a.name} (${a.type})`}
                      data-testid={`editor-project-asset-${a.id}`}
                      onClick={() => setSelectedAssets((prev) => {
                        const n = new Set(prev); if (n.has(a.url)) n.delete(a.url); else n.add(a.url); return n
                      })}
                      className={cn('relative shrink-0 w-14 h-14 rounded overflow-hidden border-2',
                        selectedAssets.has(a.url) ? 'border-violet' : 'border-border hover:border-violet/50')}>
                      <img src={toSrc(a.url)} alt={a.name} className="w-full h-full object-cover" />
                      {selectedAssets.has(a.url) && (
                        <span className="absolute top-0.5 right-0.5"><CheckCircle size={12} className="text-violet" /></span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* Studio picker (on demand) */}
              {studioOpen && (
                studioImgs.length > 0 ? (
                  <div className="flex gap-1.5 overflow-x-auto pb-1 border-b border-border/60 mb-1">
                    {studioImgs.map((s) => (
                      <button key={s.path} title={s.filename}
                        onClick={() => setSelectedStudio((prev) => {
                          const n = new Set(prev); if (n.has(s.path)) n.delete(s.path); else n.add(s.path); return n
                        })}
                        className={cn('relative shrink-0 w-14 h-14 rounded overflow-hidden border-2',
                          selectedStudio.has(s.path) ? 'border-violet' : 'border-border hover:border-violet/50')}>
                        <img src={toSrc(s.path)} alt={s.filename} className="w-full h-full object-cover" />
                        {selectedStudio.has(s.path) && (
                          <span className="absolute top-0.5 right-0.5"><CheckCircle size={12} className="text-violet" /></span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-text-muted mb-1">No Studio images yet — generate some in Studio (e.g. glasses) and they appear here.</p>
                )
              )}

              {/* Chosen refs (uploads + studio) */}
              {(uploads.length > 0 || selectedStudio.size > 0) ? (
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {uploads.map((u) => (
                    <div key={u.id} className="relative shrink-0 w-14 h-14 rounded overflow-hidden border-2 border-violet">
                      <img src={u.src} alt="upload" className="w-full h-full object-cover" />
                      <button onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}
                        className="absolute top-0 right-0 bg-black/70 text-white p-0.5"><X size={9} /></button>
                    </div>
                  ))}
                  {Array.from(selectedStudio).map((p) => (
                    <div key={p} className="relative shrink-0 w-14 h-14 rounded overflow-hidden border-2 border-violet/60">
                      <img src={toSrc(p)} alt="studio ref" className="w-full h-full object-cover" />
                      <button onClick={() => setSelectedStudio((prev) => { const n = new Set(prev); n.delete(p); return n })}
                        className="absolute top-0 right-0 bg-black/70 text-white p-0.5"><X size={9} /></button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-text-muted">Upload a face/accessory from disk, or pick one from Studio.</p>
              )}
            </div>

            {/* Quick templates — compact dropdown (was a cluttered row of buttons) */}
            <select
              value=""
              onChange={(e) => { if (e.target.value) setInstruction(e.target.value) }}
              className="w-full text-[11px] rounded border border-border bg-bg px-2 py-1 text-text-muted focus:border-violet focus:outline-none"
              data-testid="edit-preset"
            >
              <option value="">Quick template…</option>
              {PRESETS.map((p) => (
                <option key={p.label} value={p.text}>{p.label}</option>
              ))}
            </select>

            {/* Instruction + enhance */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-text">Instruction</span>
                <button onClick={runEnhance} disabled={enhancing || !instruction.trim()}
                  className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-cyan/40 text-[10px] text-cyan hover:bg-cyan/10 disabled:opacity-40">
                  {enhancing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />} Enhance
                </button>
              </div>
              <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={4}
                placeholder="Describe the change — e.g. 'give him the face from the reference; add round glasses'"
                className="w-full text-[12px] rounded border border-border bg-bg px-2 py-1.5 resize-none focus:border-violet focus:outline-none" />
            </div>

            {/* Color / Palette — two modes: recolor ONE region to an exact colour, or
                recolor the WHOLE scene to a generated harmonic palette (sent to Seedream
                as a reference-image swatch strip: the doc's "change color palette" flow). */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1">
                {(['recolor', 'palette'] as const).map((m) => (
                  <button key={m} onClick={() => setColorMode(m)}
                    className={cn('px-2 py-0.5 rounded text-[10px] font-semibold border',
                      colorMode === m ? 'border-cyan text-cyan bg-cyan/10' : 'border-border text-text-muted hover:border-cyan/40')}>
                    {m === 'recolor' ? 'Recolor' : 'Palette'}
                  </button>
                ))}
                <span className="text-[9px] text-text-dim ml-1">
                  {colorMode === 'recolor' ? 'exact colour on the marked region' : 'recolor the whole scene to a palette'}
                </span>
              </div>

              {colorMode === 'recolor' ? (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {COLOR_SWATCHES.map((c) => (
                    <button key={c} onClick={() => setTargetColor((prev) => prev === c ? null : c)}
                      title={c} style={{ backgroundColor: c }}
                      className={cn('w-5 h-5 rounded-full border-2', targetColor === c ? 'border-cyan' : 'border-border hover:border-cyan/50')} />
                  ))}
                  <label className="relative w-5 h-5 rounded border border-border cursor-pointer overflow-hidden" title="Custom color">
                    <input type="color" value={targetColor ?? '#ffffff'}
                      onChange={(e) => setTargetColor(e.target.value)}
                      className="absolute inset-0 w-[150%] h-[150%] -top-1 -left-1 cursor-pointer" data-testid="edit-color" />
                  </label>
                  {targetColor && (
                    <span className="flex items-center gap-1 text-[10px] font-mono text-text-muted">
                      {targetColor}
                      <button onClick={() => setTargetColor(null)} title="Clear color" className="hover:text-text"><X size={10} /></button>
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5" data-testid="palette-studio">
                  {/* Generated palette strip — lock swatches you like, regenerate the rest */}
                  <div className="flex rounded overflow-hidden border border-border h-16">
                    {palette.colors.map((hex, i) => (
                      <div key={i} className="relative flex-1 flex flex-col items-center justify-between py-1"
                        style={{ backgroundColor: hex }}>
                        <button title={paletteLocks[i] ? 'Unlock' : 'Lock — keep on regenerate'}
                          onClick={() => setPaletteLocks((p) => p.map((v, j) => j === i ? !v : v))}
                          className="p-0.5 rounded bg-black/30 text-white/90 hover:bg-black/50">
                          {paletteLocks[i] ? <Lock size={10} /> : <Unlock size={10} />}
                        </button>
                        <label className="cursor-pointer" title="Edit this colour">
                          <input type="color" value={hex}
                            onChange={(e) => {
                              const v = e.target.value.toUpperCase()
                              setPalette((prev) => ({ ...prev, colors: prev.colors.map((c, j) => j === i ? v : c) }))
                              setPaletteLocks((p) => p.map((l, j) => j === i ? true : l))
                            }}
                            className="w-0 h-0 opacity-0 absolute" />
                          <span className="text-[8px] font-mono px-1 rounded bg-black/35 text-white/95">{hex}</span>
                        </label>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" icon={<Shuffle size={12} />} onClick={regenPalette} className="text-[10px]">
                      Generate
                    </Button>
                    <span className="text-[9px] text-text-dim italic">scheme: {palette.scheme} · space = regenerate</span>
                  </div>
                </div>
              )}
            </div>

            {!result && (
              <Button variant="primary" size="sm" icon={<Wand2 size={13} />} loading={busy}
                disabled={busy || (colorMode !== 'palette' && !instruction.trim() && !targetColor)}
                onClick={runEdit} className="w-full">
                {busy ? 'Editing with Pro…' : colorMode === 'palette' ? 'Apply palette' : 'Generate edit'}
              </Button>
            )}

            {result && (
              <div className="flex flex-col gap-2">
                <button onClick={() => setZoom(result.url)} title="View full size"
                  className="relative rounded overflow-hidden border-2 border-violet cursor-zoom-in group">
                  <img src={result.url} alt="Edit result" className="w-full object-contain max-h-72" />
                  <span className="absolute top-1 right-1 p-1 rounded bg-bg/60 text-text-muted group-hover:text-violet">
                    <Maximize2 size={12} />
                  </span>
                </button>
                {/* Keep = make it the asset's approved image (and close). Try again = discard + re-edit. */}
                <div className="flex gap-2">
                  <Button variant="approve" size="sm" icon={<CheckCircle size={13} />}
                    onClick={applyEdit} className="flex-1">
                    Use this edit
                  </Button>
                  <Button variant="ghost" size="sm" icon={<RefreshCw size={12} />}
                    onClick={() => setResult(null)} className="text-text-muted">
                    Try again
                  </Button>
                </div>
                <p className="text-[10px] text-text-muted">
                  Kept edits become the approved image; every attempt is also saved in Version History.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Tiny helper so the toolbar icons render at a consistent size.
function createElementSafe(Icon: React.ElementType) {
  return <Icon size={13} />
}
